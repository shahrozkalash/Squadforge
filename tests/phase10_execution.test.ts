// Uses a fake backend, so nothing here runs project code on the host.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { db } from '../server/store.js';
import { Build, ExecutionSession, ProjectFile, User } from '../server/types.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { DisabledBackend } from '../server/execution/disabledBackend.js';
import {
  buildInstallCommand,
  detectMissingModules,
  planDependencies
} from '../server/execution/dependencyService.js';
import {
  ExecutionBackend,
  OutputListener,
  ProcessExit,
  ProcessHandle,
  ProcessSpec,
  parseListeningPorts
} from '../server/execution/executionBackend.js';
import { hardenedHostConfig } from '../server/execution/dockerBackend.js';
import { createExecutionRouter } from '../server/execution/executionRoutes.js';
import {
  ExecutionConfig,
  ExecutionError,
  ExecutionSessionManager
} from '../server/execution/executionSessionManager.js';
import { createPreviewServer } from '../server/execution/previewProxy.js';
import { PreviewConfig, PreviewSessionService } from '../server/execution/previewSessionService.js';
import { hashWorkspace, materializeWorkspace } from '../server/execution/workspaceMaterializer.js';

class FakeProcess implements ProcessHandle {
  stopped = false;
  private finish!: (exit: ProcessExit) => void;
  private readonly exit = new Promise<ProcessExit>(resolve => { this.finish = resolve; });

  constructor(readonly id: string, readonly spec: ProcessSpec, readonly output: OutputListener) {}

  wait() { return this.exit; }
  end(exit: Partial<ProcessExit> = {}) { this.finish({ exitCode: 0, oomKilled: false, ...exit }); }

  async stop() {
    this.stopped = true;
    this.end({ exitCode: 143 });
  }
}

class FakeBackend implements ExecutionBackend {
  readonly name = 'fake';
  environments = new Set<string>();
  uploads = new Map<string, Buffer>();
  processes: FakeProcess[] = [];
  previews = new Set<string>();
  ports: number[] = [3000];
  workspaceBytes = 1;
  available = true;
  lockfile: string | null = null;
  relayPort = 0;
  failCreate = false;

  async capabilities() {
    return { available: this.available, backend: this.name, reason: this.available ? undefined : 'offline' };
  }
  async createEnvironment({ sessionId }: { sessionId: string }) {
    if (this.failCreate) throw new Error('worker failed');
    this.environments.add(sessionId);
  }
  async uploadWorkspace(sessionId: string, archive: Buffer) { this.uploads.set(sessionId, archive); }
  async readWorkspaceFile() { return this.lockfile === null ? null : Buffer.from(this.lockfile); }
  async startProcess(_sessionId: string, spec: ProcessSpec, output: OutputListener) {
    const process = new FakeProcess(`proc${this.processes.length}`, spec, output);
    this.processes.push(process);
    return process;
  }
  async listeningPorts() { return this.ports; }
  async usage() {
    return { memoryBytes: 1, memoryLimitBytes: 2, cpuPercent: 1, pids: 1, workspaceBytes: this.workspaceBytes };
  }
  async openPreview(sessionId: string) {
    this.previews.add(sessionId);
    return { host: '127.0.0.1', port: this.relayPort };
  }
  async closePreview(sessionId: string) { this.previews.delete(sessionId); }
  async destroyEnvironment(sessionId: string) { this.environments.delete(sessionId); }
  async removeDependencyCache() { return undefined; }
  async listEnvironments() {
    return Array.from(this.environments).map(sessionId => ({ sessionId, buildId: 'unknown' }));
  }

  last() { return this.processes[this.processes.length - 1]; }
}

const config: ExecutionConfig = {
  limits: { memoryMb: 256, cpus: 1, pids: 64, maxRuntimeSeconds: 60, tmpfsMb: 32, workspaceMb: 1 },
  maxConcurrent: 100,
  allowGuests: true,
  registryUrl: 'https://registry.npmjs.org/',
  idleTimeoutMs: 1000,
  maxLogBytes: 2 * 1024 * 1024
};

const previewConfig: PreviewConfig = {
  baseDomain: 'preview.localhost',
  scheme: 'http',
  publicPort: 3001,
  listenPort: 3001,
  appOrigin: 'http://localhost:3000',
  idleTimeoutMs: 1000,
  portWaitMs: 200,
  portPollMs: 10
};

const packageJson = JSON.stringify({
  name: 'fixture',
  scripts: { dev: 'vite', test: 'node --test', start: 'node server.js' },
  dependencies: { express: '5.0.0' }
});

