// Repairs through the real routes, approval flow, and Docker backend. The model is scripted.
// Run with SANDBOX_INTEGRATION=1, after: docker build -t squadforge-sandbox:1 sandbox
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const enabled = process.env.SANDBOX_INTEGRATION === '1';

const brokenSource = 'export const add = (a, b) => a - b;\n';
const project = {
  'package.json': JSON.stringify({ name: 'repair-fixture', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }),
  'add.js': brokenSource,
  'add.test.js': [
    `import test from 'node:test';`,
    `import assert from 'node:assert/strict';`,
    `import { add } from './add.js';`,
    `test('adds numbers', () => assert.equal(add(2, 3), 5));`,
    `test('adds zero', () => assert.equal(add(2, 0), 2));`,
    ''
  ].join('\n')
};

describe('Phase 11 sandbox repair', { skip: enabled ? false : 'Set SANDBOX_INTEGRATION=1 to run' }, () => {
  let app: any;
  let db: any;
  let resolveUser: any;
  let executionManager: any;
  let smartRouter: any;
  let repairCoordinator: any;
  let apiServer: http.Server;
  let api: string;
  let buildId: string;
  let cookie: string;
  let patches: string[];
  let edit: { path: string; find: string; replace: string } | undefined;
  let userId: string;

  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${api}${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  const decide = async (approvalId: string) => {
    const response = await call(`/api/builds/${buildId}/collaboration/approvals/${approvalId}/respond`, 'POST', { approved: true });
    assert.equal(response.status, 200);
  };

  async function waitFor(repairId: string, statuses: string[]) {
    const deadline = Date.now() + 120000;
    for (;;) {
      const { repair } = await (await call(`/api/builds/${buildId}/debugging/repairs/${repairId}`)).json() as any;
      if (statuses.includes(repair.status)) return repair;
      assert.ok(Date.now() < deadline, `Repair stuck at ${repair.status}: ${repair.outcome}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  async function runScript(script: string) {
    const root = `/api/builds/${buildId}/execution`;
    const create = async () => (await call(`${root}/sessions`, 'POST', {})).json() as any;
    let session = await create();
    if (session.approvalRequired) {
      await decide(session.approvalRequired.id);
      session = await create();
    }
    const started = await call(`${root}/sessions/${session.id}/start`, 'POST', { script });
    assert.equal(started.status, 200);
    await executionManager.waitForProcess(session.id);
    return session.id as string;
  }

  /** Starts a repair from the failing test run, then approves running its tests. */
  async function repairWith(replacement: string) {
    patches = [replacement];
    const response = await call(`/api/builds/${buildId}/debugging/repairs`, 'POST', {});
    assert.equal(response.status, 200);
    const { repair } = await response.json() as any;

    const held = await waitFor(repair.id, ['awaiting_test_approval', 'failed']);
    assert.equal(held.status, 'awaiting_test_approval', held.outcome);
    await decide(held.pendingApproval.requestId);
    return waitFor(repair.id, ['verified', 'rolled_back', 'applied_unverified', 'failed']);
  }

  async function useProject(name: string, files: Record<string, string>) {
    const { MergeManager } = await import('../server/swarm/mergeManager.js');
    buildId = `bld_p11_${name}_${Date.now()}`;
    db.saveBuild({
      id: buildId, userId, idea: name, status: 'completed', createdAt: Date.now(), updatedAt: Date.now(), selectedModels: ['gemini'],
      autoPushGithub: false, totalTokens: 0, totalCost: 0, costLimit: 2, maxDurationSeconds: 120, patchesAppliedCount: 0
    });
    const seeded = await MergeManager.applyBatchActions(buildId, 'system',
      Object.entries(files).map(([path, content]) => ({ action: 'create_file', path, content })));
    assert.equal(seeded.success, true, seeded.error);
  }

  /** Approves each thing the repair asks for, until it ends. */
  async function approveUntilDone(repairId: string, waitMs = 280000) {
    const decided = new Set<string>();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const { repair } = await (await call(`/api/builds/${buildId}/debugging/repairs/${repairId}`)).json() as any;
      if (['verified', 'rolled_back', 'applied_unverified', 'failed', 'rejected'].includes(repair.status)) return repair;
      assert.ok(Date.now() < deadline, `Repair stuck at ${repair.status}: ${repair.outcome}`);
      const requestId = repair.pendingApproval?.requestId;
      if (requestId && !decided.has(requestId)) {
        decided.add(requestId);
        await decide(requestId);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  async function startRepair(body: unknown = {}) {
    const response = await call(`/api/builds/${buildId}/debugging/repairs`, 'POST', body);
    assert.equal(response.status, 200);
    return ((await response.json()) as any).repair.id as string;
  }

  /** A syntax error to repair, its test, and an unrelated test that fails if it ever runs. */
  const scopedProject = (runner: 'vitest' | 'jest') => {
    const header = runner === 'vitest' ? `import { test, expect } from 'vitest';\n` : '';
    const load = runner === 'vitest' ? `import { add } from './math.js';` : `const { add } = require('./math');`;
    const source = 'const add = (a, b) => { return a + b;\n';
    return {
      'package.json': JSON.stringify({
        name: `scoped-${runner}`,
        version: '1.0.0',
        private: true,
        ...(runner === 'vitest' ? { type: 'module' } : {}),
        scripts: { test: runner === 'vitest' ? 'vitest run' : 'jest' },
        devDependencies: runner === 'vitest' ? { vitest: '3.2.4' } : { jest: '29.7.0' }
      }),
      'src/math.js': source + (runner === 'vitest' ? 'export { add };\n' : 'module.exports = { add };\n'),
      'src/math.test.js': `${header}${load}\ntest('adds', () => expect(add(1, 2)).toBe(3));\n`,
      'src/unrelated.test.js': `${header}test('must not run', () => { throw new Error('This test was not affected'); });\n`
    };
  };

  before(async () => {
    process.env.EXECUTION_BACKEND = 'docker';
    ({ db } = await import('../server/store.js'));
    ({ app, resolveUser } = await import('../server.js'));
    ({ executionManager } = await import('../server/execution/index.js'));
    ({ smartRouter } = await import('../server/smartRouter.js'));
    ({ repairCoordinator } = await import('../server/debugging/index.js'));
    const { MergeManager } = await import('../server/swarm/mergeManager.js');

    smartRouter.executeSmartRequest = async (params: any) => {
      const system = String(params.systemInstruction);
      const parsedResponse = system.includes('You investigate')
        ? { actions: [], report: { hypothesis: 'add subtracts', evidence: [], filesToChange: ['add.js'] } }
        : system.includes('You review')
          ? { actions: [], report: { approved: true, reason: 'Addresses the failing test' } }
          : {
              actions: [edit
                ? { action: 'patch_file', path: edit.path, edits: [{ find: edit.find, replace: edit.replace }] }
                : { action: 'patch_file', path: 'add.js', edits: [{ find: 'a - b', replace: patches.shift() }] }],
              report: { explanation: 'Correct the operator' }
            };
      return { success: true, rawText: '', parsedResponse, tokensUsed: 1, modelId: 'gemini', actualModelUsed: 'gemini', providerUsed: 'gemini', isFallback: false, latencyMs: 1 };
    };

    apiServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => apiServer.once('listening', resolve));
    api = `http://127.0.0.1:${(apiServer.address() as any).port}`;

    const req: any = { cookies: {}, headers: {}, ip: '10.0.11.1' };
    const res: any = { cookie: (name: string, value: string) => { req.cookies[name] = value; } };
    const user = resolveUser(req, res);
    userId = user.id;
    cookie = Object.entries(req.cookies).map(([key, value]) => `${key}=${value}`).join('; ');

    buildId = `bld_p11_sandbox_${Date.now()}`;
    db.saveBuild({
      id: buildId,
      userId: user.id,
      idea: 'Repair fixture',
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
    const seeded = await MergeManager.applyBatchActions(buildId, 'system',
      Object.entries(project).map(([path, content]) => ({ action: 'create_file', path, content })));
    assert.equal(seeded.success, true, seeded.error);
  });

  after(async () => {
    for (const session of db.getLiveExecutionSessions().filter((item: any) => item.buildId === buildId)) {
      await executionManager.destroySession(buildId, session.id).catch(() => undefined);
    }
    await executionManager.backend.removeDependencyCache(buildId);
    apiServer.closeAllConnections();
    await new Promise(resolve => apiServer.close(resolve));
  });

  test('a real failing test is diagnosed from sandbox output', { timeout: 120000 }, async () => {
    await runScript('test');

    const { report, rootCauses } = await (await call(`/api/builds/${buildId}/debugging/analyze`, 'POST', {})).json() as any;

    assert.ok(report.diagnostics.some((item: any) => item.kind === 'test' && item.source === 'sandbox'));
    assert.equal(rootCauses[0].category, 'test_failure');
  });

  test('a patch that passes static checks but fails real tests is undone', { timeout: 180000 }, async () => {
    // a * b looks fine to every static check, and add(2, 3) is 6
    const run = await repairWith('a * b');

    assert.equal(run.status, 'rolled_back', run.outcome);
    assert.equal(run.verification.tests.status, 'failed');
    assert.equal(run.verification.tests.scope, 'full', 'node --test cannot be scoped safely');
    assert.equal(run.verification.tests.exitCode, 1);
    assert.equal(db.getFile(buildId, 'add.js').content, brokenSource);
  });

  test('a correct patch is verified by a real test run and teaches the project', { timeout: 180000 }, async () => {
    await runScript('test');
    const run = await repairWith('a + b');

    assert.equal(run.status, 'verified', run.outcome);
    assert.equal(run.verification.tests.status, 'passed');
    assert.equal(run.verification.tests.exitCode, 0);
    assert.equal(db.getFile(buildId, 'add.js').content, 'export const add = (a, b) => a + b;\n');

    const { lessons } = await (await call(`/api/builds/${buildId}/debugging/lessons`)).json() as any;
    assert.ok(lessons.some((lesson: any) => lesson.outcome === 'verified'));
    assert.ok(lessons.some((lesson: any) => lesson.outcome === 'failed'), 'the earlier failure stays remembered');

    await repairCoordinator.settled(run.id);
  });

  for (const runner of ['vitest', 'jest'] as const) {
    test(`real ${runner} runs only the affected tests`, { timeout: 300000 }, async () => {
      await useProject(`scoped_${runner}`, scopedProject(runner));
      edit = { path: 'src/math.js', find: '{ return a + b;', replace: '{ return a + b; };' };

      const run = await approveUntilDone(await startRepair());

      assert.equal(run.status, 'verified', JSON.stringify({ outcome: run.outcome, tests: run.verification?.tests }));
      assert.equal(run.verification.tests.scope, 'affected');
      assert.equal(run.verification.tests.exitCode, 0, 'the unrelated failing test must not have run');
      assert.deepEqual(run.verification.tests.affectedTests, ['src/math.test.js']);
    });
  }

  const serverHead = [
    `import http from 'node:http';`,
    `const routes = new Map();`,
    `const app = { get: (path, handler) => routes.set(path, handler) };`
  ];
  const serverTail = [
    `http.createServer((req, res) => {`,
    `  try { res.end(String(routes.get(req.url)?.() ?? 'ok')); }`,
    `  catch { res.statusCode = 500; res.end('error'); }`,
    `}).listen(process.env.PORT || 3000, '0.0.0.0');`,
    ''
  ];
  const serverPackage = JSON.stringify({ name: 'server-fixture', version: '1.0.0', private: true, type: 'module', scripts: { start: 'node server.js' } });

  test('a real crash at start is proven fixed by the server staying up', { timeout: 200000 }, async () => {
    const crash = `const settings = JSON.parse('{}');\nconsole.log(settings.db.url);`;
    await useProject('crash', {
      'package.json': serverPackage,
      'server.js': [...serverHead, crash, `app.get('/api/health', () => 'up');`, ...serverTail].join('\n')
    });
    await runScript('start');
    edit = { path: 'server.js', find: 'settings.db.url', replace: 'settings.db?.url' };

    const run = await approveUntilDone(await startRepair());

    assert.equal(run.status, 'verified', JSON.stringify({ outcome: run.outcome, runtime: run.verification?.runtime, attempts: run.attempts?.map((a: any) => a.detail), causes: run.rootCauses?.map((c: any) => c.summary) }));
    assert.equal(run.verification.runtime.survived, true);
    assert.deepEqual(run.verification.runtime.probes, [{ path: '/api/health', status: 200 }]);
  });

  test('a real 500 is found by calling the route, and proven fixed the same way', { timeout: 200000 }, async () => {
    await useProject('route', {
      'package.json': serverPackage,
      'server.js': [...serverHead, `app.get('/api/users', () => { const users = undefined; return users.length; });`, ...serverTail].join('\n')
    });

    const root = `/api/builds/${buildId}/execution`;
    const create = async () => (await call(`${root}/sessions`, 'POST', {})).json() as any;
    let session = await create();
    if (session.approvalRequired) {
      await decide(session.approvalRequired.id);
      session = await create();
    }
    assert.equal((await call(`${root}/sessions/${session.id}/start`, 'POST', { script: 'start' })).status, 200);

    const analysis = await (await call(`/api/builds/${buildId}/debugging/analyze`, 'POST', { probeSessionId: session.id })).json() as any;
    assert.ok(analysis.report.diagnostics.some((item: any) => item.message === 'GET /api/users returned 500'), JSON.stringify(analysis));

    edit = { path: 'server.js', find: 'const users = undefined;', replace: 'const users = [];' };
    const run = await approveUntilDone(await startRepair({ probeSessionId: session.id }));

    assert.equal(run.status, 'verified', JSON.stringify({ outcome: run.outcome, runtime: run.verification?.runtime, attempts: run.attempts?.map((a: any) => a.detail), causes: run.rootCauses?.map((c: any) => c.summary) }));
    assert.deepEqual(run.verification.runtime.probes, [{ path: '/api/users', status: 200 }]);
  });
});
