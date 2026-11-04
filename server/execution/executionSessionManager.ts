import crypto from 'node:crypto';
import { db } from '../store.js';
import {
  Build,
  DependencyInstallRecord,
  ProjectFile,
  ExecutionEndReason,
  ExecutionSession,
  HumanApprovalRequest,
  User
} from '../types.js';
import { ApprovalGateService } from '../swarm/approvalGateService.js';
import { MergeManager } from '../swarm/mergeManager.js';
import { ProjectMemoryService } from '../swarm/projectMemory.js';
import {
  RUNNABLE_SCRIPTS,
  buildInstallCommand,
  detectMissingModules,
  planDependencies
} from './dependencyService.js';
import { BackendCapabilities, ExecutionBackend, ProcessHandle, SandboxLimits } from './executionBackend.js';
import { hashWorkspace, materializeWorkspace } from './workspaceMaterializer.js';

export class ExecutionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface ExecutionConfig {
  limits: SandboxLimits;
  maxConcurrent: number;
  maxPerUser: number;
  allowGuests: boolean;
  registryUrl: string;
  idleTimeoutMs: number;
  maxLogBytes: number;
}

export function executionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutionConfig {
  const number = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    limits: {
      memoryMb: number(env.EXECUTION_MEMORY_MB, 1024),
      cpus: number(env.EXECUTION_CPUS, 1),
      pids: number(env.EXECUTION_PIDS, 256),
      maxRuntimeSeconds: number(env.EXECUTION_MAX_RUNTIME_SECONDS, 1800),
      tmpfsMb: 256,
      workspaceMb: number(env.EXECUTION_WORKSPACE_MB, 1024)
    },
    maxConcurrent: number(env.EXECUTION_MAX_CONCURRENT, 4),
    maxPerUser: number(env.EXECUTION_MAX_PER_USER, 2),
    allowGuests: env.EXECUTION_ALLOW_GUESTS
      ? env.EXECUTION_ALLOW_GUESTS === 'true'
      : env.NODE_ENV !== 'production',
    registryUrl: env.NPM_REGISTRY_URL || 'https://registry.npmjs.org/',
    idleTimeoutMs: number(env.EXECUTION_IDLE_MINUTES, 30) * 60 * 1000,
    maxLogBytes: 2 * 1024 * 1024
  };
}

export type ApprovalOutcome = { approvalRequired: HumanApprovalRequest };

interface ActiveProcess {
  handle: ProcessHandle;
  timer: NodeJS.Timeout;
  stopReason?: ExecutionEndReason;
  finished: Promise<void>;
}

const LIVE_PROCESS_STATES = new Set(['creating', 'installing', 'starting', 'running', 'stopping']);
/** Execution approvals last 24 hours, so a session cannot outlive that window by much. */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_SEQUENCES = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

export class ExecutionSessionManager {
  private readonly processes = new Map<string, ActiveProcess>();
  private readonly logBytes = new Map<string, number>();
  private readonly recentOutput = new Map<string, string>();
  private readonly creating = new Set<string>();
  private readonly pendingStops = new Set<string>();

  constructor(readonly backend: ExecutionBackend, readonly config: ExecutionConfig) {}

  capabilities(): Promise<BackendCapabilities> {
    return this.backend.capabilities();
  }

  private log(session: ExecutionSession, stream: 'stdout' | 'stderr' | 'system', raw: string): void {
    const text = raw.replace(TERMINAL_CONTROL_SEQUENCES, '');
    if (!text) return;

    const used = this.logBytes.get(session.id) || 0;
    if (used >= this.config.maxLogBytes) return;

    const next = used + Buffer.byteLength(text);
    this.logBytes.set(session.id, next);
    db.appendExecutionLog(session.buildId, { sessionId: session.id, stream, text, createdAt: Date.now() });

    if (next >= this.config.maxLogBytes) {
      db.appendExecutionLog(session.buildId, {
        sessionId: session.id,
        stream: 'system',
        text: 'Log limit reached. Later output is not stored.\n',
        createdAt: Date.now()
      });
    }
  }

  private requireSession(buildId: string, sessionId: string): ExecutionSession {
    const session = db.getExecutionSession(sessionId);
    if (!session || session.buildId !== buildId) {
      throw new ExecutionError('Execution session not found', 404);
    }
    return session;
  }

