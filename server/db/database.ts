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
      },
      {
        id: 7,
        name: '007_universal_architecture_engine',
        up: (db: DatabaseSync) => {
          const tableInfo = db.prepare('PRAGMA table_info(builds)').all() as Array<{ name: string }>;
          const existingCols = new Set(tableInfo.map(c => c.name));

          if (!existingCols.has('architecture_blueprint')) {
            db.exec('ALTER TABLE builds ADD COLUMN architecture_blueprint TEXT;');
          }
          if (!existingCols.has('requirements_analysis')) {
            db.exec('ALTER TABLE builds ADD COLUMN requirements_analysis TEXT;');
          }
          if (!existingCols.has('complexity_assessment')) {
            db.exec('ALTER TABLE builds ADD COLUMN complexity_assessment TEXT;');
          }
          if (!existingCols.has('file_structure_plan')) {
            db.exec('ALTER TABLE builds ADD COLUMN file_structure_plan TEXT;');
          }
          if (!existingCols.has('dependency_plan')) {
            db.exec('ALTER TABLE builds ADD COLUMN dependency_plan TEXT;');
          }
        }
      },
      {
        id: 8,
        name: '008_collaborative_agent_swarm',
        up: (db: DatabaseSync) => {
          db.exec(`
            -- Agent Collaboration Profiles
            CREATE TABLE IF NOT EXISTS agent_collaboration_profiles (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              role TEXT NOT NULL,
              name TEXT NOT NULL,
              model_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'idle',
              capabilities TEXT NOT NULL DEFAULT '[]',
              responsibilities TEXT NOT NULL DEFAULT '[]',
              assigned_task_ids TEXT NOT NULL DEFAULT '[]',
              current_task_id TEXT,
              workload_score REAL NOT NULL DEFAULT 0.0,
              collaboration_permissions TEXT NOT NULL DEFAULT '[]',
              work_history TEXT NOT NULL DEFAULT '[]',
              last_active INTEGER NOT NULL,
              model_status TEXT NOT NULL DEFAULT 'idle',
              metadata TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_agent_profiles_build ON agent_collaboration_profiles(build_id);
            CREATE INDEX IF NOT EXISTS idx_agent_profiles_role ON agent_collaboration_profiles(role);

            -- Persistent Agent Messages
            CREATE TABLE IF NOT EXISTS agent_messages (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              project_id TEXT NOT NULL,
              sender TEXT NOT NULL,
              sender_role TEXT NOT NULL,
              recipient TEXT NOT NULL DEFAULT 'broadcast',
              related_task_id TEXT,
              related_files TEXT NOT NULL DEFAULT '[]',
              relevant_file_versions TEXT,
              message_type TEXT NOT NULL,
              content TEXT NOT NULL,
              structured_metadata TEXT,
              parent_message_id TEXT,
              depth INTEGER NOT NULL DEFAULT 0,
              timestamp INTEGER NOT NULL,
              processing_status TEXT NOT NULL DEFAULT 'delivered'
            );
            CREATE INDEX IF NOT EXISTS idx_agent_messages_build ON agent_messages(build_id);
            CREATE INDEX IF NOT EXISTS idx_agent_messages_type ON agent_messages(message_type);
            CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(related_task_id);
            CREATE INDEX IF NOT EXISTS idx_agent_messages_timestamp ON agent_messages(timestamp);

            -- Code Reviews
            CREATE TABLE IF NOT EXISTS code_reviews (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              patch_id TEXT,
              author_agent TEXT NOT NULL,
              author_role TEXT NOT NULL,
              reviewer_agent TEXT NOT NULL,
              reviewer_role TEXT NOT NULL,
              changed_files TEXT NOT NULL DEFAULT '[]',
              base_versions TEXT NOT NULL DEFAULT '{}',
              proposed_changes TEXT NOT NULL DEFAULT '[]',
              requirements_addressed TEXT NOT NULL DEFAULT '[]',
              implementation_explanation TEXT NOT NULL,
              test_evidence TEXT NOT NULL,
              verdict TEXT NOT NULL DEFAULT 'approved',
              status TEXT NOT NULL DEFAULT 'pending',
              review_checks TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_code_reviews_build ON code_reviews(build_id);
            CREATE INDEX IF NOT EXISTS idx_code_reviews_task ON code_reviews(task_id);

            -- Code Review Comments
            CREATE TABLE IF NOT EXISTS code_review_comments (
              id TEXT PRIMARY KEY,
              review_id TEXT NOT NULL REFERENCES code_reviews(id) ON DELETE CASCADE,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              file_path TEXT NOT NULL,
              start_line INTEGER NOT NULL,
              end_line INTEGER NOT NULL,
              severity TEXT NOT NULL DEFAULT 'suggestion',
              explanation TEXT NOT NULL,
              suggested_correction TEXT,
              related_requirement TEXT,
              status TEXT NOT NULL DEFAULT 'open',
              author TEXT NOT NULL,
              author_role TEXT NOT NULL,
              timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_review_comments_review ON code_review_comments(review_id);
            CREATE INDEX IF NOT EXISTS idx_review_comments_build ON code_review_comments(build_id);

            -- Patch Proposals
            CREATE TABLE IF NOT EXISTS patch_proposals (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              author_agent TEXT NOT NULL,
              author_role TEXT NOT NULL,
              related_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              target_file TEXT NOT NULL,
              base_file_version INTEGER NOT NULL,
              base_content_hash TEXT NOT NULL,
              proposed_changes TEXT NOT NULL,
              change_explanation TEXT NOT NULL,
              expected_behavior TEXT NOT NULL,
              validation_results TEXT NOT NULL,
              review_status TEXT NOT NULL DEFAULT 'pending',
              application_status TEXT NOT NULL DEFAULT 'proposed',
              applied_file_version INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_patch_proposals_build ON patch_proposals(build_id);
            CREATE INDEX IF NOT EXISTS idx_patch_proposals_file ON patch_proposals(build_id, target_file);

            -- File Conflicts
            CREATE TABLE IF NOT EXISTS file_conflicts (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              file_path TEXT NOT NULL,
              base_version INTEGER NOT NULL,
              conflicting_versions TEXT NOT NULL DEFAULT '[]',
              competing_patches TEXT NOT NULL DEFAULT '[]',
              reason TEXT NOT NULL,
              overlapping_hunks TEXT NOT NULL DEFAULT '[]',
              resolution_status TEXT NOT NULL DEFAULT 'open',
              resolved_by TEXT,
              resolved_content TEXT,
              resolved_version INTEGER,
              created_at INTEGER NOT NULL,
              resolved_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_file_conflicts_build ON file_conflicts(build_id);

            -- AI Challenges
            CREATE TABLE IF NOT EXISTS ai_challenges (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              task_id TEXT,
              subject TEXT NOT NULL,
              original_proposal TEXT NOT NULL,
              proposer_agent TEXT NOT NULL,
              proposer_role TEXT NOT NULL,
              challenger_agent TEXT NOT NULL,
              challenger_role TEXT NOT NULL,
              current_round INTEGER NOT NULL DEFAULT 1,
              max_rounds INTEGER NOT NULL DEFAULT 3,
              status TEXT NOT NULL DEFAULT 'active',
              outcome TEXT NOT NULL DEFAULT 'pending',
              final_decision TEXT,
              decision_rationale TEXT,
              participants TEXT NOT NULL DEFAULT '[]',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ai_challenges_build ON ai_challenges(build_id);

            -- AI Challenge Arguments
            CREATE TABLE IF NOT EXISTS ai_challenge_arguments (
              id TEXT PRIMARY KEY,
              challenge_id TEXT NOT NULL REFERENCES ai_challenges(id) ON DELETE CASCADE,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              round_number INTEGER NOT NULL,
              author_agent TEXT NOT NULL,
              author_role TEXT NOT NULL,
              argument_type TEXT NOT NULL,
              claim TEXT NOT NULL,
              evidence TEXT NOT NULL,
              proposed_alternative TEXT,
              identified_risks TEXT NOT NULL DEFAULT '[]',
              timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_challenge_args_challenge ON ai_challenge_arguments(challenge_id);

            -- Collaborative Defects
            CREATE TABLE IF NOT EXISTS collaborative_defects (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              task_id TEXT,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              severity TEXT NOT NULL DEFAULT 'medium',
              status TEXT NOT NULL DEFAULT 'open',
              reproduction_steps TEXT NOT NULL DEFAULT '[]',
              expected_behavior TEXT NOT NULL,
              actual_behavior TEXT NOT NULL,
              affected_files TEXT NOT NULL DEFAULT '[]',
              assigned_agents TEXT NOT NULL DEFAULT '[]',
              root_cause TEXT,
              proposed_solutions TEXT NOT NULL DEFAULT '[]',
              selected_patch_id TEXT,
              test_evidence TEXT,
              verification_details TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              resolved_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_collab_defects_build ON collaborative_defects(build_id);
            CREATE INDEX IF NOT EXISTS idx_collab_defects_status ON collaborative_defects(status);

            -- Human Approval Requests
            CREATE TABLE IF NOT EXISTS approval_requests (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              task_id TEXT,
              patch_id TEXT,
              requesting_agent TEXT NOT NULL,
              requesting_role TEXT NOT NULL,
              operation_type TEXT NOT NULL,
              explanation TEXT NOT NULL,
              risk_level TEXT NOT NULL DEFAULT 'medium',
              affected_files TEXT NOT NULL DEFAULT '[]',
              proposed_changes TEXT NOT NULL,
              review_results TEXT,
              test_results TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              approved_by TEXT,
              resolution_notes TEXT,
              created_at INTEGER NOT NULL,
              resolved_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_approval_requests_build ON approval_requests(build_id);
            CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);

            -- Shared Knowledge Items
            CREATE TABLE IF NOT EXISTS shared_knowledge_items (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              source_agent TEXT NOT NULL,
              source_role TEXT NOT NULL,
              source_task_id TEXT,
              category TEXT NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              relevant_files TEXT NOT NULL DEFAULT '[]',
              version INTEGER NOT NULL DEFAULT 1,
              previous_version_id TEXT,
              supersedes_id TEXT,
              status TEXT NOT NULL DEFAULT 'active',
              supersede_reason TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_shared_knowledge_build ON shared_knowledge_items(build_id);
            CREATE INDEX IF NOT EXISTS idx_shared_knowledge_category ON shared_knowledge_items(category);
            CREATE INDEX IF NOT EXISTS idx_shared_knowledge_status ON shared_knowledge_items(status);
          `);
        }
      },
      {
        id: 9,
        name: '009_code_generation_engine',
        up: (db: DatabaseSync) => {
          db.exec(`
            -- Code Generation Runs Table
            CREATE TABLE IF NOT EXISTS code_generation_runs (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              task_id TEXT,
              user_request TEXT NOT NULL,
              generation_profile TEXT NOT NULL,
              model_id TEXT NOT NULL,
              status TEXT NOT NULL,
              current_pass INTEGER NOT NULL DEFAULT 1,
              total_passes INTEGER NOT NULL DEFAULT 6,
              passes TEXT NOT NULL DEFAULT '[]',
              files_created TEXT NOT NULL DEFAULT '[]',
              files_modified TEXT NOT NULL DEFAULT '[]',
              patch_ids TEXT NOT NULL DEFAULT '[]',
              contracts_established TEXT NOT NULL DEFAULT '[]',
              validation_results TEXT,
              repair_attempts INTEGER NOT NULL DEFAULT 0,
              repair_logs TEXT NOT NULL DEFAULT '[]',
              token_usage INTEGER NOT NULL DEFAULT 0,
              cost REAL NOT NULL DEFAULT 0.0,
              error TEXT,
              created_at INTEGER NOT NULL,
              completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_code_gen_build ON code_generation_runs(build_id);
            CREATE INDEX IF NOT EXISTS idx_code_gen_status ON code_generation_runs(status);
          `);
        }
      },
      {
        id: 10,
        name: '010_execution_environment',
        up: (db: DatabaseSync) => {
          db.exec(`
            ALTER TABLE approval_requests ADD COLUMN scope_hash TEXT;

            CREATE TABLE IF NOT EXISTS execution_sessions (
              id TEXT PRIMARY KEY,
              build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
              user_id TEXT NOT NULL,
              status TEXT NOT NULL,
              backend TEXT NOT NULL,
              workspace_hash TEXT NOT NULL,
              script TEXT,
              process_id TEXT,
              exit_code INTEGER,
              end_reason TEXT,
              failure_reason TEXT,
              dependency_status TEXT NOT NULL DEFAULT 'not_started',
              missing_dependencies TEXT NOT NULL DEFAULT '[]',
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              started_at INTEGER,
              stopped_at INTEGER,
              last_activity_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_execution_sessions_build ON execution_sessions(build_id);
            CREATE INDEX IF NOT EXISTS idx_execution_sessions_status ON execution_sessions(status);

            CREATE TABLE IF NOT EXISTS execution_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
              stream TEXT NOT NULL,
              text TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_execution_logs_session ON execution_logs(session_id, id);

            CREATE TABLE IF NOT EXISTS dependency_installs (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
              build_id TEXT NOT NULL,
              package_manager TEXT NOT NULL,
              command TEXT NOT NULL,
              status TEXT NOT NULL,
              error TEXT,
              lockfile_generated INTEGER NOT NULL DEFAULT 0,
              started_at INTEGER NOT NULL,
              finished_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_dependency_installs_session ON dependency_installs(session_id);

            CREATE TABLE IF NOT EXISTS preview_sessions (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL REFERENCES execution_sessions(id) ON DELETE CASCADE,
              build_id TEXT NOT NULL,
              user_id TEXT NOT NULL,
              status TEXT NOT NULL,
              port INTEGER NOT NULL,
              relay_host TEXT NOT NULL,
              relay_port INTEGER NOT NULL,
              token_hash TEXT,
              token_expires_at INTEGER,
              cookie_hash TEXT,
              created_at INTEGER NOT NULL,
              last_access_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_preview_sessions_session ON preview_sessions(session_id);
          `);
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
  private postCommitHooks: Array<() => void> = [];
  private postRollbackHooks: Array<() => void> = [];

  /**
   * Returns current active transaction nesting depth (0 if outside any transaction)
   */
  getTransactionDepth(): number {
    return this.transactionDepth;
  }

  /**
   * Registers a callback to be executed strictly AFTER the outermost transaction commits.
   * If not inside an active transaction, executes immediately.
   */
  onPostCommit(fn: () => void): void {
    if (this.transactionDepth === 0) {
      fn();
    } else {
      this.postCommitHooks.push(fn);
    }
  }

  /**
   * Registers a callback to be executed if the transaction rolls back.
   */
  onPostRollback(fn: () => void): void {
    if (this.transactionDepth > 0) {
      this.postRollbackHooks.push(fn);
    }
  }

  /**
   * Helper to execute in an immediate database transaction (serializes concurrent writes across processes).
   * Supports nested transactions seamlessly via SQLite SAVEPOINTs.
   */
  transaction<T>(fn: () => T): T {
    const isOuter = this.transactionDepth === 0;
    const currentDepth = this.transactionDepth;
    const savepointName = `sp_${currentDepth}`;

    const initialCommitHookCount = this.postCommitHooks.length;
    const initialRollbackHookCount = this.postRollbackHooks.length;

    // 1. Transaction initialization: execute BEGIN or SAVEPOINT before modifying depth
    let started = false;
    try {
      if (isOuter) {
        this.db.exec('BEGIN IMMEDIATE;');
      } else {
        this.db.exec(`SAVEPOINT ${savepointName};`);
      }
      this.transactionDepth++;
      started = true;
    } catch (initErr) {
      // Transaction initialization failed: transactionDepth remains unchanged.
      // Re-throw error without invoking rollback because no transaction or savepoint started.
      throw initErr;
    }

    try {
      const result = fn();
      if (isOuter) {
        try {
          this.db.exec('COMMIT;');
        } catch (commitErr) {
          // Explicit commit failure handling: outer commit failed!
          throw commitErr;
        }

        // Post-commit hooks execute ONLY after successful outer commit
        const hooks = this.postCommitHooks;
        this.postCommitHooks = [];
        this.postRollbackHooks = [];
        for (const hook of hooks) {
          try {
            hook();
          } catch (e) {
            console.error('[DATABASE] Error in post-commit hook:', e);
          }
        }
      } else {
        try {
          this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
        } catch (releaseErr) {
          throw releaseErr;
        }
      }
      return result;
    } catch (err) {
      // Discard commit hooks registered during this savepoint/transaction level
      const rollbackHooksToRun = this.postRollbackHooks.slice(initialRollbackHookCount);
      // Preserve outer transaction commit hooks!
      this.postCommitHooks = this.postCommitHooks.slice(0, initialCommitHookCount);
      // Preserve outer transaction rollback hooks!
      this.postRollbackHooks = this.postRollbackHooks.slice(0, initialRollbackHookCount);

      if (isOuter) {
        try {
          this.db.exec('ROLLBACK;');
        } catch (rbErr) {
          console.error('[DATABASE] Outer ROLLBACK failed:', rbErr);
        }
        for (const hook of rollbackHooksToRun) {
          try { hook(); } catch (hookErr) {
            console.error('[DATABASE] Error in outer rollback hook:', hookErr);
          }
        }
      } else {
        try {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
          this.db.exec(`RELEASE SAVEPOINT ${savepointName};`);
        } catch (spErr) {
          console.error(`[DATABASE] Rollback/release savepoint ${savepointName} failed:`, spErr);
        }
        for (const hook of rollbackHooksToRun) {
          try { hook(); } catch (hookErr) {
            console.error('[DATABASE] Error in savepoint rollback hook:', hookErr);
          }
        }
      }
      throw err;
    } finally {
      if (started) {
        this.transactionDepth--;
        if (this.transactionDepth === 0) {
          this.postCommitHooks = [];
          this.postRollbackHooks = [];
        }
      }
    }
  }

  /**
   * Acquires a database-backed coordination lock for distributed multi-process safety.
   * Validates duration and returns true only if lock was acquired.
   */
  acquireCoordinationLock(lockKey: string, ownerId: string, durationMs: number = 30000): boolean {
    if (!lockKey || !ownerId) return false;
    if (typeof durationMs !== 'number' || isNaN(durationMs) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) {
      return false;
    }
    const now = Date.now();
    const expiry = now + durationMs;

    try {
      const res = this.db.prepare(`
        INSERT INTO coordination_locks (lock_key, owner_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lock_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE coordination_locks.expires_at < ?
      `).run(lockKey, ownerId, now, expiry, now);

      return res.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Renews an existing database coordination lock held by ownerId before it expires.
   */
  renewCoordinationLock(lockKey: string, ownerId: string, durationMs: number = 30000): boolean {
    if (!lockKey || !ownerId) return false;
    if (typeof durationMs !== 'number' || isNaN(durationMs) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) {
      return false;
    }
    const now = Date.now();
    const expiry = now + durationMs;
    try {
      const res = this.db.prepare(`
        UPDATE coordination_locks
        SET expires_at = ?
        WHERE lock_key = ? AND owner_id = ? AND expires_at > ?
      `).run(expiry, lockKey, ownerId, now);
      return res.changes > 0;
    } catch {
      return false;
    }
  }

  /**
   * Checks whether the coordination lock is currently held by ownerId and not expired.
   */
  isCoordinationLockHeld(lockKey: string, ownerId: string): boolean {
    if (!lockKey || !ownerId) return false;
    const now = Date.now();
    try {
      const row = this.db.prepare(`
        SELECT owner_id, expires_at FROM coordination_locks
        WHERE lock_key = ? AND owner_id = ? AND expires_at > ?
      `).get(lockKey, ownerId, now) as any;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /**
   * Releases a database-backed coordination lock owned strictly by ownerId.
   * Never releases a lock owned by another process.
   */
  releaseCoordinationLock(lockKey: string, ownerId: string): boolean {
    if (!lockKey || !ownerId) return false;
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
   * Cleans expired coordination locks.
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
