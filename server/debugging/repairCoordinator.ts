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
  RepairRuntimeEvidence,
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
import { detectGetRoutes, isTestFile, selectAffectedTests } from './importGraph.js';
import { RepairAction, RepairPatchValidator, ValidationContext } from './repairPatchValidator.js';
import { RootCauseEngine } from './rootCauseEngine.js';
import { runStaticChecks } from './staticChecks.js';

const DEFAULT_ATTEMPTS = 3;
const REPAIR_ACTOR = 'debugging_specialist';
const ROLLBACK_ACTOR = 'repair_rollback';
const WORKING: RepairStatus[] = ['collecting', 'analyzing', 'investigating', 'proposing', 'validating', 'applying', 'verifying'];
const WAITING: RepairStatus[] = ['awaiting_approval', 'awaiting_test_approval'];
const BUSY_BUILD_STATES = ['planning', 'running', 'verifying'];
const BUSY_RUN_STATES = ['planning', 'generating', 'integrating', 'validating', 'repairing', 'finalizing'];
const RUN_STALE_MS = 60 * 60 * 1000;
const PROCESS_END_WAIT_MS = 5000;
const UNUSED_APPROVAL = 'Closed automatically: the approved change was not applied';
/** Another server process keeps a live run fresher than this. */
const HEARTBEAT_STALE_MS = 30000;
const MAX_REPAIR_CHAIN = 5;
const SERVER_SCRIPTS = ['dev', 'start', 'preview'];
const SERVER_START_WAIT_MS = 20000;
const MAX_START_CRASH_MS = 15000;
const FRESH_SESSION_MS = 10 * 60 * 1000;

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
  /** Carry on with the next root cause each time one is verified. */
  repairAll?: boolean;
  chainDepth?: number;
  /** A running session to call, so failing routes become diagnostics. */
  probeSessionId?: string;
}

export interface RepairCoordinatorOptions {
  heartbeatMs?: number;
  /** How long a restarted server must stay up to count as surviving. */
  settleMs?: number;
}

/** Whole-line swaps that undo edits, newest first. Lines are what a later edit can leave intact. */
function undoEditsFor(before: string, edits: Array<{ find: string; replace: string }>) {
  const undo: Array<{ find: string; replace: string }> = [];
  let content = before;
  for (const edit of edits) {
    const index = content.indexOf(edit.find);
    if (index < 0) return undefined;
    const start = content.lastIndexOf('\n', index) + 1;
    const newline = content.indexOf('\n', index + edit.find.length);
    const end = newline < 0 ? content.length : newline;
    const block = content.slice(start, end);
    const changed = block.replace(edit.find, () => edit.replace);
    if (!changed) return undefined;
    undo.unshift({ find: changed, replace: block });
    content = content.slice(0, start) + changed + content.slice(end);
  }
  return undo;
}

/**
 * Checks an undo against later content. Each block must be there exactly once, as whole lines.
 * Matching inside a longer line would turn a user's "retries = 30" into "retries = 10".
 */
function undoesWholeLines(content: string, undo: Array<{ find: string; replace: string }>): boolean {
  let current = content;
  for (const edit of undo) {
    const index = current.indexOf(edit.find);
    if (index < 0 || current.indexOf(edit.find, index + 1) >= 0) return false;

    const end = index + edit.find.length;
    const startsLine = index === 0 || current[index - 1] === '\n';
    const endsLine = end === current.length || current[end] === '\n' || current[end] === '\r';
    if (!startsLine || !endsLine) return false;
    current = current.slice(0, index) + edit.replace + current.slice(end);
  }
  return true;
}