  private requireIdleEnvironment(session: ExecutionSession): void {
    if (LIVE_PROCESS_STATES.has(session.status)) {
      throw new ExecutionError(`Session is busy (${session.status})`, 409);
    }
    if (session.status !== 'ready') {
      throw new ExecutionError(`Session is ${session.status}`, 409);
    }
  }

  /** Execution approvals cover one exact workspace, so a changed project asks again. */
  private approvalFor(
    build: Build,
    operationType: 'code_execution' | 'dependency_install' | 'install_scripts',
    hash: string,
    explanation: string
  ): ApprovalOutcome | null {
    if (ApprovalGateService.hasApprovedScope(build.id, operationType, hash)) return null;

    const pending = ApprovalGateService.findPendingScope(build.id, operationType, hash);
    if (pending) return { approvalRequired: pending };

    const created = ApprovalGateService.requestApproval(build.id, build.userId, {
      requestingAgent: 'execution_environment',
      requestingRole: 'devops_release_specialist',
      operationType,
      explanation,
      riskLevel: 'high',
      affectedFiles: [],
      proposedChanges: `Workspace ${hash.slice(0, 12)}`,
      scopeHash: hash
    });
    if (!created.request) throw new ExecutionError(created.error || 'Approval could not be requested', 403);
    return { approvalRequired: created.request };
  }

  async createSession(build: Build, user: User): Promise<ExecutionSession | ApprovalOutcome> {
    const capabilities = await this.backend.capabilities();
    if (!capabilities.available) {
      throw new ExecutionError(capabilities.reason || 'Project execution is unavailable', 503);
    }
    // isAnonymous is not stored, so restored guests are recognized by their id
    if ((user.isAnonymous || user.id.startsWith('guest_')) && !this.config.allowGuests) {
      throw new ExecutionError('Guest sessions cannot run projects on this server.', 403);
    }

    if (this.creating.has(build.id)) {
      throw new ExecutionError('An environment is already being created for this project.', 409);
    }
    this.creating.add(build.id);
    try {
      return await this.createSessionExclusive(build, user, capabilities.backend);
    } finally {
      this.creating.delete(build.id);
    }
  }

  private async createSessionExclusive(
    build: Build,
    user: User,
    backendName: string
  ): Promise<ExecutionSession | ApprovalOutcome> {
    const live = db.getLiveExecutionSessions();
    const existing = live.find(session => session.buildId === build.id);
    const files = db.getAllFiles(build.id);
    if (files.length === 0) throw new ExecutionError('This project has no files to run.', 409);
    const hash = hashWorkspace(files);

    if (existing?.workspaceHash === hash) return existing;

    const approval = this.approvalFor(build, 'code_execution', hash, 'Run this project in an isolated sandbox.');
    if (approval) return approval;

    // Checked before removing anything, so a refusal leaves the current session running
    const others = live.filter(session => session.id !== existing?.id);
    if (others.length >= this.config.maxConcurrent) {
      throw new ExecutionError('The execution environment is at capacity. Try again later.', 429);
    }
    if (others.filter(session => session.userId === user.id).length >= this.config.maxPerUser) {
      throw new ExecutionError('You have reached your limit of running projects.', 429);
    }

    if (existing) await this.destroySession(build.id, existing.id);

    const now = Date.now();
    const session: ExecutionSession = {
      id: `exe${crypto.randomBytes(8).toString('hex')}`,
      buildId: build.id,
      userId: user.id,
      status: 'creating',
      backend: backendName,
      workspaceHash: hash,
      dependencyStatus: 'not_started',
      missingDependencies: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now
    };
    db.saveExecutionSession(session);

    try {
      const workspace = await materializeWorkspace(files);
      await this.backend.createEnvironment({ sessionId: session.id, buildId: build.id, userId: user.id });
      await this.backend.uploadWorkspace(session.id, workspace.archive);
      session.status = 'ready';
      db.saveExecutionSession(session);
      this.log(session, 'system', `Environment ready with ${workspace.fileCount} files.\n`);
      return session;
    } catch (err: any) {
      session.status = 'failed';
      session.failureReason = err.message || 'Environment creation failed';
      db.saveExecutionSession(session);
      await this.backend.destroyEnvironment(session.id).catch(() => undefined);
      throw new ExecutionError(session.failureReason!, 500);
    }
  }

