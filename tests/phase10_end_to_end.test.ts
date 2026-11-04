// Full flow through the real routes, Docker backend, relay, and preview proxy.
// Run with SANDBOX_INTEGRATION=1, after: docker build -t squadforge-sandbox:1 sandbox
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const enabled = process.env.SANDBOX_INTEGRATION === '1';

const viteProject = {
  'package.json': JSON.stringify({
    name: 'e2e-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: { dev: 'vite', test: 'node --test' },
    devDependencies: { vite: '7.1.5' }
  }),
  'index.html': '<!doctype html><html><body><h1 id="app">Hello from the sandbox</h1></body></html>',
  'app.test.js': `import test from 'node:test';\ntest('passes', () => {});\n`
};

describe('Phase 10 end to end', { skip: enabled ? false : 'Set SANDBOX_INTEGRATION=1 to run' }, () => {
  let app: any;
  let db: any;
  let resolveUser: any;
  let executionManager: any;
  let previewService: any;
  let ExecutionAdapter: any;
  let apiServer: http.Server;
  let previewServer: http.Server;
  let api: string;
  let previewPort: number;
  let buildId: string;
  let sessionId: string;
  let ownerCookie: string;
  let otherCookie: string;

  function visit(ip: string) {
    const req: any = { cookies: {}, headers: {}, ip };
    const res: any = { cookie: (name: string, value: string) => { req.cookies[name] = value; } };
    const user = resolveUser(req, res);
    return { user, cookie: Object.entries(req.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  const call = (path: string, cookie: string, method = 'GET', body?: unknown) => fetch(`${api}${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  function throughProxy(host: string, path: string, cookie?: string) {
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: previewPort,
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

  async function approveAndRetry(path: string, body?: unknown) {
    const first: any = await (await call(path, ownerCookie, 'POST', body)).json();
    if (!first.approvalRequired) return first;
    const decided = await call(
      `/api/builds/${buildId}/collaboration/approvals/${first.approvalRequired.id}/respond`,
      ownerCookie,
      'POST',
      { approved: true }
    );
    assert.equal(decided.status, 200);
    return (await call(path, ownerCookie, 'POST', body)).json();
  }

  before(async () => {
    process.env.EXECUTION_BACKEND = 'docker';
    ({ db } = await import('../server/store.js'));
    ({ app, resolveUser } = await import('../server.js'));
    ({ executionManager, previewService } = await import('../server/execution/index.js'));
    ({ ExecutionAdapter } = await import('../server/swarm/executionAdapter.js'));
    const { createPreviewServer } = await import('../server/execution/previewProxy.js');

    apiServer = app.listen(0, '127.0.0.1');
    previewServer = createPreviewServer(previewService);
    previewServer.listen(0, '127.0.0.1');
    await Promise.all([
      new Promise(resolve => apiServer.once('listening', resolve)),
      new Promise(resolve => previewServer.once('listening', resolve))
    ]);
    api = `http://127.0.0.1:${(apiServer.address() as any).port}`;
    previewPort = (previewServer.address() as any).port;

    const owner = visit('10.0.0.1');
    ownerCookie = owner.cookie;
    otherCookie = visit('10.0.0.2').cookie;

    buildId = `bld_e2e_${Date.now()}`;
    db.saveBuild({
      id: buildId,
      userId: owner.user.id,
      idea: 'End to end fixture',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 2,
      maxDurationSeconds: 120,
      patchesAppliedCount: 0
    });
    for (const [path, content] of Object.entries(viteProject)) {
      db.setFile(buildId, { path, content, version: 1, ownerModel: 'system', history: [], createdAt: Date.now(), updatedAt: Date.now() });
    }
  });

  after(async () => {
    if (sessionId) await executionManager.destroySession(buildId, sessionId).catch(() => undefined);
    await executionManager.backend.removeDependencyCache(buildId);
    previewServer.closeAllConnections();
    apiServer.closeAllConnections();
    await Promise.all([
      new Promise(resolve => previewServer.close(resolve)),
      new Promise(resolve => apiServer.close(resolve))
    ]);
  });

  test('a generated project installs, serves a preview, and stays private', { timeout: 180000 }, async () => {
    const root = `/api/builds/${buildId}/execution`;

    const capabilities: any = await (await call(`${root}/capabilities`, ownerCookie)).json();
    assert.equal(capabilities.capabilities.available, true, capabilities.capabilities.reason);

    assert.equal((await call(`${root}/sessions`, otherCookie, 'POST')).status, 403);

    const session: any = await approveAndRetry(`${root}/sessions`);
    assert.equal(session.status, 'ready');
    sessionId = session.id;

    // No lockfile, so the install asks for approval and saves the versions it chose
    await approveAndRetry(`${root}/sessions/${sessionId}/dependencies`);
    await executionManager.waitForProcess(sessionId);
    const installed = db.getExecutionSession(sessionId);
    assert.equal(installed.dependencyStatus, 'installed', JSON.stringify(db.getExecutionLogs(sessionId).slice(-5)));
    assert.ok(db.getFile(buildId, 'package-lock.json'), 'the generated lockfile must be saved');

    const started = await call(`${root}/sessions/${sessionId}/start`, ownerCookie, 'POST', { script: 'dev' });
    assert.equal(started.status, 200);

    const opened: any = await (await call(`${root}/sessions/${sessionId}/preview`, ownerCookie, 'POST')).json();
    assert.ok(opened.url, JSON.stringify(opened));

    const url = new URL(opened.url);
    const host = `${opened.previewId}.preview.localhost`;

    assert.equal((await throughProxy(host, '/')).status, 403, 'no cookie, no preview');

    const redeemed = await throughProxy(host, url.pathname + url.search);
    assert.equal(redeemed.status, 302);
    const cookie = redeemed.headers['set-cookie']![0].split(';')[0];

    let page = await throughProxy(host, '/', cookie);
    for (let attempt = 0; attempt < 20 && page.status !== 200; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      page = await throughProxy(host, '/', cookie);
    }
    assert.equal(page.status, 200, page.body);
    assert.match(page.body, /Hello from the sandbox/);

    // Vite hot reload connects over a WebSocket through the same proxy
    const socketOpened = await new Promise<boolean>(resolve => {
      const req = http.request({
        host: '127.0.0.1',
        port: previewPort,
        path: '/',
        headers: {
          Host: host,
          Cookie: cookie,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Protocol': 'vite-hmr'
        }
      });
      req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(true); });
      req.on('response', () => resolve(false));
      req.on('error', () => resolve(false));
      req.end();
    });
    assert.equal(socketOpened, true, 'hot reload must work through the proxy');

    const usage: any = await (await call(`${root}/sessions/${sessionId}/usage`, ownerCookie)).json();
    assert.ok(usage.usage.memoryBytes > 0);

    const logs: any = await (await call(`${root}/sessions/${sessionId}/logs`, ownerCookie)).json();
    assert.ok(logs.logs.some((entry: any) => /VITE|vite/.test(entry.text)), 'real dev server output must be captured');

    assert.equal((await call(`${root}/sessions/${sessionId}/logs`, otherCookie)).status, 403);

    const stopped = await call(`${root}/sessions/${sessionId}/stop`, ownerCookie, 'POST');
    assert.equal(stopped.status, 200);
    assert.equal((await throughProxy(host, '/', cookie)).status, 403, 'a stopped project has no preview');
  });

  test('sandbox test results feed verification', { timeout: 60000 }, async () => {
    const root = `/api/builds/${buildId}/execution`;

    // Tests get a fresh session, because the dev run could have changed the volume
    await call(`${root}/sessions/${sessionId}`, ownerCookie, 'DELETE');
    const fresh: any = await approveAndRetry(`${root}/sessions`);
    assert.equal(fresh.status, 'ready', JSON.stringify(fresh));
    sessionId = fresh.id;
    await approveAndRetry(`${root}/sessions/${sessionId}/dependencies`);
    await executionManager.waitForProcess(sessionId);

    const started = await call(`${root}/sessions/${sessionId}/start`, ownerCookie, 'POST', { script: 'test' });
    assert.equal(started.status, 200, await started.clone().text());
    await executionManager.waitForProcess(sessionId);

    const report = ExecutionAdapter.runIsolatedTests(buildId, db.getAllFiles(buildId));
    assert.equal(report.status, 'passed', JSON.stringify(db.getExecutionLogs(sessionId).slice(-5)));
  });
});
