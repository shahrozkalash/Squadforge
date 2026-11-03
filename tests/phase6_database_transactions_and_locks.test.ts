import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
// @ts-ignore
import { DatabaseSync } from 'node:sqlite';
import { DatabaseManager } from '../server/db/database.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { db } from '../server/store.js';

describe('Phase 6 Database Transactions and Coordination Lock Reliability', () => {
  let tempDbPath: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tempDbPath = path.join(os.tmpdir(), `squadforge-phase6-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbManager = DatabaseManager.resetInstance(tempDbPath);
  });

  afterEach(() => {
    try {
      dbManager.close();
    } catch {}
    try {
      if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    } catch {}
  });

  describe('PHASE 1: Database Transaction Reliability', () => {
    test('1. Transaction depth is consistently restored even when initialization fails', () => {
      assert.equal(dbManager.getTransactionDepth(), 0);

      // Create a dummy table
      dbManager.db.exec('CREATE TABLE test_tx (id INTEGER PRIMARY KEY, val TEXT);');

      // Close the underlying DB to simulate an initialization I/O or connection failure
      dbManager.db.close();

      assert.throws(
        () => {
          dbManager.transaction(() => {
            // Should never reach here
            assert.fail('Transaction callback should not execute if initialization fails');
          });
        },
        (err: any) => {
          assert.ok(err, 'Should throw initialization error');
          return true;
        }
      );

      // CRITICAL: transactionDepth MUST remain 0, not incremented to 1!
      assert.equal(dbManager.getTransactionDepth(), 0, 'Transaction depth must remain 0 after initialization failure');
    });

    test('2. Nested transactions (SAVEPOINTs) rollback isolated inner scope without discarding outer commit hooks', () => {
      dbManager.db.exec('CREATE TABLE test_nested (id INTEGER PRIMARY KEY, val TEXT);');

      let outerCommitExecuted = false;
      let innerCommitExecuted = false;
      let outerRollbackExecuted = false;
      let innerRollbackExecuted = false;

      // Outer transaction starts
      dbManager.transaction(() => {
        dbManager.db.prepare('INSERT INTO test_nested (id, val) VALUES (?, ?)').run(1, 'outer_row');
        dbManager.onPostCommit(() => {
          outerCommitExecuted = true;
        });
        dbManager.onPostRollback(() => {
          outerRollbackExecuted = true;
        });

        // Nested savepoint starts
        try {
          dbManager.transaction(() => {
            dbManager.db.prepare('INSERT INTO test_nested (id, val) VALUES (?, ?)').run(2, 'inner_row');
            dbManager.onPostCommit(() => {
              innerCommitExecuted = true;
            });
            dbManager.onPostRollback(() => {
              innerRollbackExecuted = true;
            });
            // Simulate inner failure
            throw new Error('Inner savepoint failed');
          });
        } catch (innerErr: any) {
          assert.equal(innerErr.message, 'Inner savepoint failed');
        }

        // Verify inner rollback hook executed immediately
        assert.equal(innerRollbackExecuted, true, 'Inner rollback hook should have executed on savepoint failure');
        assert.equal(innerCommitExecuted, false, 'Inner commit hook must not execute');

        // Outer transaction continues and adds another row
        dbManager.db.prepare('INSERT INTO test_nested (id, val) VALUES (?, ?)').run(3, 'outer_row_2');
      });

      // Outer transaction committed successfully
      assert.equal(outerCommitExecuted, true, 'Outer commit hook must be preserved and executed');
      assert.equal(outerRollbackExecuted, false, 'Outer rollback hook must not execute for successful outer commit');

      // Verify database content: inner row was rolled back, outer rows committed
      const rows = dbManager.db.prepare('SELECT id, val FROM test_nested ORDER BY id ASC').all() as any[];
      assert.equal(rows.length, 2);
      assert.equal(rows[0].id, 1);
      assert.equal(rows[1].id, 3);
    });

    test('3. Outer rollback executes all appropriate rollback hooks and discards all commit hooks', () => {
      dbManager.db.exec('CREATE TABLE test_full_rb (id INTEGER PRIMARY KEY, val TEXT);');

      let outerCommitRun = false;
      let innerCommitRun = false;
      let outerRollbackRun = false;
      let innerRollbackRun = false;

      assert.throws(() => {
        dbManager.transaction(() => {
          dbManager.onPostCommit(() => { outerCommitRun = true; });
          dbManager.onPostRollback(() => { outerRollbackRun = true; });

          // Nested transaction succeeds
          dbManager.transaction(() => {
            dbManager.onPostCommit(() => { innerCommitRun = true; });
            dbManager.onPostRollback(() => { innerRollbackRun = true; });
          });

          // But outer transaction subsequently fails
          throw new Error('Outer transaction failed');
        });
      });

      assert.equal(outerCommitRun, false, 'Outer commit hook must not execute');
      assert.equal(innerCommitRun, false, 'Inner commit hook must not execute');
      assert.equal(outerRollbackRun, true, 'Outer rollback hook must execute');
      assert.equal(dbManager.getTransactionDepth(), 0, 'Depth should be reset to 0');
    });
  });

  describe('PHASE 2: Coordination Lock Reliability with Separate SQLite Connections', () => {
    test('1. Prevents another connection/process from acquiring lock while valid owner holds it', () => {
      const lockKey = 'test_coord_lock_1';
      const owner1 = 'worker_process_1';
      const owner2 = 'worker_process_2';

      // Primary connection acquires lock for 5000ms
      const acquired1 = dbManager.acquireCoordinationLock(lockKey, owner1, 5000);
      assert.equal(acquired1, true, 'Owner 1 should acquire lock');

      // Open a second, independent connection to the same SQLite database file
      const secondDb = new DatabaseSync(tempDbPath);
      try {
        const now = Date.now();
        const expiry = now + 5000;
        // Attempt acquisition from secondDb
        const res = secondDb.prepare(`
          INSERT INTO coordination_locks (lock_key, owner_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(lock_key) DO UPDATE SET
            owner_id = excluded.owner_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
          WHERE coordination_locks.expires_at < ?
        `).run(lockKey, owner2, now, expiry, now);

        assert.equal(res.changes, 0, 'Second connection must NOT acquire lock while owner 1 has active lock');

        // Verify owner1 is still the recorded owner in secondDb
        const row = secondDb.prepare('SELECT owner_id FROM coordination_locks WHERE lock_key = ?').get(lockKey) as any;
        assert.equal(row.owner_id, owner1, 'Owner 1 must remain recorded owner');
      } finally {
        secondDb.close();
      }
    });

    test('2. Releasing lock only succeeds when owned by the current process', () => {
      const lockKey = 'test_coord_lock_release';
      const ownerReal = 'worker_alpha';
      const ownerIntruder = 'worker_beta';

      dbManager.acquireCoordinationLock(lockKey, ownerReal, 10000);

      // Intruder attempts to release
      const intruderRelease = dbManager.releaseCoordinationLock(lockKey, ownerIntruder);
      assert.equal(intruderRelease, false, 'Intruder must fail to release another process lock');

      // Lock is still held by ownerReal
      assert.equal(dbManager.isCoordinationLockHeld(lockKey, ownerReal), true);

      // Real owner releases
      const ownerRelease = dbManager.releaseCoordinationLock(lockKey, ownerReal);
      assert.equal(ownerRelease, true, 'Real owner should release lock');
      assert.equal(dbManager.isCoordinationLockHeld(lockKey, ownerReal), false);
    });

    test('3. Simulated lock expiration allows acquisition by another connection after expiry', async () => {
      const lockKey = 'test_coord_lock_expiry';
      const owner1 = 'short_lived_owner';
      const owner2 = 'next_owner';

      // Acquire with short duration (150ms)
      const acquired1 = dbManager.acquireCoordinationLock(lockKey, owner1, 150);
      assert.equal(acquired1, true);

      // Wait 200ms for expiration
      await new Promise(r => setTimeout(r, 200));

      // Separate connection attempts acquisition
      const secondDb = new DatabaseSync(tempDbPath);
      try {
        const now = Date.now();
        const expiry = now + 5000;
        const res = secondDb.prepare(`
          INSERT INTO coordination_locks (lock_key, owner_id, acquired_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(lock_key) DO UPDATE SET
            owner_id = excluded.owner_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
          WHERE coordination_locks.expires_at < ?
        `).run(lockKey, owner2, now, expiry, now);

        assert.equal(res.changes, 1, 'Second connection should acquire previously expired lock');

        // Owner 1 attempting to renew must now fail!
        const renewed = dbManager.renewCoordinationLock(lockKey, owner1, 5000);
        assert.equal(renewed, false, 'Owner 1 must fail to renew lock after expiration to owner 2');
      } finally {
        secondDb.close();
      }
    });

    test('4. MergeManager.enqueuePatch detects lock loss during execution and never reports success', async () => {
      const buildId = `build_loss_test_${Date.now()}`;
      const lockKey = `build_patch_${buildId}`;

      // Reset store dbManager to test dbManager
      const origDbManager = db.dbManager;
      db.dbManager = dbManager;

      try {
        await assert.rejects(
          async () => {
            // Lock duration is 1000ms
            await MergeManager.enqueuePatch(
              buildId,
              async () => {
                // Preempt the lock from outside during the operation
                const intruderDb = new DatabaseSync(tempDbPath);
                try {
                  const now = Date.now();
                  intruderDb.prepare(`
                    UPDATE coordination_locks
                    SET owner_id = 'preempting_worker', expires_at = ?
                    WHERE lock_key = ?
                  `).run(now + 10000, lockKey);
                } finally {
                  intruderDb.close();
                }

                return { success: true, mutated: true };
              },
              5000,
              1000
            );
          },
          (err: Error) => {
            assert.match(err.message, /lock expired or was preempted/i);
            return true;
          }
        );
      } finally {
        db.dbManager = origDbManager;
      }
    });
  });
});
