import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { smartRouter } from '../server/smartRouter.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { CodeGenerationEngine } from '../server/swarm/codeGenerationEngine.js';
import { quotaManager } from '../server/quotaManager.js';
import { PatchValidationPipeline } from '../server/swarm/patchValidationPipeline.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';

const userId = 'usr_p9_gate';
let counter = 0;

function makeBuild(prefix: string): string {
  const id = `bld_gate_${prefix}_${Date.now()}_${++counter}`;
  const saved = db.saveBuild({
    id,
    userId,
    idea: 'Gate bypass regression',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 25,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  });
  assert.ok(saved);
  return id;
}

beforeEach(() => {
  db.createUser({
    id: userId,
    email: 'gate@p9.test',
    name: 'Gate Tester',
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini'],
    createdAt: Date.now()
  });
});

describe('Phase 9 approval gate bypasses', () => {
  test('a batch rename cannot move a file onto a sensitive path without approval', async () => {
    const buildId = makeBuild('rename');

    const result = await MergeManager.applyBatchActions(buildId, 'gemini', [
      { action: 'create_file', path: 'src/x.ts', content: 'export const x = 1;\n' },
      { action: 'rename_file', oldPath: 'src/x.ts', newPath: 'src/auth.ts' }
    ]);

    assert.equal(result.success, false);
    assert.match(result.error || '', /Human approval required/);
    assert.equal(db.getFile(buildId, 'src/auth.ts'), undefined);
    assert.equal(db.getFile(buildId, 'src/x.ts'), undefined);
  });

  for (const actor of ['system', ' System ']) {
    test(`a patch cannot claim the "${actor}" actor`, () => {
      const buildId = makeBuild('patch_actor');

      const result = PatchValidationPipeline.proposePatch(buildId, userId, {
        authorAgent: actor,
        authorRole: 'backend_developer',
        targetFile: '.env',
        baseFileVersion: 0,
        proposedChanges: { actionType: 'create', content: 'SECRET=1' },
        changeExplanation: 'Attempt to skip the approval gate'
      } as any);

      assert.equal(result.success, false);
      assert.match(result.error || '', /reserved/);
    });
  }

  test('conflict resolution cannot claim the system actor', async () => {
    const buildId = makeBuild('conflict_actor');

    const result = await PatchValidationPipeline.resolveConflict(buildId, userId, {
      conflictId: 'conflict_any',
      resolvedBy: 'system',
      resolvedContent: 'SECRET=1',
      resolutionExplanation: 'Attempt to skip the approval gate'
    });

    assert.equal(result.success, false);
    assert.match(result.error || '', /reserved/);
  });

  test('updating a model cannot change its id', () => {
    const [model] = modelRegistry.getAll();

    const updated = modelRegistry.updateModel(model.id, { id: 'system' } as any);

    assert.equal(updated?.id, model.id);
  });
});

