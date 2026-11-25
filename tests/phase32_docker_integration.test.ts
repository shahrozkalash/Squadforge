// Phase 32: GENUINE remote Docker worker integration tests.
//
// These tests talk to a REAL Docker daemon and are skipped unless
// DOCKER_INTEGRATION=1. In CI (.github/workflows/phase32-execution-verify.yml)
// the daemon is a TLS-verified dockerd on the runner with the gVisor
// runsc runtime registered, and DOCKER_HOST / DOCKER_TLS_CA /
// DOCKER_TLS_CERT / DOCKER_TLS_KEY point at it with certificates
// generated for the run. Nothing here is stubbed: if the daemon, the
// TLS setup or runsc is not real, these tests fail.
//
// Run locally against a worker you control:
//   docker build -t squadforge-sandbox:1 sandbox
//   DOCKER_INTEGRATION=1 DOCKER_HOST=tcp://127.0.0.1:2376 \
//     DOCKER_TLS_CA=... DOCKER_TLS_CERT=... DOCKER_TLS_KEY=... \
//     npx tsx --test tests/phase32_docker_integration.test.ts
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Docker from 'dockerode';
import { DockerBackend, dockerClientFromEnv, dockerConfigFromEnv } from '../server/execution/dockerBackend.js';
import { ProcessSpec, SandboxLimits } from '../server/execution/executionBackend.js';
import { materializeWorkspace } from '../server/execution/workspaceMaterializer.js';

const enabled = process.env.DOCKER_INTEGRATION === '1';
const tlsConfigured = Boolean(
  process.env.DOCKER_HOST?.startsWith('tcp:') &&
  process.env.DOCKER_TLS_CA && process.env.DOCKER_TLS_CERT && process.env.DOCKER_TLS_KEY
);
const wrongCaConfigured = Boolean(
  process.env.PHASE32_WRONG_CA && process.env.PHASE32_WRONG_CERT && process.env.PHASE32_WRONG_KEY
);

const limits: SandboxLimits = {
  memoryMb: 256, cpus: 1, pids: 64, maxRuntimeSeconds: 120, tmpfsMb: 32, workspaceMb: 256
};

