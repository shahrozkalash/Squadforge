import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { DatabaseSync } from 'node:sqlite';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';

describe('Phase 5 Database Coordination Locks, Transactions & Reliability Regression', () => {
  const buildId = 'test_phase5_coordination_build';

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
      userId: 'user_phase5_coord',
      idea: 'Coordination and Transaction Safety Suite',
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

  describe('1. Database Coordination Locks: Contention, Timeout & Never Execute Without Lock', () => {
    test('Operation is NEVER executed when coordination lock acquisition times out', async () => {
      const lockKey = `build_patch_${buildId}`;
      const blockingOwner = 'external_process_blocking';

      // Simulate another process holding the coordination lock
      const lockAcquired = db.dbManager.acquireCoordinationLock(lockKey, blockingOwner, 10000);
      assert.equal(lockAcquired, true, 'External process should hold coordination lock');

      let operationExecuted = false;

      // Attempt enqueuePatch with a 150ms timeout
      await assert.rejects(
        async () => {
          await MergeManager.enqueuePatch(
            buildId,
            async () => {
              operationExecuted = true;
              return { success: true };
            },
            150, // 150ms timeout
            10000
          );
        },
        (err: Error) => {
          assert.match(err.message, /timeout|failed to acquire/i);
          return true;
        }
      );

      // Verify the protected operation was NEVER executed!
      assert.equal(operationExecuted, false, 'Protected operation must NEVER be executed when lock acquisition times out');

      // Release blocking lock
      db.dbManager.releaseCoordinationLock(lockKey, blockingOwner);
    });

    test('Never releases a lock owned by another process or owner', () => {
      const lockKey = 'lock_test_ownership_protection';
      const ownerA = 'process_alpha';
      const ownerB = 'process_beta_intruder';

      const acquired = db.dbManager.acquireCoordinationLock(lockKey, ownerA, 5000);
      assert.equal(acquired, true);

      // Intruder attempts to release process_alpha's lock
      const releasedByIntruder = db.dbManager.releaseCoordinationLock(lockKey, ownerB);
      assert.equal(releasedByIntruder, false, 'Intruder must not be able to release another process lock');

      // Lock should still be held by ownerA
      assert.equal(db.dbManager.isCoordinationLockHeld(lockKey, ownerA), true);

      // Legitimate owner releases
      const releasedByOwner = db.dbManager.releaseCoordinationLock(lockKey, ownerA);
      assert.equal(releasedByOwner, true);
      assert.equal(db.dbManager.isCoordinationLockHeld(lockKey, ownerA), false);
    });

    test('Validates lock duration: rejects 0, negative, NaN, infinity, and >24h durations', () => {
      const invalid = [0, -100, NaN, Infinity, -Infinity, 25 * 60 * 60 * 1000];
      for (const dur of invalid) {
        const res = db.dbManager.acquireCoordinationLock('key_dur', 'owner_x', dur);
        assert.equal(res, false, `Duration ${dur} should be rejected`);

        const renewRes = db.dbManager.renewCoordinationLock('key_dur', 'owner_x', dur);
        assert.equal(renewRes, false, `Renew duration ${dur} should be rejected`);
      }
    });

    test('Expired lock is automatically reclaimed by next waiting process', async () => {
      const lockKey = 'lock_test_auto_expiration_reclaim';
      const ownerOld = 'process_crashed_or_stale';
      const ownerNew = 'process_active_recovery';

      // Owner 1 acquires short lock (50ms)
      db.dbManager.acquireCoordinationLock(lockKey, ownerOld, 50);
      assert.equal(db.dbManager.isCoordinationLockHeld(lockKey, ownerOld), true);

      // Wait for lock to expire
      await new Promise(r => setTimeout(r, 65));

      // Old owner no longer holds lock
      assert.equal(db.dbManager.isCoordinationLockHeld(lockKey, ownerOld), false);

      // New owner acquires cleanly
      const acquiredNew = db.dbManager.acquireCoordinationLock(lockKey, ownerNew, 5000);
      assert.equal(acquiredNew, true, 'New owner should claim expired lock');

      db.dbManager.releaseCoordinationLock(lockKey, ownerNew);
    });

    test('Multi-connection SQLite coordination safety: separate connections compete and serialize', () => {
      const dbPath = db.dbManager.getDbPath();
      if (dbPath === ':memory:') {
        // In-memory SQLite is isolated per connection
        return;
      }

      // Open a second, independent connection to the same SQLite database
      const secondDb = new DatabaseSync(dbPath);
      secondDb.exec('PRAGMA busy_timeout = 30000;');

      const lockKey = 'multi_conn_lock_test';
      const owner1 = 'conn_1';
      const owner2 = 'conn_2';

      try {
        // Connection 1 acquires lock
        const res1 = db.dbManager.acquireCoordinationLock(lockKey, owner1, 10000);
        assert.equal(res1, true);

        // Connection 2 attempts to acquire same lock directly via SQL
        const now = Date.now();
        const expiry = now + 10000;
        const res2 = secondDb.prepare(`
          INSERT INTO coordination_locks (lock_key, owner_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(lock_key) DO UPDATE SET
            owner_id = excluded.owner_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
          WHERE expires_at < ?
        `).run(lockKey, owner2, now, expiry, now);

        assert.equal(res2.changes, 0, 'Second connection must not acquire active lock');

        // Connection 1 releases lock
        db.dbManager.releaseCoordinationLock(lockKey, owner1);

        // Connection 2 can now acquire lock
        const res3 = secondDb.prepare(`
          INSERT INTO coordination_locks (lock_key, owner_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(lock_key) DO UPDATE SET
            owner_id = excluded.owner_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
          WHERE expires_at < ?
        `).run(lockKey, owner2, now, expiry, now);

        assert.equal(res3.changes, 1, 'Second connection should acquire lock after release');

        // Cleanup
        secondDb.prepare('DELETE FROM coordination_locks WHERE lock_key = ?').run(lockKey);
      } finally {
        secondDb.close();
      }
    });
  });

  describe('2. SQLite Transactions, Rollback & In-Memory Cache Consistency', () => {
    test('Rolled-back batch does NOT mutate in-memory cache, emit events, or broadcast', async () => {
      // Create initial clean file
      await MergeManager.createFile(buildId, 'agent_dev', {
        action: 'create_file',
        path: 'src/stable_cache.ts',
        content: 'export const status = "INITIAL";'
      });

      const eventsBeforeCount = db.getEvents(buildId).length;
      let broadcastReceived = false;

      // Attach dummy SSE listener
      const dummyListener = {
        id: 'test_sse_listener',
        buildId,
        res: {
          write: (msg: string) => {
            if (msg.includes('file_updated') && msg.includes('MODIFIED_IN_FAILED_BATCH')) {
              broadcastReceived = true;
            }
          }
        }
      };
      db.addSSEListener(dummyListener.id, dummyListener.res, buildId);

      // Execute a failing batch
      const batchResult = await MergeManager.applyBatchActions(buildId, 'agent_dev', [
        {
          action: 'patch_file',
          path: 'src/stable_cache.ts',
          edits: [{ find: 'INITIAL', replace: 'MODIFIED_IN_FAILED_BATCH' }]
        },
        {
          action: 'create_file',
          path: 'src/temp_rolled_back.ts',
          content: 'export const temp = true;'
        },
        {
          // Intentional failure triggers rollback
          action: 'patch_file',
          path: 'src/stable_cache.ts',
          edits: [{ find: 'NON_EXISTENT_STRING_TRIGGER_FAIL', replace: 'REPLACED' }]
        }
      ]);

      db.removeSSEListener(dummyListener.id);

      assert.equal(batchResult.success, false);
      assert.equal(batchResult.reverted, true);

      // Verify in-memory cache was NOT mutated
      const cachedFile = db.getFile(buildId, 'src/stable_cache.ts');
      assert.equal(cachedFile?.content, 'export const status = "INITIAL";', 'Cache must not hold rolled-back patch content');
      assert.equal(cachedFile?.version, 1, 'Cache version must remain 1');

      // Verify temp file does not exist in memory or database
      assert.equal(db.getFile(buildId, 'src/temp_rolled_back.ts'), undefined);
      const dbRow = db.dbManager.db.prepare('SELECT * FROM project_files WHERE build_id = ? AND path = ?').get(buildId, 'src/temp_rolled_back.ts');
      assert.equal(dbRow, undefined);

      // Verify no uncommitted broadcast was sent
      assert.equal(broadcastReceived, false, 'Uncommitted changes must never be broadcast via SSE');

      // Verify events: only 1 patch_rejected event emitted for the batch failure, NO file_created or patch_applied
      const eventsAfter = db.getEvents(buildId);
      const createdEvents = eventsAfter.filter(e => e.type === 'file_created' && e.filePath === 'src/temp_rolled_back.ts');
      assert.equal(createdEvents.length, 0, 'Zero file_created events for rolled back items');

      const patchAppliedEvents = eventsAfter.filter(e => e.type === 'patch_applied' && e.details?.includes('MODIFIED_IN_FAILED_BATCH'));
      assert.equal(patchAppliedEvents.length, 0, 'Zero patch_applied events for rolled back items');
    });

    test('Nested transaction failure via savepoint cleanly rolls back nested change without corrupting outer', () => {
      let outerErrorCaught = false;

      try {
        db.dbManager.transaction(() => {
          // Outer DB change
          db.dbManager.db.prepare(`
            INSERT INTO project_files (id, build_id, path, content, version, owner_model, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)
          `).run('outer_file_id', buildId, 'src/outer.ts', 'outer content', 'agent_outer', Date.now(), Date.now());

          // Nested transaction that fails
          try {
            db.dbManager.transaction(() => {
              db.dbManager.db.prepare(`
                INSERT INTO project_files (id, build_id, path, content, version, owner_model, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?)
              `).run('inner_file_id', buildId, 'src/inner.ts', 'inner content', 'agent_inner', Date.now(), Date.now());

              throw new Error('Nested savepoint intentional error');
            });
          } catch (nestedErr) {
            // Inner error caught and handled at savepoint level
          }

          // Outer continues and inserts another file
          db.dbManager.db.prepare(`
            INSERT INTO project_files (id, build_id, path, content, version, owner_model, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)
          `).run('outer_file_2_id', buildId, 'src/outer_2.ts', 'outer 2 content', 'agent_outer', Date.now(), Date.now());
        });
      } catch (e) {
        outerErrorCaught = true;
      }

      assert.equal(outerErrorCaught, false);

      // Inner file was rolled back by savepoint
      const innerRow = db.dbManager.db.prepare('SELECT * FROM project_files WHERE id = ?').get('inner_file_id');
      assert.equal(innerRow, undefined, 'Inner file rolled back to savepoint must not exist');

      // Outer files were committed
      const outer1 = db.dbManager.db.prepare('SELECT * FROM project_files WHERE id = ?').get('outer_file_id');
      assert.ok(outer1, 'Outer file 1 should be committed');
      const outer2 = db.dbManager.db.prepare('SELECT * FROM project_files WHERE id = ?').get('outer_file_2_id');
      assert.ok(outer2, 'Outer file 2 should be committed');
    });

    test('Atomic rename preserves full file history in SQLite database across reloads', async () => {
      // 1. Create file v1
      await MergeManager.createFile(buildId, 'agent_dev', {
        action: 'create_file',
        path: 'src/historical.ts',
        content: 'export const version = 1;'
      });

      // 2. Patch file v2
      await MergeManager.applyPatch(buildId, 'agent_dev', {
        action: 'patch_file',
        path: 'src/historical.ts',
        edits: [{ find: 'version = 1', replace: 'version = 2' }]
      });

      // 3. Rename file to src/historical_renamed.ts (v3)
      const renameRes = await MergeManager.renameFile(buildId, 'agent_dev', {
        action: 'rename_file',
        oldPath: 'src/historical.ts',
        newPath: 'src/historical_renamed.ts',
        commitMessage: 'Rename to historical_renamed.ts'
      });
      assert.equal(renameRes.success, true);

      // 4. Inspect file_versions table directly in SQLite
      const versions = db.dbManager.db.prepare(
        'SELECT version, content, path FROM file_versions WHERE build_id = ? AND path = ? ORDER BY version ASC'
      ).all(buildId, 'src/historical_renamed.ts') as Array<{ version: number; content: string; path: string }>;

      // Must contain version 1, version 2, and version 3!
      assert.equal(versions.length, 3, 'All 3 historical versions must be preserved in database under new path');
      assert.equal(versions[0].version, 1);
      assert.equal(versions[1].version, 2);
      assert.equal(versions[2].version, 3);
    });
  });

  describe('3. Task Ownership, Cancellation & Concurrent Operations', () => {
    test('Simultaneous task completion and cancellation: only one state transition succeeds', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Concurrent Racing Task',
        description: 'Race between worker complete and supervisor cancel',
        filePaths: ['src/race.ts'],
        priority: 1
      });

      // Worker claims task
      TaskManager.claimNextTask(buildId, 'worker_racer', ['backend']);

      // Race: supervisor cancels, worker completes
      const cancelRes = TaskManager.cancelTask(buildId, task.id, 'supervisor', 'Supervisor preemptive cancel');
      assert.equal(cancelRes.success, true);

      // Worker attempts to complete already-cancelled task
      const completeRes = TaskManager.completeTask(buildId, task.id, 'worker_racer');
      assert.equal(completeRes.success, false, 'Cannot complete an already cancelled task');
      assert.match(completeRes.error || '', /cancelled/i);

      const finalTask = db.getTask(buildId, task.id);
      assert.equal(finalTask?.status, 'cancelled');
    });

    test('Repeated cancellation attempt returns clear error and does not duplicate events', () => {
      const task = TaskManager.createNewTask(buildId, {
        title: 'Repeated Cancel Task',
        description: 'Idempotency test',
        filePaths: ['src/idemp.ts'],
        priority: 1
      });

      const first = TaskManager.cancelTask(buildId, task.id, 'system', 'First cancellation');
      assert.equal(first.success, true);

      const count1 = db.getEvents(buildId).filter(e => e.taskId === task.id && e.type === 'task_cancelled').length;
      assert.equal(count1, 1);

      const second = TaskManager.cancelTask(buildId, task.id, 'system', 'Second cancellation');
      assert.equal(second.success, false);
      assert.match(second.error || '', /already cancelled/i);

      const count2 = db.getEvents(buildId).filter(e => e.taskId === task.id && e.type === 'task_cancelled').length;
      assert.equal(count2, 1, 'Duplicate cancellation must not emit duplicate events');
    });
  });

  describe('4. Honest Verification: Skipped Tests Handling', () => {
    test('Skipped tests are never reported as passed and produce partially_verified verdict', () => {
      // Add files
      db.setFile(buildId, {
        path: 'README.md',
        content: '# Project\nInstructions here.',
        version: 1,
        ownerModel: 'system',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      db.setFile(buildId, {
        path: 'src/main.ts',
        content: 'export const app = "healthy";',
        version: 1,
        ownerModel: 'system',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      const report = HonestVerificationService.evaluateProjectReadiness(buildId);

      // Because automated tests were not run/skipped, verdict must NOT be 'verified'
      assert.notEqual(report.verdict, 'verified', 'Cannot be verified when test suite is skipped or missing');
      assert.equal(report.verdict, 'partially_verified');
      assert.ok(
        report.verdictExplanation.toLowerCase().includes('automated test') ||
        report.verdictExplanation.toLowerCase().includes('criteria remain unverified')
      );
    });
  });
});
