import path from 'node:path';
import fs from 'node:fs';
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

  private constructor(dbPath?: string) {
    const isProduction = process.env.NODE_ENV === 'production';
    const requestedPath = dbPath || process.env.SQLITE_DB_PATH;

    if (requestedPath === ':memory:' || dbPath === ':memory:') {
      if (isProduction) {
        throw new Error('FATAL: In-memory database (:memory:) is forbidden in production environment. A durable persistent storage path must be configured.');
      }
      this.db = new DatabaseSync(':memory:');
      this.isInMemory = true;
      console.warn('[STORAGE] Running with in-memory SQLite database (development/test mode only). Data will not persist across restarts.');
    } else {
      const targetPath = requestedPath || path.resolve(process.cwd(), 'squadforge.db');
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new DatabaseSync(targetPath);
    }

    this.configurePragmas();
    this.runMigrations();
  }

  public isMemoryStorage(): boolean {
    return this.isInMemory;
  }

  static getInstance(dbPath?: string): DatabaseManager {
    if (!DatabaseManager.instance) {
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
    if (!this.isInMemory) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
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

    const appliedRows = this.db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
    const appliedNames = new Set(appliedRows.map(r => r.name));

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
      }
    ];

    for (const m of migrations) {
      if (!appliedNames.has(m.name)) {
        m.up(this.db);
        const stmt = this.db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');
        stmt.run(m.id, m.name, Date.now());
      }
    }
  }

  /**
   * Helper to execute in a database transaction
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }
}