let counter = 0;

function makeUser(id: string, isAnonymous = false): User {
  const user = {
    id,
    email: `${id}@p10.test`,
    name: id,
    githubConnected: false,
    costLimitPerBuild: 5,
    enabledModelIds: ['gemini'],
    createdAt: Date.now(),
    isAnonymous
  } as User;
  db.createUser(user);
  return user;
}

function makeBuild(owner: User, files: Record<string, string> = { 'package.json': packageJson, 'package-lock.json': '{}' }): Build {
  const id = `bld_p10_${Date.now()}_${++counter}`;
  const build = db.saveBuild({
    id,
    userId: owner.id,
    idea: 'Phase 10 fixture',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 5,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  });
  for (const [path, content] of Object.entries(files)) {
    db.setFile(id, { path, content, version: 1, ownerModel: 'system', history: [], createdAt: Date.now(), updatedAt: Date.now() });
  }
  return build;
}

function approve(build: Build, owner: User, request: { id: string }) {
  const result = ApprovalGateService.respondToApproval(build.id, owner.id, { requestId: request.id, approved: true });
  assert.equal(result.success, true, result.error);
}

async function approvedSession(manager: ExecutionSessionManager, build: Build, owner: User): Promise<ExecutionSession> {
  const first = await manager.createSession(build, owner);
  assert.ok('approvalRequired' in first, 'the first run of new code must need approval');
  approve(build, owner, first.approvalRequired);
  const session = await manager.createSession(build, owner);
  assert.ok('id' in session);
  return session;
}

async function installed(manager: ExecutionSessionManager, backend: FakeBackend, build: Build, owner: User) {
  const session = await approvedSession(manager, build, owner);
  await manager.installDependencies(build, session.id);
  backend.last().end();
  await manager.waitForProcess(session.id);
  return session;
}

