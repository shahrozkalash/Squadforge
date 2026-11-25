// Phase 32: Production Execution Infrastructure.
//
// Everything in this file runs WITHOUT a Docker daemon. The daemon
// behaviours are exercised against clearly-labelled fixture clients
// (stubbed dockerode objects) — they prove SquadForge's configuration,
// translation and cleanup logic, never that a real daemon honoured
// anything. Genuine daemon evidence lives in
// tests/phase32_docker_integration.test.ts (gated on DOCKER_INTEGRATION=1)
// and, through it, in the Phase 32 CI workflow.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { db } from '../server/store.js';
import { Build, User } from '../server/types.js';
import { clearAuditEventsForTests, recentAuditEvents } from '../server/auditLog.js';
import { DisabledBackend } from '../server/execution/disabledBackend.js';
import { DockerBackend, dockerClientFromEnv, dockerConfigFromEnv, hardenedHostConfig } from '../server/execution/dockerBackend.js';
import { createExecutionRouter } from '../server/execution/executionRoutes.js';
import { ExecutionSessionManager, executionConfigFromEnv } from '../server/execution/executionSessionManager.js';
import {
  PreviewSessionService,
  signPreviewToken,
  verifyPreviewToken
} from '../server/execution/previewSessionService.js';
import {
  resolveDockerConnection,
  storageOptEnforced,
  storageOptSizeBytes,
  storageQuotaDecision,
  workerHealthIntervalMs
} from '../server/execution/workerConfig.js';
import { WorkerHealthMonitor } from '../server/execution/workerHealth.js';

let counter = 0;
const uniq = (prefix: string) => `${prefix}${Date.now()}_${++counter}`;

