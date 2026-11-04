import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { smartRouter } from '../server/smartRouter.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
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
