import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { app } from '../server.js';
import { db } from '../server/store.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { smartRouter } from '../server/smartRouter.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { TaskManager } from '../server/swarm/taskManager.js';

const ownerId = 'usr_p9_limits_owner';
const strangerId = 'usr_p9_limits_stranger';
const dockerfile = { action: 'create_file', path: 'Dockerfile', content: 'FROM node:22\n' };
const ordinary = { action: 'create_file', path: 'src/app.ts', content: 'export const app = 1;\n' };
const followUp = { action: 'create_task', title: 'Document the image', description: 'Explain the Dockerfile' };
let counter = 0;

function makeBuild(prefix: string, status: any = 'running'): string {
  const id = `bld_limits_${prefix}_${Date.now()}_${++counter}`;
  assert.ok(db.saveBuild({
    id,
    userId: ownerId,
    idea: 'Limitation regression',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 25,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  }));
  return id;
}

function addClaimedTask(buildId: string, filePaths: string[]) {
  const id = `task_limits_${Date.now()}_${++counter}`;
  db.addTask(buildId, {
    id,
    buildId,
    title: 'Write files',
    description: 'Write files',
    status: 'in_progress',
    claimedBy: 'gemini',
    leaseExpiresAt: Date.now() + 90_000,
    priority: 1,
    dependencies: [],
    filePaths,
    createdAt: Date.now(),
    updatedAt: Date.now()
  } as any);
  return id;
}

function mockModel(t: any, actions: any[], during?: () => void) {
  return t.mock.method(smartRouter, 'executeSmartRequest', async () => {
    during?.();
    return {
      success: true,
      rawText: '',
      parsedResponse: { thinking: 'Write', actions },
      tokensUsed: 1,
      modelId: 'gemini',
      actualModelUsed: 'gemini',
      providerUsed: 'gemini',
      isFallback: false,
      latencyMs: 1
    } as any;
  });
}

async function runTask(t: any, buildId: string, actions: any[], filePaths?: string[], during?: (id: string) => void) {
  const paths = filePaths ?? actions.filter(a => a.path).map(a => a.path);
  const id = addClaimedTask(buildId, paths);
  mockModel(t, actions, () => during?.(id));
  await (SwarmOrchestrator as any).executeTaskWork(buildId, modelRegistry.getAll()[0], db.getTask(buildId, id));
  return id;
}

function decide(buildId: string, approved: boolean) {
  const [request] = db.getApprovalRequests(buildId, 'pending');
  const decided = ApprovalGateService.respondToApproval(buildId, ownerId, { requestId: request.id, approved });
  assert.equal(decided.success, true);
  return SwarmOrchestrator.resolveHeldTask(decided.request!);
}

const patchedFiles = (buildId: string) => db.getPatchProposals(buildId).map(p => p.targetFile).sort();

let workers: ReturnType<typeof mock.method>;

// A decision can restart the swarm, and real workers would outlive the test
afterEach(() => workers.mock.restore());

beforeEach(() => {
  workers = mock.method(SwarmOrchestrator as any, 'runModelWorkerLoop', async () => undefined);
  for (const id of [ownerId, strangerId]) {
    db.createUser({
      id,
      email: `${id}@p9.test`,
      name: id,
      githubConnected: false,
      costLimitPerBuild: 25,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    });
  }
});