/** Creates a temp dir of dummy "certificate" files. Contents are never parsed by the code under test. */
function tempCertFiles(contents = 'DUMMY-CERT-FIXTURE'): { dir: string; ca: string; cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sf-p32-'));
  const files = { ca: path.join(dir, 'ca.pem'), cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem') };
  for (const file of Object.values(files)) fs.writeFileSync(file, contents);
  return { dir, ...files };
}

const tlsEnv = (files: { ca: string; cert: string; key: string }): NodeJS.ProcessEnv => ({
  DOCKER_HOST: 'tcp://worker.example:2376',
  DOCKER_TLS_CA: files.ca,
  DOCKER_TLS_CERT: files.cert,
  DOCKER_TLS_KEY: files.key
});

/**
 * A fixture dockerode client: an in-memory stand-in for a daemon, used
 * to prove SquadForge-side logic. It is NOT a Docker daemon and these
 * tests never claim daemon behaviour from it.
 */
function fixtureDocker(info: Record<string, unknown>) {
  return {
    ping: async () => 'OK',
    info: async () => info,
    version: async () => ({ Version: '27.0.0-fixture', ApiVersion: '1.46', Os: 'linux', Arch: 'amd64' }),
    getImage: () => ({ inspect: async () => ({ Id: 'fixture-image' }) })
  } as any;
}

const FIXTURE_INFO_RUNSC = {
  Driver: 'overlay2',
  DriverStatus: [['Backing Filesystem', 'xfs']],
  DefaultRuntime: 'runc',
  Runtimes: { runc: { path: 'runc' }, runsc: { path: '/usr/local/bin/runsc' } }
};
const FIXTURE_INFO_NO_RUNSC = {
  Driver: 'overlay2',
  DriverStatus: [['Backing Filesystem', 'extfs']],
  DefaultRuntime: 'runc',
  Runtimes: { runc: { path: 'runc' } }
};

describe('Phase 32 worker connection resolution (fail closed)', () => {
  test('no DOCKER_HOST means the local socket, no TLS needed', () => {
    const resolved = resolveDockerConnection({});
    assert.equal(resolved.mode, 'socket');
  });

  test('an explicit unix socket is accepted', () => {
    const resolved = resolveDockerConnection({ DOCKER_HOST: 'unix:///run/docker.sock' });
    assert.equal(resolved.mode, 'socket');
    if (resolved.mode === 'socket') assert.equal(resolved.socketPath, '/run/docker.sock');
  });

  test('a plaintext remote tcp endpoint is refused', () => {
    const resolved = resolveDockerConnection({ DOCKER_HOST: 'tcp://worker.example:2376' });
    assert.equal(resolved.mode, 'invalid');
    if (resolved.mode === 'invalid') {
      assert.match(resolved.errors.join(' '), /TLS is required/);
      assert.match(resolved.errors.join(' '), /refuses plaintext remote/);
    }
  });

  test('a plaintext http endpoint is refused', () => {
    const resolved = resolveDockerConnection({ DOCKER_HOST: 'http://worker.example:2375' });
    assert.equal(resolved.mode, 'invalid');
    if (resolved.mode === 'invalid') assert.match(resolved.errors.join(' '), /plaintext HTTP/);
  });

  test('partial TLS settings are refused and name the missing variables', () => {
    const files = tempCertFiles();
    const resolved = resolveDockerConnection({ DOCKER_HOST: 'tcp://worker.example:2376', DOCKER_TLS_CA: files.ca });
    assert.equal(resolved.mode, 'invalid');
    if (resolved.mode === 'invalid') {
      assert.match(resolved.errors.join(' '), /DOCKER_TLS_CERT/);
      assert.match(resolved.errors.join(' '), /DOCKER_TLS_KEY/);
    }
  });

  test('TLS settings pointing at missing files are refused', () => {
    const resolved = resolveDockerConnection({
      DOCKER_HOST: 'tcp://worker.example:2376',
      DOCKER_TLS_CA: '/nonexistent/ca.pem',
      DOCKER_TLS_CERT: '/nonexistent/cert.pem',
      DOCKER_TLS_KEY: '/nonexistent/key.pem'
    });
    assert.equal(resolved.mode, 'invalid');
    if (resolved.mode === 'invalid') assert.match(resolved.errors.join(' '), /does not exist or is not readable/);
  });

  test('a complete TLS configuration resolves with endpoint and files', () => {
    const files = tempCertFiles();
    const resolved = resolveDockerConnection(tlsEnv(files));
    assert.equal(resolved.mode, 'tls');
    if (resolved.mode === 'tls') {
      assert.equal(resolved.host, 'worker.example');
      assert.equal(resolved.port, 2376);
      assert.equal(resolved.caPath, files.ca);
    }
  });

  test('ssh endpoints are refused as unverifiable', () => {
    const resolved = resolveDockerConnection({ DOCKER_HOST: 'ssh://user@worker.example' });
    assert.equal(resolved.mode, 'invalid');
  });

  test('dockerClientFromEnv throws for plaintext instead of falling back', () => {
    assert.throws(
      () => dockerClientFromEnv({ DOCKER_HOST: 'tcp://worker.example:2376' }),
      /refuses plaintext remote/
    );
  });

  test('dockerClientFromEnv builds a client for a complete TLS config', () => {
    const files = tempCertFiles();
    const client = dockerClientFromEnv(tlsEnv(files));
    assert.ok(client);
  });

  test('a DockerBackend with a plaintext remote config is disabled and fails closed', async () => {
    const backend = new DockerBackend(undefined, dockerConfigFromEnv({}), { DOCKER_HOST: 'tcp://worker.example:2376' });
    assert.match(backend.configurationError() || '', /TLS is required/);
    const capabilities = await backend.capabilities();
    assert.equal(capabilities.available, false);
    assert.match(capabilities.reason || '', /TLS is required/);
    await assert.rejects(
      backend.createEnvironment({ sessionId: 's1', buildId: 'b1', userId: 'u1' }),
      /TLS is required/
    );
  });

  test('health interval is clamped to a sane minimum', () => {
    assert.equal(workerHealthIntervalMs({}), 30000);
    assert.equal(workerHealthIntervalMs({ EXECUTION_HEALTH_INTERVAL_SECONDS: '5' }), 5000);
    assert.equal(workerHealthIntervalMs({ EXECUTION_HEALTH_INTERVAL_SECONDS: '1' }), 30000);
    assert.equal(workerHealthIntervalMs({ EXECUTION_HEALTH_INTERVAL_SECONDS: '60' }), 60000);
  });
});

describe('Phase 32 configured-runtime verification (fixture daemon)', () => {
  test('runsc configured but absent on the daemon: unavailable, never a silent fallback', async () => {
    const backend = new DockerBackend(
      fixtureDocker(FIXTURE_INFO_NO_RUNSC),
      { ...dockerConfigFromEnv({}), runtime: 'runsc' },
      {}
    );
    const capabilities = await backend.capabilities();
    assert.equal(capabilities.available, false);
    assert.match(capabilities.reason || '', /SANDBOX_RUNTIME is set to "runsc"/);
    assert.match(capabilities.reason || '', /does not list it/);
  });

  test('runsc configured and present: available with the runsc runtime reported', async () => {
    const backend = new DockerBackend(
      fixtureDocker(FIXTURE_INFO_RUNSC),
      { ...dockerConfigFromEnv({}), runtime: 'runsc' },
      {}
    );
    const capabilities = await backend.capabilities();
    assert.equal(capabilities.available, true);
    assert.equal(capabilities.runtime, 'runsc');
  });

  test('no runtime configured: the daemon default is reported honestly', async () => {
    const backend = new DockerBackend(fixtureDocker(FIXTURE_INFO_NO_RUNSC), dockerConfigFromEnv({}), {});
    const capabilities = await backend.capabilities();
    assert.equal(capabilities.available, true);
    assert.equal(capabilities.runtime, 'runc');
  });

  test('checkWorker rejects when the configured runtime is absent and diagnostics say so', async () => {
    const backend = new DockerBackend(
      fixtureDocker(FIXTURE_INFO_NO_RUNSC),
      { ...dockerConfigFromEnv({}), runtime: 'runsc' },
      {}
    );
    await assert.rejects(backend.checkWorker(), /does not list the configured runtime/);
    const diagnostics = await backend.diagnostics();
    assert.equal(diagnostics.daemon?.runtimeVerified, false);
    assert.equal(diagnostics.available, false);
    assert.equal(diagnostics.health?.state, 'unhealthy');
  });
});

describe('Phase 32 storage quota decisions (documented Docker behaviour)', () => {
  const cases: Array<[string, Record<string, unknown>, 'hard' | 'conditional' | 'soft']> = [
    ['btrfs', { Driver: 'btrfs' }, 'hard'],
    ['zfs', { Driver: 'zfs' }, 'hard'],
    ['overlay2 on xfs', { Driver: 'overlay2', DriverStatus: [['Backing Filesystem', 'xfs']] }, 'conditional'],
    ['overlay2 on ext4', { Driver: 'overlay2', DriverStatus: [['Backing Filesystem', 'extfs']] }, 'soft'],
    ['overlay2 with unknown backing', { Driver: 'overlay2' }, 'soft'],
    ['vfs', { Driver: 'vfs' }, 'soft'],
    ['unknown driver', { Driver: 'something-new' }, 'soft']
  ];
  for (const [name, info, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      const decision = storageQuotaDecision(info);
      assert.equal(decision.mode, expected);
      assert.equal(storageOptEnforced(decision), expected !== 'soft');
      assert.ok(decision.reason.length > 0);
    });
  }

  test('the storage option carries the workspace size in bytes', () => {
    assert.equal(storageOptSizeBytes(1024), 1024 * 1024 * 1024);
    const host = hardenedHostConfig({}, { memoryMb: 256, cpus: 1, pids: 64, tmpfsMb: 32, storageOptSizeBytes: storageOptSizeBytes(512) });
    assert.deepEqual(host.StorageOpt, { size: String(512 * 1024 * 1024) });
  });

  test('without daemon support no storage option is passed', () => {
    const host = hardenedHostConfig({}, { memoryMb: 256, cpus: 1, pids: 64, tmpfsMb: 32 });
    assert.equal(host.StorageOpt, undefined);
  });

  test('limits translate to real HostConfig fields (memory, cpu, pids)', () => {
    const host = hardenedHostConfig({}, { memoryMb: 512, cpus: 1.5, pids: 128, tmpfsMb: 64 });
    assert.equal(host.Memory, 512 * 1024 * 1024);
    assert.equal(host.MemorySwap, host.Memory);
    assert.equal(host.NanoCpus, 1.5e9);
    assert.equal(host.PidsLimit, 128);
  });
});

