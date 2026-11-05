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
              actions: [{ action: 'patch_file', path: 'add.js', edits: [{ find: 'a - b', replace: patches.shift() }] }],
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
});