  async installDependencies(
    build: Build,
    sessionId: string,
    options: { allowScripts?: boolean } = {}
  ): Promise<ExecutionSession | ApprovalOutcome> {
    const session = this.requireSession(build.id, sessionId);
    this.requireIdleEnvironment(session);
    if (session.script) {
      throw new ExecutionError('Project code has run here, so its files may have changed. Create a new session to install.', 409);
    }

    const files = db.getAllFiles(build.id);
    if (hashWorkspace(files) !== session.workspaceHash) {
      throw new ExecutionError('The project has changed. Create a new session to install.', 409);
    }
    const plan = planDependencies(files);

    if (!plan.supported) {
      session.dependencyStatus = 'unsupported';
      session.failureReason = plan.reason;
      db.saveExecutionSession(session);
      throw new ExecutionError(plan.reason || 'This project type is not supported', 422);
    }
    if (!plan.hasDependencies) {
      session.dependencyStatus = 'not_required';
      db.saveExecutionSession(session);
      return session;
    }

    if (!plan.hasLockfile) {
      const approval = this.approvalFor(
        build,
        'dependency_install',
        session.workspaceHash,
        'This project has no lockfile. Installing will choose dependency versions and create one.'
      );
      if (approval) return approval;
    }
    if (options.allowScripts) {
      const approval = this.approvalFor(
        build,
        'install_scripts',
        session.workspaceHash,
        'Allow package install scripts. They run third-party code during install, in the sandbox.'
      );
      if (approval) return approval;
    }

    const argv = buildInstallCommand(plan, {
      registryUrl: this.config.registryUrl,
      allowScripts: Boolean(options.allowScripts)
    });
    const record: DependencyInstallRecord = {
      id: `dep${crypto.randomBytes(8).toString('hex')}`,
      sessionId: session.id,
      buildId: build.id,
      packageManager: plan.packageManager || 'npm',
      command: argv.join(' '),
      status: 'installing',
      lockfileGenerated: false,
      startedAt: Date.now()
    };
    db.saveDependencyInstall(record);

    session.status = 'installing';
    session.dependencyStatus = 'installing';
    session.failureReason = undefined;
    db.saveExecutionSession(session);
    this.log(session, 'system', `$ ${record.command}\n`);

    await this.launch(session, argv, 'registry', true, async (latest, reason, exitCode) => {
      const succeeded = reason === 'exited';
      latest.dependencyStatus = succeeded ? 'installed' : 'failed';
      record.status = succeeded ? 'installed' : 'failed';
      record.finishedAt = Date.now();
      if (!succeeded) {
        record.error = `Install ended with ${reason} (exit code ${exitCode})`;
        latest.failureReason = plan.hasLockfile
          ? record.error
          : `${record.error}. Packages that need install scripts require approval.`;
      } else if (!plan.hasLockfile) {
        if (options.allowScripts) {
          this.log(latest, 'system', 'The lockfile was not saved, because install scripts could have changed it.\n');
        } else {
          record.lockfileGenerated = await this.proposeLockfile(latest, build, files);
        }
      }
      db.saveDependencyInstall(record);
    });
    return db.getExecutionSession(session.id)!;
  }

  /** Versions chosen by an install reach the project only as a recorded file change. */
  private async proposeLockfile(session: ExecutionSession, build: Build, uploaded: ProjectFile[]): Promise<boolean> {
    const content = await this.backend.readWorkspaceFile(session.id, 'package-lock.json');
    if (!content) return false;
    const lockfile = content.toString('utf-8');

    const result = await MergeManager.applyBatchActions(build.id, 'execution_environment', [{
      action: 'create_file',
      path: 'package-lock.json',
      content: lockfile,
      commitMessage: 'Add lockfile generated by the approved sandbox install'
    }]);
    if (!result.success) {
      this.log(session, 'system', `The generated lockfile was not saved: ${result.error}\n`);
      return false;
    }
    // Hash what is in the volume. If the project changed meanwhile, startScript will refuse it.
    session.workspaceHash = hashWorkspace([...uploaded, { path: 'package-lock.json', content: lockfile, version: 1 }]);
    return true;
  }

