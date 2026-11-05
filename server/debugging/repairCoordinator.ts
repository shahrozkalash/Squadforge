import crypto from 'node:crypto';
import { computeContentHash, db } from '../store.js';
import {
  Build,
  DebugDiagnostic,
  EventType,
  ExecutionSession,
  HumanApprovalRequest,
  ProjectFile,
  RepairAttempt,
  RepairFileChange,
  RepairLesson,
  RepairRun,
  RepairStatus,
  RepairTestEvidence,
  RootCause,
  User
} from '../types.js';
import { planDependencies } from '../execution/dependencyService.js';
import { ExecutionSessionManager } from '../execution/executionSessionManager.js';
import { hashWorkspace } from '../execution/workspaceMaterializer.js';
import { ApprovalGateService } from '../swarm/approvalGateService.js';
import { CodeGenerationEngine } from '../swarm/codeGenerationEngine.js';
import { CollaborationManager } from '../swarm/collaborationManager.js';
import { CollaborativeDebuggingEngine } from '../swarm/collaborativeDebuggingEngine.js';
import { MergeManager } from '../swarm/mergeManager.js';
import { ProjectMemoryService } from '../swarm/projectMemory.js';
import { DebugAgentTeam } from './debugAgentTeam.js';
import { DiagnosticCollector, ReportedProblem } from './diagnosticCollector.js';
import { isTestFile, selectAffectedTests } from './importGraph.js';
import { RepairAction, RepairPatchValidator, ValidationContext } from './repairPatchValidator.js';
import { RootCauseEngine } from './rootCauseEngine.js';

const DEFAULT_ATTEMPTS = 3;
const REPAIR_ACTOR = 'debugging_specialist';
const ROLLBACK_ACTOR = 'repair_rollback';
const WORKING: RepairStatus[] = ['collecting', 'analyzing', 'investigating', 'proposing', 'validating', 'applying', 'verifying'];
const WAITING: RepairStatus[] = ['awaiting_approval', 'awaiting_test_approval'];
const BUSY_BUILD_STATES = ['planning', 'running', 'verifying'];
const BUSY_RUN_STATES = ['planning', 'generating', 'integrating', 'validating', 'repairing', 'finalizing'];
const RUN_STALE_MS = 60 * 60 * 1000;
const PROCESS_END_WAIT_MS = 5000;

export class RepairError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

class RepairCancelled extends Error {}

export interface StartRepairOptions {
  rootCauseId?: string;
  modelId?: string;
  maxAttempts?: number;
  reports?: ReportedProblem[];
}

/**
 * The store hands out its live objects, which change in place on every write. Anything held
 * across an await must be a copy, or a version check compares a file with itself.
 */
function snapshotFiles(buildId: string): ProjectFile[] {
  return db.getAllFiles(buildId).map(file => ({ ...file }));
}

/** An approved install adds the lockfile, which is not a change to what the repair touched. */
function projectStateHash(files: ProjectFile[]): string {
  return hashWorkspace(files.filter(file => file.path !== 'package-lock.json'));
}

function isApprovalRequired(value: unknown): value is { approvalRequired: HumanApprovalRequest } {
  return typeof value === 'object' && value !== null && 'approvalRequired' in value;
}

export class RepairCoordinator {
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly rollingBack = new Set<string>();

  constructor(private readonly execution: ExecutionSessionManager) {}

  // --- Bookkeeping ---

  private update(run: RepairRun, changes: Partial<RepairRun>): RepairRun {
    Object.assign(run, changes);
    const saved = db.saveRepairRun(run);
    run.status = saved.status;
    return run;
  }

  private finish(run: RepairRun, status: RepairStatus, outcome: string, event: EventType | null = 'repair_failed'): RepairRun {
    this.update(run, { status, outcome, completedAt: Date.now(), pendingApproval: undefined });
    if (event) this.emit(run, event, outcome);
    return run;
  }

  private emit(run: RepairRun, type: EventType, details: string): void {
    db.addEvent({
      id: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      buildId: run.buildId,
      timestamp: Date.now(),
      type,
      details: `Repair ${run.id}: ${details}`.slice(0, 500)
    });
  }

  /** Keeps other agents informed. A failed note must never stop a repair. */
  private note(run: RepairRun, role: any, messageType: any, content: string, relatedFiles: string[] = []): void {
    try {
      CollaborationManager.sendMessage(run.buildId, run.userId, {
        sender: `repair_${role}`,
        senderRole: role,
        messageType,
        content: content.slice(0, 1000),
        relatedFiles,
        structuredMetadata: { repairId: run.id }
      });
    } catch (err: any) {
      console.error('Repair note failed:', err.message);
    }
  }

  private checkpoint(run: RepairRun, signal: AbortSignal): void {
    if (signal.aborted || db.getRepairRun(run.id)?.status === 'cancelled') throw new RepairCancelled();
  }