describe('Phase 32 diagnostics redaction (fixture daemon)', () => {
  test('diagnostics expose paths and presence, never certificate contents', async () => {
    const sentinel = 'SENTINEL-CERT-CONTENT-DO-NOT-LEAK';
    const files = tempCertFiles(sentinel);
    const backend = new DockerBackend(fixtureDocker(FIXTURE_INFO_RUNSC), dockerConfigFromEnv({}), tlsEnv(files));
    const diagnostics = await backend.diagnostics();

    assert.equal(diagnostics.endpoint, 'tcp://worker.example:2376');
    assert.equal(diagnostics.tls?.enabled, true);
    assert.deepEqual(diagnostics.tls?.filesPresent, { ca: true, cert: true, key: true });
    assert.equal(diagnostics.daemon?.reachable, true);
    assert.equal(diagnostics.daemon?.storageDriver, 'overlay2');
    assert.equal(diagnostics.daemon?.backingFilesystem, 'xfs');
    assert.equal(diagnostics.daemon?.containerLayerQuota, 'conditional');
    assert.equal(diagnostics.daemon?.workspaceQuota, 'soft-polling');
    assert.equal(JSON.stringify(diagnostics).includes(sentinel), false);
  });

  test('diagnostics for a misconfigured backend report the error and no daemon', async () => {
    const backend = new DockerBackend(undefined, dockerConfigFromEnv({}), { DOCKER_HOST: 'tcp://worker.example:2376' });
    const diagnostics = await backend.diagnostics();
    assert.equal(diagnostics.available, false);
    assert.match(diagnostics.configError || '', /TLS is required/);
    assert.equal(diagnostics.daemon?.reachable, false);
  });
});