describe('Approvals cover the reviewed change', () => {
  const sensitivePath = 'server/crypto.ts';
  const reviewed = { action: 'create_file', path: sensitivePath, content: 'export const reviewed = 1;\n' };
  const other = { action: 'create_file', path: sensitivePath, content: 'export const swapped = 1;\n' };

  function approvedRequest(buildId: string, actions: any[] = [reviewed]) {
    const hashes = ApprovalGateService.fingerprintActions(actions);
    const { request } = ApprovalGateService.requestApproval(buildId, userId, {
      requestingAgent: 'gemini',
      requestingRole: 'security_specialist',
      operationType: 'security_sensitive_change',
      explanation: 'Sensitive change',
      affectedFiles: Object.keys(hashes),
      proposedChanges: 'Reviewed content',
      contentHashes: hashes
    });
    assert.ok(request);
    const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: request.id, approved: true });
    assert.equal(decided.success, true);
    return request;
  }

  test('different content cannot use the approval', async () => {
    const buildId = makeBuild('content');
    approvedRequest(buildId);

    const result = await MergeManager.applyBatchActions(buildId, 'gemini', [other]);

    assert.equal(result.success, false);
    assert.equal(db.getFile(buildId, sensitivePath), undefined);
  });

  test('the reviewed content can be applied, once', async () => {
    const buildId = makeBuild('once');
    approvedRequest(buildId);

    assert.equal((await MergeManager.applyBatchActions(buildId, 'gemini', [reviewed])).success, true);

    const again = await MergeManager.applyBatchActions(buildId, 'gemini', [{
      action: 'delete_file',
      path: sensitivePath
    }]);
    assert.equal(again.success, false);
    assert.ok(db.getFile(buildId, sensitivePath));
  });

  test('a later rejection overrides an earlier approval', async () => {
    const buildId = makeBuild('reject');
    approvedRequest(buildId);
    const { request } = ApprovalGateService.requestApproval(buildId, userId, {
      requestingAgent: 'gemini',
      requestingRole: 'security_specialist',
      operationType: 'security_sensitive_change',
      explanation: 'Second look',
      affectedFiles: [sensitivePath],
      proposedChanges: 'Same file'
    });
    await new Promise(resolve => setTimeout(resolve, 2));
    ApprovalGateService.respondToApproval(buildId, userId, { requestId: request!.id, approved: false });

    assert.equal((await MergeManager.applyBatchActions(buildId, 'gemini', [reviewed])).success, false);
  });

  test('the owner can revoke an approval, and nobody else can', async () => {
    const buildId = makeBuild('revoke');
    const request = approvedRequest(buildId);

    assert.equal(ApprovalGateService.revokeApproval(buildId, 'usr_someone_else', request.id).success, false);
    assert.equal(ApprovalGateService.revokeApproval(buildId, userId, request.id).success, true);

    assert.equal((await MergeManager.applyBatchActions(buildId, 'gemini', [reviewed])).success, false);
  });

  test('validity runs from creation, not from the decision', async () => {
    const buildId = makeBuild('ttl');
    const request = approvedRequest(buildId);
    const stored = db.getApprovalRequest(request.id)!;
    db.saveApprovalRequest({ ...stored, createdAt: Date.now() - 25 * 60 * 60 * 1000, resolvedAt: Date.now() });

    assert.equal((await MergeManager.applyBatchActions(buildId, 'gemini', [reviewed])).success, false);
  });

  test('a run pauses, and approval applies exactly what was reviewed', async (t) => {
    const buildId = makeBuild('resume');
    let calls = 0;
    t.mock.method(smartRouter, 'executeSmartRequest', async () => {
      calls += 1;
      return {
        success: true,
        rawText: '',
        parsedResponse: { thinking: 'Write', actions: [calls === 1 ? reviewed : other] },
        tokensUsed: 1,
        modelId: 'gemini',
        actualModelUsed: 'gemini',
        providerUsed: 'gemini',
        isFallback: false,
        latencyMs: 1
      } as any;
    });

    const paused = await CodeGenerationEngine.runGenerationPipeline({ buildId, userId, userRequest: 'Change server/crypto.ts' });
    assert.equal(paused.status, 'pending_approval');
    assert.equal(db.getFile(buildId, sensitivePath), undefined);

    const [request] = db.getApprovalRequests(buildId, 'pending');
    assert.match(request.proposedChanges, /reviewed = 1/, 'the owner must see the real change');
    const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: request.id, approved: true });

    const continued = await CodeGenerationEngine.continueApprovedRun(decided.request!, userId);

    assert.ok(continued);
    assert.equal(db.getFile(buildId, sensitivePath)?.content, reviewed.content);
    assert.equal(calls, 1, 'the model must not be asked again');
    assert.equal(db.getGenerationRun(paused.id)?.status, 'cancelled');
    assert.deepEqual(db.getApprovalRequest(request.id)?.consumedFiles, [sensitivePath]);
  });

  test('cancelling a paused run withdraws its request', async () => {
    const buildId = makeBuild('cancel_pending');
    const paused = await CodeGenerationEngine.runGenerationPipeline({
      buildId,
      userId,
      userRequest: 'Change server/crypto.ts',
      mockAiResponse: { thinking: 'Write', actions: [reviewed] } as any
    });
    assert.equal(paused.status, 'pending_approval');

    CodeGenerationEngine.cancelRun(paused.id, 'Not needed');

    assert.equal(db.getApprovalRequests(buildId, 'pending').length, 0);
  });

  test('sensitive detection covers common secret and auth files', () => {
    for (const path of [
      'src/authService.ts', 'server/auth_guard.ts', 'src/middleware/authMiddleware.ts', 'config/credentials.json',
      'src/lib/tokens.ts', 'config/secrets.yaml', 'package-lock.json', '.npmrc', '.github/workflows/ci.yml',
      'Dockerfile', 'certs/server.pem'
    ]) {
      assert.equal(ApprovalGateService.isSensitiveFilePath(path), true, path);
    }
    for (const path of ['src/components/AuthorCard.tsx', 'src/utils/calc.ts', 'src/tokenizer.ts', 'README.md']) {
      assert.equal(ApprovalGateService.isSensitiveFilePath(path), false, path);
    }
    assert.equal(ApprovalGateService.isSensitiveFilePath('src/AUTHService.ts'), true);
    assert.equal(ApprovalGateService.isSensitiveFilePath('docker-compose.yml'), true);
    assert.equal(ApprovalGateService.isSensitiveFilePath('src/design-tokens.css'), false);
  });

  for (const path of [' .env', '.env ', 'server//gateway.ts', '.github//workflows/ci.yml', ' package.json']) {
    test(`a batch cannot hide a sensitive file as ${JSON.stringify(path)}`, async () => {
      const buildId = makeBuild('spaced');

      const result = await MergeManager.applyBatchActions(buildId, 'gemini', [
        { action: 'create_file', path, content: 'x' }
      ]);

      assert.equal(result.success, false);
      assert.match(result.error || '', /Human approval required/);
      assert.equal(db.getAllFiles(buildId).length, 0);
    });
  }

  test('extra actions on an approved file are refused', async () => {
    const buildId = makeBuild('duplicate');
    approvedRequest(buildId);

    const result = await MergeManager.applyBatchActions(buildId, 'gemini', [
      { action: 'patch_file', path: sensitivePath, find: 'a', replace: 'evil' },
      reviewed
    ]);

    assert.equal(result.success, false);
  });

  test('an approval without a content fingerprint authorizes nothing', async () => {
    const buildId = makeBuild('unbound');
    const { request } = ApprovalGateService.requestApproval(buildId, userId, {
      requestingAgent: 'gemini',
      requestingRole: 'security_specialist',
      operationType: 'security_sensitive_change',
      explanation: 'No content',
      affectedFiles: [sensitivePath],
      proposedChanges: 'Unknown'
    });
    ApprovalGateService.respondToApproval(buildId, userId, { requestId: request!.id, approved: true });

    assert.equal((await MergeManager.applyBatchActions(buildId, 'gemini', [reviewed])).success, false);
  });

  test('a request cannot continue another build\'s run', async () => {
    const victimBuild = makeBuild('victim');
    const paused = await CodeGenerationEngine.runGenerationPipeline({
      buildId: victimBuild,
      userId,
      userRequest: 'Change server/crypto.ts',
      mockAiResponse: { thinking: 'Write', actions: [reviewed] } as any
    });
    const attackerBuild = makeBuild('attacker');
    const { request } = ApprovalGateService.requestApproval(attackerBuild, userId, {
      patchId: paused.id,
      requestingAgent: 'gemini',
      requestingRole: 'security_specialist',
      operationType: 'security_sensitive_change',
      explanation: 'Foreign run',
      affectedFiles: [],
      proposedChanges: 'x',
      proposedActions: [{ action: 'create_file', path: 'src/a.ts', content: 'x' }]
    });

    const continued = await CodeGenerationEngine.continueApprovedRun(request!, userId);

    assert.equal(continued, null);
    assert.equal(db.getGenerationRun(paused.id)?.status, 'pending_approval');
  });

  test('a stale approved patch does not land on a changed file', async () => {
    const buildId = makeBuild('stale');
    await MergeManager.createFile(buildId, 'system', { action: 'create_file', path: sensitivePath, content: 'one two' } as any);
    const patch = { action: 'patch_file', path: sensitivePath, edits: [{ find: 'one', replace: 'three' }] };
    const { request } = ApprovalGateService.requestForActions(buildId, userId, { agent: 'gemini', actions: [patch] });
    const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: request!.id, approved: true });
    await MergeManager.applyPatch(buildId, 'system', { action: 'patch_file', path: sensitivePath, edits: [{ find: 'two', replace: 'four' }] } as any);

    await CodeGenerationEngine.continueApprovedRun(decided.request!, userId);

    assert.equal(db.getFile(buildId, sensitivePath)?.content, 'one four');
  });

  test('patches to one file are version checked once', () => {
    const buildId = makeBuild('two_patches');
    db.setFile(buildId, { path: sensitivePath, content: 'a b', version: 3, ownerModel: 'system', history: [], createdAt: Date.now(), updatedAt: Date.now() } as any);
    const first = { action: 'patch_file', path: sensitivePath, edits: [{ find: 'a', replace: 'c' }] };
    const second = { action: 'patch_file', path: sensitivePath, edits: [{ find: 'b', replace: 'd' }] };

    const { request } = ApprovalGateService.requestForActions(buildId, userId, { agent: 'gemini', actions: [first, second] });

    assert.equal(request?.proposedActions?.[0].expectedVersion, 3);
    assert.equal(request?.proposedActions?.[1].expectedVersion, undefined);
  });

  test('the owner edits through the user actor, which nobody else can claim', async () => {
    const buildId = makeBuild('owner_edit');

    const edited = await MergeManager.createFile(buildId, 'user', { action: 'create_file', path: sensitivePath, content: 'x' } as any);
    assert.equal(edited.success, true);

    const claimed = PatchValidationPipeline.proposePatch(buildId, userId, {
      authorAgent: 'user',
      authorRole: 'backend_developer',
      targetFile: '.env',
      baseFileVersion: 0,
      proposedChanges: { actionType: 'create', content: 'SECRET=1' },
      changeExplanation: 'Attempt to skip the approval gate'
    } as any);
    assert.equal(claimed.success, false);
  });
});

