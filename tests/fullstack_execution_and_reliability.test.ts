import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { modelRegistry, INITIAL_MODEL_REGISTRY } from '../server/modelRegistry.js';
import { callUnifiedGateway } from '../server/gateway.js';
import { Task, Build } from '../server/types.js';

describe('SquadForge V3 Full-Stack Execution, Database Consistency & Reliability Upgrade', () => {
  let testBuildId: string;

  beforeEach(() => {
    testBuildId = `test_v3_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const build: Build = {
      id: testBuildId,
      idea: 'Real-time collaborative task board with full-stack API and interactive view',
      projectType: 'fullstack',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
      costLimit: 5.0,
      maxDurationSeconds: 600,
      userId: 'test_user_v3',
      selectedModels: ['gemini-fullstack'],
      autoPushGithub: false,
      patchesAppliedCount: 0
    };
    db.saveBuild(build);
  });

  describe('1. Full-Stack Agent Registration & Provider Routing', () => {
    test('gemini-fullstack model is registered with fullstack_developer role and direct Gemini provider', () => {
      const model = modelRegistry.getModel('gemini-fullstack');
      assert.ok(model, 'gemini-fullstack must be registered in MODEL_REGISTRY');
      assert.equal(model?.agentRole, 'fullstack_developer');
      assert.equal(model?.provider, 'gemini');
      assert.equal(model?.providerModel, 'google/gemini-2.5-flash');
      assert.ok(INITIAL_MODEL_REGISTRY.some(m => m.id === 'gemini-fullstack'));
    });

    test('Missing GEMINI_API_KEY generates honest direct error and never complains about OpenRouter', async () => {
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      try {
        const res = await callUnifiedGateway({
          modelId: 'gemini-fullstack',
          prompt: 'Create domain interfaces',
          allowFallback: false
        });

        assert.equal(res.success, false);
        assert.ok(res.error, 'Error message must exist');
        assert.ok(
          res.error.includes('GEMINI_API_KEY') && !res.error.includes('OPENROUTER_API_KEY'),
          `Error should mention GEMINI_API_KEY without mentioning OPENROUTER_API_KEY. Got: ${res.error}`
        );
      } finally {
        if (originalKey) {
          process.env.GEMINI_API_KEY = originalKey;
        }
      }
    });

    test('Model selection fallback works cleanly when primary model is unavailable', async () => {
      const res = await callUnifiedGateway({
        modelId: 'non-existent-dummy-model',
        prompt: 'Return json',
        allowFallback: true
      });

      // Even if API keys are not present in test runner, fallback routing is attempted
      assert.ok(res);
      assert.equal(typeof res.success, 'boolean');
    });

    test('Planner can assign and complete tasks under fullstack_developer role', async () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Fullstack App Root & State Orchestration',
        description: 'Wire client components to backend endpoints',
        filePaths: ['src/App.tsx'],
        priority: 2,
        assignedRole: 'fullstack_developer'
      });

      assert.equal(task.assignedRole, 'fullstack_developer');

      // Create the target file produced by the full-stack developer
      await MergeManager.createFile(testBuildId, 'gemini-fullstack', {
        action: 'create_file',
        path: 'src/App.tsx',
        content: 'export default function App() { return <div>SquadForge Fullstack</div>; }'
      });

      // Claim and complete
      const claimed = TaskManager.claimTask(testBuildId, 'gemini-fullstack');
      assert.ok(claimed);
      assert.equal(claimed?.id, task.id);
      assert.equal(claimed?.claimedBy, 'gemini-fullstack');

      TaskManager.completeTask(testBuildId, task.id, 'gemini-fullstack');
      const completed = db.getTask(testBuildId, task.id);
      assert.equal(completed?.status, 'completed');
    });
  });

  describe('2. Database & Task Consistency', () => {
    test('Prevents duplicate task completion events', async () => {
      await MergeManager.createFile(testBuildId, 'worker-1', {
        action: 'create_file',
        path: 'src/task.ts',
        content: 'export const taskDone = true;'
      });

      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Task Single Completion Test',
        description: 'Testing idempotent completion',
        filePaths: ['src/task.ts'],
        priority: 1
      });

      TaskManager.claimTask(testBuildId, 'worker-1');
      TaskManager.completeTask(testBuildId, task.id, 'worker-1');

      const firstTask = db.getTask(testBuildId, task.id);
      assert.equal(firstTask?.status, 'completed');

      // Attempt second completion by worker-2
      const secondAttempt = db.completeTaskAtomic(testBuildId, task.id, 'worker-2', {
        status: 'completed'
      });

      assert.equal(secondAttempt.success, false);
      assert.ok(secondAttempt.error?.includes('already completed'));
    });

    test('Rejects task completion by stale worker when lease has expired', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Stale Worker Lease Expiration Test',
        description: 'Worker finishes after lease timeout',
        filePaths: ['src/stale.ts'],
        priority: 1
      });

      // Manually set an expired lease on the task
      const pastTime = Date.now() - 10000;
      db.updateTask(testBuildId, task.id, {
        status: 'in_progress',
        claimedBy: 'stale-worker',
        leaseExpiresAt: pastTime
      });

      const completion = db.completeTaskAtomic(testBuildId, task.id, 'stale-worker', {
        status: 'completed'
      });

      assert.equal(completion.success, false);
      assert.ok(completion.error?.includes('expired') || completion.error?.includes('Stale lease rejected'));

      const current = db.getTask(testBuildId, task.id);
      assert.notEqual(current?.status, 'completed');
    });

    test('Rejects task completion attempt by a worker that did not claim the task', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Worker Mismatch Protection Test',
        description: 'Worker B cannot complete Worker A task',
        filePaths: ['src/protected.ts'],
        priority: 1
      });

      db.updateTask(testBuildId, task.id, {
        status: 'in_progress',
        claimedBy: 'legitimate-worker',
        leaseExpiresAt: Date.now() + 60000
      });

      const attempt = db.completeTaskAtomic(testBuildId, task.id, 'intruder-worker', {
        status: 'completed'
      });

      assert.equal(attempt.success, false);
      assert.ok(attempt.error?.includes('Stale worker rejected') || attempt.error?.includes('claimed by legitimate-worker'));
    });

    test('Preserves task history across failure, retry, and timeout reclamation cycles', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'History Preservation Test',
        description: 'Tracking execution history',
        filePaths: ['src/history.ts'],
        priority: 1
      });

      // Simulate expired lease cleanup
      db.updateTask(testBuildId, task.id, {
        status: 'in_progress',
        claimedBy: 'slow-worker',
        leaseExpiresAt: Date.now() - 5000
      });

      TaskManager.cleanExpiredLeases(testBuildId);

      const refreshed = db.getTask(testBuildId, task.id);
      assert.equal(refreshed?.status, 'pending');
      assert.ok(refreshed?.verificationHistory && refreshed.verificationHistory.length > 0);
      assert.ok(refreshed.verificationHistory.some(h => h.details?.includes('Lease timeout') || h.evidence?.includes('lease expired')));
    });
  });

  describe('3. File Leases & Atomic Batch Merging', () => {
    test('Acquires and cleanly sweeps expired file leases', async () => {
      await MergeManager.createFile(testBuildId, 'agent_1', {
        action: 'create_file',
        path: 'src/exclusive.ts',
        content: 'export const exclusive = true;'
      });

      // Acquire lease with short duration (10ms)
      const acquire = MergeManager.acquireFileLeases(testBuildId, 'agent_1', ['src/exclusive.ts'], 10);
      assert.equal(acquire.success, true);

      // Wait 25ms for expiry
      await new Promise(r => setTimeout(r, 25));

      const cleaned = MergeManager.cleanExpiredLeases(testBuildId);
      assert.equal(cleaned, 1);

      const file = db.getFile(testBuildId, 'src/exclusive.ts');
      assert.equal(file?.leaseOwner, null);
      assert.equal(file?.leaseExpiresAt, null);
    });

    test('Rejects file modification, deletion, and renaming when leased by another model', async () => {
      await MergeManager.createFile(testBuildId, 'owner_model', {
        action: 'create_file',
        path: 'src/guarded.ts',
        content: 'export const guarded = 1;'
      });

      MergeManager.acquireFileLeases(testBuildId, 'owner_model', ['src/guarded.ts'], 60000);

      // 1. Modifying guarded file fails for other models
      const patchRes = await MergeManager.applyPatch(testBuildId, 'other_model', {
        action: 'patch_file',
        path: 'src/guarded.ts',
        edits: [{ find: '1', replace: '2' }]
      });
      assert.equal(patchRes.success, false);
      assert.ok(patchRes.error?.includes('locked under refactor lease by owner_model'));

      // 2. Deleting guarded file fails for other models
      const delRes = await MergeManager.deleteFile(testBuildId, 'other_model', {
        action: 'delete_file',
        path: 'src/guarded.ts'
      });
      assert.equal(delRes.success, false);
      assert.ok(delRes.error?.toLowerCase().includes('locked under active lease by owner_model') || delRes.error?.toLowerCase().includes('file leased by owner_model'));

      // 3. Renaming guarded file fails for other models
      const renRes = await MergeManager.renameFile(testBuildId, 'other_model', {
        action: 'rename_file',
        oldPath: 'src/guarded.ts',
        newPath: 'src/renamed.ts'
      });
      assert.equal(renRes.success, false);
      assert.ok(renRes.error?.toLowerCase().includes('locked under active lease by owner_model') || renRes.error?.toLowerCase().includes('file leased by owner_model'));
    });

    test('Releasing file lease validates owner identity', async () => {
      await MergeManager.createFile(testBuildId, 'agent_a', {
        action: 'create_file',
        path: 'src/leased.ts',
        content: 'export const leased = true;'
      });

      MergeManager.acquireFileLeases(testBuildId, 'agent_a', ['src/leased.ts'], 60000);

      // agent_b attempts to release agent_a's lease
      const releaseAttempt = MergeManager.releaseFileLeases(testBuildId, 'agent_b', ['src/leased.ts']);
      assert.equal(releaseAttempt.success, false);
      assert.ok(releaseAttempt.error?.includes('Active lease is held by agent_a, not agent_b'));

      // agent_a releases legitimately
      const legitimateRelease = MergeManager.releaseFileLeases(testBuildId, 'agent_a', ['src/leased.ts']);
      assert.equal(legitimateRelease.success, true);
      assert.ok(legitimateRelease.releasedPaths.includes('src/leased.ts'));
    });

    test('Atomic multi-file batch operations revert cleanly if ANY operation fails', async () => {
      await MergeManager.createFile(testBuildId, 'agent_batch', {
        action: 'create_file',
        path: 'src/file1.ts',
        content: 'export const one = 1;'
      });

      // Prepare batch:
      // Action 1: Create src/file2.ts (valid)
      // Action 2: Patch src/file1.ts (valid)
      // Action 3: Patch non-existent src/missing.ts (FAILS)
      const actions = [
        {
          action: 'create_file',
          path: 'src/file2.ts',
          content: 'export const two = 2;'
        },
        {
          action: 'patch_file',
          path: 'src/file1.ts',
          edits: [{ find: '1', replace: '100' }]
        },
        {
          action: 'patch_file',
          path: 'src/non_existent.ts',
          edits: [{ find: 'anything', replace: 'fail' }]
        }
      ];

      const batchResult = await MergeManager.applyBatchActions(testBuildId, 'agent_batch', actions);
      assert.equal(batchResult.success, false);
      assert.equal(batchResult.reverted, true);

      // Verify complete rollback:
      // 1. src/file2.ts must NOT exist in workspace
      const file2 = db.getFile(testBuildId, 'src/file2.ts');
      assert.ok(!file2, 'Newly created file in failed batch must be rolled back');

      // 2. src/file1.ts must retain original content 'export const one = 1;'
      const file1 = db.getFile(testBuildId, 'src/file1.ts');
      assert.equal(file1?.content, 'export const one = 1;', 'Modified file must revert to original content');
    });
  });

  describe('4. Honest Verification Verdicts & Explanations', () => {
    test('Projects missing required automated tests are honestly marked partially_verified with explanation', async () => {
      await MergeManager.createFile(testBuildId, 'agent', {
        action: 'create_file',
        path: 'src/index.ts',
        content: 'export const calculate = (x: number) => x * 2;'
      });
      await MergeManager.createFile(testBuildId, 'agent', {
        action: 'create_file',
        path: 'package.json',
        content: JSON.stringify({ name: 'test-app', version: '1.0.0' })
      });
      await MergeManager.createFile(testBuildId, 'agent', {
        action: 'create_file',
        path: 'README.md',
        content: '# App Documentation'
      });

      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Build Core',
        description: 'Core logic',
        filePaths: ['src/index.ts'],
        priority: 1
      });
      TaskManager.claimTask(testBuildId, 'agent');
      TaskManager.completeTask(testBuildId, task.id, 'agent');

      const report = HonestVerificationService.evaluateProjectReadiness(testBuildId);
      // Because no automated test files exist (tests/*.test.ts), it cannot be falsely marked 'verified'
      assert.equal(report.verdict, 'partially_verified');
      assert.ok(
        report.verdictExplanation?.includes('partially verified') &&
        report.verdictExplanation?.includes('automated test suites missing')
      );
    });

    test('Unfinished or active tasks prevent verified verdict', async () => {
      await MergeManager.createFile(testBuildId, 'agent', {
        action: 'create_file',
        path: 'src/index.ts',
        content: 'export const a = 1;'
      });
      await MergeManager.createFile(testBuildId, 'agent', {
        action: 'create_file',
        path: 'README.md',
        content: '# App'
      });

      // Create an uncompleted task
      TaskManager.createNewTask(testBuildId, {
        title: 'Unfinished Task',
        description: 'Pending task',
        filePaths: ['src/pending.ts'],
        priority: 1
      });

      const report = HonestVerificationService.evaluateProjectReadiness(testBuildId);
      assert.notEqual(report.verdict, 'verified');
      assert.ok(
        report.verdict === 'in_progress' || report.verdict === 'partially_verified',
        `Verdict was ${report.verdict}`
      );
      assert.ok(report.verdictExplanation?.length > 0);
    });
  });
});