describe('Held swarm tasks', () => {
  test('tasks in a held response wait for approval, then are created', async (t) => {
    const buildId = makeBuild('followup');
    await runTask(t, buildId, [dockerfile, followUp]);

    const titles = () => db.getTasks(buildId).map(task => task.title);
    assert.ok(!titles().includes(followUp.title));
    assert.match(db.getApprovalRequests(buildId, 'pending')[0].proposedChanges, /New task: Document the image/);

    await decide(buildId, true);

    assert.ok(titles().includes(followUp.title));
    assert.ok(db.getFile(buildId, 'Dockerfile'));
  });

  test('tasks in a held response are dropped when the owner rejects', async (t) => {
    const buildId = makeBuild('followup_rejected');
    await runTask(t, buildId, [dockerfile, followUp]);

    await decide(buildId, false);

    assert.ok(!db.getTasks(buildId).some(task => task.title === followUp.title));
  });

  test('a held response records ordinary files now, and sensitive files on approval', async (t) => {
    const buildId = makeBuild('records');
    await runTask(t, buildId, [dockerfile, ordinary]);
    assert.deepEqual(patchedFiles(buildId), ['src/app.ts']);

    await decide(buildId, true);

    assert.deepEqual(patchedFiles(buildId), ['Dockerfile', 'src/app.ts']);
  });

  test('approval still runs the completion check, so a missing file fails the task', async (t) => {
    const buildId = makeBuild('verify');
    const id = await runTask(t, buildId, [dockerfile], ['Dockerfile', 'src/never-written.ts']);

    await decide(buildId, true);

    const task = db.getTask(buildId, id);
    assert.equal(task?.status, 'failed');
    assert.equal(task?.isPaused, false);
    assert.ok(db.getFile(buildId, 'Dockerfile'), 'the approved change itself was applied');
  });

  test('approval completes a task whose files all exist', async (t) => {
    const buildId = makeBuild('verified');
    const id = await runTask(t, buildId, [dockerfile]);

    await decide(buildId, true);

    assert.equal(db.getTask(buildId, id)?.status, 'completed');
  });

  test('a worker that lost its lease cannot pause the task or request approval', async (t) => {
    const buildId = makeBuild('lease');
    const newLease = Date.now() + 500_000;
    const id = await runTask(t, buildId, [dockerfile, ordinary], undefined, taskId => {
      db.updateTask(buildId, taskId, { claimedBy: 'other-worker', leaseExpiresAt: newLease });
    });

    const task = db.getTask(buildId, id);
    assert.equal(task?.status, 'in_progress');
    assert.equal(task?.claimedBy, 'other-worker');
    assert.equal(task?.isPaused ?? false, false);
    assert.equal(db.getApprovalRequests(buildId, 'pending').length, 0);
    assert.equal(db.getFile(buildId, 'src/app.ts'), undefined);
  });

  test('a reclaim by the same model also ends the old claim', () => {
    const buildId = makeBuild('reclaim');
    const id = addClaimedTask(buildId, ['Dockerfile']);
    const stale = db.getTask(buildId, id)!;
    assert.equal(TaskManager.holdsClaim(buildId, stale), true);

    db.updateTask(buildId, id, { leaseExpiresAt: (stale.leaseExpiresAt || 0) + 1000 });

    assert.equal(TaskManager.holdsClaim(buildId, stale), false);
  });

  test('stopping withdraws the request, and resuming puts the task back on the board', async (t) => {
    const buildId = makeBuild('resume');
    const id = await runTask(t, buildId, [dockerfile]);

    SwarmOrchestrator.stopSwarm(buildId);
    assert.equal(db.getApprovalRequests(buildId, 'pending').length, 0);
    assert.equal(db.getTask(buildId, id)?.status, 'paused');

    assert.equal(await SwarmOrchestrator.resumeSwarm(buildId), true);

    const task = db.getTask(buildId, id);
    assert.equal(task?.isPaused, false);
    assert.notEqual(task?.status, 'paused');
  });
});

describe('Planner files', () => {
  const plan = (build: any) => (SwarmOrchestrator as any).applyPlannedFiles(build, [dockerfile, ordinary, followUp], 'ms_1');

  test('a sensitive file waits for the owner instead of being dropped', async () => {
    const buildId = makeBuild('planner');
    await plan(db.getBuild(buildId));

    assert.ok(db.getFile(buildId, 'src/app.ts'));
    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
    const [request] = db.getApprovalRequests(buildId, 'pending');
    assert.deepEqual(request.affectedFiles, ['Dockerfile']);
    assert.equal(db.getTask(buildId, request.taskId!)?.status, 'paused');

    await decide(buildId, true);

    assert.equal(db.getFile(buildId, 'Dockerfile')?.content, dockerfile.content);
    assert.equal(db.getTask(buildId, request.taskId!)?.status, 'completed');
  });

  test('a rejected file is not written, and its task reports the failure', async () => {
    const buildId = makeBuild('planner_rejected');
    await plan(db.getBuild(buildId));
    const [request] = db.getApprovalRequests(buildId, 'pending');

    await decide(buildId, false);

    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
    assert.equal(db.getTask(buildId, request.taskId!)?.status, 'failed');
  });
});