describe('Swarm tasks with sensitive files', () => {
  const dockerfile = { action: 'create_file', path: 'Dockerfile', content: 'FROM node:22\n' };
  const ordinary = { action: 'create_file', path: 'src/app.ts', content: 'export const app = 1;\n' };

  async function runTask(t: any, buildId: string, actions: any[]) {
    const router = t.mock.method(smartRouter, 'executeSmartRequest', async () => ({
      success: true,
      rawText: '',
      parsedResponse: { thinking: 'Write', actions },
      tokensUsed: 1,
      modelId: 'gemini',
      actualModelUsed: 'gemini',
      providerUsed: 'gemini',
      isFallback: false,
      latencyMs: 1
    }) as any);

    const id = `task_held_${Date.now()}_${++counter}`;
    db.addTask(buildId, {
      id,
      buildId,
      title: 'Write files',
      description: 'Write files',
      status: 'in_progress',
      claimedBy: 'gemini',
      priority: 1,
      dependencies: [],
      filePaths: actions.map(a => a.path),
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as any);
    await (SwarmOrchestrator as any).executeTaskWork(buildId, modelRegistry.getAll()[0], db.getTask(buildId, id));
    return { id, router };
  }

  function decide(buildId: string, approved: boolean) {
    const [request] = db.getApprovalRequests(buildId, 'pending');
    const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: request.id, approved });
    assert.equal(decided.success, true);
    return SwarmOrchestrator.resolveHeldTask(decided.request!);
  }

  test('a task with only held files waits once, instead of retrying the model', async (t) => {
    const buildId = makeBuild('only_held');

    const { id, router } = await runTask(t, buildId, [dockerfile]);

    assert.equal(router.mock.callCount(), 1);
    assert.equal(db.getTask(buildId, id)?.status, 'paused');
    assert.equal(db.getApprovalRequests(buildId, 'pending').length, 1);
    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
  });

  test('a mixed task applies ordinary files and does not report complete', async (t) => {
    const buildId = makeBuild('mixed');

    const { id } = await runTask(t, buildId, [dockerfile, ordinary]);

    assert.ok(db.getFile(buildId, 'src/app.ts'));
    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
    assert.equal(db.getTask(buildId, id)?.status, 'paused');
    assert.equal(db.getPatchProposals(buildId).length, 0, 'a held change must not be recorded as applied');
  });

  test('approval applies the held change and completes the task', async (t) => {
    const buildId = makeBuild('held_approved');
    const { id } = await runTask(t, buildId, [dockerfile]);

    await decide(buildId, true);

    assert.equal(db.getFile(buildId, 'Dockerfile')?.content, dockerfile.content);
    assert.equal(db.getTask(buildId, id)?.status, 'completed');
  });

  test('rejection fails the task, so the build cannot finish as a success', async (t) => {
    const buildId = makeBuild('held_rejected');
    const { id } = await runTask(t, buildId, [dockerfile]);

    await decide(buildId, false);

    assert.equal(db.getFile(buildId, 'Dockerfile'), undefined);
    assert.equal(db.getTask(buildId, id)?.status, 'failed');
  });

  test('rejecting a task other tasks depend on fails the build instead of leaving it running', async (t) => {
    const buildId = makeBuild('held_dependents');
    const { id } = await runTask(t, buildId, [dockerfile]);
    db.addTask(buildId, {
      id: `task_dependent_${Date.now()}`,
      buildId,
      title: 'Needs the Dockerfile',
      description: 'Needs the Dockerfile',
      status: 'pending',
      priority: 1,
      dependencies: [id],
      filePaths: ['src/later.ts'],
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as any);

    await decide(buildId, false);

    const build = db.getBuild(buildId);
    assert.equal(build?.status, 'failed');
    assert.match(build?.failureReason || '', /rejected by the owner/);
  });

  test('Stop withdraws waiting requests', async (t) => {
    const buildId = makeBuild('held_stop');
    await runTask(t, buildId, [dockerfile]);

    SwarmOrchestrator.stopSwarm(buildId);

    assert.equal(db.getApprovalRequests(buildId, 'pending').length, 0);
  });
});

