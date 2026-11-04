// Real isolation tests. Project code here only ever runs inside Docker containers.
// Run with SANDBOX_INTEGRATION=1, after: docker build -t squadforge-sandbox:1 sandbox
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Docker from 'dockerode';
import { DockerBackend, dockerConfigFromEnv } from '../server/execution/dockerBackend.js';
import { ProcessExit, ProcessSpec, SandboxLimits } from '../server/execution/executionBackend.js';
import { materializeWorkspace } from '../server/execution/workspaceMaterializer.js';

const enabled = process.env.SANDBOX_INTEGRATION === '1';
const limits: SandboxLimits = { memoryMb: 256, cpus: 1, pids: 64, maxRuntimeSeconds: 60, tmpfsMb: 32, workspaceMb: 256 };

describe('Phase 10 sandbox integration', { skip: enabled ? false : 'Set SANDBOX_INTEGRATION=1 to run' }, () => {
  const docker = new Docker();
  const backend = new DockerBackend(docker, dockerConfigFromEnv());
  const created: string[] = [];

  async function environment(files: Record<string, string> = {}): Promise<string> {
    const sessionId = `t${crypto.randomBytes(6).toString('hex')}`;
    created.push(sessionId);
    await backend.createEnvironment({ sessionId, buildId: `bld_${sessionId}`, userId: 'usr_test' });
    const projectFiles = Object.entries(files).map(([path, content]) => ({ path, content, version: 1 }));
    const { archive } = await materializeWorkspace(projectFiles);
    await backend.uploadWorkspace(sessionId, archive);
    return sessionId;
  }

  async function run(
    sessionId: string,
    argv: string[],
    overrides: Partial<ProcessSpec> = {}
  ): Promise<ProcessExit & { stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const handle = await backend.startProcess(
      sessionId,
      { argv, network: 'isolated', limits, ...overrides },
      (stream, text) => {
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      }
    );
    const exit = await handle.wait();
    return { ...exit, stdout, stderr };
  }

  const nodeScript = (source: string) => ['node', '-e', source];

  before(async () => {
    const capabilities = await backend.capabilities();
    assert.equal(capabilities.available, true, capabilities.reason);
  });

  after(async () => {
    await Promise.all(created.map(async id => {
      await backend.destroyEnvironment(id);
      await backend.removeDependencyCache(`bld_${id}`);
    }));
  });

  test('runs as an unprivileged user with no capabilities or new privileges', async () => {
    const sessionId = await environment();
    const result = await run(sessionId, ['sh', '-c', 'id -u; grep -E "CapEff|NoNewPrivs" /proc/self/status']);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^10001/);
    assert.match(result.stdout, /CapEff:\s+0000000000000000/);
    assert.match(result.stdout, /NoNewPrivs:\s+1/);
  });

  test('cannot write to the root filesystem, and has no Docker socket', async () => {
    const sessionId = await environment();
    const result = await run(sessionId, ['sh', '-c', 'touch /etc/x; ls /var/run/docker.sock; echo done']);

    assert.match(result.stderr, /Read-only file system/);
    assert.match(result.stderr, /No such file or directory/);
  });

  test('host secrets are not in the environment', async () => {
    process.env.SANDBOX_TEST_SECRET = 'must-not-leak';
    const sessionId = await environment();
    const result = await run(sessionId, ['env']);
    delete process.env.SANDBOX_TEST_SECRET;

    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stdout, /must-not-leak|API_KEY|ENCRYPTION_SECRET|SMTP_|GITHUB_/);
  });

  test('project files arrive in the workspace and are readable back', async () => {
    const sessionId = await environment({ 'src/hello.txt': 'from the project' });
    const result = await run(sessionId, ['cat', 'src/hello.txt']);

    assert.equal(result.stdout, 'from the project');
    assert.equal((await backend.readWorkspaceFile(sessionId, 'src/hello.txt'))?.toString(), 'from the project');
    assert.equal(await backend.readWorkspaceFile(sessionId, 'missing.txt'), null);
  });

  test('another project workspace is not reachable', async () => {
    const first = await environment({ 'secret.txt': 'project one' });
    const second = await environment();
    const result = await run(second, ['sh', '-c', `ls /workspace; cat /workspace/secret.txt; find / -name secret.txt 2>/dev/null; echo end`]);

    assert.doesNotMatch(result.stdout, /project one|secret\.txt/);
    assert.ok(first);
  });

  test('outbound network, the metadata address, and raw IPs are blocked', async () => {
    const sessionId = await environment();
    const result = await run(sessionId, nodeScript(`
      const targets = ['https://example.com', 'http://169.254.169.254/', 'http://1.1.1.1/'];
      Promise.all(targets.map(url => fetch(url, { signal: AbortSignal.timeout(4000) })
        .then(() => 'REACHED ' + url).catch(() => 'BLOCKED ' + url)))
        .then(lines => console.log(lines.join('\\n')));
    `));

    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /REACHED/);
    assert.equal(result.stdout.match(/BLOCKED/g)?.length, 3);
  });

  test('the host is not reachable from the session network', async () => {
    const listener = await docker.createContainer({
      Image: dockerConfigFromEnv().image,
      Cmd: ['node', '-e', `require('http').createServer((q, s) => s.end('HOST')).listen(39123, '0.0.0.0')`],
      Labels: { 'squadforge.managed': 'true', 'squadforge.role': 'test-listener' },
      HostConfig: { NetworkMode: 'host', AutoRemove: true }
    });
    await listener.start();

    try {
      const sessionId = await environment();
      const result = await run(sessionId, nodeScript(`
        const net = require('net');
        const os = require('os');
        const own = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal).address;
        const prefix = own.split('.').slice(0, 3).join('.');
        const targets = [1, 2, 3, 254].map(n => prefix + '.' + n).filter(ip => ip !== own);
        const probe = host => new Promise(done => {
          const socket = net.connect({ host, port: 39123, timeout: 2000 }, () => { socket.destroy(); done('REACHED ' + host); });
          socket.on('error', () => done('BLOCKED ' + host));
          socket.on('timeout', () => { socket.destroy(); done('BLOCKED ' + host); });
        });
        Promise.all(targets.map(probe)).then(lines => console.log(lines.join('\\n')));
      `));

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /BLOCKED/);
      assert.doesNotMatch(result.stdout, /REACHED/);
    } finally {
      await listener.remove({ force: true }).catch(() => undefined);
    }
  });

  test('the egress proxy is gone once an install finishes', async () => {
    const sessionId = await environment();
    const probe = await run(sessionId, ['true'], { network: 'registry' });
    assert.equal(probe.exitCode, 0);

    const proxies = await docker.listContainers({
      all: true,
      filters: { label: [`squadforge.session=${sessionId}`, 'squadforge.role=egress'] }
    });
    assert.equal(proxies.length, 0);
  });

  test('installs reach the registry through the proxy, and nothing else', async () => {
    const sessionId = await environment({
      'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' } })
    });
    const install = await run(
      sessionId,
      ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', '/cache/npm'],
      { network: 'registry', mountDependencyCache: true }
    );
    assert.equal(install.exitCode, 0, install.stderr);

    const used = await run(sessionId, nodeScript(`console.log(require('is-odd')(3))`));
    assert.match(used.stdout, /true/);

    const denied = await run(sessionId, nodeScript(`
      const net = require('net');
      const socket = net.connect(3128, 'sf-egress-${sessionId}', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n');
      });
      socket.on('data', data => { console.log(String(data).split('\\r\\n')[0]); socket.destroy(); });
      socket.on('error', error => console.log('NO_PROXY', error.code));
    `), { network: 'registry' });
    assert.match(denied.stdout, /403/);
  });

  test('a fork bomb is contained by the process limit', async () => {
    const sessionId = await environment();
    const result = await run(sessionId, ['sh', '-c',
      'i=0; while [ $i -lt 200 ]; do sleep 20 & i=$((i+1)); done; echo finished'
    ], { limits: { ...limits, pids: 32 } });

    assert.match(result.stderr, /fork|Resource temporarily unavailable/i);
  });

  test('a memory hog is killed by the memory limit', async () => {
    const sessionId = await environment();
    const result = await run(sessionId, nodeScript(`
      const blocks = [];
      for (;;) { blocks.push(Buffer.alloc(32 * 1024 * 1024, 1)); }
    `), { limits: { ...limits, memoryMb: 128 } });

    assert.notEqual(result.exitCode, 0);
    assert.ok(result.oomKilled || result.exitCode === 137 || /heap|memory/i.test(result.stderr), result.stderr);
  });

  test('stopping a process ends it, and it is removed', async () => {
    const sessionId = await environment();
    const handle = await backend.startProcess(
      sessionId,
      { argv: ['sleep', '300'], network: 'isolated', limits },
      () => undefined
    );

    await handle.stop();
    const exit = await handle.wait();

    assert.notEqual(exit.exitCode, 0);
    const running = await docker.listContainers({
      all: true,
      filters: { label: [`squadforge.session=${sessionId}`, 'squadforge.role=process'] }
    });
    assert.equal(running.length, 0);
  });

  test('the sandbox cannot write through tmp with executables', async () => {
    const sessionId = await environment();
    const result = await run(sessionId, ['sh', '-c', 'cp /bin/true /tmp/t && /tmp/t; echo "code=$?"']);

    assert.match(result.stdout, /code=126/);
  });

  test('a symlink inside a workspace cannot expose files through read back', async () => {
    const sessionId = await environment();
    await run(sessionId, ['ln', '-s', '/etc/passwd', 'link.txt']);

    assert.equal(await backend.readWorkspaceFile(sessionId, 'link.txt'), null);
  });

  test('the preview relay reaches the project', async () => {
    const sessionId = await environment({
      'server.js': `require('http').createServer((q, s) => s.end('preview-ok')).listen(4173, '0.0.0.0');`
    });
    const handle = await backend.startProcess(
      sessionId,
      { argv: ['node', 'server.js'], network: 'isolated', limits },
      () => undefined
    );

    let ports: number[] = [];
    for (let attempt = 0; attempt < 40 && !ports.includes(4173); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      ports = await backend.listeningPorts(handle.id);
    }
    assert.deepEqual(ports, [4173]);

    const endpoint = await backend.openPreview(sessionId, handle.id, 4173);
    let body = '';
    for (let attempt = 0; attempt < 20 && !body; attempt++) {
      body = await fetch(`http://${endpoint.host}:${endpoint.port}/`).then(r => r.text()).catch(() => '');
      if (!body) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(body, 'preview-ok');

    const usage = await backend.usage(handle.id);
    assert.ok(usage && usage.memoryBytes > 0 && usage.workspaceBytes > 0);

    await backend.closePreview(sessionId);
    await handle.stop();
    await handle.wait();
  });

  test('destroying an environment removes its containers, network, and volume', async () => {
    const sessionId = await environment({ 'a.txt': 'a' });
    await backend.startProcess(sessionId, { argv: ['sleep', '300'], network: 'isolated', limits }, () => undefined);

    await backend.destroyEnvironment(sessionId);

    const containers = await docker.listContainers({ all: true, filters: { label: [`squadforge.session=${sessionId}`] } });
    assert.equal(containers.length, 0);
    assert.equal((await backend.listEnvironments()).some(e => e.sessionId === sessionId), false);
    await assert.rejects(docker.getVolume(`sf-ws-${sessionId}`).inspect());
    await assert.rejects(docker.getNetwork(`sf-net-${sessionId}`).inspect());
  });

  test('a traversal path is rejected before an archive is built', async () => {
    await assert.rejects(materializeWorkspace([{ path: '../../etc/evil', content: 'x', version: 1 }]));
  });
});
