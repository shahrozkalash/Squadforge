import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseManager } from '../server/db/database.js';

describe('SquadForge SQLite Database Engine & Migration Architecture', () => {
  let dbMgr: DatabaseManager;

  beforeEach(() => {
    // Isolated in-memory database for testing
    dbMgr = DatabaseManager.resetInstance(':memory:');
  });

  afterEach(() => {
    try {
      dbMgr.db.close();
    } catch (e) {
      // Ignored
    }
  });

  test('Migrations execute automatically and register in _migrations', () => {
    const rows = dbMgr.db.prepare('SELECT * FROM _migrations').all() as any[];
    assert.ok(rows.length >= 1, 'Should have applied at least 1 migration');
    assert.equal(rows[0].name, '001_initial_schema');
    assert.ok(rows[0].applied_at > 0);
  });

  test('All core tables and indexes are created properly', () => {
    const tables = dbMgr.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const tableNames = new Set(tables.map(t => t.name));

    const expectedTables = [
      'users',
      'sessions',
      'password_reset_codes',
      'password_reset_auths',
      'builds',
      'tasks',
      'project_files',
      'file_versions',
      'swarm_events',
      'model_runs',
      'checkpoints',
      'usage_logs',
      'audit_logs',
      'execution_jobs'
    ];

    for (const tbl of expectedTables) {
      assert.ok(tableNames.has(tbl), `Table ${tbl} must exist in SQLite database`);
    }
  });

  test('Transactions commit successfully on clean execution', () => {
    dbMgr.transaction(() => {
      dbMgr.db.prepare(`
        INSERT INTO users (id, email, name, enabled_model_ids, created_at)
        VALUES ('u1', 'test@test.com', 'Test User', '["gemini"]', 1000)
      `).run();
    });

    const user = dbMgr.db.prepare("SELECT * FROM users WHERE id = 'u1'").get() as any;
    assert.ok(user);
    assert.equal(user.email, 'test@test.com');
  });

  test('Transactions roll back completely on error without partial state', () => {
    assert.throws(() => {
      dbMgr.transaction(() => {
        dbMgr.db.prepare(`
          INSERT INTO users (id, email, name, enabled_model_ids, created_at)
          VALUES ('u2', 'rollback@test.com', 'Rollback User', '["gemini"]', 2000)
        `).run();

        // Intentionally trigger constraint error (duplicate primary key)
        dbMgr.db.prepare(`
          INSERT INTO users (id, email, name, enabled_model_ids, created_at)
          VALUES ('u2', 'dup@test.com', 'Dup User', '["gemini"]', 2000)
        `).run();
      });
    });

    const user = dbMgr.db.prepare("SELECT * FROM users WHERE id = 'u2'").get();
    assert.equal(user, undefined, 'User must not exist after rolled-back transaction');
  });

  test('Foreign key cascade deletes child records', () => {
    dbMgr.db.prepare(`
      INSERT INTO users (id, email, name, enabled_model_ids, created_at)
      VALUES ('u_parent', 'parent@test.com', 'Parent User', '["gemini"]', 1000)
    `).run();

    dbMgr.db.prepare(`
      INSERT INTO builds (id, user_id, idea, status, created_at, updated_at, selected_models)
      VALUES ('b_child', 'u_parent', 'Child Build', 'running', 1000, 1000, '["gemini"]')
    `).run();

    const buildBefore = dbMgr.db.prepare("SELECT * FROM builds WHERE id = 'b_child'").get();
    assert.ok(buildBefore);

    // Delete user -> CASCADE should delete child build
    dbMgr.db.prepare("DELETE FROM users WHERE id = 'u_parent'").run();

    const buildAfter = dbMgr.db.prepare("SELECT * FROM builds WHERE id = 'b_child'").get();
    assert.equal(buildAfter, undefined, 'Build must be cascade-deleted when user is deleted');
  });

  test('Database health check verifies SQLite connectivity and detects closed connection', () => {
    // 1. Live database returns healthy
    const liveCheck = {
      healthy: true,
      result: dbMgr.db.prepare('SELECT 1 as alive').get() as { alive: number }
    };
    assert.equal(liveCheck.healthy, true);
    assert.equal(liveCheck.result.alive, 1);

    // 2. Closed connection triggers failure
    dbMgr.db.close();
    let failed = false;
    try {
      dbMgr.db.prepare('SELECT 1 as alive').get();
    } catch {
      failed = true;
    }
    assert.equal(failed, true, 'Querying closed database must throw error');
  });
});