function apiPath(message: string): string | undefined {
  // A path with a query is a different request from the bare path, so it cannot be proven by one
  return message.match(/\bGET\s+(\/[\w./~-]*)(?=\s|$)/)?.[1];
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

  private readonly heartbeatMs: number;
  private readonly settleMs: number;

  constructor(private readonly execution: ExecutionSessionManager, options: RepairCoordinatorOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.settleMs = options.settleMs ?? 3000;
  }

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

    // Shows other server processes this run is alive, and hears a cancel made in one of them
    const heartbeat = setInterval(() => {
      db.touchRepairRun(run.id);
      const stored = db.getRepairRun(run.id);
      if (stored?.status !== 'cancelled' || abort.signal.aborted) return;
      abort.abort(new Error('Repair cancelled'));
      const build = db.getBuild(run.buildId);
      if (build && stored.activeSessionId) void this.execution.stop(build, stored.activeSessionId).catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref();

    // The caller gets its answer before any work starts
    const done = new Promise(resolve => setImmediate(resolve))
      .then(() => stage(abort.signal))
      .catch(err => {
        if (err instanceof RepairCancelled || abort.signal.aborted) return;
        console.error(`Repair ${run.id} failed:`, err.message);
        const applied = run.fileChanges.length > 0 && !run.rollback;
        if (applied) {
          this.finish(run, 'applied_unverified', `The patch is applied, but checking it failed: ${err.message}`);
        } else {
          this.finish(run, 'failed', err.message || 'The repair failed');
        }
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(run.id);
      });
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
        // Another server process may own this run
        if (Date.now() - db.getRepairHeartbeat(run.id) < HEARTBEAT_STALE_MS) continue;
        const message = 'The server restarted during this repair.';
        if (run.fileChanges.length > 0) this.finish(run, 'applied_unverified', `${message} The patch is applied and was not fully checked.`);
        else this.finish(run, 'failed', message);
        continue;
      }

      if (run.rollback?.state === 'pending_approval' && !WAITING.includes(run.status)) {
        if (Date.now() - db.getRepairHeartbeat(run.id) < HEARTBEAT_STALE_MS && !run.pendingApproval) continue;
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
      repairAll: options.repairAll,
      chainDepth: options.chainDepth ?? 0,
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
    const probes = options.probeSessionId ? await this.probe(build, options.probeSessionId) : [];
    this.checkpoint(run, signal);
    const report = await DiagnosticCollector.collect(build.id, options.reports, { signal, probes });
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
      const validation = await RepairPatchValidator.validate(context, proposal.actions, signal);
      this.checkpoint(run, signal);
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
        afterHash: computeContentHash(content),
        undoEdits: previous && action.action === 'patch_file' ? undoEditsFor(previous.content, action.edits) : undefined
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

    const after = await runStaticChecks(build.id, files, DiagnosticCollector.contractsFor(build.id), signal);
    this.checkpoint(run, signal);
    const skippedBefore = new Set(run.report!.checks.filter(check => check.status === 'skipped').map(check => check.name));
    const { actions } = RepairPatchValidator.normalize(run.attempts[run.attempts.length - 1]?.actions || []);
    const { comparable, revealed } = RepairPatchValidator.splitRevealed(
      cause,
      run.report!.diagnostics,
      after.diagnostics.filter(item => !skippedBefore.has(item.kind)),
      actions,
      files
    );
    const comparison = RepairPatchValidator.compare(cause, run.report!.diagnostics, comparable);

    // These are not this patch's fault, but they do mean the project is not known to be good
    const unmaskedDiagnostics = [
      ...[...revealed, ...after.diagnostics.filter(item => skippedBefore.has(item.kind))]
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

    if (tests.status !== 'failed') {
      const paused = await this.proveRuntime(run, build, user, files, signal);
      if (paused) return;
    }
    await this.conclude(run, cause, tests);
  }

  /** How long the failed process lived, if it died by itself soon enough to be a crash at start. */
  private crashLifetime(item: DebugDiagnostic): number | undefined {
    const session = item.sessionId ? db.getExecutionSession(item.sessionId) : undefined;
    if (!session?.startedAt || !session.stoppedAt || session.endReason !== 'failed') return undefined;
    // The sandbox has no way in except the relay, so with no relay no request caused this
    if (db.sessionWasReached(session.id)) return undefined;
    const lifetime = session.stoppedAt - session.startedAt;
    return lifetime <= MAX_START_CRASH_MS ? lifetime : undefined;
  }

  private runtimeTargets(run: RepairRun): DebugDiagnostic[] {
    return run.verification!.needsRuntimeProof
      .map(print => run.report!.diagnostics.find(item => item.fingerprint === print))
      .filter((item): item is DebugDiagnostic => Boolean(item) && item!.kind !== 'test');
  }

  /**
   * Runs what failed again, so a runtime fix is judged by the real thing. A server is given time
   * to crash, and its GET routes are called. Other request methods could change data, so they
   * are never called, and a problem only they can show stays unproven.
   */
  private async proveRuntime(run: RepairRun, build: Build, user: User, files: ProjectFile[], signal: AbortSignal): Promise<boolean> {
    const targets = this.runtimeTargets(run);
    if (targets.length === 0) return false;

    const plan = planDependencies(files);
    const script = targets.map(item => item.script).find(name => name && typeof plan.scripts[name] === 'string')
      || ['start', 'dev'].find(name => typeof plan.scripts[name] === 'string');
    const capabilities = await this.execution.capabilities();
    if (!script || !plan.supported || !capabilities.available) return false;

    let sessionId: string | undefined;
    try {
      const prepared = await this.prepareSession(run, build, user, files, signal);
      if (isApprovalRequired(prepared)) {
        this.update(run, {
          status: 'awaiting_test_approval',
          pendingApproval: { requestId: prepared.approvalRequired.id, purpose: 'tests' },
          outcome: 'The patch is applied. Waiting for the owner to approve running the project in the sandbox.'
        });
        return true;
      }

      sessionId = prepared.id;
      this.checkpoint(run, signal);
      const started = await this.execution.startScript(build, prepared.id, script);
      const runtime = SERVER_SCRIPTS.includes(script)
        ? await this.observeServer(run, build, started, targets, files, signal)
        : await this.observeExit(started, targets, files);
      this.update(run, { verification: { ...run.verification!, runtime } });
    } catch (err: any) {
      if (err instanceof RepairCancelled) throw err;
      this.checkpoint(run, signal);
      console.error(`Repair ${run.id} could not run the project:`, err.message);
    } finally {
      if (sessionId) await this.releaseSession(run, build, sessionId);
    }
    return false;
  }

  private reproduced(session: ExecutionSession, targets: DebugDiagnostic[], files: ProjectFile[]): string[] {
    const output = DiagnosticCollector.parseOutput(session, files).map(item => item.fingerprint);
    return targets.filter(item => output.includes(item.fingerprint)).map(item => item.fingerprint);
  }

  private async observeExit(started: ExecutionSession, targets: DebugDiagnostic[], files: ProjectFile[]): Promise<RepairRuntimeEvidence> {
    const finished = await this.waitForEnd(started.id);
    const survived = finished.endReason === 'exited' && finished.exitCode === 0;
    return {
      script: finished.script!,
      sessionId: finished.id,
      survived,
      listening: false,
      uptimeMs: 0,
      reproduced: this.reproduced(finished, targets, files),
      probes: [],
      detail: `The ${finished.script} script ended with ${finished.endReason} (exit code ${finished.exitCode}).`
    };
  }

  private async observeServer(
    run: RepairRun,
    build: Build,
    started: ExecutionSession,
    targets: DebugDiagnostic[],
    files: ProjectFile[],
    signal: AbortSignal
  ): Promise<RepairRuntimeEvidence> {
    const stillRunning = () => !db.getExecutionSession(started.id)?.endReason;

    const deadline = Date.now() + SERVER_START_WAIT_MS;
    let listening = false;
    while (!listening && stillRunning() && Date.now() < deadline) {
      this.checkpoint(run, signal);
      listening = (await this.execution.backend.listeningPorts(started.processId!).catch(() => [] as number[])).length > 0;
      if (!listening) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const startedAt = Date.now();
    const lifetimes = targets.map(item => this.crashLifetime(item) ?? 0);
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, Math.max(this.settleMs, ...lifetimes.map(lifetime => lifetime * 2)));
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    this.checkpoint(run, signal);

    const wanted = [...targets.map(item => apiPath(item.message)).filter((path): path is string => Boolean(path)), ...detectGetRoutes(files).map(route => route.path)];
    const probes = listening && stillRunning()
      ? await this.execution.probeHttp(build, started.id, Array.from(new Set(wanted))).catch(() => [])
      : [];

    const survived = stillRunning();
    const uptimeMs = Date.now() - startedAt;
    if (survived) await this.execution.stop(build, started.id);
    const finished = db.getExecutionSession(started.id)!;

    // A timeout says nothing either way, so only a real server error counts as still failing
    const failingPaths = probes.filter(probe => probe.status !== undefined && probe.status >= 500).map(probe => probe.path);
    const stillFailing = targets.filter(item => {
      const path = apiPath(item.message);
      return path !== undefined && failingPaths.includes(path);
    }).map(item => item.fingerprint);

    return {
      script: started.script!,
      sessionId: started.id,
      survived,
      listening,
      uptimeMs,
      reproduced: Array.from(new Set([...this.reproduced(finished, targets, files), ...stillFailing])),
      probes,
      detail: survived
        ? `The ${started.script} script stayed up${listening ? ' and listened on a port' : ', but never listened on a port'}. ${probes.length} route(s) called, ${failingPaths.length} failed.`
        : `The ${started.script} script ended with ${finished.endReason} (exit code ${finished.exitCode}).`
    };
  }

  private async conclude(run: RepairRun, cause: RootCause, tests: RepairTestEvidence): Promise<void> {
    if (run.appliedWorkspaceHash !== projectStateHash(db.getAllFiles(run.buildId))) {
      this.finish(run, 'applied_unverified', 'The project changed while this repair was being checked, so its result cannot be judged alone. The patch stays applied.');
      this.recordMemoryAttempt(run, false, 'The project changed during verification');
      return;
    }

    if (tests.status === 'failed') {
      if (this.failuresAlreadyExisted(run, cause, tests)) {
        const reason = 'The tests that failed are the ones that already failed before this repair, so it did not break them, and it cannot be verified while they fail.';
        this.finish(run, 'applied_unverified', `The patch is applied and passed static checks, but it is not verified. ${reason}`);
        this.recordMemoryAttempt(run, false, reason);
        return;
      }
      await this.failAndRollBack(run, `Tests failed after the patch: ${tests.detail}`);
      return;
    }

    const runtime = run.verification!.runtime;
    if (runtime && runtime.reproduced.length > 0) {
      await this.failAndRollBack(run, `The same problem happened again when ${runtime.script} ran after the patch. ${runtime.detail}`);
      return;
    }

    const unproven = this.unprovenTargets(run, tests);
    const unmasked = run.verification!.unmaskedDiagnostics;
    if (tests.status === 'not_run' || unproven.length > 0 || unmasked.length > 0) {
      const reason = tests.status === 'not_run'
        ? tests.detail
        : unmasked.length > 0
          ? `Checks that could not run before now report: ${unmasked[0]}`
          : `This problem came from a run or a report, and nothing shows it is gone. ${runtime?.detail || 'Run what failed again, then check this repair again.'}`;
      this.finish(run, 'applied_unverified', `The patch is applied and passed static checks, but it is not verified. ${reason}`);
      this.recordMemoryAttempt(run, false, `Applied but unverified: ${reason}`);
      return;
    }

    this.finish(run, 'verified', `Verified: the target is gone, nothing new is wrong, and ${tests.detail}`, 'repair_verified');
    this.recordVerified(run, cause, tests);
    this.continueRepairAll(run);
  }

  /** Failures can be compared only with a run of the earlier version, and only by name. */
  private failuresAlreadyExisted(run: RepairRun, cause: RootCause, tests: RepairTestEvidence): boolean {
    const session = tests.sessionId ? db.getExecutionSession(tests.sessionId) : undefined;
    if (session?.endReason !== 'failed') return false;

    // "FAIL src/a.test.ts" names a file, so a new failure in it would look like an old one
    const failures = DiagnosticCollector.testFailures(session, db.getAllFiles(run.buildId))
      .filter(item => item.message !== `Test failed: ${item.filePath}` && !/failed to run/i.test(item.message));
    const before = new Set(run.report!.diagnostics.filter(item => item.kind === 'test').map(item => item.fingerprint));
    return failures.length > 0 &&
      failures.every(item => before.has(item.fingerprint) && !cause.fingerprints.includes(item.fingerprint));
  }

  private continueRepairAll(run: RepairRun): void {
    const depth = (run.chainDepth ?? 0) + 1;
    if (!run.repairAll || depth >= MAX_REPAIR_CHAIN) return;

    setImmediate(() => {
      const build = db.getBuild(run.buildId);
      const user = db.getUser(run.userId);
      if (!build || !user) return;
      try {
        this.start(build, user, { repairAll: true, chainDepth: depth, modelId: run.modelId, maxAttempts: run.maxAttempts });
      } catch (err: any) {
        console.error('The next repair could not start:', err.message);
      }
    });
  }

  /**
   * A problem seen at runtime is gone only if the thing that failed now succeeds on this exact
   * workspace. Any other passing test says nothing about it, and a report can never be re-run.
   */
  private unprovenTargets(run: RepairRun, tests: RepairTestEvidence): string[] {
    const hash = hashWorkspace(db.getAllFiles(run.buildId));
    const sessions = db.getExecutionSessions(run.buildId, 20);
    const routes = detectGetRoutes(db.getAllFiles(run.buildId)).map(route => route.path);

    return run.verification!.needsRuntimeProof.filter(fingerprint => {
      const item = run.report!.diagnostics.find(diagnostic => diagnostic.fingerprint === fingerprint);
      if (!item) return true;

      // A real call to the route that failed is proof, whoever reported it
      const runtime = run.verification!.runtime;
      const path = item.kind === 'api' ? apiPath(item.message) : undefined;
      const probe = path ? runtime?.probes.find(result => result.path === path) : undefined;
      // 401 and 404 show nothing, and a dev server answers 200 for routes that no longer exist.
      // A 200 also proves a fix only if this same call failed before, so a report never qualifies:
      // it may have needed a login or some data that the sandbox does not have.
      const answered = probe?.status !== undefined && probe.status >= 200 && probe.status < 300;
      if (item.code === 'HTTP_PROBE' && answered && routes.includes(path!)) return false;

      if (item.source === 'reported') return true;

      if (item.kind === 'test') {
        const covered = tests.scope === 'full' || (item.filePath !== undefined && tests.affectedTests.includes(item.filePath));
        return !(tests.status === 'passed' && covered);
      }

      // Staying up proves something only if the original crash came quickly on its own, and the
      // server has now outlived it. A crash from a request would need that request to prove.
      const lifetime = this.crashLifetime(item);
      const outlived = lifetime !== undefined && (runtime?.uptimeMs ?? 0) >= lifetime * 2;
      if (runtime?.survived && runtime.listening && runtime.script === item.script && !path && outlived && !runtime.reproduced.includes(fingerprint)) {
        return false;
      }

      // A server that exits has not shown it works. A clean exit proves only a script meant to end
      if (item.script && SERVER_SCRIPTS.includes(item.script)) return true;

      const rerun = item.script ? sessions.find(session => session.script === item.script && session.endReason) : undefined;
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
      const prepared = await this.prepareSession(run, build, user, files, signal);
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
        activeSessionId: started.id,
        verification: { ...run.verification!, tests: { ...this.notRun(affected, 'Tests are running.'), sessionId: started.id, scope } }
      });

      const finished = await this.waitForEnd(started.id);
      this.checkpoint(run, signal);
      const evidence = this.evidenceFrom(finished, scope, affected);
      await this.releaseSession(run, build, finished.id);
      return evidence;
    } catch (err: any) {
      if (err instanceof RepairCancelled) throw err;
      this.checkpoint(run, signal);
      return this.notRun(affected, `Tests could not run: ${err.message}`);
    }
  }

  /** Tests need a session of their own with dependencies in place. */
  private async prepareSession(run: RepairRun, build: Build, user: User, files: ProjectFile[], signal: AbortSignal) {
    const hash = hashWorkspace(files);
    const existing = db.getLiveExecutionSessions().find(item => item.buildId === build.id && item.workspaceHash === hash)?.id;
    const remember = (activeSessionId: string, activeSessionOwned: boolean) => this.update(run, { activeSessionId, activeSessionOwned });

    let session = await this.execution.createSession(build, user);
    if (isApprovalRequired(session)) return session;
    remember(session.id, session.id !== existing);

    // An approved workspace can already have a used session, which cannot give trusted results
    if (session.script) {
      if (session.status !== 'ready') throw new RepairError('This workspace is busy running another script.', 409);
      await this.execution.destroySession(build.id, session.id);
      session = await this.execution.createSession(build, user);
      if (isApprovalRequired(session)) return session;
      remember(session.id, true);
    }

    this.checkpoint(run, signal);
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

  /** Removes a session this run created. One the owner already had stays theirs. */
  private async releaseSession(run: RepairRun, build: Build, sessionId: string): Promise<void> {
    if (!run.activeSessionOwned) return;
    await this.execution.destroySession(build.id, sessionId).catch(err => console.error('Session cleanup failed:', err.message));
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
  private rollbackPlan(run: RepairRun): { actions: any[]; conflicts: string[]; kept: string[] } {
    const actions: any[] = [];
    const conflicts: string[] = [];
    const kept: string[] = [];

    for (const change of run.fileChanges) {
      const file = db.getFile(run.buildId, change.path);
      const hash = file && (file.contentHash || computeContentHash(file.content));
      const commitMessage = `Roll back repair ${run.id}`;

      if (!file || file.version !== change.afterVersion || hash !== change.afterHash) {
        // Later edits to other lines stay. Anything touching the repaired lines needs a person
        const undo = { action: 'patch_file' as const, path: change.path, edits: change.undoEdits };
        if (!file || !change.undoEdits || !undoesWholeLines(file.content, change.undoEdits)) {
          conflicts.push(`${change.path} changed after the repair, including the repaired lines`);
          continue;
        }
        kept.push(change.path);
        actions.push({ ...undo, expectedVersion: file.version, expectedContentHash: hash, commitMessage });
        continue;
      }

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
    return { actions, conflicts, kept };
  }

  private async performRollback(run: RepairRun, reason: string, automatic: boolean, approved?: any[]): Promise<RepairRun> {
    const at = Date.now();
    const plan = approved ? { actions: approved, conflicts: [], kept: run.rollback?.keptLaterEdits || [] } : this.rollbackPlan(run);

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
        rollback: { state: 'pending_approval', reason, conflicts: [], automatic, keptLaterEdits: plan.kept, at },
        pendingApproval: { requestId: request.request.id, purpose: 'rollback' }
      });
      return run;
    }

    const result = await MergeManager.applyBatchActions(run.buildId, ROLLBACK_ACTOR, plan.actions);
    if (!result.success) {
      this.update(run, { rollback: { state: 'conflict', reason, conflicts: [result.error || 'The rollback could not be applied'], automatic, at } });
      return run;
    }

    this.update(run, { rollback: { state: 'done', reason, conflicts: [], automatic, keptLaterEdits: plan.kept, at } });
    ProjectMemoryService.retractRepairLessons(run.buildId, run.userId, run.id);
    if (run.defectId) {
      CollaborativeDebuggingEngine.updateStatus(run.buildId, run.userId, { defectId: run.defectId, status: 'reopened' });
    }
    const keptNote = plan.kept.length ? ` Later edits to ${plan.kept.join(', ')} were kept.` : '';
    this.finish(run, 'rolled_back', `Rolled back: ${reason}${keptNote}`, 'repair_rolled_back');
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
    this.reconcile(build.id);
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
          if (run.fileChanges.length === 0) ApprovalGateService.revokeApproval(build.id, user.id, request.id, UNUSED_APPROVAL);
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
      try {
        await this.performRollback(run, run.rollback?.reason || 'Approved by the owner', Boolean(run.rollback?.automatic), this.approvedRollback(run, request));
      } finally {
        if (run.rollback?.state !== 'done') ApprovalGateService.revokeApproval(build.id, user.id, request.id, UNUSED_APPROVAL);
      }
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
    const report = hashWorkspace(files) === run.workspaceHash ? run.report! : await DiagnosticCollector.collect(build.id, [], { signal });
    this.update(run, { report, workspaceHash: report.workspaceHash });
    const validation = await RepairPatchValidator.validate(this.validationContext(run, cause, files, []), request.proposedActions || [], signal);

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
    const sessionId = run.activeSessionId || run.verification?.tests.sessionId;
    if (sessionId) await this.execution.stop(build, sessionId).catch(() => undefined);
    await active?.done;
    if (sessionId) await this.releaseSession(db.getRepairRun(run.id)!, build, sessionId);
    return db.getRepairRun(run.id)!;
  }

  /** Checks an applied patch again, for example after the owner ran the tests. */
  verifyAgain(build: Build, user: User, repairId: string): RepairRun {
    this.reconcile(build.id);
    const run = this.requireRun(build, repairId);
    const busy = this.active.has(run.id) || this.rollingBack.has(run.id) || run.rollback?.state === 'pending_approval';
    if (run.status !== 'applied_unverified' || busy) {
      throw new RepairError('Only an unverified repair that is not being checked can be checked again.', 409);
    }
    if (this.rollbackPlan(run).conflicts.length > 0) {
      throw new RepairError('The repaired files changed afterwards, so this repair can no longer be verified alone.', 409);
    }
    this.track(run, signal => this.verify(run, build, user, signal));
    return run;
  }

  /** Calls a running project's GET routes. Failures come back as diagnostics. */
  async probe(build: Build, sessionId: string): Promise<DebugDiagnostic[]> {
    const session = db.getExecutionSession(sessionId);
    if (!session || session.buildId !== build.id) throw new RepairError('Execution session not found', 404);

    const files = snapshotFiles(build.id);
    if (session.workspaceHash !== hashWorkspace(files)) {
      throw new RepairError('That session runs an older version of the project.', 409);
    }
    const routes = detectGetRoutes(files);
    // Requests and time build up state that a fresh start would not have
    const fresh = !db.sessionHadPreview(session.id) && Date.now() - (session.startedAt ?? 0) <= FRESH_SESSION_MS;
    const results = await this.execution.probeHttp(build, session.id, routes.map(route => route.path));
    return DiagnosticCollector.fromProbes(results, session, routes, fresh);
  }

  /** Off unless REPAIR_AUTO_START=true, because each repair spends model tokens. */
  startAfterFailedGeneration(build: Build, user: User): RepairRun | null {
    if (process.env.REPAIR_AUTO_START !== 'true') return null;
    try {
      return this.start(build, user, { repairAll: true });
    } catch (err: any) {
      console.error('Automatic repair did not start:', err.message);
      return null;
    }
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