describe('Phase 10 execution', () => {
  let backend: FakeBackend;
  let manager: ExecutionSessionManager;
  let owner: User;
  let other: User;

  beforeEach(() => {
    backend = new FakeBackend();
    manager = new ExecutionSessionManager(backend, config);
    owner = makeUser(`usr_p10_owner_${++counter}`);
    other = makeUser(`usr_p10_other_${++counter}`);
  });

  describe('backends', () => {
    test('the disabled backend reports unavailable and refuses to run anything', async () => {
      const disabled = new DisabledBackend();
      assert.equal((await disabled.capabilities()).available, false);
      await assert.rejects(disabled.startProcess());
      await assert.rejects(disabled.createEnvironment());
    });

    test('sessions cannot be created while the backend is unavailable', async () => {
      backend.available = false;
      await assert.rejects(manager.createSession(makeBuild(owner), owner), (err: ExecutionError) => err.status === 503);
    });

    test('the container profile drops all privileges and sets every limit', () => {
      const host = hardenedHostConfig({}, { memoryMb: 256, cpus: 1.5, pids: 64, tmpfsMb: 32 });

      assert.deepEqual(host.CapDrop, ['ALL']);
      assert.deepEqual(host.SecurityOpt, ['no-new-privileges:true']);
      assert.equal(host.ReadonlyRootfs, true);
      assert.equal(host.Privileged, false);
      assert.equal(host.Memory, host.MemorySwap);
      assert.equal(host.Memory, 256 * 1024 * 1024);
      assert.equal(host.NanoCpus, 1.5e9);
      assert.equal(host.PidsLimit, 64);
      assert.match(host.Tmpfs!['/tmp'], /noexec/);
    });

    test('port detection ignores loopback listeners and Docker DNS', () => {
      const proc = [
        '  sl  local_address rem_address   st',
        '   0: 0B00007F:88BD 00000000:0000 0A 00000000:00000000',
        '   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000',
        '   2: 0100007F:1F90 00000000:0000 0A 00000000:00000000',
        '   3: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A',
        '   4: 00000000000000000000000001000000:1F92 00000000000000000000000000000000:0000 0A',
        '   5: 00000000:0050 0A0A0A0A:1234 01 00000000:00000000'
      ].join('\n');

      assert.deepEqual(parseListeningPorts(proc), [3000, 8081]);
    });
  });

  describe('workspace', () => {
    const file = (path: string, content = 'x'): ProjectFile => ({ path, content, version: 1 });

    for (const path of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\evil', '\\\\server\\share', 'a\0b']) {
      test(`rejects the unsafe path ${JSON.stringify(path)}`, async () => {
        await assert.rejects(materializeWorkspace([file(path)]), /Unsafe project path/);
      });
    }

    test('install config files never reach the sandbox', async () => {
      const workspace = await materializeWorkspace([file('.npmrc', 'registry=https://evil.example'), file('a.txt')]);

      assert.equal(workspace.fileCount, 1);
      assert.equal(workspace.archive.includes('evil.example'), false);
    });

    test('the workspace hash changes with content and ignores order', () => {
      const one = hashWorkspace([file('a', '1'), file('b', '2')]);

      assert.equal(one, hashWorkspace([file('b', '2'), file('a', '1')]));
      assert.notEqual(one, hashWorkspace([file('a', '1'), file('b', '3')]));
    });
  });

  describe('approval', () => {
    test('new code cannot run until the owner approves that exact workspace', async () => {
      const build = makeBuild(owner);

      const result = await manager.createSession(build, owner);

      assert.ok('approvalRequired' in result);
      assert.equal(result.approvalRequired.operationType, 'code_execution');
      assert.equal(backend.environments.size, 0);
    });

    test('repeated requests reuse one pending approval', async () => {
      const build = makeBuild(owner);
      const first = await manager.createSession(build, owner);
      const second = await manager.createSession(build, owner);

      assert.ok('approvalRequired' in first && 'approvalRequired' in second);
      assert.equal(first.approvalRequired.id, second.approvalRequired.id);
    });

    test('changed code needs a new approval', async () => {
      const build = makeBuild(owner);
      await approvedSession(manager, build, owner);
      db.setFile(build.id, { path: 'new.txt', content: 'changed', version: 1, ownerModel: 'system', history: [], createdAt: Date.now(), updatedAt: Date.now() });

      const result = await manager.createSession(build, owner);

      assert.ok('approvalRequired' in result);
    });

    test('an approval for another operation does not authorize execution', async () => {
      const build = makeBuild(owner);
      const hash = hashWorkspace(db.getAllFiles(build.id));
      const created = ApprovalGateService.requestApproval(build.id, owner.id, {
        requestingAgent: 'test',
        requestingRole: 'security_specialist',
        operationType: 'dependency_install',
        explanation: 'Not execution',
        affectedFiles: [],
        proposedChanges: 'None',
        scopeHash: hash
      });
      approve(build, owner, created.request!);

      assert.equal(ApprovalGateService.hasApprovedScope(build.id, 'code_execution', hash), false);
    });

    test('an old execution approval stops working', async () => {
      const build = makeBuild(owner);
      const first = await manager.createSession(build, owner);
      assert.ok('approvalRequired' in first);
      approve(build, owner, first.approvalRequired);
      const stored = db.getApprovalRequest(first.approvalRequired.id)!;
      db.saveApprovalRequest({ ...stored, createdAt: Date.now() - 25 * 60 * 60 * 1000 });

      const result = await manager.createSession(build, owner);

      assert.ok('approvalRequired' in result);
    });

    test('guests are refused when guest execution is off', async () => {
      const guest = makeUser(`guest_${++counter}`, true);
      const strict = new ExecutionSessionManager(backend, { ...config, allowGuests: false });

      await assert.rejects(strict.createSession(makeBuild(guest), guest), (err: ExecutionError) => err.status === 403);
    });
  });

  describe('process lifecycle', () => {
    test('environment creation uploads the project', async () => {
      const session = await approvedSession(manager, makeBuild(owner), owner);

      assert.equal(session.status, 'ready');
      assert.equal(backend.environments.has(session.id), true);
      assert.ok(backend.uploads.get(session.id)?.length);
    });

    test('a failed environment is cleaned up and reported', async () => {
      const build = makeBuild(owner);
      const first = await manager.createSession(build, owner);
      assert.ok('approvalRequired' in first);
      approve(build, owner, first.approvalRequired);
      backend.failCreate = true;

      await assert.rejects(manager.createSession(build, owner), /worker failed/);

      assert.equal(db.getExecutionSessions(build.id)[0].status, 'failed');
    });

    test('a script starts, captures output, and records its exit', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);

      const running = await manager.startScript(build, session.id, 'dev');
      assert.equal(running.status, 'running');
      assert.equal(running.processId, backend.last().id);
      assert.equal(backend.last().spec.network, 'isolated');
      assert.deepEqual(backend.last().spec.argv, ['npm', 'run', 'dev', '--', '--host', '0.0.0.0']);

      backend.last().output('stdout', '\x1b[32mready\x1b[0m\n');
      backend.last().output('stderr', 'warn\n');
      backend.last().end({ exitCode: 3 });
      await manager.waitForProcess(session.id);

      const ended = db.getExecutionSession(session.id)!;
      assert.equal(ended.status, 'ready');
      assert.equal(ended.exitCode, 3);
      assert.equal(ended.endReason, 'failed');

      const logs = db.getExecutionLogs(session.id);
      assert.ok(logs.some(l => l.stream === 'stdout' && l.text === 'ready\n'), 'terminal codes must be removed');
      assert.ok(logs.some(l => l.stream === 'stderr' && l.text === 'warn\n'));
    });

    test('only allowed scripts that exist can run', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);

      await assert.rejects(manager.startScript(build, session.id, 'postinstall'), /not allowed/);
      await assert.rejects(manager.startScript(build, session.id, 'rm -rf /'), /not allowed/);
      await assert.rejects(manager.startScript(build, session.id, 'build'), /no "build" script/);
    });

    test('scripts wait for dependencies', async () => {
      const build = makeBuild(owner);
      const session = await approvedSession(manager, build, owner);

      await assert.rejects(manager.startScript(build, session.id, 'dev'), /Install dependencies/);
    });

    test('stop ends the process and records why', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');

      const stopped = await manager.stop(build, session.id);

      assert.equal(backend.last().stopped, true);
      assert.equal(stopped.endReason, 'stopped');
      assert.equal(stopped.status, 'ready');
    });

    test('restart replaces the running process', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');
      const first = backend.last();

      const restarted = await manager.restart(build, session.id);

      assert.equal(first.stopped, true);
      assert.notEqual(backend.last(), first);
      assert.equal(restarted.status, 'running');
    });

    test('a busy session refuses a second process', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');

      await assert.rejects(manager.startScript(build, session.id, 'test'), (err: ExecutionError) => err.status === 409);
    });

    test('a run past its time limit is stopped', async () => {
      const quick = new ExecutionSessionManager(backend, {
        ...config,
        limits: { ...config.limits, maxRuntimeSeconds: 0.02 }
      });
      const build = makeBuild(owner);
      const session = await installed(quick, backend, build, owner);

      await quick.startScript(build, session.id, 'dev');
      await new Promise(resolve => setTimeout(resolve, 80));
      await quick.waitForProcess(session.id);

      const ended = db.getExecutionSession(session.id)!;
      assert.equal(ended.endReason, 'timed_out');
      assert.equal(backend.last().stopped, true);
    });

    test('an out-of-memory exit is reported', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');

      backend.last().end({ exitCode: 137, oomKilled: true });
      await manager.waitForProcess(session.id);

      assert.equal(db.getExecutionSession(session.id)?.endReason, 'out_of_memory');
    });

    test('a changed project cannot run in an old session', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      db.setFile(build.id, { path: 'new.txt', content: 'x', version: 1, ownerModel: 'system', history: [], createdAt: Date.now(), updatedAt: Date.now() });

      await assert.rejects(manager.startScript(build, session.id, 'dev'), /project has changed/);
    });

    test('missing modules are reported from real output', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');

      backend.last().output('stderr', "Error: Cannot find module 'left-pad'\n");
      backend.last().end({ exitCode: 1 });
      await manager.waitForProcess(session.id);

      assert.deepEqual(db.getExecutionSession(session.id)?.missingDependencies, ['left-pad']);
    });

    test('log storage is capped', async () => {
      const small = new ExecutionSessionManager(backend, { ...config, maxLogBytes: 10 });
      const build = makeBuild(owner);
      const session = await installed(small, backend, build, owner);
      const before = db.getExecutionLogs(session.id).length;
      await small.startScript(build, session.id, 'dev');

      for (let i = 0; i < 20; i++) backend.last().output('stdout', 'more output\n');

      const added = db.getExecutionLogs(session.id).length - before;
      assert.ok(added <= 3, `expected the cap to hold, got ${added} entries`);
    });

    test('concurrent projects get separate sessions, and capacity is enforced', async () => {
      const limited = new ExecutionSessionManager(backend, { ...config, maxConcurrent: db.getLiveExecutionSessions().length + 2 });
      const [one, two] = await Promise.all([
        approvedSession(limited, makeBuild(owner), owner),
        approvedSession(limited, makeBuild(other), other)
      ]);
      assert.notEqual(one.id, two.id);

      const third = makeBuild(owner);
      const pending = await limited.createSession(third, owner);
      assert.ok('approvalRequired' in pending);
      approve(third, owner, pending.approvalRequired);

      await assert.rejects(limited.createSession(third, owner), (err: ExecutionError) => err.status === 429);
    });
  });

  describe('dependencies', () => {
    test('uses npm ci without scripts when a lockfile exists', async () => {
      const build = makeBuild(owner);
      const session = await approvedSession(manager, build, owner);

      await manager.installDependencies(build, session.id);

      const { spec } = backend.last();
      assert.deepEqual(spec.argv.slice(0, 3), ['npm', 'ci', '--ignore-scripts']);
      assert.equal(spec.network, 'registry');
      assert.equal(spec.mountDependencyCache, true);
    });

    test('a failed install is tracked and blocks scripts', async () => {
      const build = makeBuild(owner);
      const session = await approvedSession(manager, build, owner);

      await manager.installDependencies(build, session.id);
      backend.last().end({ exitCode: 1 });
      await manager.waitForProcess(session.id);

      const ended = db.getExecutionSession(session.id)!;
      assert.equal(ended.dependencyStatus, 'failed');
      assert.equal(db.getDependencyInstalls(session.id)[0].status, 'failed');
      await assert.rejects(manager.startScript(build, session.id, 'dev'), /Install dependencies/);
    });

    test('no lockfile needs approval, and the result is saved as a project file', async () => {
      const build = makeBuild(owner, { 'package.json': packageJson });
      const session = await approvedSession(manager, build, owner);

      const pending = await manager.installDependencies(build, session.id);
      assert.ok('approvalRequired' in pending);
      assert.equal(pending.approvalRequired.operationType, 'dependency_install');
      assert.equal(backend.processes.length, 0);

      approve(build, owner, pending.approvalRequired);
      await manager.installDependencies(build, session.id);
      assert.equal(backend.last().spec.argv[1], 'install');

      backend.lockfile = '{"lockfileVersion":3}';
      backend.last().end();
      await manager.waitForProcess(session.id);

      assert.equal(db.getFile(build.id, 'package-lock.json')?.content, backend.lockfile);
      assert.equal(db.getDependencyInstalls(session.id)[0].lockfileGenerated, true);
      assert.equal(db.getExecutionSession(session.id)?.workspaceHash, hashWorkspace(db.getAllFiles(build.id)));
    });

    test('install scripts need their own approval', async () => {
      const build = makeBuild(owner);
      const session = await approvedSession(manager, build, owner);

      const pending = await manager.installDependencies(build, session.id, { allowScripts: true });

      assert.ok('approvalRequired' in pending);
      assert.equal(pending.approvalRequired.operationType, 'install_scripts');
      assert.equal(backend.processes.length, 0);
    });

    test('detects package managers and refuses to guess', () => {
      const file = (path: string, content = '{}'): ProjectFile => ({ path, content, version: 1 });

      assert.equal(planDependencies([file('package.json')]).packageManager, 'npm');
      assert.equal(planDependencies([file('package.json'), file('yarn.lock')]).supported, false);
      assert.equal(planDependencies([file('package.json'), file('pnpm-lock.yaml')]).packageManager, 'pnpm');
      assert.equal(planDependencies([file('requirements.txt')]).ecosystem, 'python');
      assert.equal(planDependencies([file('requirements.txt')]).supported, false);
      assert.equal(planDependencies([file('package.json', 'not json')]).supported, false);
      assert.equal(planDependencies([file('index.html')]).ecosystem, 'none');
    });

    test('install commands block scripts unless approved', () => {
      const plan = planDependencies([{ path: 'package.json', content: '{}', version: 1 }]);
      const options = { registryUrl: 'https://r.example/', allowScripts: false };

      assert.ok(buildInstallCommand(plan, options).includes('--ignore-scripts'));
      assert.equal(buildInstallCommand(plan, { ...options, allowScripts: true }).includes('--ignore-scripts'), false);
    });

    test('missing module detection skips relative paths and keeps scopes', () => {
      const output = [
        "Cannot find module './local'",
        "Cannot find module 'node:fs'",
        "Cannot find package '@scope/pkg/sub'",
        'Failed to resolve import "react-dom/client"'
      ].join('\n');

      assert.deepEqual(detectMissingModules(output), ['@scope/pkg', 'react-dom']);
    });
  });

  describe('cleanup', () => {
    test('destroying a session stops it and removes the environment', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');

      const destroyed = await manager.destroySession(build.id, session.id);

      assert.equal(destroyed.status, 'destroyed');
      assert.equal(backend.environments.has(session.id), false);
      assert.equal(backend.last().stopped, true);
    });

    test('idle sessions are removed, and active ones are not', async () => {
      const idleBuild = makeBuild(owner);
      const idle = await approvedSession(manager, idleBuild, owner);
      const activeBuild = makeBuild(other);
      const active = await installed(manager, backend, activeBuild, other);
      await manager.startScript(activeBuild, active.id, 'dev');

      await manager.reap(Date.now() + config.idleTimeoutMs + 1000);

      assert.equal(db.getExecutionSession(idle.id)?.status, 'destroyed');
      assert.equal(db.getExecutionSession(active.id)?.status, 'running');
      await manager.stop(activeBuild, active.id);
    });

    test('abandoned environments nothing owns are removed', async () => {
      backend.environments.add('orphan');

      await manager.reap();

      assert.equal(backend.environments.has('orphan'), false);
    });

    test('a process over the disk limit is stopped', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');
      backend.workspaceBytes = 2 * 1024 * 1024;

      await manager.reap();

      assert.equal(db.getExecutionSession(session.id)?.endReason, 'disk_limit');
    });

    test('startup ends sessions the server can no longer supervise', async () => {
      const build = makeBuild(owner);
      const session = await approvedSession(manager, build, owner);

      await new ExecutionSessionManager(backend, config).reconcile();

      const ended = db.getExecutionSession(session.id)!;
      assert.equal(ended.status, 'failed');
      assert.match(ended.failureReason || '', /restarted/);
      assert.equal(backend.environments.has(session.id), false);
    });
  });

  describe('API authorization', () => {
    let server: http.Server;
    let base: string;
    let previews: PreviewSessionService;

    beforeEach(async () => {
      previews = new PreviewSessionService(manager, previewConfig);
      const app = express();
      app.use(express.json());
      const requireAuth: express.RequestHandler = (req, _res, next) => {
        req.user = db.getUser(String(req.headers['x-test-user']));
        next();
      };
      app.use('/api/builds/:id/execution', createExecutionRouter({
        requireAuth,
        verifyBuildOwnership: (req, res, buildId) => {
          const build = db.getBuild(buildId);
          if (!build) { res.status(404).json({ error: 'Build not found' }); return null; }
          if (build.userId !== req.user?.id) { res.status(403).json({ error: 'Forbidden' }); return null; }
          return build;
        },
        manager,
        previews
      }));
      server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    });

    afterEach(async () => {
      await new Promise(resolve => server.close(resolve));
    });

    const call = (path: string, user: User, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
      method,
      headers: { 'x-test-user': user.id, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });

    test('every endpoint refuses a user who does not own the build', async () => {
      const build = makeBuild(owner);
      const session = await approvedSession(manager, build, owner);
      const root = `/api/builds/${build.id}/execution`;
      const session_ = `${root}/sessions/${session.id}`;

      const routes: Array<[string, string]> = [
        ['GET', `${root}/capabilities`],
        ['GET', `${root}/sessions`],
        ['POST', `${root}/sessions`],
        ['GET', session_],
        ['GET', `${session_}/logs`],
        ['GET', `${session_}/usage`],
        ['POST', `${session_}/dependencies`],
        ['POST', `${session_}/start`],
        ['POST', `${session_}/stop`],
        ['POST', `${session_}/restart`],
        ['DELETE', session_],
        ['POST', `${session_}/preview`],
        ['POST', `${root}/previews/pv1/link`],
        ['DELETE', `${root}/previews/pv1`]
      ];

      for (const [method, path] of routes) {
        const response = await call(path, other, method);
        assert.equal(response.status, 403, `${method} ${path}`);
      }
      assert.equal(db.getExecutionSession(session.id)?.status, 'ready');
    });

    test('a session cannot be reached through another build', async () => {
      const ownerBuild = makeBuild(owner);
      const session = await approvedSession(manager, ownerBuild, owner);
      const otherBuild = makeBuild(other);
      const session_ = `/api/builds/${otherBuild.id}/execution/sessions/${session.id}`;

      for (const [method, path] of [['GET', session_], ['GET', `${session_}/logs`], ['POST', `${session_}/stop`], ['DELETE', session_]]) {
        assert.equal((await call(path, other, method)).status, 404, `${method} ${path}`);
      }
    });

    test('the owner can run the flow, and the response never exposes preview secrets', async () => {
      const build = makeBuild(owner);
      const root = `/api/builds/${build.id}/execution`;

      const first = await (await call(`${root}/sessions`, owner, 'POST')).json() as any;
      assert.ok(first.approvalRequired);
      approve(build, owner, first.approvalRequired);
      const session = await (await call(`${root}/sessions`, owner, 'POST')).json() as any;
      assert.equal(session.status, 'ready');

      await call(`${root}/sessions/${session.id}/dependencies`, owner, 'POST');
      backend.last().end();
      await manager.waitForProcess(session.id);

      const started = await call(`${root}/sessions/${session.id}/start`, owner, 'POST', { script: 'dev' });
      assert.equal(started.status, 200);

      const opened = await (await call(`${root}/sessions/${session.id}/preview`, owner, 'POST')).json() as any;
      assert.match(opened.url, /^http:\/\/pv[0-9a-f]{24}\.preview\.localhost:3001\/__squadforge\/auth\?token=/);

      const details = await (await call(`${root}/sessions/${session.id}`, owner)).json() as any;
      assert.equal(details.previews.length, 1);
      assert.equal('tokenHash' in details.previews[0], false);
      assert.equal('cookieHash' in details.previews[0], false);

      await manager.stop(build, session.id);
    });
  });

  describe('preview access', () => {
    let upstream: http.Server;
    let proxy: http.Server;
    let proxyPort: number;
    let service: PreviewSessionService;
    let received: http.IncomingHttpHeaders[];

    beforeEach(async () => {
      received = [];
      upstream = http.createServer((req, res) => {
        received.push(req.headers);
        res.setHeader('X-Frame-Options', 'DENY');
        res.end('project page');
      });
      upstream.listen(0, '127.0.0.1');
      await new Promise(resolve => upstream.once('listening', resolve));
      backend.relayPort = (upstream.address() as any).port;

      service = new PreviewSessionService(manager, previewConfig);
      proxy = createPreviewServer(service);
      proxy.listen(0, '127.0.0.1');
      await new Promise(resolve => proxy.once('listening', resolve));
      proxyPort = (proxy.address() as any).port;
    });

    afterEach(async () => {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise(resolve => proxy.close(resolve)),
        new Promise(resolve => upstream.close(resolve))
      ]);
    });

    function request(host: string, path: string, cookie?: string) {
      return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          path,
          headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) }
        }, res => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function openPreview(user = owner) {
      const build = makeBuild(user);
      const session = await installed(manager, backend, build, user);
      await manager.startScript(build, session.id, 'dev');
      const { preview, url } = await service.open(build, session.id);
      received.length = 0; // Ignore the readiness probe, which carries no credentials
      const parsed = new URL(url);
      return { build, session, preview, host: `${preview.id}.preview.localhost`, path: parsed.pathname + parsed.search };
    }

    function cookieFrom(response: { headers: http.IncomingHttpHeaders }) {
      return response.headers['set-cookie']![0].split(';')[0];
    }

    test('a preview needs the one-time token before it serves anything', async () => {
      const { host } = await openPreview();

      const response = await request(host, '/');

      assert.equal(response.status, 403);
      assert.equal(received.length, 0);
    });

    test('the token gives an HttpOnly cookie, and works only once', async () => {
      const { host, path } = await openPreview();

      const first = await request(host, path);
      assert.equal(first.status, 302);
      assert.match(first.headers['set-cookie']![0], /HttpOnly/);
      assert.match(first.headers['set-cookie']![0], /Secure; SameSite=None/, 'the preview loads in a cross-site iframe');
      assert.doesNotMatch(first.headers['set-cookie']![0], /Domain=/);

      const page = await request(host, '/', cookieFrom(first));
      assert.equal(page.status, 200);
      assert.equal(page.body, 'project page');

      const replay = await request(host, path);
      assert.equal(replay.status, 403);
    });

    test('an expired token is refused', async () => {
      const { host, path, preview } = await openPreview();
      db.savePreviewSession({ ...db.getPreviewSession(preview.id)!, tokenExpiresAt: Date.now() - 1 });

      assert.equal((await request(host, path)).status, 403);
    });

    test('one preview cookie cannot open another project preview', async () => {
      const first = await openPreview(owner);
      const second = await openPreview(other);
      const cookie = cookieFrom(await request(first.host, first.path));

      const response = await request(second.host, '/', cookie);

      assert.equal(response.status, 403);
    });

    test('the credential and app session never reach project code', async () => {
      const { host, path } = await openPreview();
      const cookie = cookieFrom(await request(host, path));

      await request(host, '/', `${cookie}; other=1`);

      assert.equal(received[0].cookie, 'other=1');
      assert.doesNotMatch(String(received[0].host), /preview\.localhost/);
    });

    test('framing is limited to the app origin', async () => {
      const { host, path } = await openPreview();
      const cookie = cookieFrom(await request(host, path));

      const page = await request(host, '/', cookie);

      assert.equal(page.headers['x-frame-options'], undefined);
      assert.match(String(page.headers['content-security-policy']), /frame-ancestors http:\/\/localhost:3000/);
    });

    test('unknown hosts are refused', async () => {
      assert.equal((await request('localhost', '/')).status, 404);
      assert.equal((await request('pvzz.preview.localhost', '/')).status, 404);
      assert.equal((await request('pv000000000000000000000000.evil.example', '/')).status, 404);
    });

    test('websocket upgrades are refused without a valid cookie', async () => {
      const { host } = await openPreview();

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          path: '/',
          headers: { Host: host, Connection: 'Upgrade', Upgrade: 'websocket' }
        });
        req.on('response', res => resolve(res.statusCode || 0));
        req.on('upgrade', () => reject(new Error('The upgrade must be refused')));
        req.on('error', reject);
        req.end();
      });

      assert.equal(status, 403);
    });

    test('a preview closes when its process ends', async () => {
      const { build, session, preview, host, path } = await openPreview();
      const cookie = cookieFrom(await request(host, path));

      await manager.stop(build, session.id);

      assert.equal(db.getPreviewSession(preview.id)?.status, 'closed');
      assert.equal(backend.previews.has(session.id), false);
      assert.equal((await request(host, '/', cookie)).status, 403);
    });

    test('idle previews are closed', async () => {
      const { preview } = await openPreview();

      await service.reap(Date.now() + previewConfig.idleTimeoutMs + 1000);

      assert.equal(db.getPreviewSession(preview.id)?.status, 'closed');
    });

    test('a failed startup is reported instead of a dead preview', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'dev');
      backend.ports = [];

      await assert.rejects(service.open(build, session.id), (err: ExecutionError) => err.status === 504);
    });

    test('a preview needs a running process', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);

      await assert.rejects(service.open(build, session.id), (err: ExecutionError) => err.status === 409);
    });

    test('previews are disabled without a dedicated domain', async () => {
      const disabled = new PreviewSessionService(manager, { ...previewConfig, baseDomain: null });
      const build = makeBuild(owner);

      await assert.rejects(disabled.open(build, 'any'), (err: ExecutionError) => err.status === 503);
    });
  });

  describe('verification', () => {
    const files: ProjectFile[] = [
      { path: 'tests/a.test.js', content: 'require("fs").writeFileSync("/tmp/pwned", "x")', version: 1 }
    ];

    test('generated tests do not run on the host', () => {
      const previous = process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
      delete process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
      try {
        const report = ExecutionAdapter.runIsolatedTests(`bld_none_${++counter}`, files);

        assert.equal(report.status, 'skipped');
        assert.equal(report.passed, 0);
        assert.match(report.skipReason || '', /sandbox/);
      } finally {
        if (previous !== undefined) process.env.SQUADFORGE_TRUSTED_HOST_TESTS = previous;
      }
    });

    test('the trusted fixture switch has no effect in production', () => {
      const previous = { flag: process.env.SQUADFORGE_TRUSTED_HOST_TESTS, env: process.env.NODE_ENV };
      process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';
      process.env.NODE_ENV = 'production';
      try {
        assert.equal(ExecutionAdapter.runIsolatedTests(`bld_none_${++counter}`, files).status, 'skipped');
      } finally {
        if (previous.flag === undefined) delete process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
        else process.env.SQUADFORGE_TRUSTED_HOST_TESTS = previous.flag;
        if (previous.env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous.env;
      }
    });

    test('sandbox test results count only for the exact workspace', async () => {
      const build = makeBuild(owner);
      const session = await installed(manager, backend, build, owner);
      await manager.startScript(build, session.id, 'test');
      backend.last().end({ exitCode: 1 });
      await manager.waitForProcess(session.id);

      const previous = process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
      delete process.env.SQUADFORGE_TRUSTED_HOST_TESTS;
      try {
        const current = db.getAllFiles(build.id);
        const withTests = [...current, ...files];
        assert.equal(ExecutionAdapter.runIsolatedTests(build.id, withTests).status, 'skipped');

        const run = db.getSandboxTestRun(build.id, hashWorkspace(current));
        assert.equal(run?.exitCode, 1);
      } finally {
        if (previous !== undefined) process.env.SQUADFORGE_TRUSTED_HOST_TESTS = previous;
      }
    });
  });
});