describe('Phase 32 orphan sweep (fixture daemon)', () => {
  test('only resources labelled with a dead session are removed', async () => {
    const removed: string[] = [];
    const labels = (session?: string) => ({
      'squadforge.managed': 'true',
      ...(session ? { 'squadforge.session': session } : {})
    });
    const fixture = {
      listContainers: async () => [
        { Id: 'c-live', Labels: labels('live') },
        { Id: 'c-orphan', Labels: labels('dead') },
        { Id: 'c-edge', Labels: labels() }
      ],
      listVolumes: async () => ({
        Volumes: [
          { Name: 'v-live', Labels: labels('live') },
          { Name: 'v-orphan', Labels: labels('dead') },
          { Name: 'v-cache', Labels: { 'squadforge.managed': 'true', 'squadforge.role': 'cache' } }
        ]
      }),
      listNetworks: async () => [
        { Id: 'n-live', Labels: labels('live') },
        { Id: 'n-orphan', Labels: labels('dead') },
        { Id: 'n-edge', Labels: labels() }
      ],
      getContainer: (id: string) => ({ remove: async () => { removed.push(`container:${id}`); } }),
      getVolume: (name: string) => ({ remove: async () => { removed.push(`volume:${name}`); } }),
      getNetwork: (id: string) => ({ remove: async () => { removed.push(`network:${id}`); } })
    };
    const backend = new DockerBackend(fixture as any, dockerConfigFromEnv({}), {});
    const result = await backend.sweepOrphans(new Set(['live']));

    assert.deepEqual(result, { containers: 1, volumes: 1, networks: 1 });
    assert.deepEqual(removed.sort(), ['container:c-orphan', 'network:n-orphan', 'volume:v-orphan']);
  });
});

describe('Phase 32 worker health monitor', () => {
  test('loss and regain are audited once per transition and regain runs recovery', async () => {
    clearAuditEventsForTests();
    let healthy = true;
    let recoveries = 0;
    const monitor = new WorkerHealthMonitor({
      intervalMs: 60000,
      probe: async () => { if (!healthy) throw new Error('daemon down'); },
      onRegained: async () => { recoveries++; }
    });

    await monitor.check();
    assert.equal(monitor.snapshot().state, 'healthy');
    assert.equal(recoveries, 0, 'the first healthy probe is not a regain');

    healthy = false;
    await monitor.check();
    await monitor.check();
    assert.equal(monitor.snapshot().state, 'unhealthy');
    assert.equal(monitor.snapshot().consecutiveFailures, 2);

    healthy = true;
    await monitor.check();
    assert.equal(monitor.snapshot().state, 'healthy');
    assert.equal(recoveries, 1);

    const actions = recentAuditEvents().map(event => event.action);
    assert.equal(actions.filter(a => a === 'execution.worker.health_lost').length, 1);
    assert.equal(actions.filter(a => a === 'execution.worker.health_regained').length, 1);
  });
});