  /** Runs one stage in the background and records anything it throws as a failure. */
  private track(run: RepairRun, stage: (signal: AbortSignal) => Promise<void>): void {
    const abort = new AbortController();
    // Checks block while they run, so the caller gets its answer first
    const done = new Promise(resolve => setImmediate(resolve))
      .then(() => stage(abort.signal))
      .catch(err => {
        if (err instanceof RepairCancelled) return;
        console.error(`Repair ${run.id} failed:`, err.message);
        const applied = run.fileChanges.length > 0 && !run.rollback;
        if (applied) {
          this.finish(run, 'applied_unverified', `The patch is applied, but checking it failed: ${err.message}`);
        } else {
          this.finish(run, 'failed', err.message || 'The repair failed');
        }
      })
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { abort, done });
  }

  /** Test support, and a clean wait for a stage already started. */
  async settled(runId: string): Promise<RepairRun | undefined> {
    await this.active.get(runId)?.done;
    return db.getRepairRun(runId);
  }

  /** Ends runs that cannot continue, such as after a restart or an unanswered approval. */
  private reconcile(buildId: string): void {
    for (const run of db.getRepairRuns(buildId)) {
      if (this.active.has(run.id)) continue;

      if (WORKING.includes(run.status)) {
        const message = 'The server restarted during this repair.';
        if (run.fileChanges.length > 0) this.finish(run, 'applied_unverified', `${message} The patch is applied and was not fully checked.`);
        else this.finish(run, 'failed', message);
        continue;
      }

      if (run.rollback?.state === 'pending_approval' && !WAITING.includes(run.status)) {
        const request = run.pendingApproval && db.getApprovalRequest(run.pendingApproval.requestId);
        if (!request || request.status !== 'pending' || ApprovalGateService.hasExpired(request)) {
          this.update(run, {
            pendingApproval: undefined,
            rollback: { ...run.rollback, state: 'failed', reason: `Nobody approved this rollback in time. ${run.rollback.reason}` }
          });
        }
        continue;
      }

      if (WAITING.includes(run.status)) {
        const request = run.pendingApproval && db.getApprovalRequest(run.pendingApproval.requestId);
        if (!request || request.status !== 'pending' || ApprovalGateService.hasExpired(request)) {
          this.closeUnanswered(run, request ? 'The approval request expired or was withdrawn.' : 'No approval request is open.');
        }
      }
    }
  }

  private closeUnanswered(run: RepairRun, reason: string): void {
    if (run.status === 'awaiting_test_approval') this.finish(run, 'applied_unverified', `${reason} The patch is applied, and its tests did not run.`);
    else this.finish(run, 'failed', `${reason} No files were changed.`);
  }

  private assertReady(build: Build): void {
    this.reconcile(build.id);

    const open = db.getRepairRuns(build.id).find(run => WORKING.includes(run.status) || WAITING.includes(run.status));
    if (open) throw new RepairError(`Repair ${open.id} is still ${open.status}. Finish or cancel it first.`, 409);

    if (BUSY_BUILD_STATES.includes(build.status)) {
      throw new RepairError('This project is still being built. Repair it when the build ends.', 409);
    }
    const recent = Date.now() - RUN_STALE_MS;
    if (db.getGenerationRuns(build.id).some(run => BUSY_RUN_STATES.includes(run.status) && run.createdAt > recent)) {
      throw new RepairError('Code generation is running on this project. Repair it when that ends.', 409);
    }
  }

  // --- Repair pipeline ---

  /** Starts a repair of one root cause. The result is read from the run's history. */
  start(build: Build, user: User, options: StartRepairOptions = {}): RepairRun {
    this.assertReady(build);

    const model = CodeGenerationEngine.resolveGenerationModel(options.modelId);
    if (!model) throw new RepairError('No AI model is available.', 503);

    const now = Date.now();
    const run: RepairRun = {
      id: `rep_${now}_${crypto.randomBytes(4).toString('hex')}`,
      buildId: build.id,
      userId: user.id,
      status: 'collecting',
      modelId: model.id,
      maxAttempts: Math.min(Math.max(Math.floor(options.maxAttempts || DEFAULT_ATTEMPTS), 1), DEFAULT_ATTEMPTS),
      rootCauses: [],
      attempts: [],
      fileChanges: [],
      tokenUsage: 0,
      createdAt: now,
      updatedAt: now
    };
    db.saveRepairRun(run);
    this.emit(run, 'repair_started', 'Collecting diagnostics');

    this.track(run, signal => this.pipeline(run, build, user, options, signal));
    return run;
  }

  private call(run: RepairRun, signal: AbortSignal) {
    const model = CodeGenerationEngine.resolveGenerationModel(run.modelId);
    return { buildId: run.buildId, userId: run.userId, model, signal };
  }

  private target(run: RepairRun): RootCause {
    return run.rootCauses.find(cause => cause.id === run.targetRootCauseId)!;
  }

  private lessonsFor(run: RepairRun, cause: RootCause): RepairLesson[] {
    return ProjectMemoryService.getRepairLessons(run.buildId, run.userId, { fingerprints: cause.fingerprints });
  }

  private validationContext(run: RepairRun, cause: RootCause, files: ProjectFile[], lessons: RepairLesson[]): ValidationContext {
    return {
      buildId: run.buildId,
      files,
      baseline: run.report!.diagnostics,
      baselineChecks: run.report!.checks,
      cause,
      scope: RootCauseEngine.repairScope(cause, files),
      contracts: DiagnosticCollector.contractsFor(run.buildId),
      failedPatches: new Set(lessons.filter(lesson => lesson.outcome === 'failed' && lesson.patchFingerprint).map(lesson => lesson.patchFingerprint!))
    };
  }

  private async pipeline(run: RepairRun, build: Build, user: User, options: StartRepairOptions, signal: AbortSignal): Promise<void> {
    const report = DiagnosticCollector.collect(build.id, options.reports);
    this.update(run, { status: 'analyzing', report, workspaceHash: report.workspaceHash });
    this.checkpoint(run, signal);

    const files = snapshotFiles(build.id);
    const lessons = ProjectMemoryService.getRepairLessons(build.id, user.id);
    const rootCauses = RootCauseEngine.analyze(files, report.diagnostics, lessons);
    this.update(run, { rootCauses });

    if (rootCauses.length === 0) {
      const skipped = report.checks.filter(check => check.status === 'skipped').map(check => check.name);
      const note = skipped.length ? ` These checks did not run: ${skipped.join(', ')}.` : '';
      this.finish(run, 'no_action', `No problems were found.${note}`, null);
      return;
    }

    const cause = options.rootCauseId
      ? rootCauses.find(item => item.id === options.rootCauseId)
      : rootCauses[0];
    if (!cause) {
      this.finish(run, 'failed', `Root cause ${options.rootCauseId} is not present in this workspace.`);
      return;
    }
    this.update(run, { targetRootCauseId: cause.id });

    if (!cause.primaryFile) {
      this.finish(run, 'failed', `No file could be tied to this problem, so nothing was changed: ${cause.summary}`);
      return;
    }

    this.recordDefect(run, cause);
    await this.investigate(run, cause, signal);
    await this.attemptRepairs(run, build, user, cause, signal);
  }

  private recordDefect(run: RepairRun, cause: RootCause): void {
    const defect = CollaborativeDebuggingEngine.recordDefect(run.buildId, run.userId, {
      title: cause.summary.slice(0, 100),
      description: cause.summary,
      severity: 'high',
      reproductionSteps: cause.evidence,
      expectedBehavior: 'The checks that reported this problem pass.',
      actualBehavior: cause.summary,
      affectedFiles: cause.affectedFiles,
      assignedAgent: cause.leadAgent,
      authorRole: cause.leadAgent
    });
    // Agents read this later with no fence around it, so it quotes no project output
    const memoryDefectId = ProjectMemoryService.recordDefect(run.buildId, run.userId, {
      description: `${cause.category.replace(/_/g, ' ')} in ${cause.primaryFile}`,
      filePaths: cause.affectedFiles,
      severity: 'high'
    });
    this.update(run, { defectId: defect.defect?.id, memoryDefectId: memoryDefectId ?? undefined });
  }

  private async investigate(run: RepairRun, cause: RootCause, signal: AbortSignal): Promise<void> {
    this.update(run, { status: 'investigating' });
    const files = snapshotFiles(run.buildId);
    const scope = RootCauseEngine.repairScope(cause, files);

    const result = await DebugAgentTeam.investigate(
      this.call(run, signal), cause, run.report!.diagnostics, files, scope, this.lessonsFor(run, cause)
    );
    this.checkpoint(run, signal);

    this.update(run, { investigation: result.investigation, tokenUsage: run.tokenUsage + result.tokens });
    if (!result.investigation?.supported) {
      this.note(run, cause.leadAgent, 'debugging_request', `No supported explanation from the agent: ${result.error || 'evidence was not cited'}. Using the static analysis only.`);
      return;
    }

    this.note(run, cause.leadAgent, 'bug_report', result.investigation.hypothesis, cause.affectedFiles);
    if (run.defectId) {
      CollaborativeDebuggingEngine.proposeSolution(run.buildId, run.userId, {
        defectId: run.defectId,
        authorRole: cause.leadAgent,
        rootCause: result.investigation.hypothesis
      });
    }
  }

  private async attemptRepairs(run: RepairRun, build: Build, user: User, cause: RootCause, signal: AbortSignal): Promise<void> {
    const attempts: RepairAttempt[] = [];

    for (let number = 1; number <= run.maxAttempts; number++) {
      this.checkpoint(run, signal);

      // A workspace that moved on makes the diagnostics out of date
      if (hashWorkspace(db.getAllFiles(build.id)) !== run.workspaceHash) {
        this.finish(run, 'failed', 'The project changed during this repair, so it stopped without changing anything. Start a new repair.');
        return;
      }

      const files = snapshotFiles(build.id);
      const lessons = this.lessonsFor(run, cause);
      const context = this.validationContext(run, cause, files, lessons);

      this.update(run, { status: 'proposing' });
      const proposal = await DebugAgentTeam.proposePatch(
        this.call(run, signal), cause, run.report!.diagnostics, files, context.scope, context.contracts, run.investigation, lessons, attempts
      );
      this.checkpoint(run, signal);
      this.update(run, { tokenUsage: run.tokenUsage + proposal.tokens });

      const attempt: RepairAttempt = {
        attempt: number,
        agent: run.modelId,
        role: 'debugging_specialist',
        outcome: 'model_failed',
        explanation: proposal.explanation,
        actions: proposal.actions || [],
        detail: proposal.error,
        timestamp: Date.now()
      };
      attempts.push(attempt);

      if (!proposal.actions) {
        this.update(run, { attempts: [...attempts] });
        continue;
      }

      this.update(run, { status: 'validating' });
      const validation = RepairPatchValidator.validate(context, proposal.actions);
      attempt.validation = validation;

      if (!validation.passed) {
        attempt.outcome = 'validation_failed';
        attempt.detail = validation.checks.filter(check => !check.passed).map(check => `${check.name}: ${check.detail}`).join('; ');
        this.update(run, { attempts: [...attempts] });
        this.rememberFailure(run, cause, validation.patchFingerprint, `Validation refused it. ${attempt.detail}`);
        continue;
      }

      const { actions } = RepairPatchValidator.normalize(proposal.actions);
      const paths = actions.map(action => action.path);
      const reviewerRole = DebugAgentTeam.reviewerRole(cause, paths);
      const review = await DebugAgentTeam.reviewPatch(this.call(run, signal), cause, actions, proposal.explanation, reviewerRole);
      this.checkpoint(run, signal);
      attempt.review = { agent: run.modelId, role: reviewerRole, approved: review.approved, reason: review.reason };
      this.update(run, { tokenUsage: run.tokenUsage + review.tokens });

      if (!review.approved) {
        attempt.outcome = 'review_rejected';
        attempt.detail = review.reason;
        this.update(run, { attempts: [...attempts] });
        this.note(run, reviewerRole, 'review_response', `Patch rejected: ${review.reason}`, paths);
        continue;
      }

      this.update(run, { patchFingerprint: validation.patchFingerprint });
      const guarded = this.guardActions(actions, files);

      if (ApprovalGateService.isSensitiveOperation(paths)) {
        attempt.outcome = 'held_for_approval';
        this.update(run, { attempts: [...attempts] });
        this.holdForApproval(run, guarded, attempt);
        return;
      }

      this.update(run, { status: 'applying' });
      const applied = await this.apply(run, guarded, REPAIR_ACTOR, signal);
      if (applied.error) {
        attempt.outcome = 'apply_failed';
        attempt.detail = applied.error;
        this.update(run, { attempts: [...attempts] });
        continue;
      }

      attempt.outcome = 'applied';
      this.update(run, { attempts: [...attempts] });
      await this.verify(run, build, user, signal);
      return;
    }

    this.finish(run, 'failed', `No patch passed after ${run.maxAttempts} attempt(s). No files were changed.`);
    this.recordMemoryAttempt(run, false, 'No patch passed validation');
  }

  /** Each patch names the file state it was validated against, so it cannot land on anything else. */
  private guardActions(actions: RepairAction[], files: ProjectFile[]): RepairAction[] {
    return actions.map(action => {
      const file = files.find(item => item.path === action.path);
      const commitMessage = action.commitMessage || 'Validated repair';
      if (action.action !== 'patch_file' || !file) return { ...action, commitMessage };
      return {
        ...action,
        commitMessage,
        expectedVersion: file.version,
        expectedContentHash: file.contentHash || computeContentHash(file.content)
      };
    });
  }

  private holdForApproval(run: RepairRun, actions: RepairAction[], attempt: RepairAttempt): void {
    const validation = attempt.validation!;
    const request = ApprovalGateService.requestForActions(run.buildId, run.userId, {
      agent: REPAIR_ACTOR,
      actions,
      runId: run.id,
      explanation: `A validated repair changes sensitive files: ${attempt.explanation}`,
      reviewResults: [
        `Dry run: ${validation.clearedFingerprints.length} target diagnostic(s) cleared, ${validation.newDiagnostics.length} new.`,
        `${validation.changedLines} line(s) changed.`,
        `Reviewer: ${attempt.review?.reason}`
      ].join(' ')
    });
    if (!request.request) {
      this.finish(run, 'failed', request.error || 'Approval could not be requested. No files were changed.');
      return;
    }
    this.update(run, {
      status: 'awaiting_approval',
      pendingApproval: { requestId: request.request.id, purpose: 'apply' },
      outcome: 'Waiting for the owner to approve a change to sensitive files. Nothing has been changed.'
    });
  }

  /** Writes a patch through the normal gated path and records how to undo it. */
  private async apply(run: RepairRun, actions: any[], actor: string, signal?: AbortSignal): Promise<{ error?: string }> {
    const snapshot = snapshotFiles(run.buildId);
    const before = new Map(actions.map(action => {
      const file = db.getFile(run.buildId, action.path);
      return [action.path, file && { ...file, history: [...(file.history || [])] }] as const;
    }));

    const result = await MergeManager.applyBatchActions(run.buildId, actor, actions, { signal });
    if (!result.success) return { error: result.error || 'The patch could not be applied.' };

    // A write queued behind this one may already have run, so the file cannot be read back here
    const written = new Map<string, string>();
    const fileChanges: RepairFileChange[] = actions.map((action, index) => {
      const previous = before.get(action.path);
      const outcome = result.results[index];
      const content: string = outcome.currentContent ?? action.content;
      written.set(action.path, content);
      const inHistory = previous?.history?.some(entry => entry.version === previous.version);
      return {
        path: action.path,
        created: !previous,
        beforeVersion: previous?.version ?? 0,
        beforeHash: previous ? previous.contentHash || computeContentHash(previous.content) : '',
        beforeContent: previous && !inHistory ? previous.content : undefined,
        afterVersion: outcome.version,
        afterHash: computeContentHash(content)
      };
    });
    const applied = [
      ...snapshot.filter(file => !written.has(file.path)),
      ...Array.from(written, ([path, content]) => ({ path, content }) as ProjectFile)
    ];
    this.update(run, { fileChanges, appliedWorkspaceHash: projectStateHash(applied) });
    this.emit(run, 'repair_applied', `Changed ${fileChanges.map(change => change.path).join(', ')}`);
    return {};
  }

  // --- Verification ---

  /** Looks at the real workspace after the write. The dry run proved nothing about this state. */
  private async verify(run: RepairRun, build: Build, user: User, signal: AbortSignal): Promise<void> {
    const files = snapshotFiles(build.id);

    // Other changes would be blamed on this patch, and a correct repair could be undone for them
    if (run.appliedWorkspaceHash !== projectStateHash(files)) {
      this.finish(run, 'applied_unverified', 'The project changed after this repair, so its result cannot be judged alone. The patch stays applied.');
      this.recordMemoryAttempt(run, false, 'The project changed before verification finished');
      return;
    }

    this.update(run, { status: 'verifying' });
    const cause = this.target(run);

    const after = DiagnosticCollector.collectStatic(build.id, files, DiagnosticCollector.contractsFor(build.id));
    const skippedBefore = new Set(run.report!.checks.filter(check => check.status === 'skipped').map(check => check.name));
    const comparison = RepairPatchValidator.compare(
      cause,
      run.report!.diagnostics,
      after.diagnostics.filter(item => !skippedBefore.has(item.kind))
    );

    // These are not this patch's fault, but they do mean the project is not known to be good
    const unmaskedDiagnostics = [
      ...after.diagnostics
        .filter(item => skippedBefore.has(item.kind))
        .map(item => `[${item.kind}] ${item.filePath || 'project'}: ${item.message}`),
      ...after.checks
        .filter(check => check.status === 'skipped' && !skippedBefore.has(check.name))
        .map(check => `The ${check.name} check stopped running: ${check.detail || 'no reason given'}`)
    ];

    const notRun: RepairTestEvidence = { status: 'not_run', affectedTests: [], detail: 'Tests have not run yet.' };
    this.update(run, { verification: { ...comparison, unmaskedDiagnostics, tests: notRun, checkedAt: Date.now() } });
    this.checkpoint(run, signal);

    if (comparison.remainingFingerprints.length > 0 || comparison.newDiagnostics.length > 0) {
      await this.failAndRollBack(run, 'The real workspace still fails after the patch, although the dry run passed.');
      return;
    }

    const tests = await this.runTests(run, build, user, cause, files, signal);
    if (!tests) return;
    this.update(run, { verification: { ...run.verification!, tests, checkedAt: Date.now() } });
    await this.conclude(run, cause, tests);
  }

  private async conclude(run: RepairRun, cause: RootCause, tests: RepairTestEvidence): Promise<void> {
    if (tests.status === 'failed') {
      await this.failAndRollBack(run, `Tests failed after the patch: ${tests.detail}`);
      return;
    }

    const unproven = this.unprovenTargets(run, tests);
    const unmasked = run.verification!.unmaskedDiagnostics;
    if (tests.status === 'not_run' || unproven.length > 0 || unmasked.length > 0) {
      const reason = tests.status === 'not_run'
        ? tests.detail
        : unmasked.length > 0
          ? `Checks that could not run before now report: ${unmasked[0]}`
          : 'This problem came from a run or a report, and nothing shows it is gone. Run what failed again, then check this repair again.';
      this.finish(run, 'applied_unverified', `The patch is applied and passed static checks, but it is not verified. ${reason}`);
      this.recordMemoryAttempt(run, false, `Applied but unverified: ${reason}`);
      return;
    }

    this.finish(run, 'verified', `Verified: the target is gone, nothing new is wrong, and ${tests.detail}`, 'repair_verified');
    this.recordVerified(run, cause, tests);
  }

  /**
   * A problem seen at runtime is gone only if the thing that failed now succeeds on this exact
   * workspace. Any other passing test says nothing about it, and a report can never be re-run.
   */
  private unprovenTargets(run: RepairRun, tests: RepairTestEvidence): string[] {
    const hash = hashWorkspace(db.getAllFiles(run.buildId));
    const sessions = db.getExecutionSessions(run.buildId, 20);

    return run.verification!.needsRuntimeProof.filter(fingerprint => {
      const item = run.report!.diagnostics.find(diagnostic => diagnostic.fingerprint === fingerprint);
      if (!item || item.source === 'reported') return true;

      if (item.kind === 'test') {
        const covered = tests.scope === 'full' || (item.filePath !== undefined && tests.affectedTests.includes(item.filePath));
        return !(tests.status === 'passed' && covered);
      }

      const script = item.sessionId ? db.getExecutionSession(item.sessionId)?.script : undefined;
      const rerun = script ? sessions.find(session => session.script === script && session.endReason) : undefined;
      return !(rerun?.workspaceHash === hash && rerun.endReason === 'exited' && rerun.exitCode === 0);
    });
  }

  private notRun(affectedTests: string[], detail: string): RepairTestEvidence {
    return { status: 'not_run', affectedTests, detail };
  }

  private evidenceFrom(session: ExecutionSession, scope: 'affected' | 'full', affectedTests: string[]): RepairTestEvidence {
    const base = { scope, affectedTests, sessionId: session.id, exitCode: session.exitCode, endReason: session.endReason };
    const what = scope === 'affected' ? `${affectedTests.length} affected test file(s)` : 'the full test script';
    if (session.endReason === 'exited' && session.exitCode === 0) {
      return { ...base, status: 'passed', detail: `${what} passed in the sandbox.` };
    }
    if (session.endReason === 'stopped') {
      return { ...base, status: 'not_run', detail: 'The test run was stopped before it finished.' };
    }
    return { ...base, status: 'failed', detail: `${what} ended with ${session.endReason} (exit code ${session.exitCode}).` };
  }

  /** Tests are project code, so they run only in the sandbox and only with approval. */
  private async runTests(
    run: RepairRun,
    build: Build,
    user: User,
    cause: RootCause,
    files: ProjectFile[],
    signal: AbortSignal
  ): Promise<RepairTestEvidence | null> {
    const changed = run.fileChanges.map(change => change.path);
    const failing = cause.affectedFiles.filter(path => isTestFile(path) && files.some(file => file.path === path));
    const affected = Array.from(new Set([...selectAffectedTests(files, changed), ...failing])).sort();

    if (affected.length === 0) {
      return { status: 'none_affected', affectedTests: [], detail: 'no test imports the changed code.' };
    }

    const recorded = db.getSandboxTestRun(build.id, hashWorkspace(files));
    if (recorded) return this.evidenceFrom(recorded, 'full', affected);

    const capabilities = await this.execution.capabilities();
    if (!capabilities.available) {
      return this.notRun(affected, `The sandbox is unavailable, so ${affected.length} affected test file(s) did not run. ${capabilities.reason || ''}`.trim());
    }

    try {
      const prepared = await this.prepareSession(run, build, user, files);
      if (isApprovalRequired(prepared)) {
        this.update(run, {
          status: 'awaiting_test_approval',
          pendingApproval: { requestId: prepared.approvalRequired.id, purpose: 'tests' },
          outcome: 'The patch is applied. Waiting for the owner to approve running tests in the sandbox.',
          verification: { ...run.verification!, tests: this.notRun(affected, 'Waiting for approval to run tests.') }
        });
        return null;
      }

      this.checkpoint(run, signal);
      const started = await this.execution.startScript(build, prepared.id, 'test', affected);
      const scope = started.script === 'test' ? 'full' : 'affected';
      this.update(run, {
        verification: { ...run.verification!, tests: { ...this.notRun(affected, 'Tests are running.'), sessionId: started.id, scope } }
      });

      const finished = await this.waitForEnd(started.id);
      this.checkpoint(run, signal);
      const evidence = this.evidenceFrom(finished, scope, affected);
      await this.execution.destroySession(build.id, finished.id).catch(err => console.error('Test session cleanup failed:', err.message));
      return evidence;
    } catch (err: any) {
      if (err instanceof RepairCancelled) throw err;
      this.checkpoint(run, signal);
      return this.notRun(affected, `Tests could not run: ${err.message}`);
    }
  }

  /** Tests need a session of their own with dependencies in place. */
  private async prepareSession(run: RepairRun, build: Build, user: User, files: ProjectFile[]) {
    const remember = (sessionId: string) => this.update(run, {
      verification: { ...run.verification!, tests: { ...run.verification!.tests, sessionId } }
    });

    let session = await this.execution.createSession(build, user);
    if (isApprovalRequired(session)) return session;
    remember(session.id);

    // An approved workspace can already have a used session, which cannot give trusted results
    if (session.script) {
      if (session.status !== 'ready') throw new RepairError('This workspace is busy running another script.', 409);
      await this.execution.destroySession(build.id, session.id);
      session = await this.execution.createSession(build, user);
      if (isApprovalRequired(session)) return session;
      remember(session.id);
    }

    if (planDependencies(files).hasDependencies && session.dependencyStatus !== 'installed') {
      const installing = await this.execution.installDependencies(build, session.id);
      if (isApprovalRequired(installing)) return installing;

      await this.execution.waitForProcess(installing.id);
      const installed = db.getExecutionSession(installing.id)!;
      if (installed.dependencyStatus !== 'installed') {
        throw new RepairError(installed.failureReason || 'Dependencies did not install.', 500);
      }
      return installed;
    }
    return session;
  }

  /** The process handle ends slightly before its session record is saved. */
  private async waitForEnd(sessionId: string): Promise<ExecutionSession> {
    await this.execution.waitForProcess(sessionId);
    const deadline = Date.now() + PROCESS_END_WAIT_MS;
    let session = db.getExecutionSession(sessionId)!;
    while (!session.endReason && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      session = db.getExecutionSession(sessionId)!;
    }
    return session;
  }

  // --- Rollback ---

  private beforeContent(run: RepairRun, change: RepairFileChange, file: ProjectFile): string | undefined {
    return change.beforeContent ?? file.history?.find(entry => entry.version === change.beforeVersion)?.content;
  }

  /** Files changed since the repair are named and left alone. Undoing them would lose that work. */
  private rollbackPlan(run: RepairRun): { actions: any[]; conflicts: string[] } {
    const actions: any[] = [];
    const conflicts: string[] = [];

    for (const change of run.fileChanges) {
      const file = db.getFile(run.buildId, change.path);
      const hash = file && (file.contentHash || computeContentHash(file.content));
      if (!file || file.version !== change.afterVersion || hash !== change.afterHash) {
        conflicts.push(`${change.path} changed after the repair`);
        continue;
      }

      const commitMessage = `Roll back repair ${run.id}`;
      if (change.created) {
        actions.push({ action: 'delete_file', path: change.path, expectedVersion: change.afterVersion, commitMessage });
        continue;
      }

      const before = this.beforeContent(run, change, file);
      if (before === undefined) {
        conflicts.push(`The earlier version of ${change.path} is not available`);
        continue;
      }
      actions.push({
        action: 'patch_file',
        path: change.path,
        edits: [{ find: file.content, replace: before }],
        expectedVersion: change.afterVersion,
        expectedContentHash: change.afterHash,
        commitMessage
      });
    }
    return { actions, conflicts };
  }

  private async performRollback(run: RepairRun, reason: string, automatic: boolean, approved?: any[]): Promise<RepairRun> {
    const at = Date.now();
    const plan = approved ? { actions: approved, conflicts: [] } : this.rollbackPlan(run);

    if (plan.conflicts.length > 0) {
      this.update(run, { rollback: { state: 'conflict', reason, conflicts: plan.conflicts, automatic, at } });
      return run;
    }

    const paths = plan.actions.map(action => action.path);
    if (!approved && ApprovalGateService.isSensitiveOperation(paths)) {
      const request = ApprovalGateService.requestForActions(run.buildId, run.userId, {
        agent: ROLLBACK_ACTOR,
        actions: plan.actions,
        runId: run.id,
        explanation: `Roll back a repair that changed sensitive files: ${reason}`
      });
      if (!request.request) {
        this.update(run, { rollback: { state: 'failed', reason: request.error || reason, conflicts: [], automatic, at } });
        return run;
      }
      this.update(run, {
        rollback: { state: 'pending_approval', reason, conflicts: [], automatic, at },
        pendingApproval: { requestId: request.request.id, purpose: 'rollback' }
      });
      return run;
    }

    const result = await MergeManager.applyBatchActions(run.buildId, ROLLBACK_ACTOR, plan.actions);
    if (!result.success) {
      this.update(run, { rollback: { state: 'conflict', reason, conflicts: [result.error || 'The rollback could not be applied'], automatic, at } });
      return run;
    }

    this.update(run, { rollback: { state: 'done', reason, conflicts: [], automatic, at } });
    ProjectMemoryService.retractRepairLessons(run.buildId, run.userId, run.id);
    if (run.defectId) {
      CollaborativeDebuggingEngine.updateStatus(run.buildId, run.userId, { defectId: run.defectId, status: 'reopened' });
    }
    this.finish(run, 'rolled_back', `Rolled back: ${reason}`, 'repair_rolled_back');
    return run;
  }

  /** A failed repair must not stay in the project, and the attempt must stay visible. */
  private async failAndRollBack(run: RepairRun, reason: string): Promise<void> {
    this.rememberFailure(run, this.target(run), run.patchFingerprint, reason);
    this.recordMemoryAttempt(run, false, reason);
    await this.performRollback(run, reason, true);

    if (run.rollback?.state === 'pending_approval') {
      this.update(run, { status: 'failed', completedAt: Date.now(), outcome: `${reason} The patch is still applied, because undoing it changes sensitive files and needs the owner's approval.` });
    } else if (run.rollback?.state !== 'done') {
      this.finish(run, 'failed', `${reason} The patch is still applied, because it could not be rolled back: ${run.rollback?.conflicts.join('; ')}`);
    }
  }

  /** Undoes a repair for the owner. Sensitive files still go through approval. */
  async rollback(build: Build, repairId: string, reason?: string): Promise<RepairRun> {
    const run = this.requireRun(build, repairId);
    if (run.fileChanges.length === 0) throw new RepairError('This repair changed no files.', 409);
    if (run.rollback?.state === 'done') throw new RepairError('This repair is already rolled back.', 409);
    if (run.rollback?.state === 'pending_approval') throw new RepairError('This rollback is waiting for approval.', 409);
    if (this.active.has(run.id) || WORKING.includes(run.status)) throw new RepairError('This repair is still running. Cancel it first.', 409);
    if (this.rollingBack.has(run.id)) throw new RepairError('This repair is already being rolled back.', 409);

    const waitingOn = run.pendingApproval?.requestId;
    this.rollingBack.add(run.id);
    try {
      await this.performRollback(run, reason?.slice(0, 300) || 'Requested by the owner', false);
    } finally {
      this.rollingBack.delete(run.id);
    }

    // A rollback that went ahead or now waits on the owner replaces what the run was waiting for
    if (waitingOn && run.rollback?.state !== 'conflict' && run.rollback?.state !== 'failed') {
      ApprovalGateService.cancelRequest(build.id, waitingOn);
    }
    return run;
  }

  // --- Decisions and control ---

  /** Continues a repair after the owner decides. A run no longer waiting is left alone. */
  async handleApprovalDecision(request: HumanApprovalRequest, user: User): Promise<boolean> {
    const run = db.getRepairRuns(request.buildId).find(item => item.pendingApproval?.requestId === request.id);
    const build = db.getBuild(request.buildId);
    if (!run || !build || request.status === 'pending' || build.userId !== user.id) return false;

    const purpose = run.pendingApproval!.purpose;
    this.update(run, { pendingApproval: undefined });
    const approved = request.status === 'approved';

    if (purpose === 'apply') {
      if (!approved) {
        this.rememberFailure(run, this.target(run), run.patchFingerprint, `The owner did not approve this change (${request.status}).`);
        this.finish(run, 'rejected', `The owner did not approve this change (${request.status}). No files were changed.`);
        this.recordMemoryAttempt(run, false, 'Not approved by the owner');
        return true;
      }
      this.track(run, async signal => {
        try {
          await this.applyApproved(run, request, build, user, signal);
        } finally {
          if (run.fileChanges.length === 0) ApprovalGateService.revokeApproval(build.id, user.id, request.id);
        }
      });
      return true;
    }

    if (purpose === 'tests') {
      if (!approved) {
        this.finish(run, 'applied_unverified', `The patch is applied, but its tests did not run, because the owner did not approve running them (${request.status}).`);
        this.recordMemoryAttempt(run, false, 'Tests were not approved');
        return true;
      }
      this.track(run, signal => this.verify(run, build, user, signal));
      return true;
    }

    if (!approved) {
      const reason = run.rollback?.reason || 'Requested by the owner';
      this.update(run, { rollback: { state: 'failed', reason: `Rollback not approved (${request.status}). ${reason}`, conflicts: [], automatic: Boolean(run.rollback?.automatic), at: Date.now() } });
      return true;
    }
    this.track(run, async () => {
      await this.performRollback(run, run.rollback?.reason || 'Approved by the owner', Boolean(run.rollback?.automatic), this.approvedRollback(run, request));
      if (run.rollback?.state !== 'done') ApprovalGateService.revokeApproval(build.id, user.id, request.id);
    });
    return true;
  }

  /** The approval covers the reviewed change. Whether it still fits the files is checked here. */
  private approvedRollback(run: RepairRun, request: HumanApprovalRequest): any[] | undefined {
    return this.rollbackPlan(run).conflicts.length > 0 ? undefined : request.proposedActions;
  }

  private async applyApproved(run: RepairRun, request: HumanApprovalRequest, build: Build, user: User, signal: AbortSignal): Promise<void> {
    const cause = this.target(run);
    const attempts = [...run.attempts];
    const attempt = attempts[attempts.length - 1];

    // Time passed during review, so the patch is checked again against the project as it is now
    this.update(run, { status: 'validating' });
    const files = snapshotFiles(build.id);
    const report = hashWorkspace(files) === run.workspaceHash ? run.report! : DiagnosticCollector.collect(build.id);
    this.update(run, { report, workspaceHash: report.workspaceHash });
    const validation = RepairPatchValidator.validate(this.validationContext(run, cause, files, []), request.proposedActions || []);

    if (!validation.passed) {
      const detail = validation.checks.filter(check => !check.passed).map(check => `${check.name}: ${check.detail}`).join('; ');
      attempt.outcome = 'validation_failed';
      attempt.detail = detail;
      this.update(run, { attempts });
      this.finish(run, 'failed', `The approved patch no longer fits the project, so nothing was changed. ${detail}`);
      return;
    }

    this.checkpoint(run, signal);
    this.update(run, { status: 'applying' });
    const applied = await this.apply(run, request.proposedActions!, REPAIR_ACTOR, signal);
    if (applied.error) {
      attempt.outcome = 'apply_failed';
      attempt.detail = applied.error;
      this.update(run, { attempts });
      this.finish(run, 'failed', `The approved patch could not be applied: ${applied.error}`);
      return;
    }

    attempt.outcome = 'applied';
    this.update(run, { attempts });
    await this.verify(run, build, user, signal);
  }

  /** Stops the work, including any model call or test run in progress. */
  async cancel(build: Build, repairId: string): Promise<RepairRun> {
    const run = this.requireRun(build, repairId);
    if (!WORKING.includes(run.status) && !WAITING.includes(run.status)) {
      throw new RepairError(`This repair already ended (${run.status}).`, 409);
    }

    const applied = run.fileChanges.length > 0;
    const pending = run.pendingApproval;
    this.update(run, {
      status: 'cancelled',
      completedAt: Date.now(),
      pendingApproval: undefined,
      outcome: applied
        ? 'Cancelled. The patch stays applied and unverified. Roll it back if it is not wanted.'
        : 'Cancelled. No files were changed.'
    });

    ApprovalGateService.cancelRequestsForRun(build.id, run.id);
    if (pending) ApprovalGateService.cancelRequest(build.id, pending.requestId);

    const active = this.active.get(run.id);
    active?.abort.abort(new Error('Repair cancelled'));
    const sessionId = run.verification?.tests.sessionId;
    if (sessionId) await this.execution.stop(build, sessionId).catch(() => undefined);
    await active?.done;
    return db.getRepairRun(run.id)!;
  }

  /** Checks an applied patch again, for example after the owner ran the tests. */
  verifyAgain(build: Build, user: User, repairId: string): RepairRun {
    const run = this.requireRun(build, repairId);
    if (run.status !== 'applied_unverified' || this.active.has(run.id) || run.rollback?.state === 'pending_approval') {
      throw new RepairError('Only an unverified repair that is not being checked can be checked again.', 409);
    }
    if (this.rollbackPlan(run).conflicts.length > 0) {
      throw new RepairError('The repaired files changed afterwards, so this repair can no longer be verified alone.', 409);
    }
    this.track(run, signal => this.verify(run, build, user, signal));
    return run;
  }

  private requireRun(build: Build, repairId: string): RepairRun {
    const run = db.getRepairRun(repairId);
    if (!run || run.buildId !== build.id) throw new RepairError('Repair not found', 404);
    return run;
  }

  list(build: Build): RepairRun[] {
    this.reconcile(build.id);
    return db.getRepairRuns(build.id);
  }

  get(build: Build, repairId: string): RepairRun {
    this.reconcile(build.id);
    return this.requireRun(build, repairId);
  }

  // --- Memory ---

  private rememberFailure(run: RepairRun, cause: RootCause, patchFingerprint: string | undefined, reason: string): void {
    ProjectMemoryService.recordRepairLesson(run.buildId, run.userId, {
      outcome: 'failed',
      fingerprints: cause.fingerprints,
      category: cause.category,
      patchFingerprint,
      summary: cause.summary,
      evidence: reason.slice(0, 500),
      files: cause.affectedFiles,
      repairId: run.id
    });
  }

  private recordMemoryAttempt(run: RepairRun, success: boolean, note: string): void {
    if (!run.memoryDefectId) return;
    ProjectMemoryService.recordRepairExecution(run.buildId, run.userId, run.memoryDefectId, note, success, success ? undefined : note);
  }

  /** Only a verified repair teaches the project anything positive. */
  private recordVerified(run: RepairRun, cause: RootCause, tests: RepairTestEvidence): void {
    const attempt = run.attempts[run.attempts.length - 1];
    const evidence = `${run.verification!.clearedFingerprints.length} diagnostic(s) cleared. Tests: ${tests.detail}`;

    this.recordMemoryAttempt(run, true, evidence);
    ProjectMemoryService.recordRepairLesson(run.buildId, run.userId, {
      outcome: 'verified',
      fingerprints: cause.fingerprints,
      category: cause.category,
      patchFingerprint: run.patchFingerprint,
      summary: `${cause.summary} Fixed by: ${attempt?.explanation || 'a validated patch'}`.slice(0, 500),
      evidence,
      files: run.fileChanges.map(change => change.path),
      repairId: run.id
    });

    if (run.defectId) {
      CollaborativeDebuggingEngine.updateStatus(run.buildId, run.userId, {
        defectId: run.defectId,
        status: 'resolved',
        testEvidence: evidence
      });
    }
  }
}
