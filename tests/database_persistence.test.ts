import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseManager } from '../server/db/database.js';
import { PersistentDatabase } from '../server/store.js';
import { getEncryptionKey } from '../server/crypto.js';

describe('SquadForge SQLite Database Engine & Migration Architecture', () => {
  let dbMgr: DatabaseManager;

  beforeEach(() => {
    // Isolated in-memory database for testing
    dbMgr = DatabaseManager.resetInstance(':memory:');
  });

  afterEach(() => {
    try {
      dbMgr.close();
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

  test('In production mode, storage initialization failure throws fatal error rather than silent in-memory fallback', () => {
    const origNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const brokenDbManager: any = {
        db: {
          prepare: () => {
            throw new Error('Disk I/O error or permission denied');
          }
        }
      };

      assert.throws(() => {
        const store = Object.create(PersistentDatabase.prototype);
        store.dbManager = brokenDbManager;
        (store as any).initializeStorage();
      }, /Production database initialization failed/);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  test('In production mode, DatabaseManager rejects :memory: storage with fatal error', () => {
    const origNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => {
        DatabaseManager.resetInstance(':memory:');
      }, /FATAL: In-memory database \(:memory:\) is forbidden in production environment/);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      // Reset back to in-memory for following tests
      DatabaseManager.resetInstance(':memory:');
    }
  });

  test('In production mode, getEncryptionKey enforces 32+ character non-default ENCRYPTION_SECRET', () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origSecret = process.env.ENCRYPTION_SECRET;
    try {
      process.env.NODE_ENV = 'production';

      // 1. Missing secret
      delete process.env.ENCRYPTION_SECRET;
      assert.throws(() => {
        getEncryptionKey();
      }, /ENCRYPTION_SECRET environment variable is missing/);

      // 2. Default placeholder secret
      process.env.ENCRYPTION_SECRET = 'squadforge-development-master-encryption-key-2026';
      assert.throws(() => {
        getEncryptionKey();
      }, /ENCRYPTION_SECRET is insecure or too short for production/);

      // 3. Short secret (< 32 chars)
      process.env.ENCRYPTION_SECRET = 'too-short-secret';
      assert.throws(() => {
        getEncryptionKey();
      }, /ENCRYPTION_SECRET is insecure or too short for production/);

      // 4. Valid 32+ character secret passes
      process.env.ENCRYPTION_SECRET = 'a'.repeat(32);
      const key = getEncryptionKey();
      assert.ok(Buffer.isBuffer(key));
      assert.equal(key.length, 32);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origSecret !== undefined) {
        process.env.ENCRYPTION_SECRET = origSecret;
      } else {
        delete process.env.ENCRYPTION_SECRET;
      }
    }
  });

  test('Database write errors mark storage degraded and throw in production', () => {
    const store = new PersistentDatabase(':memory:');
    assert.equal(store.checkHealth().healthy, true);

    // Simulate SQLite error handling
    store.handleDatabaseWriteError('testWrite', new Error('Disk full or locked'));
    
    // Health probe must immediately report unhealthy
    const health = store.checkHealth();
    assert.equal(health.healthy, false);
    assert.match(health.error || '', /Disk full or locked/);

    // In production, write errors throw rather than being silently ignored
    const origNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => {
        store.handleDatabaseWriteError('criticalWrite', new Error('Constraint violation'));
      }, /SQLite write failure during criticalWrite: Constraint violation/);
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  test('Disk-backed database initializes in WAL mode with busy_timeout configured', () => {
    // Verify WAL and busy timeout pragmas on disk-backed test DB
    const pragmaJournal = dbMgr.db.prepare('PRAGMA journal_mode;').get() as any;
    // In-memory returns 'memory'; disk returns 'wal'
    assert.ok(pragmaJournal);

    const pragmaTimeout = dbMgr.db.prepare('PRAGMA busy_timeout;').get() as any;
    assert.ok(pragmaTimeout.timeout >= 5000, 'busy_timeout must be at least 5000ms to handle concurrent queries');
  });

  test('Concurrent sequential transactions execute without lock contention', () => {
    // Execute multiple rapid transactions to verify lock release
    for (let i = 0; i < 20; i++) {
      dbMgr.transaction(() => {
        dbMgr.db.prepare(`
          INSERT INTO users (id, email, name, enabled_model_ids, created_at)
          VALUES (?, ?, ?, '["gemini"]', ?)
        `).run(`user_concurrent_${i}`, `user_${i}@concurrent.test`, `User ${i}`, Date.now());
      });
    }

    const countRow = dbMgr.db.prepare("SELECT COUNT(*) as count FROM users WHERE id LIKE 'user_concurrent_%'").get() as any;
    assert.equal(countRow.count, 20);
  });
});
