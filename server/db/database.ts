import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// @ts-ignore - node:sqlite is built-in in Node.js 22
import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  public db: DatabaseSync;
  private isInMemory: boolean = false;
  private dbPath: string = ':memory:';

  private constructor(dbPath?: string) {
    const isProduction = process.env.NODE_ENV === 'production';
    const isTest = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
    let requestedPath = dbPath || process.env.SQLITE_DB_PATH;

    if (!requestedPath && isTest && !isProduction) {
      const tmpDir = os.tmpdir();
      requestedPath = path.join(tmpDir, `squadforge-test-${process.pid}.db`);
    }

    if (requestedPath === ':memory:' || dbPath === ':memory:') {
      if (isProduction) {
        throw new Error('FATAL: In-memory database (:memory:) is forbidden in production environment. A durable persistent storage path must be configured.');
      }
      this.db = new DatabaseSync(':memory:');
      this.isInMemory = true;
      this.dbPath = ':memory:';
      console.warn('[STORAGE] Running with in-memory SQLite database (development/test mode only). Data will not persist across restarts.');
    } else {
      const targetPath = requestedPath || path.resolve(process.cwd(), 'squadforge.db');
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(targetPath);
      this.dbPath = targetPath;
    }

    this.configurePragmas();
    this.runMigrations();
  }

  public isMemoryStorage(): boolean {
    return this.isInMemory;
  }

  public getDbPath(): string {
    return this.dbPath;
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
    if (DatabaseManager.instance === this) {
      DatabaseManager.instance = null;
    }
  }

  static getInstance(dbPath?: string): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager(dbPath);
    } else if (dbPath && (
      (dbPath === ':memory:' && !DatabaseManager.instance.isInMemory) ||
      (dbPath !== ':memory:' && DatabaseManager.instance.isInMemory)
    )) {
      DatabaseManager.instance.close();
      DatabaseManager.instance = new DatabaseManager(dbPath);
    }
    return DatabaseManager.instance;
  }

  /**
   * Resets the singleton instance (useful for isolated unit testing)
   */
  static resetInstance(dbPath?: string): DatabaseManager {
    if (DatabaseManager.instance) {
      try {
        DatabaseManager.instance.db.close();
      } catch (err) {
        // ignore
      }
      DatabaseManager.instance = null;
    }
    DatabaseManager.instance = new DatabaseManager(dbPath);
    return DatabaseManager.instance;
  }

  private configurePragmas(): void {
    // CRITICAL: Set busy_timeout first so concurrent workers wait rather than throwing SQLITE_BUSY
    this.db.exec('PRAGMA busy_timeout = 30000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (!this.isInMemory) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
      } catch (err) {
        // WAL may already be active or temporarily shared
      }
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
  }

  private runMigrations(): void {
    // Migration tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const appliedRows = this.db.prepare('SELECT id, name FROM _migrations').all() as Array<{ id: number; name: string }>;
    const appliedNames = new Set(appliedRows.map(r => r.name));
    const appliedIds = new Set(appliedRows.map(r => r.id));

    const migrations: Migration[] = [
      {
        id: 1,
        name: '001_initial_schema',
        up: (db: DatabaseSync) => {
          db.exec(`
            -- Users Table
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              email TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              password_hash TEXT,
              avatar_url TEXT,
              github_username TEXT,
              github_connected INTEGER NOT NULL DEFAULT 0,
              default_repo TEXT,
              cost_limit_per_build REAL NOT NULL DEFAULT 5.0,
              token_limit_per_build INTEGER DEFAULT 100000,
              routing_preference TEXT DEFAULT 'quality',
              enabled_model_ids TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

            -- Sessions Table
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              ip TEXT,
              user_agent TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

            -- Password Reset Codes (OTP)
            CREATE TABLE IF NOT EXISTS password_reset_codes (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              email TEXT NOT NULL,
              code_hash TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              consumed INTEGER NOT NULL DEFAULT 0,
              invalidated INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_reset_codes_email ON password_reset_codes(email);

            -- Password Reset Auth Tokens
            CREATE TABLE IF NOT EXISTS password_reset_auths (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              email TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              consumed INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_reset_auths_user ON password_reset_auths(user_id);

            -- Legacy Password Reset Tokens
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              email TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            );

            -- Encrypted GitHub OAuth Tokens
            CREATE TABLE IF NOT EXISTS encrypted_github_tokens (
              user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
              encrypted_token TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );

            -- Builds Table
            CREATE TABLE IF NOT EXISTS builds (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              idea TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              completed_at INTEGER,
              selected_models TEXT NOT NULL,
              auto_push_github INTEGER NOT NULL DEFAULT 0,
              total_tokens INTEGER NOT NULL DEFAULT 0,
              total_cost REAL NOT NULL DEFAULT 0.0,
              cost_limit REAL NOT NULL DEFAULT 5.0,
              token_budget INTEGER DEFAULT 100000,
              max_duration_seconds INTEGER NOT NULL DEFAULT 300,
              patches_applied_count INTEGER NOT NULL DEFAULT 0,
              error TEXT,
              failure_reason TEXT,
              tech_stack TEXT,
              milestones TEXT,
              test_report TEXT,
              security_audit TEXT,
              verification_report TEXT,
              verification_feedback TEXT,
              verification_attempts INTEGER NOT NULL DEFAULT 0,
              max_verification_attempts INTEGER NOT NULL DEFAULT 3,
              budget_warning_emitted INTEGER NOT NULL DEFAULT 0,
              github_repo TEXT,
              github_branch TEXT,
              github_pr_url TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_builds_user_id ON builds(user_id);
            CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);

            -- Tasks Table
            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              file_paths TEXT NOT NULL,
              priority INTEGER NOT NULL DEFAULT 3,
              status TEXT NOT NULL DEFAULT 'pending',
              claimed_by TEXT,
              lease_expires_at INTEGER,
              created_at INTEGER NOT NULL,
              completed_at INTEGER,
              error TEXT,
              is_fix_task INTEGER NOT NULL DEFAULT 0,
              retry_count INTEGER NOT NULL DEFAULT 0,
              max_retries INTEGER NOT NULL DEFAULT 3,
              last_error TEXT,
              dependencies TEXT,
              assigned_role TEXT,
              milestone TEXT,
              complexity TEXT,
              token_budget INTEGER,
              actual_tokens_used INTEGER NOT NULL DEFAULT 0,
              estimated_cost REAL NOT NULL DEFAULT 0.0,
              is_paused INTEGER NOT NULL DEFAULT 0,
              paused_reason TEXT,
              execution_logs TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_build_id ON tasks(build_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

            -- Project Files Table
            CREATE TABLE IF NOT EXISTS project_files (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              path TEXT NOT NULL,
              content TEXT NOT NULL,
              version INTEGER NOT NULL DEFAULT 1,
              owner_model TEXT NOT NULL,
              lease_owner TEXT,
              lease_expires_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_project_files_build_path ON project_files(build_id, path);

            -- File Versions History
            CREATE TABLE IF NOT EXISTS file_versions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              file_id TEXT NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              path TEXT NOT NULL,
              version INTEGER NOT NULL,
              content TEXT NOT NULL,
              author_model TEXT NOT NULL,
              commit_message TEXT,
              timestamp INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_file_versions_build_path ON file_versions(build_id, path);

            -- Swarm Events Table
            CREATE TABLE IF NOT EXISTS swarm_events (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              timestamp INTEGER NOT NULL,
              type TEXT NOT NULL,
              model_id TEXT,
              task_id TEXT,
              file_path TEXT,
              details TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_swarm_events_build_id ON swarm_events(build_id);

            -- Model Runs Table
            CREATE TABLE IF NOT EXISTS model_runs (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              model_id TEXT NOT NULL,
              status TEXT NOT NULL,
              role TEXT,
              current_task_id TEXT,
              tokens_used INTEGER NOT NULL DEFAULT 0,
              estimated_cost REAL NOT NULL DEFAULT 0.0,
              patches_applied INTEGER NOT NULL DEFAULT 0,
              patches_rejected INTEGER NOT NULL DEFAULT 0,
              last_action_summary TEXT,
              error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_model_runs_build_id ON model_runs(build_id);

            -- Checkpoints Table
            CREATE TABLE IF NOT EXISTS checkpoints (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              timestamp INTEGER NOT NULL,
              description TEXT NOT NULL,
              snapshot TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_checkpoints_build_id ON checkpoints(build_id);

            -- Usage Logs Table
            CREATE TABLE IF NOT EXISTS usage_logs (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              build_id TEXT,
              timestamp INTEGER NOT NULL,
              requested_model_id TEXT NOT NULL,
              actual_model_used TEXT NOT NULL,
              provider_used TEXT NOT NULL,
              input_tokens INTEGER NOT NULL,
              output_tokens INTEGER NOT NULL,
              total_tokens INTEGER NOT NULL,
              estimated_cost REAL NOT NULL,
              task_complexity TEXT NOT NULL,
              is_fallback INTEGER NOT NULL DEFAULT 0,
              cached INTEGER NOT NULL DEFAULT 0,
              latency_ms INTEGER NOT NULL,
              success INTEGER NOT NULL,
              task_id TEXT,
              task_title TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_usage_logs_user_id ON usage_logs(user_id);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_build_id ON usage_logs(build_id);

            -- Audit Logs Table
            CREATE TABLE IF NOT EXISTS audit_logs (
              id TEXT PRIMARY KEY,
              user_id TEXT,
              event_type TEXT NOT NULL,
              ip TEXT,
              user_agent TEXT,
              details TEXT NOT NULL,
              timestamp INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

            -- Execution Jobs Table
            CREATE TABLE IF NOT EXISTS execution_jobs (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              job_type TEXT NOT NULL,
              status TEXT NOT NULL,
              exit_code INTEGER,
              stdout TEXT,
              stderr TEXT,
              report TEXT,
              created_at INTEGER NOT NULL,
              completed_at INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_execution_jobs_build_id ON execution_jobs(build_id);
          `);
        }
      },
      {
        id: 2,
        name: '002_oauth_states',
        up: (db: DatabaseSync) => {
          db.exec(`
            -- Persistent GitHub OAuth States
            CREATE TABLE IF NOT EXISTS oauth_states (
              state TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              session_token_hash TEXT NOT NULL,
              redirect_uri TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL,
              consumed INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_oauth_states_user_id ON oauth_states(user_id);
            CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
            CREATE INDEX IF NOT EXISTS idx_oauth_states_consumed ON oauth_states(consumed);
          `);
        }
      },
      {
        id: 3,
        name: '003_project_intelligence_memory',
        up: (db: DatabaseSync) => {
          const tableInfo = db.prepare('PRAGMA table_info(builds)').all() as Array<{ name: string }>;
          const existingCols = new Set(tableInfo.map(c => c.name));

          if (!existingCols.has('project_type')) {
            db.exec("ALTER TABLE builds ADD COLUMN project_type TEXT DEFAULT 'fullstack';");
          }
          if (!existingCols.has('architecture_decisions')) {
            db.exec('ALTER TABLE builds ADD COLUMN architecture_decisions TEXT;');
          }
          if (!existingCols.has('requirements_checklist')) {
            db.exec('ALTER TABLE builds ADD COLUMN requirements_checklist TEXT;');
          }
          if (!existingCols.has('revisions')) {
            db.exec('ALTER TABLE builds ADD COLUMN revisions TEXT;');
          }
          if (!existingCols.has('live_preview_html')) {
            db.exec('ALTER TABLE builds ADD COLUMN live_preview_html TEXT;');
          }
        }
      },
      {
        id: 4,
        name: '004_project_memory_engine',
        up: (db: DatabaseSync) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS project_memories (
              project_id TEXT PRIMARY KEY REFERENCES builds(id) ON DELETE CASCADE,
              user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              memory_data TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_project_memories_user_id ON project_memories(user_id);
          `);
        }
      },
      {
        id: 5,
        name: '005_preview_metadata_and_verification',
        up: (db: DatabaseSync) => {
          const tableInfo = db.prepare('PRAGMA table_info(builds)').all() as Array<{ name: string }>;
          const existingCols = new Set(tableInfo.map(c => c.name));

          if (!existingCols.has('preview_mode')) {
            db.exec('ALTER TABLE builds ADD COLUMN preview_mode TEXT;');
          }
          if (!existingCols.has('preview_diagnostic')) {
            db.exec('ALTER TABLE builds ADD COLUMN preview_diagnostic TEXT;');
          }
          if (!existingCols.has('preview_runtime_errors')) {
            db.exec('ALTER TABLE builds ADD COLUMN preview_runtime_errors TEXT;');
          }
          if (!existingCols.has('preview_entry_point')) {
            db.exec('ALTER TABLE builds ADD COLUMN preview_entry_point TEXT;');
          }
        }
      },
      {
        id: 6,
        name: '006_coordination_and_patch_integrity',
        up: (db: DatabaseSync) => {
          // Distributed coordination locks table across processes
          db.exec(`
            CREATE TABLE IF NOT EXISTS coordination_locks (
              lock_key TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL,
              acquired_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_coordination_locks_expires_at ON coordination_locks(expires_at);
          `);

          // Ensure project_files has content_hash column
          const pfCols = db.prepare('PRAGMA table_info(project_files)').all() as Array<{ name: string }>;
          const pfColNames = new Set(pfCols.map(c => c.name));
          if (!pfColNames.has('content_hash')) {
            db.exec('ALTER TABLE project_files ADD COLUMN content_hash TEXT;');
          }

          // Ensure file_versions has content_hash column
          const fvCols = db.prepare('PRAGMA table_info(file_versions)').all() as Array<{ name: string }>;
          const fvColNames = new Set(fvCols.map(c => c.name));
          if (!fvColNames.has('content_hash')) {
            db.exec('ALTER TABLE file_versions ADD COLUMN content_hash TEXT;');
          }
        }
      }
    ];

    for (const m of migrations) {
      if (!appliedNames.has(m.name) && !appliedIds.has(m.id)) {
        this.db.exec('BEGIN IMMEDIATE;');
        try {
          // Re-check inside transaction in case another connection applied it
          const row = this.db.prepare('SELECT id FROM _migrations WHERE id = ? OR name = ?').get(m.id, m.name);
          if (!row) {
            m.up(this.db);
            const stmt = this.db.prepare('INSERT OR REPLACE INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');
            stmt.run(m.id, m.name, Date.now());
          }
          this.db.exec('COMMIT;');
        } catch (err) {
          try { this.db.exec('ROLLBACK;'); } catch {}
          throw err;
        }
      }
    }
  }

  private transactionDepth = 0;

  /**
   * Helper to execute in an immediate database transaction (serializes concurrent writes across processes).
   * Supports nested transactions seamlessly via SQLite SAVEPOINTs.
   */
  transaction<T>(fn: () => T): T {
    const isOuter = this.transactionDepth === 0;
    const savepointName = `sp_${this.transactionDepth}`;
    this.transactionDepth++;

    if (isOuter) {
      this.db.exec('BEGIN IMMEDIATE;');
    } else {
      this.db.exec(`SAVEPOINT ${savepointName};`);
    }

    try {
      const result = fn();
      if (isOuter) {
        this.db.exec('COMMIT;');
      } else {
        this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }
      return result;
    } catch (err) {
      try {
        if (isOuter) {
          this.db.exec('ROLLBACK;');
        } else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
          this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
        }
      } catch {}
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  /**
   * Acquires a database-backed coordination lock for distributed multi-process safety
   */
  acquireCoordinationLock(lockKey: string, ownerId: string, durationMs: number = 30000): boolean {
    const now = Date.now();
    const expiry = now + durationMs;

    try {
      // First clean up expired locks
      this.cleanExpiredCoordinationLocks(now);

      const res = this.db.prepare(`
        INSERT INTO coordination_locks (lock_key, owner_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lock_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE expires_at < ?
      `).run(lockKey, ownerId, now, expiry, now);

      return res.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Releases a database-backed coordination lock owned by ownerId
   */
  releaseCoordinationLock(lockKey: string, ownerId: string): boolean {
    try {
      const res = this.db.prepare(`
        DELETE FROM coordination_locks
        WHERE lock_key = ? AND owner_id = ?
      `).run(lockKey, ownerId);
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Cleans expired coordination locks
   */
  cleanExpiredCoordinationLocks(now: number = Date.now()): number {
    try {
      const res = this.db.prepare(`
        DELETE FROM coordination_locks WHERE expires_at < ?
      `).run(now);
      return Number(res.changes);
    } catch {
      return 0;
    }
  }
}