describe('Cancellation records', () => {
  test('a cancellation made by another process stops the run', async (t) => {
    const buildId = makeBuild('other_process');
    const started = new Promise<string>(resolve => {
      t.mock.method(smartRouter, 'executeSmartRequest', async () => {
        const [{ id }] = CodeGenerationEngine.getActiveRunsForBuild(buildId);
        resolve(id);
        // Another process writes straight to storage, so this process's abort never fires
        (db as any).dbManager.db.prepare(
          `UPDATE code_generation_runs SET status = 'cancelled', cancellation_reason = 'Other process' WHERE id = ?`
        ).run(id);
        return {
          success: true,
          rawText: '',
          parsedResponse: { thinking: 'Write', actions: [{ action: 'create_file', path: 'src/late.ts', content: 'export const a = 1;\n' }] },
          tokensUsed: 1,
          modelId: 'gemini',
          actualModelUsed: 'gemini',
          providerUsed: 'gemini',
          isFallback: false,
          latencyMs: 1
        } as any;
      });
    });

    const run = await CodeGenerationEngine.runGenerationPipeline({ buildId, userId, userRequest: 'Create src/late.ts' });
    await started;

    assert.equal(run.status, 'cancelled');
    assert.equal(run.cancellationReason, 'Other process');
    assert.equal(db.getFile(buildId, 'src/late.ts'), undefined);
  });

  test('the cancellation reason survives in storage', async () => {
    const buildId = makeBuild('persist');
    const paused = await CodeGenerationEngine.runGenerationPipeline({
      buildId,
      userId,
      userRequest: 'Change server/crypto.ts',
      mockAiResponse: {
        thinking: 'Write',
        actions: [{ action: 'create_file', path: 'server/crypto.ts', content: 'export const a = 1;\n' }]
      } as any
    });

    CodeGenerationEngine.cancelRun(paused.id, 'Kept reason');

    assert.equal(db.getStoredRunCancellation(paused.id)?.reason, 'Kept reason');
    assert.equal(db.getGenerationRunsByBuild(buildId)[0].cancellationReason, 'Kept reason');
  });

  test('cancelled requests report no cost', async () => {
    const controller = new AbortController();
    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gemini',
      prompt: 'Prompt',
      signal: (() => { controller.abort(); return controller.signal; })()
    });

    assert.equal(result.errorCode, 'CANCELLED');
    assert.ok(!result.estimatedCost);
  });

  test('an abort while reading an error body is not a provider failure', async (t) => {
    const previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    t.after(() => {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    });
    const controller = new AbortController();
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => {
        controller.abort();
        throw new Error('aborted');
      }
    }) as any);
    t.mock.method(quotaManager, 'isProviderAvailable', () => ({ available: true }) as any);
    const recordOutcome = t.mock.method(quotaManager, 'recordOutcome', () => undefined as any);

    const result = await (smartRouter as any).executeCloudCall({
      model: { id: 'm', displayName: 'M', provider: 'openrouter', providerModel: 'm' },
      prompt: 'Prompt',
      systemInstruction: 'System',
      allowFallback: true,
      signal: controller.signal
    });

    assert.equal(result.errorCode, 'CANCELLED');
    assert.equal(recordOutcome.mock.callCount(), 0);
  });
});