describe('Phase 32 signed preview tokens', () => {
  const SECRET = 'phase32-test-secret';
  const payload = () => ({ pid: 'pvabc', sid: 'exe123', uid: 'usr_owner', exp: Date.now() + 60000 });

  test('a signed token verifies and returns its binding', () => {
    const token = signPreviewToken(SECRET, payload());
    const verified = verifyPreviewToken(SECRET, token);
    assert.equal(verified?.pid, 'pvabc');
    assert.equal(verified?.sid, 'exe123');
    assert.equal(verified?.uid, 'usr_owner');
  });

  test('tampering with the payload or signature is rejected', () => {
    const token = signPreviewToken(SECRET, payload());
    const [body, signature] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...payload(), uid: 'usr_attacker' })).toString('base64url');
    assert.equal(verifyPreviewToken(SECRET, `${forgedBody}.${signature}`), null);
    assert.equal(verifyPreviewToken(SECRET, `${body}.${Buffer.from('x'.repeat(32)).toString('base64url')}`), null);
    assert.equal(verifyPreviewToken('another-secret', token), null);
    assert.equal(verifyPreviewToken(SECRET, 'not-a-token'), null);
    assert.equal(verifyPreviewToken(SECRET, crypto.randomBytes(32).toString('hex')), null, 'the old unsigned token shape is not accepted');
  });

  test('an expired signed token is rejected', () => {
    const token = signPreviewToken(SECRET, { ...payload(), exp: Date.now() - 1000 });
    assert.equal(verifyPreviewToken(SECRET, token), null);
  });

  test('redeem enforces binding, expiry and one-time use against stored previews', () => {
    const manager = new ExecutionSessionManager(new DisabledBackend(), executionConfigFromEnv({}));
    const service = new PreviewSessionService(manager, {
      baseDomain: 'preview.localhost',
      scheme: 'http',
      publicPort: 3001,
      listenPort: 3001,
      appOrigin: 'http://localhost:3000',
      idleTimeoutMs: 60000,
      portWaitMs: 100,
      portPollMs: 10,
      tokenSecret: SECRET
    });

    const previewId = `pv${crypto.randomBytes(12).toString('hex')}`;
    const sessionId = uniq('exe_p32_');
    const userId = uniq('usr_p32_');
    const buildId = uniq('bld_p32_');
    // preview_sessions has foreign keys to users, builds and sessions.
    db.createUser({
      id: userId, email: `${userId}@p32.test`, name: userId, githubConnected: false,
      costLimitPerBuild: 5, enabledModelIds: ['gemini'], createdAt: Date.now(), isAnonymous: false
    } as User);
    db.saveBuild({
      id: buildId, userId, idea: 'Phase 32 fixture', status: 'completed', createdAt: Date.now(),
      updatedAt: Date.now(), selectedModels: ['gemini'], autoPushGithub: false, totalTokens: 0, totalCost: 0
    } as Build);
    db.saveExecutionSession({
      id: sessionId, buildId, userId, status: 'running', backend: 'disabled',
      workspaceHash: 'fixture', dependencyStatus: 'installed', missingDependencies: [],
      createdAt: Date.now(), updatedAt: Date.now(), lastActivityAt: Date.now()
    });
    const issue = (overrides: Partial<{ sid: string; uid: string; exp: number }> = {}) => {
      const exp = overrides.exp ?? Date.now() + 60000;
      const token = signPreviewToken(SECRET, {
        pid: previewId,
        sid: overrides.sid ?? sessionId,
        uid: overrides.uid ?? userId,
        exp
      });
      db.savePreviewSession({
        id: previewId,
        sessionId,
        buildId,
        userId,
        status: 'active',
        port: 3000,
        relayHost: '127.0.0.1',
        relayPort: 39999,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        tokenExpiresAt: exp,
        createdAt: Date.now(),
        lastAccessAt: Date.now()
      });
      return token;
    };

    assert.ok(service.redeem(previewId, issue()), 'a valid bound token redeems');
    assert.equal(service.redeem(previewId, issue({ uid: 'usr_attacker' })), null, 'a token bound to another user is refused');
    assert.equal(service.redeem(previewId, issue({ sid: 'exe_other' })), null, 'a token bound to another session is refused');
    assert.equal(service.redeem(previewId, issue({ exp: Date.now() - 1000 })), null, 'an expired token is refused');

    const oneTime = issue();
    assert.ok(service.redeem(previewId, oneTime), 'first redemption succeeds');
    assert.equal(service.redeem(previewId, oneTime), null, 'the same token cannot redeem twice');
  });
});