describe('Approval and model routes over HTTP', () => {
  let server: Server;
  let base: string;
  const tokens: Record<string, string> = {};

  before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    for (const id of [ownerId, strangerId]) {
      tokens[id] = crypto.randomBytes(24).toString('hex');
      db.createSession(id, tokens[id]);
    }
  });

  const post = (path: string, userId: string, body: unknown = {}, method = 'POST') => fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[userId]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(check(), true);
  };

  const heldRequest = async (t: any, prefix: string) => {
    const buildId = makeBuild(prefix);
    const taskId = await runTask(t, buildId, [dockerfile]);
    const [request] = db.getApprovalRequests(buildId, 'pending');
    return { buildId, taskId, request, path: `/api/builds/${buildId}/collaboration/approvals/${request.id}` };
  };

  test('the owner approves through the route, and the change is applied', async (t) => {
    const { buildId, taskId, path } = await heldRequest(t, 'http_approve');

    const res = await post(`${path}/respond`, ownerId, { approved: true });

    assert.equal(res.status, 200);
    await until(() => db.getTask(buildId, taskId)?.status === 'completed');
    assert.ok(db.getFile(buildId, 'Dockerfile'));
  });

  test('another user cannot decide or revoke', async (t) => {
    const { buildId, request, path } = await heldRequest(t, 'http_stranger');

    assert.equal((await post(`${path}/respond`, strangerId, { approved: true })).status, 403);
    assert.equal((await post(`${path}/revoke`, strangerId)).status, 403);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'pending');
    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
  });

  test('a decision must be a boolean', async (t) => {
    const { request, path } = await heldRequest(t, 'http_invalid');

    assert.equal((await post(`${path}/respond`, ownerId, { approved: 'yes' })).status, 400);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'pending');
  });

  test('a late decision expires the request and fails the waiting task', async (t) => {
    const { buildId, taskId, request, path } = await heldRequest(t, 'http_expired');
    db.saveApprovalRequest({ ...request, createdAt: Date.now() - 25 * 60 * 60 * 1000 });

    assert.equal((await post(`${path}/respond`, ownerId, { approved: true })).status, 400);

    assert.equal(db.getApprovalRequest(request.id)?.status, 'expired');
    await until(() => db.getTask(buildId, taskId)?.status === 'failed');
    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
  });

  test('a revoked approval cannot authorize its change', async () => {
    const buildId = makeBuild('http_revoke');
    const { request } = ApprovalGateService.requestForActions(buildId, ownerId, { agent: 'gemini', actions: [dockerfile] });
    assert.ok(request);
    ApprovalGateService.respondToApproval(buildId, ownerId, { requestId: request.id, approved: true });
    const fingerprints = ApprovalGateService.fingerprintActions([dockerfile]);
    assert.equal(ApprovalGateService.hasApprovedRequestForFiles(buildId, ['Dockerfile'], fingerprints), true);

    const res = await post(`/api/builds/${buildId}/collaboration/approvals/${request.id}/revoke`, ownerId);

    assert.equal(res.status, 200);
    assert.equal(ApprovalGateService.hasApprovedRequestForFiles(buildId, ['Dockerfile'], fingerprints), false);
  });

  describe('in production', () => {
    const saved = { env: process.env.NODE_ENV, admins: process.env.MODEL_ADMIN_USER_IDS };

    before(() => {
      process.env.NODE_ENV = 'production';
      process.env.MODEL_ADMIN_USER_IDS = ` ${ownerId} , usr_other `;
    });

    after(() => {
      process.env.NODE_ENV = saved.env;
      if (saved.admins === undefined) delete process.env.MODEL_ADMIN_USER_IDS;
      else process.env.MODEL_ADMIN_USER_IDS = saved.admins;
    });

    test('only a listed administrator can change shared models', async () => {
      const [model] = modelRegistry.getAll();
      const body = { displayName: model.displayName };

      assert.equal((await post(`/api/models/${model.id}`, strangerId, body, 'PUT')).status, 403);
      assert.equal((await post(`/api/models/${model.id}`, ownerId, body, 'PUT')).status, 200);
    });

    test('nobody can change shared models when no administrator is set', async () => {
      const admins = process.env.MODEL_ADMIN_USER_IDS;
      delete process.env.MODEL_ADMIN_USER_IDS;
      try {
        const [model] = modelRegistry.getAll();
        const res = await post(`/api/models/${model.id}`, ownerId, { displayName: model.displayName }, 'PUT');
        assert.equal(res.status, 403);
      } finally {
        process.env.MODEL_ADMIN_USER_IDS = admins;
      }
    });
  });
});