  async startScript(build: Build, sessionId: string, script: string): Promise<ExecutionSession> {
    const session = this.requireSession(build.id, sessionId);
    this.requireIdleEnvironment(session);

    if (Date.now() - session.createdAt > MAX_SESSION_AGE_MS) {
      throw new ExecutionError('This session has expired. Create a new one.', 409);
    }

    // Earlier code could change the test files, and a later run would replace the result
    if (session.script && (script === 'test' || session.script === 'test')) {
      throw new ExecutionError('Tests run in their own session, so their results can be trusted. Create a new session.', 409);
    }

    const files = db.getAllFiles(build.id);
    if (hashWorkspace(files) !== session.workspaceHash) {
      throw new ExecutionError('The project has changed. Create a new session to run the latest code.', 409);
    }

    const plan = planDependencies(files);
    if (!(RUNNABLE_SCRIPTS as readonly string[]).includes(script)) {
      throw new ExecutionError(`Script "${script}" is not allowed.`, 400);
    }
    const definition = plan.scripts[script];
    if (typeof definition !== 'string') {
      throw new ExecutionError(`package.json has no "${script}" script.`, 422);
    }
    if (plan.hasDependencies && session.dependencyStatus !== 'installed') {
      throw new ExecutionError('Install dependencies before running this script.', 409);
    }

    const argv = ['npm', 'run', script];
    if (/\bvite\b/.test(definition) && (script === 'dev' || script === 'preview')) {
      argv.push('--', '--host', '0.0.0.0');
    }

    session.status = 'starting';
    session.script = script;
    session.exitCode = undefined;
    session.endReason = undefined;
    session.failureReason = undefined;
    session.missingDependencies = [];
    session.startedAt = Date.now();
    session.stoppedAt = undefined;
    db.saveExecutionSession(session);
    this.log(session, 'system', `$ ${argv.join(' ')}\n`);

    await this.launch(session, argv, 'isolated', false, async (latest, reason) => {
      if (reason === 'exited' || reason === 'failed') {
        latest.missingDependencies = detectMissingModules(this.recentOutput.get(latest.id) || '');
      }
      this.recordOutcome(latest, reason);
    });
    return db.getExecutionSession(session.id)!;
  }

  private recordOutcome(session: ExecutionSession, reason: ExecutionEndReason): void {
    if (reason !== 'failed' && reason !== 'out_of_memory') return;
    ProjectMemoryService.recordFact(session.buildId, session.userId, {
      statement: `Sandbox run of "${session.script}" ended with ${reason} (exit code ${session.exitCode}).`,
      category: 'constraint',
      confidence: 'confirmed',
      source: 'verifier_agent'
    });
  }

  private async launch(
    session: ExecutionSession,
    argv: string[],
    network: 'isolated' | 'registry',
    mountDependencyCache: boolean,
    onFinished: (latest: ExecutionSession, reason: ExecutionEndReason, exitCode: number) => Promise<void>
  ): Promise<void> {
    const env = network === 'isolated' ? { HOST: '0.0.0.0', PORT: '3000' } : undefined;
    this.recentOutput.set(session.id, '');

    let handle: ProcessHandle;
    try {
      handle = await this.backend.startProcess(
        session.id,
        { argv, env, network, limits: this.config.limits, mountDependencyCache },
        (stream, text) => {
          const tail = (this.recentOutput.get(session.id) || '') + text;
          this.recentOutput.set(session.id, tail.slice(-16384));
          this.log(session, stream, text);
        }
      );
    } catch (err: any) {
      session.status = 'ready';
      session.endReason = 'failed';
      session.failureReason = err.message || 'The process could not start';
      session.stoppedAt = Date.now();
      await onFinished(session, 'failed', -1);
      db.saveExecutionSession(session);
      throw new ExecutionError(session.failureReason!, 500);
    }

    const timer = setTimeout(() => {
      void this.stopProcess(session.id, 'timed_out');
    }, this.config.limits.maxRuntimeSeconds * 1000);
    timer.unref?.();

    const active: ActiveProcess = { handle, timer, finished: Promise.resolve() };
    active.finished = handle.wait().then(async exit => {
      clearTimeout(timer);
      this.processes.delete(session.id);

      const latest = db.getExecutionSession(session.id);
      if (!latest || latest.status === 'destroyed') return;

      const reason: ExecutionEndReason = active.stopReason
        || (exit.oomKilled ? 'out_of_memory' : exit.exitCode === 0 ? 'exited' : 'failed');

      latest.status = 'ready';
      latest.processId = undefined;
      latest.exitCode = exit.exitCode;
      latest.endReason = reason;
      latest.stoppedAt = Date.now();
      latest.lastActivityAt = Date.now();
      await onFinished(latest, reason, exit.exitCode).catch(err => {
        latest.failureReason = err.message;
      });
      db.saveExecutionSession(latest);
      this.log(latest, 'system', `Process ended: ${reason} (exit code ${exit.exitCode}).\n`);
      await this.onProcessEnded?.(latest);
    });
    this.processes.set(session.id, active);

    const latest = db.getExecutionSession(session.id);
    if (latest && latest.status !== 'destroyed') {
      if (latest.status === 'starting') latest.status = 'running';
      latest.processId = handle.id;
      db.saveExecutionSession(latest);
    }

    if (this.pendingStops.delete(session.id)) await this.stopProcess(session.id, 'stopped');
  }