describe('Phase 32 worker diagnostics route', () => {
  let server: http.Server;
  let base: string;
  let owner: User;
  let admin: User;
  let build: Build;
  let adminBuild: Build;
  const previousAdmins = process.env.MODEL_ADMIN_USER_IDS;

  before(async () => {
    const suffix = uniq('');
    owner = {
      id: `usr_p32_owner_${suffix}`, email: `owner_${suffix}@p32.test`, name: 'owner',
      githubConnected: false, costLimitPerBuild: 5, enabledModelIds: ['gemini'], createdAt: Date.now(), isAnonymous: false
    } as User;
    admin = { ...owner, id: `usr_p32_admin_${suffix}`, email: `admin_${suffix}@p32.test` } as User;
    db.createUser(owner);
    db.createUser(admin);
    const makeBuild = (userId: string): Build => db.saveBuild({
      id: uniq('bld_p32_'), userId, idea: 'Phase 32 fixture', status: 'completed',
      createdAt: Date.now(), updatedAt: Date.now(), selectedModels: ['gemini'], autoPushGithub: false,
      totalTokens: 0, totalCost: 0
    } as Build);
    build = makeBuild(owner.id);
    // The admin gets their own build too, so ownership passes and only
    // the admin gate decides the outcome.
    adminBuild = makeBuild(admin.id);

    process.env.MODEL_ADMIN_USER_IDS = admin.id;

    const manager = new ExecutionSessionManager(new DisabledBackend(), executionConfigFromEnv({}));
    const previews = new PreviewSessionService(manager, {
      baseDomain: 'preview.localhost', scheme: 'http', publicPort: 3001, listenPort: 3001,
      appOrigin: 'http://localhost:3000', idleTimeoutMs: 60000, portWaitMs: 100, portPollMs: 10,
      tokenSecret: 'route-test-secret'
    });
    const app = express();
    app.use(express.json());
    const requireAuth: express.RequestHandler = (req, _res, next) => {
      req.user = db.getUser(String(req.headers['x-test-user']));
      next();
    };
    app.use('/api/builds/:id/execution', createExecutionRouter({
      requireAuth,
      verifyBuildOwnership: (req, res, buildId) => {
        const found = db.getBuild(buildId);
        if (!found) { res.status(404).json({ error: 'Build not found' }); return null; }
        if (found.userId !== req.user?.id) { res.status(403).json({ error: 'Forbidden' }); return null; }
        return found;
      },
      manager,
      previews
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  after(async () => {
    if (previousAdmins === undefined) delete process.env.MODEL_ADMIN_USER_IDS;
    else process.env.MODEL_ADMIN_USER_IDS = previousAdmins;
    (server as any).closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });

  test('a build owner who is not an admin is refused', async () => {
    const res = await fetch(`${base}/api/builds/${build.id}/execution/worker/diagnostics`, {
      headers: { 'x-test-user': owner.id }
    });
    assert.equal(res.status, 403);
  });

  test('an admin gets redacted diagnostics', async () => {
    const res = await fetch(`${base}/api/builds/${adminBuild.id}/execution/worker/diagnostics`, {
      headers: { 'x-test-user': admin.id }
    });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.diagnostics.backend, 'disabled');
    assert.equal(body.diagnostics.available, false);
    assert.equal(JSON.stringify(body).includes('route-test-secret'), false);
  });
});
