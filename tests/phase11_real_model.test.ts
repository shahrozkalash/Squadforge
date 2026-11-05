// Repairs with a real model through the real gateway. Nothing about the model is scripted.
// Run with LOCAL_MODEL_INTEGRATION=1, against an OpenAI-compatible server such as Ollama:
//   LOCAL_MODEL_NAME (default qwen2.5:7b), LOCAL_MODEL_URL (default http://127.0.0.1:11434/v1)
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { Build, RepairRun, User } from '../server/types.js';
import { localLLMService } from '../server/localLLM.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { DisabledBackend } from '../server/execution/disabledBackend.js';
import { ExecutionSessionManager, executionConfigFromEnv } from '../server/execution/executionSessionManager.js';
import { DiagnosticCollector } from '../server/debugging/diagnosticCollector.js';
import { RepairCoordinator } from '../server/debugging/repairCoordinator.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';

const enabled = process.env.LOCAL_MODEL_INTEGRATION === '1';
const modelName = process.env.LOCAL_MODEL_NAME || 'qwen2.5:7b';
const endpointUrl = process.env.LOCAL_MODEL_URL || 'http://127.0.0.1:11434/v1';
const MODEL_TIMEOUT_MS = 240000;

let counter = 0;

function makeUser(): User {
  const id = `usr_p11_real_${Date.now()}_${++counter}`;
  const user = {
    id, email: `${id}@p11.test`, name: id, githubConnected: false, costLimitPerBuild: 5, enabledModelIds: [], createdAt: Date.now()
  } as User;
  db.createUser(user);
  return user;
}

async function makeBuild(owner: User, files: Record<string, string>): Promise<Build> {
  const id = `bld_p11_real_${Date.now()}_${++counter}`;
  const build = db.saveBuild({
    id, userId: owner.id, idea: 'Real model fixture', status: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
    selectedModels: [], autoPushGithub: false, totalTokens: 0, totalCost: 0, costLimit: 5, maxDurationSeconds: 600, patchesAppliedCount: 0
  });
  const seeded = await MergeManager.applyBatchActions(id, 'system',
    Object.entries(files).map(([path, content]) => ({ action: 'create_file', path, content })));
  assert.equal(seeded.success, true, seeded.error);
  return build;
}

function describeRun(run: RepairRun): string {
  return JSON.stringify({
    status: run.status,
    outcome: run.outcome,
    investigation: run.investigation,
    attempts: run.attempts.map(item => ({ outcome: item.outcome, detail: item.detail, actions: item.actions, review: item.review }))
  }, null, 2);
}

describe('Phase 11 with a real model', { skip: enabled ? false : 'Set LOCAL_MODEL_INTEGRATION=1 to run' }, () => {
  let modelId: string;
  let repairs: RepairCoordinator;

  before(async () => {
    localLLMService.updateConfig({ enabled: true, endpointUrl, modelName, timeoutMs: MODEL_TIMEOUT_MS });
    modelId = modelRegistry.registerLocalModel(modelName, endpointUrl).id;
    repairs = new RepairCoordinator(new ExecutionSessionManager(new DisabledBackend(), executionConfigFromEnv()));
  });

  async function runRepair(files: Record<string, string>) {
    const owner = makeUser();
    const build = await makeBuild(owner, files);
    const started = repairs.start(build, owner, { modelId });
    const run = (await repairs.settled(started.id))!;
    console.log(describeRun(run));
    return { owner, build, run };
  }

  test('a real model repairs a type error, and the result is proven by real checks', { timeout: 900000 }, async () => {
    const { owner, build, run } = await runRepair({
      'src/total.ts': `export const total: number = 'five';\n`,
      'src/app.ts': `import { total } from './total';\nexport const doubled = total * 2;\n`
    });

    assert.equal(run.status, 'verified', describeRun(run));
    assert.equal((await DiagnosticCollector.collect(build.id)).diagnostics.length, 0);
    assert.equal(ProjectMemoryService.getRepairLessons(build.id, owner.id).some(lesson => lesson.outcome === 'verified'), true);
  });

  test('a real model repairs a missing export in another file', { timeout: 900000 }, async () => {
    const { build, run } = await runRepair({
      'src/math.ts': `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
      'src/app.ts': `import { add, subtract } from './math';\nexport const result = add(5, subtract(3, 1));\n`
    });

    assert.equal(run.status, 'verified', describeRun(run));
    assert.equal((await DiagnosticCollector.collect(build.id)).diagnostics.length, 0);
  });

  test('cancelling aborts a real model request', { timeout: 300000 }, async () => {
    const owner = makeUser();
    const build = await makeBuild(owner, { 'src/total.ts': `export const total: number = 'five';\n` });

    const started = repairs.start(build, owner, { modelId });
    const deadline = Date.now() + 60000;
    while (db.getRepairRun(started.id)?.status !== 'investigating') {
      assert.ok(Date.now() < deadline, `Stuck at ${db.getRepairRun(started.id)?.status}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const before = Date.now();
    const cancelled = await repairs.cancel(build, started.id);

    assert.equal(cancelled.status, 'cancelled');
    assert.ok(Date.now() - before < 5000, 'cancel must not wait for the model to finish');
    assert.equal(db.getFile(build.id, 'src/total.ts')?.version, 1);
  });
});