describe('Swarm stop', () => {
  test('stopSwarm aborts model requests, and a late response writes nothing', async (t) => {
    const buildId = makeBuild('stop');
    const control = { stopRequested: false, workerCount: 0, abortController: new AbortController() };
    const swarms = (SwarmOrchestrator as any).activeSwarms as Map<string, unknown>;
    swarms.set(buildId, control);
    t.after(() => swarms.delete(buildId));

    let receivedSignal: AbortSignal | undefined;
    const router = t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
      receivedSignal = params.signal;
      SwarmOrchestrator.stopSwarm(buildId);
      return {
        success: true,
        rawText: '',
        parsedResponse: {
          thinking: 'Create a file',
          actions: [{ action: 'create_file', path: 'src/late.ts', content: 'export const late = 1;\n' }]
        },
        tokensUsed: 1,
        modelId: 'gemini',
        actualModelUsed: 'gemini',
        providerUsed: 'gemini',
        isFallback: false,
        latencyMs: 1
      } as any;
    });

    const task = db.addTask(buildId, {
      id: `task_stop_${Date.now()}`,
      buildId,
      title: 'Create a file',
      description: 'Create a file',
      status: 'in_progress',
      priority: 1,
      dependencies: [],
      filePaths: ['src/late.ts'],
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as any);

    await (SwarmOrchestrator as any).executeTaskWork(
      buildId,
      modelRegistry.getAll()[0],
      task ?? db.getTasks(buildId)[0]
    );

    assert.equal(receivedSignal?.aborted, true);
    assert.equal(router.mock.callCount(), 1, 'Stop must prevent further attempts');
    assert.equal(db.getFile(buildId, 'src/late.ts'), undefined);
  });
});
