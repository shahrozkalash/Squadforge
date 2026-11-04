import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { getGoogleGenAI } from '../server/gateway.js';
import { localLLMService } from '../server/localLLM.js';
import { quotaManager } from '../server/quotaManager.js';
import { smartRouter } from '../server/smartRouter.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { CodeGenerationEngine } from '../server/swarm/codeGenerationEngine.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { CodeGenerationRun, GatewayResult, ModelConfig } from '../server/types.js';

const ownerId = 'usr_p9_owner';
const otherUserId = 'usr_p9_other';
let counter = 0;

function makeBuild(prefix: string, userId = ownerId): string {
  const id = `bld_${prefix}_${Date.now()}_${++counter}`;
  const saved = db.saveBuild({
    id,
    userId,
    idea: 'Phase 9 approval and cancellation',
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
  assert.ok(saved, 'test build must be saved');
  return id;
}

function makeApproval(buildId: string, userId = ownerId) {
  const result = ApprovalGateService.requestApproval(buildId, userId, {
    requestingAgent: 'gemini-2.5-pro',
    requestingRole: 'security_specialist',
    operationType: 'security_sensitive_change',
    explanation: 'Change a sensitive file',
    affectedFiles: ['server/crypto.ts'],
    proposedChanges: 'Update crypto settings'
  });
  assert.ok(result.request, 'approval request must be created');
  return result.request;
}

function gatewayResult(overrides: Partial<GatewayResult>): GatewayResult {
  return {
    success: false,
    rawText: '',
    parsedResponse: null,
    tokensUsed: 0,
    modelId: 'test',
    actualModelUsed: 'test',
    providerUsed: 'none',
    isFallback: false,
    latencyMs: 1,
    ...overrides
  };
}

function successfulActions(path: string): GatewayResult {
  return gatewayResult({
    success: true,
    tokensUsed: 10,
    parsedResponse: {
      thinking: 'Create a file',
      actions: [{ action: 'create_file', path, content: 'export const value = 1;\n' }]
    } as any
  });
}

function isRegistered(runId: string): boolean {
  return (CodeGenerationEngine as any).activeRuns.has(runId);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function activeRunId(buildId: string): string {
  const runs = CodeGenerationEngine.getActiveRunsForBuild(buildId);
  assert.equal(runs.length, 1, 'exactly one run must be active');
  return runs[0].id;
}

function abortableFetch(calls: Array<{ url: string; signal: AbortSignal }>) {
  return (url: any, init: any) => new Promise<Response>((_, reject) => {
    calls.push({ url: String(url), signal: init.signal });
    init.signal.addEventListener('abort', () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

beforeEach(() => {
  for (const id of [ownerId, otherUserId]) {
    db.createUser({
      id,
      email: `${id}@p9.test`,
      name: 'backend_developer',
      githubConnected: false,
      costLimitPerBuild: 25,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    });
  }
});

describe('Phase 9 approval authorization', () => {
  test('the build owner can approve, and the session user is recorded as approver', () => {
    const buildId = makeBuild('owner');
    const request = makeApproval(buildId);

    const result = ApprovalGateService.respondToApproval(buildId, ownerId, {
      requestId: request.id,
      approved: true,
      approvedBy: 'Display Name'
    });

    assert.equal(result.success, true);
    assert.equal(result.request?.status, 'approved');
    assert.equal(db.getApprovalRequest(request.id)?.approvedBy, ownerId);
  });

  test('another authenticated user cannot approve, even when claiming the owner identity', () => {
    const buildId = makeBuild('other_user');
    const request = makeApproval(buildId);

    const result = ApprovalGateService.respondToApproval(buildId, otherUserId, {
      requestId: request.id,
      approved: true,
      approvedBy: ownerId
    });

    assert.equal(result.success, false);
    assert.match(result.error || '', /Unauthorized/);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'pending');
  });

  test('the removed human_reviewer identity has no special access', () => {
    const buildId = makeBuild('reviewer');
    const request = makeApproval(buildId);

    const result = ApprovalGateService.respondToApproval(buildId, 'human_reviewer', {
      requestId: request.id,
      approved: true,
      approvedBy: 'human_reviewer'
    });

    assert.equal(result.success, false);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'pending');
  });

  test('a guest cannot approve another guest request', () => {
    const guestOwner = `guest_owner_${Date.now()}`;
    const buildId = makeBuild('guest', ownerId);
    const build = db.getBuild(buildId)!;
    db.saveBuild({ ...build, userId: guestOwner });
    const request = makeApproval(buildId, guestOwner);

    const result = ApprovalGateService.respondToApproval(buildId, `guest_other_${Date.now()}`, {
      requestId: request.id,
      approved: true
    });

    assert.equal(result.success, false);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'pending');
  });

  test('an AI agent cannot approve its own request', () => {
    const buildId = makeBuild('agent');
    const request = makeApproval(buildId);

    for (const approvedBy of [request.requestingAgent, request.requestingRole, 'agent_security']) {
      const result = ApprovalGateService.respondToApproval(buildId, ownerId, {
        requestId: request.id,
        approved: true,
        approvedBy
      });
      assert.equal(result.success, false);
      assert.match(result.error || '', /Agents cannot approve/);
    }

    const asAgent = ApprovalGateService.respondToApproval(buildId, request.requestingAgent, {
      requestId: request.id,
      approved: true
    });
    assert.equal(asAgent.success, false);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'pending');
  });

  test('an expired request cannot be approved and does not authorize changes', () => {
    const buildId = makeBuild('expired');
    const request = makeApproval(buildId);
    db.saveApprovalRequest({ ...request, createdAt: Date.now() - 25 * 60 * 60 * 1000 });

    const result = ApprovalGateService.respondToApproval(buildId, ownerId, {
      requestId: request.id,
      approved: true
    });

    assert.equal(result.success, false);
    assert.match(result.error || '', /expired/);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'expired');
    assert.equal(ApprovalGateService.hasApprovedRequestForFiles(buildId, ['server/crypto.ts']), false);
  });

  test('a request from another build cannot be approved', () => {
    const buildA = makeBuild('build_a');
    const buildB = makeBuild('build_b');
    const requestB = makeApproval(buildB);

    const result = ApprovalGateService.respondToApproval(buildA, ownerId, {
      requestId: requestB.id,
      approved: true
    });

    assert.equal(result.success, false);
    assert.match(result.error || '', /not found in this build/);
    assert.equal(db.getApprovalRequest(requestB.id)?.status, 'pending');
  });

  test('repeated approval or rejection is rejected', () => {
    const buildId = makeBuild('repeat');
    const request = makeApproval(buildId);
    const decide = (approved: boolean) => ApprovalGateService.respondToApproval(buildId, ownerId, {
      requestId: request.id,
      approved
    });

    assert.equal(decide(true).success, true);
    assert.match(decide(true).error || '', /already resolved/);
    assert.match(decide(false).error || '', /already resolved/);
    assert.equal(db.getApprovalRequest(request.id)?.status, 'approved');
  });

  test('no identity, and builds without an owner, cannot be approved', (t) => {
    const buildId = makeBuild('no_identity');
    const request = makeApproval(buildId);

    const legacy = ApprovalGateService.respondToApproval(buildId, request.id, 'approved');
    assert.equal(legacy.success, false);

    const build = db.getBuild(buildId)!;
    t.mock.method(db, 'getBuild', () => ({ ...build, userId: '' }));
    const ownerless = ApprovalGateService.respondToApproval(buildId, ownerId, {
      requestId: request.id,
      approved: true
    });
    assert.equal(ownerless.success, false);
  });
});

describe('Phase 9 cancellation', () => {
  test('cancelling during an active model request aborts it and ends the run', async (t) => {
    const buildId = makeBuild('active_request');
    const requestStarted = deferred<AbortSignal>();
    t.mock.method(smartRouter, 'executeSmartRequest', (params: any) => new Promise<GatewayResult>(resolve => {
      requestStarted.resolve(params.signal);
      params.signal.addEventListener('abort', () => {
        resolve(gatewayResult({ error: 'Model request cancelled', errorCode: 'CANCELLED' }));
      }, { once: true });
    }));

    const runPromise = CodeGenerationEngine.runGenerationPipeline({ buildId, userRequest: 'Create src/a.ts' });
    const signal = await requestStarted.promise;
    const runId = activeRunId(buildId);

    assert.equal(signal.aborted, false);
    assert.equal(CodeGenerationEngine.cancelRun(runId, 'User pressed stop'), true);
    assert.equal(signal.aborted, true, 'cancelRun must abort the signal given to the model request');

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.cancellationReason, 'User pressed stop');
    assert.equal(db.getGenerationRun(runId)?.status, 'cancelled');
    assert.equal(isRegistered(runId), false, 'cancellation state must be cleaned up');
  });

  test('a late model response cannot apply files or overwrite a cancelled run', async (t) => {
    const buildId = makeBuild('late_response');
    const requestStarted = deferred();
    const release = deferred();
    t.mock.method(smartRouter, 'executeSmartRequest', async () => {
      requestStarted.resolve();
      await release.promise;
      return successfulActions('src/late.ts');
    });

    const runPromise = CodeGenerationEngine.runGenerationPipeline({ buildId, userRequest: 'Create src/late.ts' });
    await requestStarted.promise;
    const runId = activeRunId(buildId);
    CodeGenerationEngine.cancelRun(runId, 'Stop before response');
    release.resolve();

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    assert.equal(db.getFile(buildId, 'src/late.ts'), undefined);
    assert.equal(db.getGenerationRun(runId)?.status, 'cancelled');
  });

  test('cancelling immediately before patch application writes nothing', async () => {
    const buildId = makeBuild('before_patch');
    const holdQueue = deferred();
    const queueHolder = MergeManager.enqueuePatch(buildId, () => holdQueue.promise);

    const runPromise = CodeGenerationEngine.runGenerationPipeline({
      buildId,
      userRequest: 'Create src/queued.ts',
      mockAiResponse: {
        thinking: 'Create a file',
        actions: [{ action: 'create_file', path: 'src/queued.ts', content: 'export const queued = 1;\n' }]
      } as any
    });

    // The pipeline is now waiting behind queueHolder, just before its write
    const runId = activeRunId(buildId);
    CodeGenerationEngine.cancelRun(runId, 'Stop before patch');
    holdQueue.resolve();
    await queueHolder;

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(run.filesCreated, []);
    assert.equal(db.getFile(buildId, 'src/queued.ts'), undefined);
    assert.equal(isRegistered(runId), false);
  });

  test('applyBatchActions refuses an aborted signal without touching files', async () => {
    const buildId = makeBuild('aborted_batch');
    const controller = new AbortController();
    controller.abort();

    const result = await MergeManager.applyBatchActions(
      buildId,
      'gemini',
      [{ action: 'create_file', path: 'src/aborted.ts', content: 'export const a = 1;\n' }],
      { signal: controller.signal }
    );

    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(db.getFile(buildId, 'src/aborted.ts'), undefined);
  });

  test('files completed before cancellation are preserved and reported', async (t) => {
    const buildId = makeBuild('preserve');
    const repairStarted = deferred();
    t.mock.method(smartRouter, 'executeSmartRequest', (params: any) => new Promise<GatewayResult>(resolve => {
      repairStarted.resolve();
      params.signal.addEventListener('abort', () => {
        resolve(gatewayResult({ error: 'Model request cancelled', errorCode: 'CANCELLED' }));
      }, { once: true });
    }));

    const runPromise = CodeGenerationEngine.runGenerationPipeline({
      buildId,
      userRequest: 'Create src/broken.ts',
      mockAiResponse: {
        thinking: 'Create a file with a syntax error',
        actions: [{ action: 'create_file', path: 'src/broken.ts', content: 'export const broken = {;\n' }]
      } as any
    });

    await repairStarted.promise;
    CodeGenerationEngine.cancelRun(activeRunId(buildId), 'Stop during repair');

    const run = await runPromise;
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(run.filesCreated, ['src/broken.ts']);
    assert.ok(db.getFile(buildId, 'src/broken.ts'), 'completed files must remain after cancellation');
  });

  test('a stale writer cannot move a cancelled run to finalized', () => {
    const buildId = makeBuild('stale_writer');
    const run: CodeGenerationRun = {
      id: `run_stale_${Date.now()}`,
      buildId,
      userRequest: 'Stale writer',
      generationProfile: 'website_and_web_app',
      modelId: 'gemini',
      status: 'cancelled',
      currentPass: 2,
      totalPasses: 6,
      passes: [],
      filesCreated: [],
      filesModified: [],
      patchIds: [],
      contractsEstablished: [],
      repairAttempts: 0,
      repairLogs: [],
      tokenUsage: 0,
      cost: 0,
      createdAt: Date.now()
    };
    db.saveGenerationRun(run);

    const result = db.saveGenerationRun({ ...run, status: 'finalized' });

    assert.equal(result.status, 'cancelled');
    assert.equal(db.getGenerationRun(run.id)?.status, 'cancelled');
  });

  test('run state is cleaned up after a run fails', async (t) => {
    const buildId = makeBuild('cleanup');
    t.mock.method(smartRouter, 'executeSmartRequest', async () => gatewayResult({ error: 'Provider failed' }));

    const run = await CodeGenerationEngine.runGenerationPipeline({ buildId, userRequest: 'Create src/a.ts' });

    assert.equal(run.status, 'failed');
    assert.equal(isRegistered(run.id), false);
  });
});

describe('Phase 9 provider cancellation', () => {
  const openRouterModel = {
    id: 'test-openrouter',
    displayName: 'Test OpenRouter',
    provider: 'openrouter',
    providerModel: 'test/model'
  } as ModelConfig;
  const geminiModel = {
    id: 'test-gemini',
    displayName: 'Test Gemini',
    provider: 'gemini',
    providerModel: 'gemini-test'
  } as ModelConfig;

  function withEnv(t: any, values: Record<string, string>) {
    const previous = Object.keys(values).map(key => [key, process.env[key]] as const);
    Object.assign(process.env, values);
    t.after(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  test('OpenRouter fetch is aborted, with no fallback and no provider failure recorded', async (t) => {
    withEnv(t, { OPENROUTER_API_KEY: 'test-key', GEMINI_API_KEY: 'test-key' });
    const calls: Array<{ url: string; signal: AbortSignal }> = [];
    t.mock.method(globalThis, 'fetch', abortableFetch(calls) as any);
    const generate = t.mock.method(getGoogleGenAI()!.models, 'generateContent', async () => ({ text: '{}' }) as any);
    t.mock.method(quotaManager, 'isProviderAvailable', () => ({ available: true }) as any);
    const recordOutcome = t.mock.method(quotaManager, 'recordOutcome', () => undefined as any);

    const controller = new AbortController();
    const pending = (smartRouter as any).executeCloudCall({
      model: openRouterModel,
      prompt: 'Prompt',
      systemInstruction: 'System',
      allowFallback: true,
      signal: controller.signal
    });
    assert.equal(calls.length, 1);
    controller.abort();

    const result: GatewayResult = await pending;
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(result.errorCode, 'CANCELLED');
    assert.equal(generate.mock.callCount(), 0, 'a cancelled request must not start a fallback provider');
    assert.equal(recordOutcome.mock.callCount(), 0);
  });

  test('Gemini receives the abort signal and returns as soon as it is cancelled', async (t) => {
    withEnv(t, { GEMINI_API_KEY: 'test-key' });
    let received: AbortSignal | undefined;
    t.mock.method(getGoogleGenAI()!.models, 'generateContent', (request: any) => {
      received = request.config.abortSignal;
      return new Promise(() => undefined) as any;
    });
    const recordOutcome = t.mock.method(quotaManager, 'recordOutcome', () => undefined as any);

    const controller = new AbortController();
    const pending = (smartRouter as any).executeGeminiCall({
      model: geminiModel,
      prompt: 'Prompt',
      systemInstruction: 'System',
      isFallbackRun: false,
      signal: controller.signal
    });
    controller.abort();

    const result: GatewayResult = await pending;
    assert.equal(received, controller.signal);
    assert.equal(result.errorCode, 'CANCELLED');
    assert.equal(recordOutcome.mock.callCount(), 0);
  });

  test('a local model request is aborted', async (t) => {
    const calls: Array<{ url: string; signal: AbortSignal }> = [];
    t.mock.method(globalThis, 'fetch', abortableFetch(calls) as any);

    const controller = new AbortController();
    const pending = localLLMService.callLocalModel({ prompt: 'Prompt', signal: controller.signal });
    assert.equal(calls.length, 1);
    controller.abort();

    const result = await pending;
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(result.errorCode, 'CANCELLED');
  });

  test('the router does not start a request that is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gemini',
      prompt: 'Prompt',
      signal: controller.signal
    });

    assert.equal(result.errorCode, 'CANCELLED');
    assert.equal(result.providerUsed, 'none');
  });
});