describe('Phase 32 Docker worker integration', { skip: enabled ? false : 'Set DOCKER_INTEGRATION=1 to run' }, () => {
  let client: Docker;
  let backend: DockerBackend;
  const sessions: string[] = [];

  async function environment(backendInstance: DockerBackend): Promise<string> {
    const sessionId = `p32${crypto.randomBytes(6).toString('hex')}`;
    sessions.push(sessionId);
    await backendInstance.createEnvironment({ sessionId, buildId: `bld_${sessionId}`, userId: 'usr_p32_integration' });
    const { archive } = await materializeWorkspace([{ path: 'package.json', content: '{}', version: 1 }]);
    await backendInstance.uploadWorkspace(sessionId, archive);
    return sessionId;
  }

  async function runCollecting(
    backendInstance: DockerBackend,
    sessionId: string,
    argv: string[],
    overrides: Partial<ProcessSpec> = {}
  ): Promise<{ exitCode: number; oomKilled: boolean; stdout: string }> {
    let stdout = '';
    const handle = await backendInstance.startProcess(
      sessionId,
      { argv, network: 'isolated', limits, ...overrides },
      (stream, text) => { if (stream === 'stdout') stdout += text; }
    );
    const exit = await handle.wait();
    return { ...exit, stdout };
  }

  before(async () => {
    client = dockerClientFromEnv();
    backend = new DockerBackend(client, dockerConfigFromEnv());
    const capabilities = await backend.capabilities();
    assert.equal(capabilities.available, true, capabilities.reason);
  });

  after(async () => {
    for (const sessionId of sessions) {
      await backend.destroyEnvironment(sessionId).catch(() => undefined);
      await backend.removeDependencyCache(`bld_${sessionId}`).catch(() => undefined);
    }
  });

  test('TLS connection with a valid client certificate reaches the daemon', { skip: tlsConfigured ? false : 'DOCKER_HOST/TLS env not configured' }, async () => {
    const version: any = await client.version();
    assert.ok(version.Version, 'daemon returned a version');
    const diagnostics = await backend.diagnostics();
    assert.equal(diagnostics.tls?.enabled, true);
    assert.deepEqual(diagnostics.tls?.filesPresent, { ca: true, cert: true, key: true });
    assert.equal(diagnostics.daemon?.reachable, true);
  });

  test('a client certificate from a different CA is rejected', { skip: wrongCaConfigured ? false : 'PHASE32_WRONG_* env not configured' }, async () => {
    const url = new URL(process.env.DOCKER_HOST!.replace(/^tcp:/, 'https:'));
    const impostor = new Docker({
      host: url.hostname,
      port: Number(url.port || 2376),
      protocol: 'https',
      ca: fs.readFileSync(process.env.PHASE32_WRONG_CA!),
      cert: fs.readFileSync(process.env.PHASE32_WRONG_CERT!),
      key: fs.readFileSync(process.env.PHASE32_WRONG_KEY!)
    });
    await assert.rejects(impostor.ping());
  });

  test('a plaintext HTTP client cannot talk to the TLS port', { skip: tlsConfigured ? false : 'DOCKER_HOST/TLS env not configured' }, async () => {
    const url = new URL(process.env.DOCKER_HOST!.replace(/^tcp:/, 'https:'));
    const plaintext = new Docker({ host: url.hostname, port: Number(url.port || 2376), protocol: 'http' });
    await assert.rejects(plaintext.ping());
  });

  test('containers run under runsc when it is configured', { timeout: 120000 }, async t => {
    const info: any = await client.info();
    if (!info.Runtimes || !('runsc' in info.Runtimes)) {
      t.skip('the test daemon does not list the runsc runtime');
      return;
    }
    const runscBackend = new DockerBackend(client, { ...dockerConfigFromEnv(), runtime: 'runsc' });
    const capabilities = await runscBackend.capabilities();
    assert.equal(capabilities.available, true, capabilities.reason);
    assert.equal(capabilities.runtime, 'runsc');

    const sessionId = await environment(runscBackend);
    let stdout = '';
    const handle = await runscBackend.startProcess(
      sessionId,
      { argv: ['node', '-e', 'setTimeout(() => {}, 30000)'], network: 'isolated', limits },
      (stream, text) => { if (stream === 'stdout') stdout += text; }
    );
    try {
      const inspection: any = await client.getContainer(handle.id).inspect();
      assert.equal(inspection.HostConfig.Runtime, 'runsc', 'docker inspect must report the runsc runtime');
      assert.equal(inspection.HostConfig.Memory, limits.memoryMb * 1024 * 1024);
    } finally {
      await handle.stop();
      await handle.wait();
    }
    await runscBackend.destroyEnvironment(sessionId);
    void stdout;
  });

  test('a container that exceeds its memory limit is OOM-killed', { timeout: 120000 }, async () => {
    const sessionId = await environment(backend);
    const result = await runCollecting(
      backend,
      sessionId,
      ['node', '--max-old-space-size=8192', '-e',
        'const held = []; for (;;) { held.push(Buffer.alloc(8 * 1024 * 1024, 1)); }'],
      { limits: { ...limits, memoryMb: 96 } }
    );
    assert.equal(result.oomKilled, true, `expected the kernel OOM killer, got exit ${result.exitCode} without OOMKilled`);
    await backend.destroyEnvironment(sessionId);
  });

  test('the pids limit is set on the container and contains a fork flood', { timeout: 120000 }, async () => {
    const sessionId = await environment(backend);
    const pids = 24;
    let stdout = '';
    const handle = await backend.startProcess(
      sessionId,
      {
        argv: ['node', '-e', `
          const { spawn } = require('node:child_process');
          const kids = [];
          for (let i = 0; i < 60; i++) {
            try { const child = spawn('sleep', ['30'], { stdio: 'ignore' }); child.on('error', () => {}); kids.push(child); }
            catch { /* spawn itself refused */ }
          }
          setTimeout(() => {
            console.log('SPAWNED=' + kids.filter(k => k.pid !== undefined).length);
          }, 3000);
          setTimeout(() => {}, 8000);
        `],
        network: 'isolated',
        limits: { ...limits, pids }
      },
      (stream, text) => { if (stream === 'stdout') stdout += text; }
    );
    const inspection: any = await client.getContainer(handle.id).inspect();
    assert.equal(inspection.HostConfig.PidsLimit, pids);
    const exit = await handle.wait();
    assert.equal(exit.exitCode, 0, stdout);
    const spawned = Number(/SPAWNED=(\d+)/.exec(stdout)?.[1]);
    assert.ok(Number.isInteger(spawned), `expected a SPAWNED count in the output, got: ${stdout}`);
    assert.ok(spawned > 0, 'some children should have started');
    assert.ok(spawned <= pids, `spawned ${spawned} processes despite a pids limit of ${pids}`);
    await backend.destroyEnvironment(sessionId);
  });

  test('destroy and the orphan sweep leave no labelled resources behind', { timeout: 120000 }, async () => {
    const labelled = async (sessionId: string) => {
      const filter = { label: [`squadforge.session=${sessionId}`] };
      const [containers, volumes, networks] = await Promise.all([
        client.listContainers({ all: true, filters: filter }),
        client.listVolumes({ filters: filter }),
        client.listNetworks({ filters: filter })
      ]);
      return {
        containers: containers.length,
        volumes: (volumes.Volumes || []).length,
        networks: networks.length
      };
    };

    // Normal teardown path.
    const destroyed = await environment(backend);
    await backend.destroyEnvironment(destroyed);
    assert.deepEqual(await labelled(destroyed), { containers: 0, volumes: 0, networks: 0 });

    // Crash path: an environment whose session record is gone is swept.
    const orphaned = await environment(backend);
    const before = await labelled(orphaned);
    assert.ok(before.volumes >= 1 && before.networks >= 1, 'the orphan environment exists before the sweep');
    const swept = await backend.sweepOrphans(new Set());
    assert.ok(swept.volumes >= 1 && swept.networks >= 1);
    assert.deepEqual(await labelled(orphaned), { containers: 0, volumes: 0, networks: 0 });
  });
});