  /** Set by the preview service, so a preview never outlives its process. */
  onProcessEnded?: (session: ExecutionSession) => Promise<void>;

  private async stopProcess(sessionId: string, reason: ExecutionEndReason): Promise<void> {
    const active = this.processes.get(sessionId);
    if (!active) {
      // A stop can arrive while the process is still being created
      if (db.getExecutionSession(sessionId)?.status === 'starting') this.pendingStops.add(sessionId);
      return;
    }

    active.stopReason = active.stopReason || reason;
    clearTimeout(active.timer);

    const session = db.getExecutionSession(sessionId);
    if (session && session.status !== 'destroyed') {
      session.status = 'stopping';
      db.saveExecutionSession(session);
    }
    await active.handle.stop();
    await active.finished;
  }

  async stop(build: Build, sessionId: string): Promise<ExecutionSession> {
    this.requireSession(build.id, sessionId);
    await this.stopProcess(sessionId, 'stopped');
    return db.getExecutionSession(sessionId)!;
  }

  async restart(build: Build, sessionId: string): Promise<ExecutionSession> {
    const session = this.requireSession(build.id, sessionId);
    if (!session.script) throw new ExecutionError('This session has not run a script yet.', 409);
    await this.stopProcess(sessionId, 'stopped');
    return this.startScript(build, sessionId, session.script);
  }

  async destroySession(buildId: string, sessionId: string): Promise<ExecutionSession> {
    const session = this.requireSession(buildId, sessionId);
    await this.stopProcess(sessionId, 'stopped');

    const latest = db.getExecutionSession(sessionId)!;
    await this.onProcessEnded?.(latest);
    await this.backend.destroyEnvironment(sessionId);

    latest.status = 'destroyed';
    latest.processId = undefined;
    db.saveExecutionSession(latest);
    this.logBytes.delete(session.id);
    this.recentOutput.delete(session.id);
    return latest;
  }

  usage(build: Build, sessionId: string) {
    const session = this.requireSession(build.id, sessionId);
    return session.processId ? this.backend.usage(session.processId) : Promise.resolve(null);
  }

  /** Enforces disk limits and idle timeouts, and removes environments nothing owns. */
  async reap(now = Date.now()): Promise<void> {
    const live = db.getLiveExecutionSessions();

    for (const session of live) {
      const processId = this.processes.get(session.id)?.handle.id;
      if (processId) {
        const usage = await this.backend.usage(processId);
        if (usage && usage.workspaceBytes > this.config.limits.workspaceMb * 1024 * 1024) {
          this.log(session, 'system', 'Workspace disk limit exceeded.\n');
          await this.stopProcess(session.id, 'disk_limit');
        }
      }
      const idle = session.status === 'ready' && now - session.lastActivityAt > this.config.idleTimeoutMs;
      if (idle || now - session.createdAt > MAX_SESSION_AGE_MS) {
        await this.destroySession(session.buildId, session.id);
        await this.backend.removeDependencyCache(session.buildId);
      }
    }

    const owned = new Set(db.getLiveExecutionSessions().map(session => session.id));
    for (const environment of await this.backend.listEnvironments()) {
      if (!owned.has(environment.sessionId)) {
        await this.backend.destroyEnvironment(environment.sessionId);
      }
    }
  }

  /** Runs at startup. Processes from a previous server cannot be supervised, so they are ended. */
  async reconcile(): Promise<void> {
    for (const session of db.getLiveExecutionSessions()) {
      if (this.processes.has(session.id)) continue;
      await this.backend.destroyEnvironment(session.id).catch(() => undefined);
      session.status = 'failed';
      session.processId = undefined;
      session.failureReason = 'The server restarted while this session was active.';
      db.saveExecutionSession(session);
    }
    for (const preview of db.getActivePreviews()) {
      db.savePreviewSession({ ...preview, status: 'closed' });
    }
  }

  /** Test support: waits for the current process in a session to finish. */
  async waitForProcess(sessionId: string): Promise<void> {
    await this.processes.get(sessionId)?.finished;
  }
}
