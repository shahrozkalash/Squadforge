import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { MergeManager } from '../server/swarm/mergeManager.js';

describe('Phase 5 Concurrency Hardening & Architectural Guarantees', () => {
  const buildId = 'test_phase5_hardening_build';

  beforeEach(() => {
    try {
      db.dbManager.db.prepare('DELETE FROM tasks WHERE build_id = ?').run(buildId);
      db.dbManager.db.prepare('DELETE FROM project_files WHERE build_id = ?').run(buildId);
      db.dbManager.db.prepare('DELETE FROM file_versions WHERE build_id = ?').run(buildId);
      db.dbManager.db.prepare('DELETE FROM swarm_events WHERE build_id = ?').run(buildId);
    } catch {}
    db.tasks.delete(buildId);
    db.files.delete(buildId);
    db.events.delete(buildId);

    db.saveBuild({
      id: buildId,
      userId: 'test_user_phase5',
      idea: 'Phase 5 Concurrency Hardening Tests',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini', 'claude'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    });
  });

  describe('A. Task Cancellation Ownership & Lifecycle', () => {
    test('Ordinary worker cannot cancel an unclaimed (pending) task', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Unclaimed Task A',
        description: 'Should only be cancellable by supervisor',
        filePaths: ['src/unclaimed.ts'],
        priority: 2
      });

      const res = TaskManager.cancelTask(buildId, task.id, 'worker_alpha', 'Worker trying to cancel unclaimed task');
      assert.equal(res.success, false);
      assert.match(res.error || '', /supervisor|unclaimed/i);

      const current = db.getTask(buildId, task.id);
      assert.equal(current?.status, 'pending');
    });

    test('Supervisor or system can cancel an unclaimed (pending) task', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Unclaimed Task B',
        description: 'Supervisor will cancel',
        filePaths: ['src/unclaimed_b.ts'],
        priority: 2
      });

      const res = TaskManager.cancelTask(buildId, task.id, 'supervisor', 'Supervisor cancellation');
      assert.equal(res.success, true);

      const current = db.getTask(buildId, task.id);
      assert.equal(current?.status, 'cancelled');
    });

    test('Claimed task can be cancelled by its owning worker', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Claimed Task Alpha',
        description: 'Owned by worker_alpha',
        filePaths: ['src/alpha.ts'],
        priority: 2
      });

      TaskManager.claimTask(buildId, 'worker_alpha');

      const res = TaskManager.cancelTask(buildId, task.id, 'worker_alpha', 'Work discontinued by owner');
      assert.equal(res.success, true);

      const current = db.getTask(buildId, task.id);
      assert.equal(current?.status, 'cancelled');
      assert.equal(current?.error, 'Work discontinued by owner');
    });

    test('Stale/non-owning worker cannot cancel a task claimed by another worker', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Claimed Task Beta',
        description: 'Owned by worker_alpha',
        filePaths: ['src/beta.ts'],
        priority: 2
      });

      TaskManager.claimTask(buildId, 'worker_alpha');

      const res = TaskManager.cancelTask(buildId, task.id, 'worker_intruder', 'Intruder cancellation');
      assert.equal(res.success, false);
      assert.match(res.error || '', /worker_alpha|ownership/i);

      const current = db.getTask(buildId, task.id);
      assert.equal(current?.status, 'in_progress');
    });

    test('Worker with expired lease cannot cancel task', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Expired Lease Task',
        description: 'Owned by worker_alpha with expired lease',
        filePaths: ['src/expired.ts'],
        priority: 2
      });

      db.claimTaskAtomic(buildId, task.id, 'worker_alpha', Date.now() - 5000); // Already expired

      const res = TaskManager.cancelTask(buildId, task.id, 'worker_alpha', 'Cancellation with expired lease');
      assert.equal(res.success, false);
      assert.match(res.error || '', /expired/i);

      const current = db.getTask(buildId, task.id);
      assert.notEqual(current?.status, 'cancelled');
    });

    test('Duplicate cancellation returns error and does not duplicate events', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Task For Duplicate Cancel',
        description: 'Test idempotence',
        filePaths: ['src/dup.ts'],
        priority: 2
      });

      TaskManager.cancelTask(buildId, task.id, 'system', 'First cancel');
      const eventsBefore = db.getEvents(buildId).filter(e => e.taskId === task.id && e.type === 'task_cancelled').length;

      const secondRes = TaskManager.cancelTask(buildId, task.id, 'system', 'Second cancel');
      assert.equal(secondRes.success, false);
      assert.match(secondRes.error || '', /already cancelled/i);

      const eventsAfter = db.getEvents(buildId).filter(e => e.taskId === task.id && e.type === 'task_cancelled').length;
      assert.equal(eventsBefore, eventsAfter);
    });
  });

  describe('B. File Mutation Atomicity & Lease Validation', () => {
    test('Cannot modify, delete, or rename file leased by another model', async () => {
      await MergeManager.createFile(buildId, 'agent_1', {
        action: 'create_file',
        path: 'src/protected.ts',
        content: 'export const locked = true;'
      });

      // agent_1 acquires lease
      const leaseRes = MergeManager.acquireFileLeases(buildId, 'agent_1', ['src/protected.ts'], 60000);
      assert.equal(leaseRes.success, true);

      // agent_2 attempts patch
      const patchRes = await MergeManager.applyPatch(buildId, 'agent_2', {
        action: 'patch_file',
        path: 'src/protected.ts',
        edits: [{ find: 'locked = true', replace: 'locked = false' }]
      });
      assert.equal(patchRes.success, false);
      assert.match(patchRes.error || '', /locked|lease|agent_1/i);

      // agent_2 attempts delete
      const delRes = await MergeManager.deleteFile(buildId, 'agent_2', {
        action: 'delete_file',
        path: 'src/protected.ts'
      });
      assert.equal(delRes.success, false);
      assert.match(delRes.error || '', /lease|agent_1/i);

      // agent_2 attempts rename
      const renameRes = await MergeManager.renameFile(buildId, 'agent_2', {
        action: 'rename_file',
        oldPath: 'src/protected.ts',
        newPath: 'src/stolen.ts'
      });
      assert.equal(renameRes.success, false);
      assert.match(renameRes.error || '', /lease|agent_1/i);
    });

    test('Expired lease cannot authorize file modification', async () => {
      await MergeManager.createFile(buildId, 'agent_1', {
        action: 'create_file',
        path: 'src/stale_lease.ts',
        content: 'export const initial = 1;'
      });

      // Manually set an expired lease in database
      db.dbManager.db.prepare(`
        UPDATE project_files SET lease_owner = ?, lease_expires_at = ? WHERE build_id = ? AND path = ?
      `).run('agent_1', Date.now() - 5000, buildId, 'src/stale_lease.ts');

      const patchRes = await MergeManager.applyPatch(buildId, 'agent_1', {
        action: 'patch_file',
        path: 'src/stale_lease.ts',
        edits: [{ find: 'initial = 1', replace: 'initial = 2' }]
      });
      assert.equal(patchRes.success, false);
      assert.match(patchRes.error || '', /expired/i);
    });

    test('Stale expectedVersion or expectedContentHash rejects patch atomically', async () => {
      const createRes = await MergeManager.createFile(buildId, 'agent_dev', {
        action: 'create_file',
        path: 'src/versioned.ts',
        content: 'export const version = 1;'
      });
      assert.equal(createRes.success, true);

      // Expected version 5 on a v1 file must fail
      const badVerRes = await MergeManager.applyPatch(buildId, 'agent_dev', {
        action: 'patch_file',
        path: 'src/versioned.ts',
        expectedVersion: 5,
        edits: [{ find: 'version = 1', replace: 'version = 2' }]
      });
      assert.equal(badVerRes.success, false);
      assert.match(badVerRes.error || '', /version/i);

      // Expected bad hash must fail
      const badHashRes = await MergeManager.applyPatch(buildId, 'agent_dev', {
        action: 'patch_file',
        path: 'src/versioned.ts',
        expectedContentHash: 'invalid_sha256_hash_here',
        edits: [{ find: 'version = 1', replace: 'version = 2' }]
      });
      assert.equal(badHashRes.success, false);
      assert.match(badHashRes.error || '', /hash/i);

      // Content and version must be unchanged
      const file = db.getFile(buildId, 'src/versioned.ts');
      assert.equal(file?.version, 1);
      assert.equal(file?.content, 'export const version = 1;');
    });

    test('Atomic rename creates destination and deletes source cleanly', async () => {
      await MergeManager.createFile(buildId, 'agent_dev', {
        action: 'create_file',
        path: 'src/oldName.ts',
        content: 'export const name = "old";'
      });

      const res = await MergeManager.renameFile(buildId, 'agent_dev', {
        action: 'rename_file',
        oldPath: 'src/oldName.ts',
        newPath: 'src/newName.ts'
      });
      assert.equal(res.success, true);

      assert.equal(db.getFile(buildId, 'src/oldName.ts'), undefined);
      const renamed = db.getFile(buildId, 'src/newName.ts');
      assert.ok(renamed);
      assert.equal(renamed.content, 'export const name = "old";');
      assert.equal(renamed.version, 2);
    });

    test('Batch action failure triggers SQLite rollback and restores state cleanly', async () => {
      await MergeManager.createFile(buildId, 'agent_dev', {
        action: 'create_file',
        path: 'src/stable.ts',
        content: 'export const stable = true;'
      });

      const batchRes = await MergeManager.applyBatchActions(buildId, 'agent_dev', [
        {
          action: 'patch_file',
          path: 'src/stable.ts',
          edits: [{ find: 'stable = true', replace: 'stable = false' }]
        },
        {
          action: 'create_file',
          path: 'src/second.ts',
          content: 'export const second = 2;'
        },
        {
          // Intentional failure: target text does not exist
          action: 'patch_file',
          path: 'src/stable.ts',
          edits: [{ find: 'NON_EXISTENT_TEXT', replace: 'REPLACED' }]
        }
      ]);

      assert.equal(batchRes.success, false);
      assert.equal(batchRes.reverted, true);

      // File 1 must remain untouched
      const stable = db.getFile(buildId, 'src/stable.ts');
      assert.equal(stable?.content, 'export const stable = true;');
      assert.equal(stable?.version, 1);

      // File 2 must not exist
      assert.equal(db.getFile(buildId, 'src/second.ts'), undefined);
    });
  });

  describe('C. Lease Lifecycle Reliability & Duration Validation', () => {
    test('Rejects invalid lease durations (0, negative, NaN, infinity, >24h)', () => {
      const invalidDurations = [0, -1000, NaN, Infinity, -Infinity, 25 * 60 * 60 * 1000];

      for (const dur of invalidDurations) {
        const res = MergeManager.acquireFileLeases(buildId, 'agent_1', ['src/dur_test.ts'], dur);
        assert.equal(res.success, false, `Duration ${dur} should be rejected`);
        assert.match(res.error || '', /duration/i);

        const renewRes = MergeManager.renewFileLeases(buildId, 'agent_1', ['src/dur_test.ts'], dur);
        assert.equal(renewRes.success, false, `Renew duration ${dur} should be rejected`);
      }
    });

    test('Lease renewal is all-or-none when multiple files are requested', async () => {
      await MergeManager.createFile(buildId, 'agent_1', {
        action: 'create_file',
        path: 'src/lease_a.ts',
        content: 'export const a = 1;'
      });
      await MergeManager.createFile(buildId, 'agent_1', {
        action: 'create_file',
        path: 'src/lease_b.ts',
        content: 'export const b = 2;'
      });

      // Acquire only lease_a
      MergeManager.acquireFileLeases(buildId, 'agent_1', ['src/lease_a.ts'], 30000);

      // Attempt to renew both lease_a and lease_b (lease_b is unleased!)
      const renewRes = MergeManager.renewFileLeases(buildId, 'agent_1', ['src/lease_a.ts', 'src/lease_b.ts'], 30000);
      assert.equal(renewRes.success, false);
      assert.match(renewRes.error || '', /lease_b/i);
    });

    test('Database coordination locks acquire, prevent conflicts, and release cleanly', () => {
      const lockKey = 'build_coordination_test_key';
      const ownerA = 'process_alpha';
      const ownerB = 'process_beta';

      // Owner A acquires lock
      const acquiredA = db.dbManager.acquireCoordinationLock(lockKey, ownerA, 5000);
      assert.equal(acquiredA, true);

      // Owner B cannot acquire active lock
      const acquiredB = db.dbManager.acquireCoordinationLock(lockKey, ownerB, 5000);
      assert.equal(acquiredB, false);

      // Owner A releases lock
      const released = db.dbManager.releaseCoordinationLock(lockKey, ownerA);
      assert.equal(released, true);

      // Owner B can now acquire lock
      const acquiredB2 = db.dbManager.acquireCoordinationLock(lockKey, ownerB, 5000);
      assert.equal(acquiredB2, true);

      // Clean up
      db.dbManager.releaseCoordinationLock(lockKey, ownerB);
    });
  });
});
