import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { 
  User, 
  SafeUser,
  Session,
  Build, 
  Task, 
  ProjectFile, 
  FileVersion,
  SwarmEvent, 
  ModelRunStatus, 
  Checkpoint,
  PasswordResetToken,
  PasswordResetCodeRecord,
  PasswordResetAuthRecord,
  UsageLogEntry,
  SwarmUsageStats,
  PatchAction,
  CreateFileAction,
  DeleteFileAction,
  RenameFileAction,
  AgentProfile,
  AgentLifecycleState,
  AgentMessage,
  CodeReview,
  CodeReviewComment,
  PatchProposal,
  FileConflict,
  AIChallenge,
  AIChallengeArgument,
  CollaborativeDefect,
  HumanApprovalRequest,
  SharedKnowledgeItem,
  CodeGenerationRun
} from './types.js';
import { ProjectMemory } from './swarm/projectMemory.js';
import { 
  encryptToken, 
  decryptToken, 
  hashSessionToken, 
  generateSessionToken,
  hashVerificationCode,
  timingSafeVerifyCodeHash,
  generateResetAuthToken,
  hashResetAuthToken,
  hashPassword
} from './crypto.js';
import { modelRegistry } from './modelRegistry.js';
import { quotaManager } from './quotaManager.js';
import { safeResultCache } from './cache.js';
import { localLLMService } from './localLLM.js';
import { DatabaseManager } from './db/database.js';
import { ExecutionAdapter } from './swarm/executionAdapter.js';

interface ClientSSEListener {
  id: string;
  res: any;
  buildId?: string;
}

const DATA_FILE = path.resolve(process.cwd(), '.squadforge_data.json');
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function safeJsonParse<T>(value: any, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function computeContentHash(content: string): string {
  return crypto.createHash('sha256').update(content || '', 'utf-8').digest('hex');
}

export class PersistentDatabase {
  public dbManager: DatabaseManager;

  // In-memory synchronized entity caches
  public users: Map<string, User> = new Map();
  public usersByEmail: Map<string, string> = new Map();
  public sessions: Map<string, Session> = new Map();
  public passwordResetTokens: Map<string, PasswordResetToken> = new Map();
  public passwordResetCodes: Map<string, PasswordResetCodeRecord> = new Map();
  public passwordResetAuths: Map<string, PasswordResetAuthRecord> = new Map();
  public encryptedGithubTokens: Map<string, string> = new Map();
  public builds: Map<string, Build> = new Map();
  public tasks: Map<string, Task[]> = new Map();
  public files: Map<string, Map<string, ProjectFile>> = new Map();
  public events: Map<string, SwarmEvent[]> = new Map();
  public modelRuns: Map<string, Map<string, ModelRunStatus>> = new Map();
  public checkpoints: Map<string, Checkpoint[]> = new Map();
  public usageLogs: UsageLogEntry[] = [];
  public projectMemories: Map<string, ProjectMemory> = new Map();
  public generationRuns: Map<string, CodeGenerationRun> = new Map();

  // In-memory rate limiter: identifier -> { attempts: number, lockUntil: number }
  private rateLimits: Map<string, { attempts: number; lockUntil: number }> = new Map();

  // Controllable clock for testing and production time enforcement
  private testClock: (() => number) | null = null;

  // Active SSE listeners for real-time updates
  private sseListeners: ClientSSEListener[] = [];

  // Tracks persistent storage health error state
  private storageError: string | null = null;

  constructor(dbPath?: string) {
    this.dbManager = DatabaseManager.getInstance(dbPath);
    this.initializeStorage();
  }

  public initialize(): void {
    this.initializeStorage();
  }

  public getTime(): number {
    return this.testClock ? this.testClock() : Date.now();
  }

  public setTestClock(fn: () => number) {
    this.testClock = fn;
  }

  public resetTestClock() {
    this.testClock = null;
  }

  /**
   * Health and readiness probe for SQLite database storage
   */
  public checkHealth(): { healthy: boolean; error?: string } {
    if (this.storageError) {
      return { healthy: false, error: this.storageError };
    }
    try {
      const row = this.dbManager.db.prepare('SELECT 1 as alive').get() as { alive: number } | undefined;
      if (!row || row.alive !== 1) {
        return { healthy: false, error: 'Database ping returned invalid result' };
      }
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, error: err?.message || 'Database unavailable' };
    }
  }

  public handleDatabaseWriteError(operation: string, err: any): void {
    const errorMsg = `SQLite write failure during ${operation}: ${err?.message || err}`;
    console.error(`[DATABASE ERROR] ${errorMsg}`);
    this.storageError = errorMsg;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(errorMsg);
    }
  }

  public clearStorageError(): void {
    this.storageError = null;
  }

  /**
   * Initializes storage: loads data from SQLite database, or migrates existing .squadforge_data.json
   */
  private initializeStorage() {
    try {
      if (process.env.NODE_ENV === 'production' && typeof this.dbManager?.isMemoryStorage === 'function' && this.dbManager.isMemoryStorage()) {
        throw new Error('FATAL: SQLite storage cannot run in-memory in production environment.');
      }

      const sqlite = this.dbManager.db;

      // Check if sqlite has users
      const userCountRow = sqlite.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
      const hasSqliteData = userCountRow && userCountRow.count > 0;

      if (!hasSqliteData && fs.existsSync(DATA_FILE)) {
        // Migrate legacy JSON file into SQLite
        this.migrateJsonFileToSqlite();
      }

      // Load all records from SQLite into memory cache
      this.loadFromSqlite();
    } catch (err: any) {
      this.storageError = err?.message || 'Failed to initialize SQLite database storage';
      if (process.env.NODE_ENV === 'production') {
        console.error('FATAL: SQLite storage failed to initialize in production environment. Halting startup to prevent data loss:', err);
        throw new Error(`Production database initialization failed: ${err?.message || err}`);
      }
      console.warn('Storage initialization fallback to memory (development only):', err);
    }
  }

  private loadFromSqlite() {
    const sqlite = this.dbManager.db;
    const now = this.getTime();

    // Clean expired leases on startup to recover safely after process restart
    try {
      sqlite.prepare(`
        UPDATE tasks SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL
        WHERE status IN ('in_progress', 'claimed', 'working') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(now);
      sqlite.prepare(`
        UPDATE project_files SET lease_owner = NULL, lease_expires_at = NULL
        WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(now);
      this.dbManager.cleanExpiredCoordinationLocks(now);
    } catch {
      // Best-effort startup cleanup
    }

    // 1. Users
    const userRows = sqlite.prepare('SELECT * FROM users').all() as any[];
    for (const u of userRows) {
      const user: User = {
        id: u.id,
        email: u.email,
        name: u.name,
        passwordHash: u.password_hash || undefined,
        avatarUrl: u.avatar_url || undefined,
        githubUsername: u.github_username || undefined,
        githubConnected: Boolean(u.github_connected),
        defaultRepo: u.default_repo || undefined,
        costLimitPerBuild: u.cost_limit_per_build,
        tokenLimitPerBuild: u.token_limit_per_build,
        routingPreference: u.routing_preference || 'quality',
        enabledModelIds: safeJsonParse<string[]>(u.enabled_model_ids, []),
        createdAt: u.created_at,
        updatedAt: u.updated_at || undefined
      };
      this.users.set(user.id, user);
      if (user.email) {
        this.usersByEmail.set(user.email.toLowerCase().trim(), user.id);
      }
    }

    // 2. Active Sessions
    const sessionRows = sqlite.prepare('SELECT * FROM sessions WHERE expires_at > ?').all(now) as any[];
    for (const s of sessionRows) {
      this.sessions.set(s.id, {
        id: s.id,
        userId: s.user_id,
        expiresAt: s.expires_at,
        createdAt: s.created_at,
        ip: s.ip || undefined,
        userAgent: s.user_agent || undefined
      });
    }

    // 3. Active Password Reset Codes
    const resetCodeRows = sqlite.prepare('SELECT * FROM password_reset_codes WHERE expires_at > ? AND consumed = 0 AND invalidated = 0').all(now) as any[];
    for (const r of resetCodeRows) {
      this.passwordResetCodes.set(r.id, {
        id: r.id,
        userId: r.user_id,
        email: r.email,
        codeHash: r.code_hash,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        attempts: r.attempts,
        consumed: Boolean(r.consumed),
        invalidated: Boolean(r.invalidated)
      });
    }

    // 4. Password Reset Auths
    const authRows = sqlite.prepare('SELECT * FROM password_reset_auths WHERE expires_at > ? AND consumed = 0').all(now) as any[];
    for (const a of authRows) {
      this.passwordResetAuths.set(a.id, {
        id: a.id,
        userId: a.user_id,
        email: a.email,
        createdAt: a.created_at,
        expiresAt: a.expires_at,
        consumed: Boolean(a.consumed)
      });
    }

    // 5. Encrypted GitHub Tokens
    const ghRows = sqlite.prepare('SELECT * FROM encrypted_github_tokens').all() as any[];
    for (const g of ghRows) {
      this.encryptedGithubTokens.set(g.user_id, g.encrypted_token);
    }

    // 6. Builds
    const buildRows = sqlite.prepare('SELECT * FROM builds').all() as any[];
    for (const b of buildRows) {
      const build: Build = {
        id: b.id,
        userId: b.user_id,
        idea: b.idea,
        status: b.status,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        completedAt: b.completed_at || undefined,
        selectedModels: safeJsonParse<string[]>(b.selected_models, []),
        autoPushGithub: Boolean(b.auto_push_github),
        totalTokens: b.total_tokens || 0,
        totalCost: b.total_cost || 0.0,
        costLimit: b.cost_limit || 5.0,
        tokenBudget: b.token_budget || undefined,
        maxDurationSeconds: b.max_duration_seconds || 300,
        patchesAppliedCount: b.patches_applied_count || 0,
        error: b.error || undefined,
        failureReason: b.failure_reason || undefined,
        techStack: safeJsonParse<any>(b.tech_stack, undefined),
        milestones: safeJsonParse<any>(b.milestones, undefined),
        testReport: safeJsonParse<any>(b.test_report, undefined),
        securityAudit: safeJsonParse<any>(b.security_audit, undefined),
        verificationReport: safeJsonParse<any>(b.verification_report, undefined),
        verificationFeedback: b.verification_feedback || undefined,
        verificationAttempts: b.verification_attempts || 0,
        maxVerificationAttempts: b.max_verification_attempts || 3,
        budgetWarningEmitted: Boolean(b.budget_warning_emitted),
        githubRepoUrl: b.github_repo || undefined,
        gitBranch: b.github_branch || undefined,
        pullRequestUrl: b.github_pr_url || undefined,
        projectType: b.project_type || 'fullstack',
        architectureDecisions: safeJsonParse<any>(b.architecture_decisions, undefined),
        requirementsChecklist: safeJsonParse<any>(b.requirements_checklist, undefined),
        revisions: safeJsonParse<any>(b.revisions, undefined),
        livePreviewHtml: b.live_preview_html || undefined,
        previewMode: b.preview_mode || undefined,
        previewDiagnostic: b.preview_diagnostic || undefined,
        previewRuntimeErrors: safeJsonParse<any>(b.preview_runtime_errors, undefined),
        previewEntryPoint: b.preview_entry_point || undefined,
        architectureBlueprint: safeJsonParse<any>(b.architecture_blueprint, undefined),
        requirementsAnalysis: safeJsonParse<any>(b.requirements_analysis, undefined),
        complexityAssessment: safeJsonParse<any>(b.complexity_assessment, undefined),
        fileStructurePlan: safeJsonParse<any>(b.file_structure_plan, undefined),
        dependencyPlan: safeJsonParse<any>(b.dependency_plan, undefined)
      };
      this.builds.set(build.id, build);
    }

    // 7. Tasks
    const taskRows = sqlite.prepare('SELECT * FROM tasks').all() as any[];
    for (const t of taskRows) {
      const task: Task = this.mapDbRowToTask(t);
      let list = this.tasks.get(task.buildId);
      if (!list) {
        list = [];
        this.tasks.set(task.buildId, list);
      }
      list.push(task);
    }

    // 8. Project Files & Versions
    const fileRows = sqlite.prepare('SELECT * FROM project_files').all() as any[];
    for (const f of fileRows) {
      const versionRows = sqlite.prepare('SELECT * FROM file_versions WHERE file_id = ? ORDER BY version ASC').all(f.id) as any[];
      const history: FileVersion[] = versionRows.map(v => ({
        version: v.version,
        content: v.content,
        authorModel: v.author_model,
        timestamp: v.timestamp,
        commitMessage: v.commit_message || undefined,
        contentHash: v.content_hash || computeContentHash(v.content)
      }));

      const projFile: ProjectFile = {
        path: f.path,
        content: f.content,
        version: f.version,
        ownerModel: f.owner_model,
        history,
        leaseOwner: f.lease_owner || null,
        leaseExpiresAt: f.lease_expires_at || null,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
        contentHash: f.content_hash || computeContentHash(f.content)
      };

      let buildFiles = this.files.get(f.build_id);
      if (!buildFiles) {
        buildFiles = new Map();
        this.files.set(f.build_id, buildFiles);
      }
      buildFiles.set(projFile.path, projFile);
    }

    // 9. Swarm Events
    const eventRows = sqlite.prepare('SELECT * FROM swarm_events ORDER BY timestamp ASC').all() as any[];
    for (const e of eventRows) {
      const event: SwarmEvent = {
        id: e.id,
        buildId: e.build_id,
        timestamp: e.timestamp,
        type: e.type,
        modelId: e.model_id || undefined,
        taskId: e.task_id || undefined,
        filePath: e.file_path || undefined,
        details: e.details
      };
      let list = this.events.get(event.buildId);
      if (!list) {
        list = [];
        this.events.set(event.buildId, list);
      }
      list.push(event);
    }

    // 10. Checkpoints
    const checkpointRows = sqlite.prepare('SELECT * FROM checkpoints ORDER BY timestamp ASC').all() as any[];
    for (const c of checkpointRows) {
      const checkpoint: Checkpoint = {
        id: c.id,
        buildId: c.build_id,
        timestamp: c.timestamp,
        description: c.description,
        filesSnapshot: c.snapshot ? JSON.parse(c.snapshot) : {},
        patchCount: 0
      };
      let list = this.checkpoints.get(checkpoint.buildId);
      if (!list) {
        list = [];
        this.checkpoints.set(checkpoint.buildId, list);
      }
      list.push(checkpoint);
    }

    // 11. Usage Logs
    const logRows = sqlite.prepare('SELECT * FROM usage_logs ORDER BY timestamp ASC LIMIT 5000').all() as any[];
    for (const l of logRows) {
      this.usageLogs.push({
        id: l.id,
        userId: l.user_id,
        buildId: l.build_id || undefined,
        timestamp: l.timestamp,
        requestedModelId: l.requested_model_id,
        actualModelUsed: l.actual_model_used,
        provider: l.provider_used as any,
        providerUsed: l.provider_used,
        modelId: l.requested_model_id,
        inputTokens: l.input_tokens,
        outputTokens: l.output_tokens,
        totalTokens: l.total_tokens,
        estimatedCost: l.estimated_cost,
        taskComplexity: l.task_complexity as any,
        isFallback: Boolean(l.is_fallback),
        cached: Boolean(l.cached),
        latencyMs: l.latency_ms,
        success: Boolean(l.success),
        taskId: l.task_id || undefined,
        taskTitle: l.task_title || undefined
      });
    }

    // 12. Project Memories
    try {
      const memoryRows = sqlite.prepare('SELECT * FROM project_memories').all() as any[];
      for (const m of memoryRows) {
        try {
          const parsed = JSON.parse(m.memory_data);
          this.projectMemories.set(m.project_id, parsed);
        } catch {
          // Ignore individual malformed record
        }
      }
    } catch {
      // Table may not exist yet in unmigrated databases
    }
  }

  private migrateJsonFileToSqlite() {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const sqlite = this.dbManager.db;

      this.dbManager.transaction(() => {
        if (parsed.users && Array.isArray(parsed.users)) {
          const stmt = sqlite.prepare(`
            INSERT OR REPLACE INTO users (
              id, email, name, password_hash, avatar_url, github_username, github_connected,
              default_repo, cost_limit_per_build, token_limit_per_build, routing_preference,
              enabled_model_ids, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const u of parsed.users) {
            stmt.run(
              u.id, u.email, u.name, u.passwordHash || null, u.avatarUrl || null,
              u.githubUsername || null, u.githubConnected ? 1 : 0, u.defaultRepo || null,
              u.costLimitPerBuild || 5.0, u.tokenLimitPerBuild || 100000,
              u.routingPreference || 'quality', JSON.stringify(u.enabledModelIds || []),
              u.createdAt || Date.now(), u.updatedAt || Date.now()
            );
          }
        }

        if (parsed.builds && Array.isArray(parsed.builds)) {
          const stmt = sqlite.prepare(`
            INSERT OR REPLACE INTO builds (
              id, user_id, idea, status, created_at, updated_at, completed_at,
              selected_models, auto_push_github, total_tokens, total_cost, cost_limit,
              token_budget, max_duration_seconds, patches_applied_count, error, failure_reason,
              tech_stack, milestones, test_report, security_audit, verification_report,
              verification_feedback, verification_attempts, max_verification_attempts,
              budget_warning_emitted, github_repo, github_branch, github_pr_url
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const b of parsed.builds) {
            stmt.run(
              b.id, b.userId, b.idea, b.status, b.createdAt, b.updatedAt, b.completedAt || null,
              JSON.stringify(b.selectedModels || []), b.autoPushGithub ? 1 : 0,
              b.totalTokens || 0, b.totalCost || 0.0, b.costLimit || 5.0,
              b.tokenBudget || 100000, b.maxDurationSeconds || 300,
              b.patchesAppliedCount || 0, b.error || null, b.failureReason || null,
              b.techStack ? JSON.stringify(b.techStack) : null,
              b.milestones ? JSON.stringify(b.milestones) : null,
              b.testReport ? JSON.stringify(b.testReport) : null,
              b.securityAudit ? JSON.stringify(b.securityAudit) : null,
              b.verificationReport ? JSON.stringify(b.verificationReport) : null,
              b.verificationFeedback || null, b.verificationAttempts || 0,
              b.maxVerificationAttempts || 3, b.budgetWarningEmitted ? 1 : 0,
              b.githubRepoUrl || null, b.gitBranch || null, b.pullRequestUrl || null
            );
          }
        }
      });
    } catch (err) {
      console.warn('JSON to SQLite migration skipped:', err);
    }
  }

  // --- Real-Time SSE Broadcasting ---

  addSSEListener(id: string, res: any, buildId?: string) {
    this.sseListeners.push({ id, res, buildId });
  }

  removeSSEListener(id: string) {
    this.sseListeners = this.sseListeners.filter(l => l.id !== id);
  }

  broadcast(buildId: string, eventType: string, payload: any) {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const listener of this.sseListeners) {
      if (!listener.buildId || listener.buildId === buildId) {
        try {
          listener.res.write(message);
        } catch (err) {
          // Listener disconnected
        }
      }
    }
  }

  // --- Authentication & User Operations ---

  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  findUserByEmail(email: string): User | undefined {
    if (!email) return undefined;
    const normalized = email.toLowerCase().trim();
    const userId = this.usersByEmail.get(normalized);
    if (!userId) return undefined;
    return this.users.get(userId);
  }

  saveUser(user: User): User {
    const normalized = user.email.toLowerCase().trim();
    user.email = normalized;
    user.updatedAt = this.getTime();
    this.users.set(user.id, user);
    this.usersByEmail.set(normalized, user.id);

    try {
      const sqlite = this.dbManager.db;
      sqlite.prepare(`
        INSERT OR REPLACE INTO users (
          id, email, name, password_hash, avatar_url, github_username, github_connected,
          default_repo, cost_limit_per_build, token_limit_per_build, routing_preference,
          enabled_model_ids, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id, user.email, user.name || user.email || 'user', user.passwordHash || null, user.avatarUrl || null,
        user.githubUsername || null, user.githubConnected ? 1 : 0, user.defaultRepo || null,
        user.costLimitPerBuild || 5.0, user.tokenLimitPerBuild || 100000,
        user.routingPreference || 'quality', JSON.stringify(user.enabledModelIds || []),
        user.createdAt, user.updatedAt || user.createdAt
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('saveUser', err);
    }

    return user;
  }

  createUser(user: User): User {
    return this.saveUser(user);
  }

  toSafeUser(user: User): SafeUser {
    const { passwordHash, ...safe } = user;
    return safe;
  }

  // --- Session Management ---

  createSession(userId: string, plainToken: string, ip?: string, userAgent?: string): Session {
    const hashed = hashSessionToken(plainToken);
    const session: Session = {
      id: hashed,
      userId,
      expiresAt: this.getTime() + SESSION_DURATION_MS,
      createdAt: this.getTime(),
      ip,
      userAgent
    };
    this.sessions.set(hashed, session);

    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(session.id, session.userId, session.expiresAt, session.createdAt, session.ip || null, session.userAgent || null);
    } catch (err: any) {
      this.handleDatabaseWriteError('createSession', err);
    }

    return session;
  }

  getSession(plainToken: string): Session | undefined {
    if (!plainToken) return undefined;
    const hashed = hashSessionToken(plainToken);
    const session = this.sessions.get(hashed);
    if (!session) return undefined;

    // Check expiration
    if (session.expiresAt < this.getTime()) {
      this.deleteSession(plainToken);
      return undefined;
    }
    return session;
  }

  deleteSession(plainToken: string): boolean {
    if (!plainToken) return false;
    const hashed = hashSessionToken(plainToken);
    const existed = this.sessions.delete(hashed);
    try {
      this.dbManager.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashed);
    } catch (err: any) {
      this.handleDatabaseWriteError('deleteSession', err);
    }
    return existed;
  }

  // --- Atomic Database-Backed File Mutations ---

  createFileAtomic(
    buildId: string,
    modelId: string,
    action: { action?: string; path: string; content: string; commitMessage?: string; taskId?: string },
    maxFileSize: number = 500 * 1024,
    maxProjectSize: number = 10 * 1024 * 1024
  ): { success: boolean; filePath: string; version?: number; currentContent?: string; error?: string } {
    const sanitized = ExecutionAdapter.sanitizeFilePath(action.path);
    if (!sanitized.valid) {
      return {
        success: false,
        filePath: action.path || '',
        error: sanitized.error || 'Invalid file path'
      };
    }
    const cleanPath = sanitized.cleanPath;
    const byteLength = Buffer.byteLength(action.content || '', 'utf-8');
    if (byteLength > maxFileSize) {
      return {
        success: false,
        filePath: cleanPath,
        error: `File size limit exceeded (${byteLength} bytes > ${maxFileSize} bytes max).`
      };
    }

    const now = this.getTime();
    const fileId = `${buildId}:${cleanPath}`;
    const contentHash = computeContentHash(action.content || '');

    try {
      const result = this.dbManager.transaction(() => {
        const existing = this.dbManager.db.prepare(
          'SELECT version, content, lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, cleanPath) as any;

        if (existing && (existing.version > 0 || existing.content !== '')) {
          return {
            success: false,
            filePath: cleanPath,
            error: `File ${cleanPath} already exists (v${existing.version}). Models must use patch_file with exact find/replace edits.`,
            currentContent: existing.content
          };
        }

        if (existing && existing.lease_owner && existing.lease_owner !== modelId && (!existing.lease_expires_at || existing.lease_expires_at > now)) {
          return {
            success: false,
            filePath: cleanPath,
            error: `File is currently locked under refactor lease by ${existing.lease_owner}.`
          };
        }

        const allDbFiles = this.dbManager.db.prepare(
          'SELECT content FROM project_files WHERE build_id = ? AND path != ?'
        ).all(buildId, cleanPath) as Array<{ content: string }>;
        const totalProjectBytes = allDbFiles.reduce((acc, f) => acc + Buffer.byteLength(f.content || '', 'utf-8'), 0) + byteLength;
        if (totalProjectBytes > maxProjectSize) {
          return {
            success: false,
            filePath: cleanPath,
            error: `Project size limit exceeded (${totalProjectBytes} bytes > ${maxProjectSize} bytes max).`
          };
        }

        const wasPreviouslyDeleted = (this.events.get(buildId) || []).some(e => e.type === 'file_deleted' && e.filePath === cleanPath);

        const initialVersion: FileVersion = {
          version: 1,
          content: action.content,
          authorModel: modelId,
          timestamp: now,
          commitMessage: action.commitMessage || (wasPreviouslyDeleted ? `Recreated ${cleanPath}` : `Created ${cleanPath}`),
          taskId: action.taskId,
          changeType: wasPreviouslyDeleted ? 'recreated' : 'added',
          contentHash
        };

        this.dbManager.db.prepare(`
          INSERT INTO project_files (
            id, build_id, path, content, version, owner_model,
            lease_owner, lease_expires_at, created_at, updated_at, content_hash
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            version = 1,
            owner_model = excluded.owner_model,
            lease_owner = excluded.lease_owner,
            lease_expires_at = excluded.lease_expires_at,
            updated_at = excluded.updated_at,
            content_hash = excluded.content_hash
        `).run(fileId, buildId, cleanPath, action.content, modelId, existing?.lease_owner || null, existing?.lease_expires_at || null, now, now, contentHash);

        this.dbManager.db.prepare(`
          INSERT INTO file_versions (file_id, build_id, path, version, content, author_model, commit_message, timestamp, content_hash)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(fileId, buildId, cleanPath, action.content, modelId, initialVersion.commitMessage, now, contentHash);

        return {
          success: true,
          filePath: cleanPath,
          version: 1,
          currentContent: action.content,
          initialVersion,
          wasPreviouslyDeleted
        };
      });

      if (!result.success) {
        return result;
      }

      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        const files = this.getFilesMap(buildId);
        const newFile: ProjectFile = {
          path: cleanPath,
          content: action.content,
          version: 1,
          ownerModel: modelId,
          history: [result.initialVersion!],
          createdAt: now,
          updatedAt: now,
          contentHash,
          isRecreated: result.wasPreviouslyDeleted
        };
        files.set(cleanPath, newFile);

        this.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: now,
          type: 'file_created',
          modelId,
          filePath: cleanPath,
          details: `${modelId} created ${cleanPath} (v1)`
        });

        this.broadcast(buildId, 'file_updated', newFile);
      });

      return { success: true, filePath: cleanPath, version: 1, currentContent: action.content };
    } catch (err: any) {
      this.handleDatabaseWriteError('createFileAtomic', err);
      return { success: false, filePath: cleanPath, error: err.message || 'Database error creating file' };
    }
  }

  applyPatchAtomic(
    buildId: string,
    modelId: string,
    action: PatchAction,
    maxFileSize: number = 500 * 1024
  ): { success: boolean; filePath: string; version?: number; currentContent?: string; error?: string } {
    const sanitized = ExecutionAdapter.sanitizeFilePath(action.path);
    if (!sanitized.valid) {
      return {
        success: false,
        filePath: action.path || '',
        error: sanitized.error || 'Invalid file path'
      };
    }
    const cleanPath = sanitized.cleanPath;
    const now = this.getTime();
    const fileId = `${buildId}:${cleanPath}`;

    try {
      const result = this.dbManager.transaction(() => {
        const row = this.dbManager.db.prepare(
          'SELECT version, content, lease_owner, lease_expires_at, content_hash, owner_model, created_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, cleanPath) as any;

        if (!row || (row.version === 0 && row.content === '')) {
          return {
            success: false,
            filePath: cleanPath,
            error: `File ${cleanPath} does not exist yet. Use create_file first.`
          };
        }

        if (row.lease_owner) {
          if (row.lease_owner !== modelId && (!row.lease_expires_at || row.lease_expires_at > now)) {
            const error = `File is currently locked under refactor lease by ${row.lease_owner}. Lease expires in ${Math.round(((row.lease_expires_at || now) - now) / 1000)}s.`;
            return { success: false, filePath: cleanPath, error, currentContent: row.content };
          }
          if (row.lease_owner === modelId && row.lease_expires_at && row.lease_expires_at <= now) {
            const error = `Stale lease rejected: Lease for file ${cleanPath} expired ${Math.round((now - row.lease_expires_at) / 1000)}s ago. Renew your lease before applying edits.`;
            return { success: false, filePath: cleanPath, error, currentContent: row.content };
          }
        }

        if (action.expectedVersion !== undefined && row.version !== action.expectedVersion) {
          const error = `Version conflict: Expected file version v${action.expectedVersion}, but ${cleanPath} is currently at v${row.version}. File was modified concurrently.`;
          return { success: false, filePath: cleanPath, error, currentContent: row.content };
        }

        if (action.expectedContentHash && row.content_hash && row.content_hash !== action.expectedContentHash) {
          const error = `Content hash conflict: Expected hash ${action.expectedContentHash}, but ${cleanPath} has hash ${row.content_hash}. File was modified concurrently.`;
          return { success: false, filePath: cleanPath, error, currentContent: row.content };
        }

        let content = row.content;
        for (const edit of action.edits) {
          if (!edit.find && edit.find !== '') continue;
          const occurrences = content.split(edit.find).length - 1;
          if (occurrences === 0) {
            const error = `Conflict: "find" text was not found in ${cleanPath} (current v${row.version}). File may have been edited by another model. Redo your edit on this version.`;
            return { success: false, filePath: cleanPath, error, currentContent: content };
          }
          if (occurrences > 1) {
            const error = `Ambiguity: "find" text appears ${occurrences} times in ${cleanPath}. Provide more surrounding context lines in "find".`;
            return { success: false, filePath: cleanPath, error, currentContent: content };
          }
          content = content.replace(edit.find, edit.replace);
        }

        const byteLength = Buffer.byteLength(content, 'utf-8');
        if (byteLength > maxFileSize) {
          return {
            success: false,
            filePath: cleanPath,
            error: `Patched file exceeds maximum file size limit (${byteLength} bytes > ${maxFileSize} bytes max).`,
            currentContent: row.content
          };
        }

        const newVersionNum = row.version + 1;
        const newContentHash = computeContentHash(content);

        const res = this.dbManager.db.prepare(`
          UPDATE project_files SET
            content = ?,
            version = ?,
            owner_model = ?,
            updated_at = ?,
            content_hash = ?
          WHERE id = ?
            AND build_id = ?
            AND version = ?
            AND (content_hash IS NULL OR content_hash = ?)
            AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)
        `).run(content, newVersionNum, modelId, now, newContentHash, fileId, buildId, row.version, row.content_hash || newContentHash, modelId, now);

        if (res.changes === 0) {
          return {
            success: false,
            filePath: cleanPath,
            error: `Concurrent write conflict: File ${cleanPath} was modified by another process.`,
            currentContent: row.content
          };
        }

        this.dbManager.db.prepare(`
          INSERT INTO file_versions (file_id, build_id, path, version, content, author_model, commit_message, timestamp, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(fileId, buildId, cleanPath, newVersionNum, content, modelId, action.commitMessage || `Patch ${cleanPath} v${newVersionNum}`, now, newContentHash);

        return {
          success: true,
          filePath: cleanPath,
          version: newVersionNum,
          currentContent: content,
          newContentHash
        };
      });

      if (!result.success) {
        this.dbManager.onPostCommit(() => {
          this.addEvent({
            id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            buildId,
            timestamp: now,
            type: 'patch_rejected',
            modelId,
            filePath: cleanPath,
            details: `Rejected patch from ${modelId} on ${cleanPath}: ${result.error}`
          });
        });
        return result;
      }

      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        const file = this.getFile(buildId, cleanPath);
        const isReverted = file ? file.history.some(h => h.version < file.version && h.content === result.currentContent) : false;
        const isFormattingOnly = file ? file.content.trim().replace(/\s+/g, ' ') === result.currentContent!.trim().replace(/\s+/g, ' ') : false;

        const newVersion: FileVersion = {
          version: result.version!,
          content: result.currentContent!,
          authorModel: modelId,
          timestamp: now,
          commitMessage: action.commitMessage || `Patch ${cleanPath} v${result.version}`,
          taskId: action.taskId,
          changeType: isReverted ? 'reverted' : 'modified',
          isFormattingOnly,
          contentHash: result.newContentHash
        };

        if (file) {
          file.content = result.currentContent!;
          file.version = result.version!;
          file.ownerModel = modelId;
          file.updatedAt = now;
          file.contentHash = result.newContentHash;
          file.history.push(newVersion);
        } else {
          const fullFile: ProjectFile = {
            path: cleanPath,
            content: result.currentContent!,
            version: result.version!,
            ownerModel: modelId,
            history: [newVersion],
            createdAt: now,
            updatedAt: now,
            contentHash: result.newContentHash
          };
          this.getFilesMap(buildId).set(cleanPath, fullFile);
        }

        const build = this.getBuild(buildId);
        if (build) {
          build.patchesAppliedCount = (build.patchesAppliedCount || 0) + 1;
          this.saveBuild(build);
        }

        this.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: now,
          type: 'patch_applied',
          modelId,
          filePath: cleanPath,
          details: `${modelId} patched ${cleanPath} (v${result.version})`
        });

        this.broadcast(buildId, 'file_updated', this.getFile(buildId, cleanPath));
      });

      return { success: true, filePath: cleanPath, version: result.version, currentContent: result.currentContent };
    } catch (err: any) {
      this.handleDatabaseWriteError('applyPatchAtomic', err);
      return { success: false, filePath: cleanPath, error: err.message || 'Database error during patch' };
    }
  }

  deleteFileAtomic(
    buildId: string,
    modelId: string,
    filePath: string
  ): { success: boolean; filePath: string; error?: string } {
    const sanitized = ExecutionAdapter.sanitizeFilePath(filePath);
    if (!sanitized.valid) {
      return { success: false, filePath, error: sanitized.error || 'Invalid file path' };
    }
    const cleanPath = sanitized.cleanPath;
    const now = this.getTime();

    try {
      const result = this.dbManager.transaction(() => {
        const row = this.dbManager.db.prepare(
          'SELECT version, content, lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, cleanPath) as any;

        if (!row || (row.version === 0 && row.content === '')) {
          return { success: false, filePath: cleanPath, error: `File ${cleanPath} does not exist.` };
        }

        if (row.lease_owner) {
          if (row.lease_owner !== modelId && (!row.lease_expires_at || row.lease_expires_at > now)) {
            return { success: false, filePath: cleanPath, error: `Cannot delete file: Locked under active lease by ${row.lease_owner}.` };
          }
          if (row.lease_owner === modelId && row.lease_expires_at && row.lease_expires_at <= now) {
            return { success: false, filePath: cleanPath, error: `Cannot delete file: Lease for ${cleanPath} expired. Renew lease before deleting.` };
          }
        }

        const res = this.dbManager.db.prepare(`
          DELETE FROM project_files
          WHERE build_id = ? AND path = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)
        `).run(buildId, cleanPath, modelId, now);

        if (res.changes === 0) {
          return { success: false, filePath: cleanPath, error: `Cannot delete file ${cleanPath}: condition not satisfied.` };
        }

        return { success: true, filePath: cleanPath };
      });

      if (!result.success) {
        this.dbManager.onPostCommit(() => {
          this.addEvent({
            id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            buildId,
            timestamp: now,
            type: 'patch_rejected',
            modelId,
            filePath: cleanPath,
            details: `Rejected delete from ${modelId}: ${result.error}`
          });
        });
        return result;
      }

      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        const files = this.getFilesMap(buildId);
        files.delete(cleanPath);

        this.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: now,
          type: 'file_deleted',
          modelId,
          filePath: cleanPath,
          details: `${modelId} deleted file: ${cleanPath}`
        });

        this.broadcast(buildId, 'file_deleted', { path: cleanPath });
      });

      return { success: true, filePath: cleanPath };
    } catch (err: any) {
      this.handleDatabaseWriteError('deleteFileAtomic', err);
      return { success: false, filePath: cleanPath, error: err.message || 'Database error during delete' };
    }
  }

  renameFileAtomic(
    buildId: string,
    modelId: string,
    oldPath: string,
    newPath: string,
    commitMessage?: string,
    taskId?: string
  ): { success: boolean; oldPath: string; newPath: string; error?: string } {
    const sanitizedOld = ExecutionAdapter.sanitizeFilePath(oldPath);
    if (!sanitizedOld.valid) {
      return { success: false, oldPath, newPath, error: `Invalid source path: ${sanitizedOld.error}` };
    }
    const sanitizedNew = ExecutionAdapter.sanitizeFilePath(newPath);
    if (!sanitizedNew.valid) {
      return { success: false, oldPath, newPath, error: `Invalid destination path: ${sanitizedNew.error}` };
    }
    const cleanOld = sanitizedOld.cleanPath;
    const cleanNew = sanitizedNew.cleanPath;
    const now = this.getTime();
    const oldId = `${buildId}:${cleanOld}`;
    const newId = `${buildId}:${cleanNew}`;

    try {
      const result = this.dbManager.transaction(() => {
        const source = this.dbManager.db.prepare(
          'SELECT * FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, cleanOld) as any;

        if (!source || (source.version === 0 && source.content === '')) {
          return { success: false, oldPath: cleanOld, newPath: cleanNew, error: `File ${cleanOld} does not exist.` };
        }

        if (source.lease_owner) {
          if (source.lease_owner !== modelId && (!source.lease_expires_at || source.lease_expires_at > now)) {
            return { success: false, oldPath: cleanOld, newPath: cleanNew, error: `Cannot rename file: Source file is locked under active lease by ${source.lease_owner}.` };
          }
          if (source.lease_owner === modelId && source.lease_expires_at && source.lease_expires_at <= now) {
            return { success: false, oldPath: cleanOld, newPath: cleanNew, error: `Cannot rename file: Lease for source file expired. Renew lease before renaming.` };
          }
        }

        const dest = this.dbManager.db.prepare(
          'SELECT version, content, lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, cleanNew) as any;

        if (dest && (dest.version > 0 || dest.content !== '')) {
          return { success: false, oldPath: cleanOld, newPath: cleanNew, error: `Destination ${cleanNew} already exists.` };
        }

        if (dest && dest.lease_owner && dest.lease_owner !== modelId && (!dest.lease_expires_at || dest.lease_expires_at > now)) {
          return { success: false, oldPath: cleanOld, newPath: cleanNew, error: `Destination ${cleanNew} is locked by another agent.` };
        }

        const newVersionNum = source.version + 1;

        // Destination created FIRST in database before source is deleted
        this.dbManager.db.prepare(`
          INSERT INTO project_files (
            id, build_id, path, content, version, owner_model,
            lease_owner, lease_expires_at, created_at, updated_at, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            version = excluded.version,
            owner_model = excluded.owner_model,
            lease_owner = excluded.lease_owner,
            lease_expires_at = excluded.lease_expires_at,
            updated_at = excluded.updated_at,
            content_hash = excluded.content_hash
        `).run(
          newId, buildId, cleanNew, source.content, newVersionNum, modelId,
          source.lease_owner || null, source.lease_expires_at || null,
          source.created_at || now, now, source.content_hash
        );

        // Move existing historical versions to destination file_id and path to preserve history across reloads
        this.dbManager.db.prepare(`
          UPDATE file_versions
          SET file_id = ?, path = ?
          WHERE build_id = ? AND file_id = ?
        `).run(newId, cleanNew, buildId, oldId);

        // Record the rename commit version
        this.dbManager.db.prepare(`
          INSERT INTO file_versions (file_id, build_id, path, version, content, author_model, commit_message, timestamp, content_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, buildId, cleanNew, newVersionNum, source.content, modelId, commitMessage || `Renamed from ${cleanOld} to ${cleanNew}`, now, source.content_hash);

        // Delete source
        this.dbManager.db.prepare('DELETE FROM project_files WHERE id = ?').run(oldId);

        return {
          success: true,
          oldPath: cleanOld,
          newPath: cleanNew,
          version: newVersionNum,
          content: source.content,
          contentHash: source.content_hash
        };
      });

      if (!result.success) {
        return result;
      }

      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        const files = this.getFilesMap(buildId);
        const oldFile = files.get(cleanOld);
        files.delete(cleanOld);

        const newVersion: FileVersion = {
          version: result.version!,
          content: result.content!,
          authorModel: modelId,
          timestamp: now,
          commitMessage: commitMessage || `Renamed from ${cleanOld} to ${cleanNew}`,
          taskId,
          changeType: 'modified',
          contentHash: result.contentHash
        };

        const newFileObj: ProjectFile = {
          path: cleanNew,
          content: result.content!,
          version: result.version!,
          ownerModel: modelId,
          history: oldFile ? [...oldFile.history, newVersion] : [newVersion],
          createdAt: oldFile?.createdAt || now,
          updatedAt: now,
          isRenamed: true,
          originalPath: oldFile?.originalPath || cleanOld,
          contentHash: result.contentHash
        };
        files.set(cleanNew, newFileObj);

        this.addEvent({
          id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          buildId,
          timestamp: now,
          type: 'patch_applied',
          modelId,
          filePath: cleanNew,
          details: `${modelId} renamed ${cleanOld} -> ${cleanNew}`
        });

        this.broadcast(buildId, 'file_deleted', { path: cleanOld });
        this.broadcast(buildId, 'file_updated', newFileObj);
      });

      return { success: true, oldPath: cleanOld, newPath: cleanNew };
    } catch (err: any) {
      this.handleDatabaseWriteError('renameFileAtomic', err);
      return { success: false, oldPath: cleanOld, newPath: cleanNew, error: err.message || 'Database error during rename' };
    }
  }

  applyBatchActionsAtomic(
    buildId: string,
    modelId: string,
    actions: Array<{ action?: string; [key: string]: any }>,
    maxFileSize: number = 500 * 1024,
    maxProjectSize: number = 10 * 1024 * 1024
  ): {
    success: boolean;
    appliedCount: number;
    totalCount: number;
    error?: string;
    reverted?: boolean;
    results: any[];
  } {
    const results: any[] = [];
    let failureError: string | undefined;

    try {
      this.dbManager.transaction(() => {
        for (const item of actions) {
          let res: { success: boolean; error?: string; [key: string]: any } = { success: false, error: 'Unknown action' };

          if (item.action === 'create_file') {
            res = this.createFileAtomic(buildId, modelId, item as any, maxFileSize, maxProjectSize);
          } else if (item.action === 'patch_file') {
            res = this.applyPatchAtomic(buildId, modelId, item as any, maxFileSize);
          } else if (item.action === 'delete_file') {
            res = this.deleteFileAtomic(buildId, modelId, (item as any).path);
          } else if (item.action === 'rename_file') {
            res = this.renameFileAtomic(buildId, modelId, (item as any).oldPath, (item as any).newPath, (item as any).commitMessage, (item as any).taskId);
          } else if (item.action === 'create_task') {
            res = { success: true };
          } else {
            res = { success: false, error: `Unsupported action type: ${item.action}` };
          }

          results.push(res);

          if (!res.success) {
            failureError = res.error || `Action ${item.action} failed`;
            // Throw inside transaction to trigger automatic SQLite rollback of all statements in this batch!
            throw new Error(failureError);
          }
        }
      });

      return {
        success: true,
        appliedCount: results.filter(r => r.success).length,
        totalCount: actions.length,
        results
      };
    } catch (err: any) {
      // Transaction was completely rolled back by SQLite.
      // In-memory cache is resynchronized from database to ensure perfect cache consistency.
      this.resyncFilesMapFromDb(buildId);

      this.addEvent({
        id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        buildId,
        timestamp: this.getTime(),
        type: 'patch_rejected',
        modelId,
        details: `Batch transaction aborted and rolled back cleanly: ${failureError || err.message}`
      });

      return {
        success: false,
        appliedCount: 0,
        totalCount: actions.length,
        error: failureError || err.message,
        reverted: true,
        results
      };
    }
  }

  resyncFilesMapFromDb(buildId: string): void {
    const fileMap = new Map<string, ProjectFile>();
    try {
      const rows = this.dbManager.db.prepare('SELECT * FROM project_files WHERE build_id = ?').all(buildId) as any[];
      for (const row of rows) {
        const fileVersions = this.dbManager.db.prepare(
          'SELECT * FROM file_versions WHERE build_id = ? AND path = ? ORDER BY version ASC'
        ).all(buildId, row.path) as any[];

        fileMap.set(row.path, {
          path: row.path,
          content: row.content || '',
          version: row.version || 1,
          ownerModel: row.owner_model || 'system',
          leaseOwner: row.lease_owner || null,
          leaseExpiresAt: row.lease_expires_at || null,
          createdAt: row.created_at || Date.now(),
          updatedAt: row.updated_at || Date.now(),
          contentHash: row.content_hash || computeContentHash(row.content || ''),
          history: fileVersions.map(v => ({
            version: v.version,
            content: v.content,
            authorModel: v.author_model,
            commitMessage: v.commit_message || undefined,
            timestamp: v.timestamp,
            contentHash: v.content_hash
          }))
        });
      }
      this.files.set(buildId, fileMap);
    } catch {}
  }

  deleteUserSessions(userId: string): void {
    for (const [id, s] of this.sessions.entries()) {
      if (s.userId === userId) {
        this.sessions.delete(id);
      }
    }
    try {
      this.dbManager.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    } catch (err: any) {
      this.handleDatabaseWriteError('deleteUserSessions', err);
    }
  }

  // --- Password Reset Tokens (Legacy fallback) ---

  createPasswordResetToken(email: string): string | null {
    const user = this.findUserByEmail(email);
    if (!user) return null;

    const plainToken = generateSessionToken();
    const hashed = hashSessionToken(plainToken);
    const resetToken: PasswordResetToken = {
      id: hashed,
      userId: user.id,
      email: user.email,
      expiresAt: this.getTime() + 60 * 60 * 1000, // 1 hour
      createdAt: this.getTime()
    };
    this.passwordResetTokens.set(hashed, resetToken);
    return plainToken;
  }

  verifyAndConsumePasswordResetToken(plainToken: string): { valid: boolean; userId?: string } {
    if (!plainToken) return { valid: false };
    const hashed = hashSessionToken(plainToken);
    const record = this.passwordResetTokens.get(hashed);
    if (!record) return { valid: false };

    if (record.expiresAt < this.getTime()) {
      this.passwordResetTokens.delete(hashed);
      return { valid: false };
    }

    this.passwordResetTokens.delete(hashed);
    return { valid: true, userId: record.userId };
  }

  // --- Secure 6-Digit Email OTP Password Reset System ---

  getActiveResetCode(email: string): PasswordResetCodeRecord | undefined {
    if (!email) return undefined;
    const normalized = email.toLowerCase().trim();
    const now = this.getTime();
    let latest: PasswordResetCodeRecord | undefined;
    for (const rec of this.passwordResetCodes.values()) {
      if (
        rec.email.toLowerCase() === normalized && 
        !rec.consumed && 
        !rec.invalidated && 
        rec.expiresAt > now
      ) {
        if (!latest || rec.createdAt > latest.createdAt) {
          latest = rec;
        }
      }
    }
    return latest;
  }

  createPasswordResetCode(
    email: string, 
    code: string, 
    customTtlMs = 300_000
  ): { 
    success: boolean; 
    record?: PasswordResetCodeRecord; 
    error?: string; 
    cooldownRemaining?: number;
    notFound?: boolean;
  } {
    const user = this.findUserByEmail(email);
    if (!user) {
      return { success: false, notFound: true };
    }

    const now = this.getTime();
    const normalizedEmail = user.email.toLowerCase().trim();

    // Check 60-second cooldown
    for (const rec of this.passwordResetCodes.values()) {
      if (rec.email.toLowerCase() === normalizedEmail && !rec.consumed && !rec.invalidated) {
        const timeSince = now - rec.createdAt;
        if (timeSince < 60_000 && timeSince >= 0) {
          const cooldownRemaining = Math.ceil((60_000 - timeSince) / 1000);
          return {
            success: false,
            error: `Please wait ${cooldownRemaining} seconds before requesting a new code.`,
            cooldownRemaining
          };
        }
      }
    }

    // Invalidate all previous pending codes
    for (const rec of this.passwordResetCodes.values()) {
      if (
        (rec.userId === user.id || rec.email.toLowerCase() === normalizedEmail) &&
        !rec.consumed &&
        !rec.invalidated
      ) {
        rec.invalidated = true;
      }
    }

    const codeHash = hashVerificationCode(code);
    const id = `prc_${now}_${Math.random().toString(36).substring(2, 8)}`;
    const record: PasswordResetCodeRecord = {
      id,
      userId: user.id,
      email: user.email,
      codeHash,
      createdAt: now,
      expiresAt: now + customTtlMs,
      attempts: 0,
      consumed: false,
      invalidated: false
    };

    this.passwordResetCodes.set(id, record);

    try {
      this.dbManager.db.prepare(`
        INSERT INTO password_reset_codes (id, user_id, email, code_hash, created_at, expires_at, attempts, consumed, invalidated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(record.id, record.userId, record.email, record.codeHash, record.createdAt, record.expiresAt, record.attempts, 0, 0);
    } catch (err: any) {
      this.handleDatabaseWriteError('createPasswordResetCode', err);
    }

    return { success: true, record };
  }

  verifyPasswordResetCode(
    email: string, 
    code: string
  ): { 
    success: boolean; 
    error?: string; 
    resetAuthToken?: string; 
    codeExpiredOrInvalid?: boolean; 
    attemptsRemaining?: number;
  } {
    if (!email || !code) {
      return { success: false, error: 'Email and verification code are required.' };
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedCode = code.trim();

    let record: PasswordResetCodeRecord | undefined;
    for (const rec of this.passwordResetCodes.values()) {
      if (rec.email.toLowerCase() === normalizedEmail && !rec.consumed && !rec.invalidated) {
        if (!record || rec.createdAt > record.createdAt) {
          record = rec;
        }
      }
    }

    if (!record) {
      return { 
        success: false, 
        error: 'No active verification code found for this email. Please request a new code.', 
        codeExpiredOrInvalid: true 
      };
    }

    if (record.attempts >= 5) {
      record.invalidated = true;
      return { 
        success: false, 
        error: 'Maximum verification attempts (5) exceeded. This code has been invalidated. Please request a new code.', 
        codeExpiredOrInvalid: true, 
        attemptsRemaining: 0 
      };
    }

    const now = this.getTime();
    if (now >= record.expiresAt) {
      record.invalidated = true;
      return { 
        success: false, 
        error: 'Verification code has expired (5-minute limit). Please request a new code.', 
        codeExpiredOrInvalid: true 
      };
    }

    const isMatch = timingSafeVerifyCodeHash(trimmedCode, record.codeHash);
    if (!isMatch) {
      record.attempts += 1;
      if (record.attempts >= 5) {
        record.invalidated = true;
        return { 
          success: false, 
          error: 'Incorrect verification code. Maximum verification attempts (5) exceeded. Code has been invalidated. Please request a new code.', 
          codeExpiredOrInvalid: true, 
          attemptsRemaining: 0 
        };
      }
      const remaining = 5 - record.attempts;
      return { 
        success: false, 
        error: `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`, 
        attemptsRemaining: remaining 
      };
    }

    record.consumed = true;

    const resetAuthToken = generateResetAuthToken();
    const hashedAuth = hashResetAuthToken(resetAuthToken);
    const authRecord: PasswordResetAuthRecord = {
      id: hashedAuth,
      userId: record.userId,
      email: record.email,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      consumed: false
    };

    this.passwordResetAuths.set(hashedAuth, authRecord);

    try {
      this.dbManager.db.prepare(`
        INSERT INTO password_reset_auths (id, user_id, email, created_at, expires_at, consumed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(authRecord.id, authRecord.userId, authRecord.email, authRecord.createdAt, authRecord.expiresAt, 0);
    } catch (err: any) {
      this.handleDatabaseWriteError('createPasswordResetAuth', err);
    }

    return { success: true, resetAuthToken };
  }

  async completePasswordReset(
    resetAuthToken: string, 
    newPassword: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!resetAuthToken || typeof resetAuthToken !== 'string') {
      return { success: false, error: 'Reset authorization is missing or invalid. Please verify your code again.' };
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return { success: false, error: 'Password must be at least 8 characters long.' };
    }

    const hashedAuth = hashResetAuthToken(resetAuthToken);
    const authRecord = this.passwordResetAuths.get(hashedAuth);
    const now = this.getTime();

    if (!authRecord || authRecord.consumed || now >= authRecord.expiresAt) {
      return { 
        success: false, 
        error: 'Reset authorization has expired or is invalid. Please request a new verification code.' 
      };
    }

    authRecord.consumed = true;
    this.passwordResetAuths.delete(hashedAuth);

    const user = this.getUser(authRecord.userId);
    if (!user) {
      return { success: false, error: 'User account not found.' };
    }

    const newHash = await hashPassword(newPassword);
    user.passwordHash = newHash;
    user.updatedAt = now;
    this.saveUser(user);

    this.deleteUserSessions(user.id);
    this.invalidateAllResetCodesForUser(user.id);

    return { success: true };
  }

  invalidateAllResetCodesForUser(userId: string): void {
    for (const rec of this.passwordResetCodes.values()) {
      if (rec.userId === userId && !rec.consumed && !rec.invalidated) {
        rec.invalidated = true;
      }
    }
  }

  // --- Rate Limiting ---

  checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const record = this.rateLimits.get(key);
    if (!record) return { allowed: true, retryAfterSeconds: 0 };

    const now = this.getTime();
    if (record.lockUntil > now) {
      return { 
        allowed: false, 
        retryAfterSeconds: Math.ceil((record.lockUntil - now) / 1000) 
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailedLogin(key: string): void {
    const now = this.getTime();
    const record = this.rateLimits.get(key) || { attempts: 0, lockUntil: 0 };
    record.attempts += 1;

    if (record.attempts >= 5) {
      record.lockUntil = now + 15 * 60 * 1000;
    }
    this.rateLimits.set(key, record);
  }

  clearRateLimit(key: string): void {
    this.rateLimits.delete(key);
  }

  // --- GitHub Credentials ---

  setGithubToken(userId: string, plainToken: string, username?: string): void {
    if (userId && !this.users.has(userId)) {
      this.saveUser({
        id: userId,
        email: `${userId}@squadforge.internal`,
        name: userId,
        githubConnected: true,
        githubUsername: username,
        costLimitPerBuild: 5.0,
        enabledModelIds: [],
        createdAt: this.getTime()
      });
    }

    const encrypted = encryptToken(plainToken);
    this.encryptedGithubTokens.set(userId, encrypted);

    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO encrypted_github_tokens (user_id, encrypted_token, created_at)
        VALUES (?, ?, ?)
      `).run(userId, encrypted, this.getTime());
    } catch (err: any) {
      this.handleDatabaseWriteError('setGithubToken', err);
    }

    const user = this.users.get(userId);
    if (user) {
      user.githubConnected = true;
      if (username) user.githubUsername = username;
      this.saveUser(user);
    }
  }

  getGithubToken(userId: string): string | null {
    const encrypted = this.encryptedGithubTokens.get(userId);
    if (!encrypted) return null;
    return decryptToken(encrypted);
  }

  disconnectGithub(userId: string): void {
    this.encryptedGithubTokens.delete(userId);
    try {
      this.dbManager.db.prepare('DELETE FROM encrypted_github_tokens WHERE user_id = ?').run(userId);
    } catch (err: any) {
      this.handleDatabaseWriteError('disconnectGithub', err);
    }

    const user = this.users.get(userId);
    if (user) {
      user.githubConnected = false;
      user.githubUsername = undefined;
      this.saveUser(user);
    }
  }

  // ==========================================
  // GitHub OAuth State Management (Persistent Storage)
  // ==========================================

  saveOAuthState(record: {
    state: string;
    userId: string;
    sessionTokenHash: string;
    redirectUri: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    const sqlite = this.dbManager.db;
    const stmt = sqlite.prepare(`
      INSERT OR REPLACE INTO oauth_states (
        state, user_id, session_token_hash, redirect_uri, created_at, expires_at, consumed
      ) VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    stmt.run(
      record.state,
      record.userId,
      record.sessionTokenHash,
      record.redirectUri,
      record.createdAt,
      record.expiresAt
    );
  }

  getOAuthState(state: string): {
    state: string;
    userId: string;
    sessionTokenHash: string;
    redirectUri: string;
    createdAt: number;
    expiresAt: number;
    consumed: boolean;
  } | null {
    try {
      const row = this.dbManager.db.prepare(
        'SELECT * FROM oauth_states WHERE state = ?'
      ).get(state) as any;
      if (!row) return null;
      return {
        state: row.state,
        userId: row.user_id,
        sessionTokenHash: row.session_token_hash,
        redirectUri: row.redirect_uri,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        consumed: Boolean(row.consumed)
      };
    } catch {
      return null;
    }
  }

  consumeOAuthState(
    state: string,
    sessionToken: string
  ): { 
    valid: boolean; 
    record?: {
      state: string;
      userId: string;
      sessionTokenHash: string;
      redirectUri: string;
      createdAt: number;
      expiresAt: number;
    }; 
    error?: string; 
  } {
    if (!state || typeof state !== 'string' || state.trim().length === 0) {
      return { valid: false, error: 'Missing or invalid OAuth state parameter.' };
    }
    if (!sessionToken || typeof sessionToken !== 'string' || sessionToken.trim().length === 0) {
      return { valid: false, error: 'Missing or invalid session credentials.' };
    }

    const trimmedState = state.trim();
    const now = this.getTime();

    return this.dbManager.transaction(() => {
      const sqlite = this.dbManager.db;
      const row = sqlite.prepare('SELECT * FROM oauth_states WHERE state = ?').get(trimmedState) as any;

      if (!row) {
        return { valid: false, error: 'Invalid or already consumed OAuth state parameter.' };
      }

      if (row.consumed === 1) {
        return { valid: false, error: 'Invalid or already consumed OAuth state parameter (replay attack prevented).' };
      }

      if (now > row.expires_at) {
        return { valid: false, error: 'OAuth state parameter has expired. Please initiate authentication again.' };
      }

      // 1. Constant-time comparison of state
      const stateBuf = Buffer.from(trimmedState, 'utf-8');
      const expectedStateBuf = Buffer.from(row.state, 'utf-8');
      if (stateBuf.length !== expectedStateBuf.length || !crypto.timingSafeEqual(stateBuf, expectedStateBuf)) {
        return { valid: false, error: 'OAuth state comparison failed.' };
      }

      // 2. Constant-time comparison of session token hash
      const currentSessionHash = hashSessionToken(sessionToken);
      const currentHashBuf = Buffer.from(currentSessionHash, 'utf-8');
      const expectedHashBuf = Buffer.from(row.session_token_hash, 'utf-8');
      if (currentHashBuf.length !== expectedHashBuf.length || !crypto.timingSafeEqual(currentHashBuf, expectedHashBuf)) {
        return { valid: false, error: 'OAuth state does not match the initiating browser session.' };
      }

      // 3. Atomic consumption: Mark consumed = 1 only if still consumed = 0
      const updateResult = sqlite.prepare(
        'UPDATE oauth_states SET consumed = 1 WHERE state = ? AND consumed = 0'
      ).run(trimmedState);

      if (updateResult.changes === 0) {
        return { valid: false, error: 'OAuth state was concurrently consumed or already used.' };
      }

      const record = {
        state: row.state,
        userId: row.user_id,
        sessionTokenHash: row.session_token_hash,
        redirectUri: row.redirect_uri,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      };

      return { valid: true, record };
    });
  }

  cleanExpiredOAuthStates(): void {
    try {
      const now = this.getTime();
      this.dbManager.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
    } catch {
      // Ignored
    }
  }

  clearOAuthStates(): void {
    try {
      this.dbManager.db.prepare('DELETE FROM oauth_states').run();
    } catch {
      // Ignored
    }
  }

  getActiveOAuthStateCount(): number {
    try {
      const now = this.getTime();
      const row = this.dbManager.db.prepare(
        'SELECT COUNT(*) as count FROM oauth_states WHERE consumed = 0 AND expires_at >= ?'
      ).get(now) as { count: number };
      return row ? row.count : 0;
    } catch {
      return 0;
    }
  }

  // --- Builds ---

  getBuild(buildId: string): Build | undefined {
    return this.builds.get(buildId);
  }

  saveBuild(build: Build): Build {
    // Ensure referenced user exists in users table to satisfy foreign key constraint integrity
    if (build.userId) {
      try {
        const userExists = this.dbManager.db.prepare('SELECT id FROM users WHERE id = ?').get(build.userId);
        if (!userExists) {
          this.saveUser({
            id: build.userId,
            email: `${build.userId}@squadforge.internal`,
            name: build.userId,
            githubConnected: false,
            costLimitPerBuild: 5.0,
            enabledModelIds: [],
            createdAt: this.getTime(),
            updatedAt: this.getTime()
          });
        }
      } catch {
        // Fallback
      }
    }

    // 1. Database write MUST happen BEFORE cache mutation
    try {
      this.dbManager.db.prepare(`
        INSERT INTO builds (
          id, user_id, idea, status, created_at, updated_at, completed_at,
          selected_models, auto_push_github, total_tokens, total_cost, cost_limit,
          token_budget, max_duration_seconds, patches_applied_count, error, failure_reason,
          tech_stack, milestones, test_report, security_audit, verification_report,
          verification_feedback, verification_attempts, max_verification_attempts,
          budget_warning_emitted, github_repo, github_branch, github_pr_url,
          project_type, architecture_decisions, requirements_checklist, revisions, live_preview_html,
          preview_mode, preview_diagnostic, preview_runtime_errors, preview_entry_point,
          architecture_blueprint, requirements_analysis, complexity_assessment, file_structure_plan, dependency_plan
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          idea = excluded.idea,
          status = excluded.status,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          selected_models = excluded.selected_models,
          auto_push_github = excluded.auto_push_github,
          total_tokens = excluded.total_tokens,
          total_cost = excluded.total_cost,
          cost_limit = excluded.cost_limit,
          token_budget = excluded.token_budget,
          max_duration_seconds = excluded.max_duration_seconds,
          patches_applied_count = excluded.patches_applied_count,
          error = excluded.error,
          failure_reason = excluded.failure_reason,
          tech_stack = excluded.tech_stack,
          milestones = excluded.milestones,
          test_report = excluded.test_report,
          security_audit = excluded.security_audit,
          verification_report = excluded.verification_report,
          verification_feedback = excluded.verification_feedback,
          verification_attempts = excluded.verification_attempts,
          max_verification_attempts = excluded.max_verification_attempts,
          budget_warning_emitted = excluded.budget_warning_emitted,
          github_repo = excluded.github_repo,
          github_branch = excluded.github_branch,
          github_pr_url = excluded.github_pr_url,
          project_type = excluded.project_type,
          architecture_decisions = excluded.architecture_decisions,
          requirements_checklist = excluded.requirements_checklist,
          revisions = excluded.revisions,
          live_preview_html = excluded.live_preview_html,
          preview_mode = excluded.preview_mode,
          preview_diagnostic = excluded.preview_diagnostic,
          preview_runtime_errors = excluded.preview_runtime_errors,
          preview_entry_point = excluded.preview_entry_point,
          architecture_blueprint = excluded.architecture_blueprint,
          requirements_analysis = excluded.requirements_analysis,
          complexity_assessment = excluded.complexity_assessment,
          file_structure_plan = excluded.file_structure_plan,
          dependency_plan = excluded.dependency_plan
      `).run(
        build.id, build.userId, build.idea, build.status, build.createdAt, (build.updatedAt || build.createdAt || this.getTime()),
        build.completedAt || null, JSON.stringify(build.selectedModels || []),
        build.autoPushGithub ? 1 : 0, build.totalTokens || 0, build.totalCost || 0.0,
        build.costLimit || 5.0, build.tokenBudget || 100000, build.maxDurationSeconds || 300,
        build.patchesAppliedCount || 0, build.error || null, build.failureReason || null,
        build.techStack ? JSON.stringify(build.techStack) : null,
        build.milestones ? JSON.stringify(build.milestones) : null,
        build.testReport ? JSON.stringify(build.testReport) : null,
        build.securityAudit ? JSON.stringify(build.securityAudit) : null,
        build.verificationReport ? JSON.stringify(build.verificationReport) : null,
        build.verificationFeedback || null, build.verificationAttempts || 0,
        build.maxVerificationAttempts || 3, build.budgetWarningEmitted ? 1 : 0,
        build.githubRepoUrl || null, build.gitBranch || null, build.pullRequestUrl || null,
        build.projectType || 'fullstack',
        build.architectureDecisions ? JSON.stringify(build.architectureDecisions) : null,
        build.requirementsChecklist ? JSON.stringify(build.requirementsChecklist) : null,
        build.revisions ? JSON.stringify(build.revisions) : null,
        build.livePreviewHtml || null,
        build.previewMode || null,
        build.previewDiagnostic || null,
        build.previewRuntimeErrors ? JSON.stringify(build.previewRuntimeErrors) : null,
        build.previewEntryPoint || null,
        build.architectureBlueprint ? JSON.stringify(build.architectureBlueprint) : null,
        build.requirementsAnalysis ? JSON.stringify(build.requirementsAnalysis) : null,
        build.complexityAssessment ? JSON.stringify(build.complexityAssessment) : null,
        build.fileStructurePlan ? JSON.stringify(build.fileStructurePlan) : null,
        build.dependencyPlan ? JSON.stringify(build.dependencyPlan) : null
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('saveBuild', err);
      throw err;
    }

    // 2. Only mutate in-memory cache and broadcast after DB write succeeds
    this.builds.set(build.id, build);
    this.broadcast(build.id, 'build_updated', build);

    return build;
  }

  getAllBuilds(userId?: string): Build[] {
    const all = Array.from(this.builds.values());
    if (userId) {
      return all.filter(b => b.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
    }
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- Tasks ---

  getTasks(buildId: string): Task[] {
    return this.tasks.get(buildId) || [];
  }

  getTask(buildIdOrTaskId: string, taskIdMaybe?: string): Task | undefined {
    if (taskIdMaybe) {
      const list = this.getTasks(buildIdOrTaskId);
      return list.find(t => t.id === taskIdMaybe);
    }
    for (const list of this.tasks.values()) {
      const found = list.find(t => t.id === buildIdOrTaskId);
      if (found) return found;
    }
    return undefined;
  }

  public mapDbRowToTask(t: any): Task {
    return {
      id: t.id,
      buildId: t.build_id,
      title: t.title,
      description: t.description,
      filePaths: safeJsonParse<string[]>(t.file_paths, []),
      priority: t.priority as any,
      status: t.status as any,
      claimedBy: t.claimed_by || null,
      leaseExpiresAt: t.lease_expires_at || null,
      createdAt: t.created_at,
      completedAt: t.completed_at || undefined,
      error: t.error || undefined,
      isFixTask: Boolean(t.is_fix_task),
      retryCount: t.retry_count || 0,
      maxRetries: t.max_retries || 3,
      lastError: t.last_error || undefined,
      dependencies: safeJsonParse<string[] | undefined>(t.dependencies, undefined),
      assignedRole: t.assigned_role || undefined,
      milestone: t.milestone || undefined,
      complexity: t.complexity || undefined,
      tokenBudget: t.token_budget || undefined,
      actualTokensUsed: t.actual_tokens_used || 0,
      estimatedCost: t.estimated_cost || 0.0,
      isPaused: Boolean(t.is_paused),
      pausedReason: t.paused_reason || undefined,
      executionLogs: safeJsonParse<any[] | undefined>(t.execution_logs, undefined)
    };
  }

  addTask(buildId: string, task: Task): Task {
    // 1. Database write MUST happen BEFORE cache mutation
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO tasks (
          id, build_id, title, description, file_paths, priority, status,
          claimed_by, lease_expires_at, created_at, completed_at, error,
          is_fix_task, retry_count, max_retries, last_error, dependencies,
          assigned_role, milestone, complexity, token_budget, actual_tokens_used,
          estimated_cost, is_paused, paused_reason, execution_logs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id, task.buildId, task.title, task.description, JSON.stringify(task.filePaths || []),
        task.priority, task.status, task.claimedBy || null, task.leaseExpiresAt || null,
        task.createdAt, task.completedAt || null, task.error || null,
        task.isFixTask ? 1 : 0, task.retryCount || 0, task.maxRetries || 3,
        task.lastError || null, task.dependencies ? JSON.stringify(task.dependencies) : null,
        task.assignedRole || null, task.milestone || null, task.complexity || null,
        task.tokenBudget || null, task.actualTokensUsed || 0, task.estimatedCost || 0.0,
        task.isPaused ? 1 : 0, task.pausedReason || null,
        task.executionLogs ? JSON.stringify(task.executionLogs) : null
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addTask', err);
      throw err;
    }

    // 2. Only mutate in-memory cache and broadcast after successful persistence
    let list = this.tasks.get(buildId);
    if (!list) {
      list = [];
      this.tasks.set(buildId, list);
    }
    list.push(task);
    this.broadcast(buildId, 'task_added', task);

    return task;
  }

  updateTask(buildId: string, taskId: string, updates: Partial<Task>): Task | null {
    const list = this.getTasks(buildId);
    const index = list.findIndex(t => t.id === taskId);
    if (index === -1) return null;
    const current = list[index];
    const updated = { ...current, ...updates };

    try {
      // Conditional database update scoped to id and build_id
      const res = this.dbManager.db.prepare(`
        UPDATE tasks SET
          status = ?, claimed_by = ?, lease_expires_at = ?, completed_at = ?,
          error = ?, retry_count = ?, last_error = ?, is_paused = ?, paused_reason = ?,
          actual_tokens_used = ?, estimated_cost = ?
        WHERE id = ? AND build_id = ?
      `).run(
        updated.status, updated.claimedBy || null, updated.leaseExpiresAt || null,
        updated.completedAt || null, updated.error || null, updated.retryCount || 0,
        updated.lastError || null, updated.isPaused ? 1 : 0, updated.pausedReason || null,
        updated.actualTokensUsed || 0, updated.estimatedCost || 0.0, taskId, buildId
      );

      if (res.changes === 0) {
        return null;
      }

      // Only mutate in-memory cache and broadcast if database write succeeded
      list[index] = updated;
      this.tasks.set(buildId, list);
      this.broadcast(buildId, 'task_updated', updated);

      return updated;
    } catch (err: any) {
      this.handleDatabaseWriteError('updateTask', err);
      return null;
    }
  }

  claimTaskAtomic(buildId: string, taskId: string, modelId: string, leaseExpiresAt: number): Task | null {
    if (!buildId || !taskId || !modelId) return null;
    const now = this.getTime();

    try {
      // Atomic conditional update in SQLite:
      // Validates task ID, build ID, pause state (is_paused = 0), and that status is open/pending/retrying
      // OR status is in_progress/claimed/working with an expired lease.
      const res = this.dbManager.db.prepare(`
        UPDATE tasks SET 
          status = 'in_progress', 
          claimed_by = ?, 
          lease_expires_at = ?
        WHERE id = ? 
          AND build_id = ? 
          AND is_paused = 0 
          AND (
            status IN ('pending', 'open', 'retrying')
            OR (status IN ('in_progress', 'claimed', 'working') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
          )
      `).run(modelId, leaseExpiresAt, taskId, buildId, now);

      if (res.changes === 0) {
        // Lost race condition in database or conditions not satisfied
        return null;
      }

      // Mutate in-memory cache ONLY AFTER database update succeeded
      const list = this.getTasks(buildId);
      const index = list.findIndex(t => t.id === taskId);
      let updated: Task;
      if (index !== -1) {
        updated = {
          ...list[index],
          status: 'in_progress',
          claimedBy: modelId,
          leaseExpiresAt
        };
        list[index] = updated;
      } else {
        const row = this.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
        updated = this.mapDbRowToTask(row);
        list.push(updated);
      }

      this.tasks.set(buildId, list);
      this.broadcast(buildId, 'task_updated', updated);
      return updated;
    } catch (err: any) {
      this.handleDatabaseWriteError('claimTaskAtomic', err);
      return null;
    }
  }

  completeTaskAtomic(
    buildId: string, 
    taskId: string, 
    modelId: string, 
    updates: Partial<Task>
  ): { success: boolean; task?: Task; error?: string } {
    if (!buildId || !taskId || !modelId) {
      return { success: false, error: 'buildId, taskId, and modelId are required' };
    }
    const now = this.getTime();
    const updatedStatus = updates.status || 'completed';
    const updatedCompletedAt = updatedStatus === 'completed' ? (updates.completedAt || now) : null;

    try {
      // 1. Authoritative Database Pre-check for strict ownership diagnostics
      const row = this.dbManager.db.prepare(
        'SELECT status, claimed_by, lease_expires_at, is_paused, retry_count FROM tasks WHERE id = ? AND build_id = ?'
      ).get(taskId, buildId) as any;

      if (!row) {
        return { success: false, error: 'Task not found' };
      }
      if (row.is_paused) {
        return { success: false, error: `Task ${taskId} is currently paused` };
      }
      if (row.status === 'completed' || row.status === 'done') {
        return { success: false, error: 'Task is already completed' };
      }
      if (row.status === 'failed' || row.status === 'cancelled') {
        return { success: false, error: `Task cannot be completed because current status is ${row.status}` };
      }
      if (!row.claimed_by || row.status === 'pending') {
        return { success: false, error: 'Cannot complete unclaimed task: Task must be claimed before completion' };
      }
      if (row.claimed_by !== modelId) {
        return { 
          success: false, 
          error: `Stale worker rejected: Task ${taskId} is currently claimed by ${row.claimed_by}, not ${modelId}` 
        };
      }
      if (row.lease_expires_at && row.lease_expires_at < now) {
        return { 
          success: false, 
          error: `Stale lease rejected: Worker ${modelId} lease expired at ${new Date(row.lease_expires_at).toISOString()}` 
        };
      }

      // 2. Ownership validation and state transition occur in the SAME conditional database update.
      // Strictly enforces: active status, claimed_by = modelId, lease_expires_at not expired.
      const res = this.dbManager.db.prepare(`
        UPDATE tasks SET
          status = ?, 
          claimed_by = ?, 
          lease_expires_at = NULL, 
          completed_at = ?,
          error = ?, 
          retry_count = ?, 
          last_error = ?,
          actual_tokens_used = ?, 
          estimated_cost = ?
        WHERE id = ? 
          AND build_id = ?
          AND is_paused = 0
          AND status IN ('in_progress', 'claimed', 'working', 'retrying')
          AND claimed_by = ?
          AND (lease_expires_at IS NULL OR lease_expires_at >= ?)
      `).run(
        updatedStatus,
        updatedStatus === 'completed' ? modelId : null,
        updatedCompletedAt,
        updates.error || null,
        updates.retryCount ?? row.retry_count ?? 0,
        updates.lastError || null,
        updates.actualTokensUsed ?? 0,
        updates.estimatedCost ?? 0.0,
        taskId,
        buildId,
        modelId,
        now
      );

      if (res.changes === 0) {
        return { 
          success: false, 
          error: 'Task completion rejected: Task state, ownership, or lease condition not satisfied' 
        };
      }

      // Successful DB update! Mutate in-memory cache and broadcast
      const list = this.getTasks(buildId);
      const index = list.findIndex(t => t.id === taskId);
      let updated: Task;
      if (index !== -1) {
        updated = {
          ...list[index],
          ...updates,
          status: updatedStatus,
          claimedBy: updatedStatus === 'completed' ? modelId : null,
          leaseExpiresAt: null,
          completedAt: updatedCompletedAt || undefined
        };
        list[index] = updated;
      } else {
        const fullRow = this.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
        updated = this.mapDbRowToTask(fullRow);
        list.push(updated);
      }

      this.tasks.set(buildId, list);
      this.broadcast(buildId, 'task_updated', updated);

      return { success: true, task: updated };
    } catch (err: any) {
      this.handleDatabaseWriteError('completeTaskAtomic', err);
      return { success: false, error: err.message || 'Database error during task completion' };
    }
  }

  failTaskAtomic(
    buildId: string,
    taskId: string,
    modelId: string,
    error: string
  ): { success: boolean; task?: Task; error?: string } {
    if (!buildId || !taskId || !modelId) {
      return { success: false, error: 'buildId, taskId, and modelId are required' };
    }
    const now = this.getTime();
    try {
      // 1. Authoritative DB check
      const row = this.dbManager.db.prepare(
        'SELECT status, claimed_by, lease_expires_at FROM tasks WHERE id = ? AND build_id = ?'
      ).get(taskId, buildId) as any;

      if (!row) {
        return { success: false, error: 'Task not found' };
      }
      if (row.status === 'failed') {
        return { success: false, error: 'Task is already failed' };
      }
      if (row.status === 'completed' || row.status === 'done') {
        return { success: false, error: 'Cannot fail task: Task is already completed' };
      }
      if (row.status === 'cancelled') {
        return { success: false, error: 'Cannot fail task: Task is already cancelled' };
      }

      // Check worker ownership: only owning worker or system supervisor can fail the task
      const isSystem = modelId === 'system';
      if (!isSystem) {
        if (!row.claimed_by || row.status === 'pending') {
          return { success: false, error: 'Cannot fail unclaimed task: Only claiming worker or system can fail tasks' };
        }
        if (row.claimed_by !== modelId) {
          return { success: false, error: `Cannot fail task: Task is currently owned by ${row.claimed_by}, not ${modelId}` };
        }
        if (row.lease_expires_at && row.lease_expires_at < now) {
          return { success: false, error: `Stale lease rejected: Worker ${modelId} lease expired at ${new Date(row.lease_expires_at).toISOString()}` };
        }
      }

      // 2. Atomic conditional database update: prevents duplicate failure transitions
      const res = this.dbManager.db.prepare(`
        UPDATE tasks SET
          status = 'failed',
          claimed_by = NULL,
          lease_expires_at = NULL,
          error = ?,
          last_error = ?
        WHERE id = ?
          AND build_id = ?
          AND status IN ('pending', 'in_progress', 'claimed', 'working', 'retrying')
          AND (
            (? = 'system')
            OR (claimed_by = ? AND (lease_expires_at IS NULL OR lease_expires_at >= ?))
          )
      `).run(error, error, taskId, buildId, modelId, modelId, now);

      if (res.changes === 0) {
        return { success: false, error: `Cannot fail task ${taskId}: task not found, already completed, or claimed by another active worker` };
      }

      const list = this.getTasks(buildId);
      const index = list.findIndex(t => t.id === taskId);
      let updated: Task;
      if (index !== -1) {
        updated = {
          ...list[index],
          status: 'failed',
          claimedBy: null,
          leaseExpiresAt: null,
          error,
          lastError: error
        };
        list[index] = updated;
      } else {
        const fullRow = this.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
        updated = this.mapDbRowToTask(fullRow);
        list.push(updated);
      }
      this.tasks.set(buildId, list);
      this.broadcast(buildId, 'task_updated', updated);
      return { success: true, task: updated };
    } catch (err: any) {
      this.handleDatabaseWriteError('failTaskAtomic', err);
      return { success: false, error: err.message || 'Database error during failTask' };
    }
  }

  cancelTaskAtomic(
    buildId: string,
    taskId: string,
    modelId: string,
    reason: string
  ): { success: boolean; task?: Task; error?: string } {
    if (!buildId || !taskId || !modelId) {
      return { success: false, error: 'buildId, taskId, and modelId are required' };
    }
    const now = this.getTime();
    try {
      const row = this.dbManager.db.prepare(
        'SELECT status, claimed_by, lease_expires_at FROM tasks WHERE id = ? AND build_id = ?'
      ).get(taskId, buildId) as any;

      if (!row) {
        return { success: false, error: 'Task not found' };
      }
      if (row.status === 'cancelled') {
        return { success: false, error: 'Task is already cancelled' };
      }
      if (row.status === 'completed' || row.status === 'done') {
        return { success: false, error: 'Cannot cancel task: Task is already completed' };
      }

      const isSupervisor = modelId === 'system' || modelId === 'supervisor' || modelId === 'project_manager';
      if (!isSupervisor) {
        if (!row.claimed_by || row.status === 'pending' || row.status === 'open') {
          return { success: false, error: 'Cannot cancel unclaimed task: Only an authorized system supervisor can cancel unclaimed tasks' };
        }
        if (row.claimed_by !== modelId) {
          return { success: false, error: `Cannot cancel task: Task is currently owned by ${row.claimed_by}, not ${modelId}` };
        }
        if (row.lease_expires_at && row.lease_expires_at < now) {
          return { success: false, error: `Stale lease rejected: Worker ${modelId} lease expired at ${new Date(row.lease_expires_at).toISOString()}` };
        }
      }

      const res = this.dbManager.db.prepare(`
        UPDATE tasks SET
          status = 'cancelled',
          claimed_by = NULL,
          lease_expires_at = NULL,
          error = ?,
          last_error = ?
        WHERE id = ?
          AND build_id = ?
          AND status NOT IN ('completed', 'done', 'cancelled')
          AND (
            (? = 1)
            OR (
              claimed_by IS NOT NULL 
              AND claimed_by = ? 
              AND (lease_expires_at IS NULL OR lease_expires_at >= ?)
            )
          )
      `).run(reason, reason, taskId, buildId, isSupervisor ? 1 : 0, modelId, now);

      if (res.changes === 0) {
        return { success: false, error: `Cannot cancel task ${taskId}: task condition not satisfied` };
      }

      const list = this.getTasks(buildId);
      const index = list.findIndex(t => t.id === taskId);
      let updated: Task;
      if (index !== -1) {
        updated = {
          ...list[index],
          status: 'cancelled',
          claimedBy: null,
          leaseExpiresAt: null,
          error: reason,
          lastError: reason
        };
        list[index] = updated;
      } else {
        const fullRow = this.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
        updated = this.mapDbRowToTask(fullRow);
        list.push(updated);
      }
      this.tasks.set(buildId, list);
      this.broadcast(buildId, 'task_updated', updated);
      return { success: true, task: updated };
    } catch (err: any) {
      this.handleDatabaseWriteError('cancelTaskAtomic', err);
      return { success: false, error: err.message || 'Database error during cancelTask' };
    }
  }

  // --- Files ---

  getFilesMap(buildId: string): Map<string, ProjectFile> {
    let files = this.files.get(buildId);
    if (!files) {
      files = new Map();
      this.files.set(buildId, files);
    }
    return files;
  }

  getFile(buildId: string, path: string): ProjectFile | undefined {
    return this.getFilesMap(buildId).get(path);
  }

  getAllFiles(buildId: string): ProjectFile[] {
    return Array.from(this.getFilesMap(buildId).values());
  }

  setFile(buildId: string, file: ProjectFile): ProjectFile {
    const fileId = `${buildId}:${file.path}`;
    const now = this.getTime();
    const contentHash = computeContentHash(file.content);
    file.contentHash = contentHash;

    const latestVer = file.history[file.history.length - 1];
    if (latestVer) {
      latestVer.contentHash = computeContentHash(latestVer.content);
    }

    // 1. Database write MUST happen BEFORE cache mutation
    try {
      this.dbManager.transaction(() => {
        this.dbManager.db.prepare(`
          INSERT INTO project_files (
            id, build_id, path, content, version, owner_model,
            lease_owner, lease_expires_at, created_at, updated_at, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            version = excluded.version,
            owner_model = excluded.owner_model,
            lease_owner = excluded.lease_owner,
            lease_expires_at = excluded.lease_expires_at,
            updated_at = excluded.updated_at,
            content_hash = excluded.content_hash
        `).run(
          fileId, buildId, file.path, file.content, file.version, file.ownerModel || 'system',
          file.leaseOwner || null, file.leaseExpiresAt || null, file.createdAt || now, file.updatedAt || now, contentHash
        );

        if (latestVer) {
          this.dbManager.db.prepare(`
            INSERT INTO file_versions (file_id, build_id, path, version, content, author_model, commit_message, timestamp, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fileId, buildId, file.path, latestVer.version, latestVer.content, latestVer.authorModel, latestVer.commitMessage || null, latestVer.timestamp, latestVer.contentHash || contentHash);
        }
      });
    } catch (err: any) {
      this.handleDatabaseWriteError('setFile', err);
      throw err;
    }

    // 2. Only mutate in-memory cache and broadcast after DB transaction succeeds
    const files = this.getFilesMap(buildId);
    files.set(file.path, file);
    this.broadcast(buildId, 'file_updated', file);

    return file;
  }

  deleteFile(buildId: string, filePath: string): boolean {
    const fileId = `${buildId}:${filePath}`;
    // 1. Database delete first
    try {
      this.dbManager.db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
    } catch (err: any) {
      this.handleDatabaseWriteError('deleteFile', err);
      throw err;
    }

    // 2. Mutate cache and broadcast after DB delete
    const files = this.getFilesMap(buildId);
    const existed = files.delete(filePath);
    if (existed) {
      this.broadcast(buildId, 'file_deleted', { path: filePath });
    }
    return existed;
  }

  // --- Atomic File Lease Management ---

  acquireFileLeasesAtomic(
    buildId: string, 
    modelId: string, 
    filePaths: string[], 
    durationMs: number
  ): { success: boolean; lockedBy?: string; acquiredPaths: string[]; error?: string } {
    if (!buildId || !modelId || !filePaths || filePaths.length === 0) {
      return { success: false, acquiredPaths: [], error: 'buildId, modelId, and filePaths are required' };
    }
    if (typeof durationMs !== 'number' || isNaN(durationMs) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) {
      return { success: false, acquiredPaths: [], error: 'Invalid lease duration: must be a positive finite number <= 24 hours' };
    }
    const now = this.getTime();
    const sortedPaths = [...new Set(filePaths)].sort();
    const expiry = now + durationMs;

    // 1. Clean expired leases in database and memory
    try {
      this.dbManager.db.prepare(`
        UPDATE project_files 
        SET lease_owner = NULL, lease_expires_at = NULL 
        WHERE build_id = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      `).run(buildId, now);
      
      const fileMap = this.getFilesMap(buildId);
      for (const file of fileMap.values()) {
        if (file.leaseExpiresAt && file.leaseExpiresAt <= now) {
          file.leaseOwner = null;
          file.leaseExpiresAt = null;
        }
      }
    } catch (err: any) {
      this.handleDatabaseWriteError('sweepExpiredFileLeases', err);
    }

    return this.dbManager.transaction(() => {
      // 2. Validate that NO requested file is actively leased by another model
      for (const p of sortedPaths) {
        const row = this.dbManager.db.prepare(
          'SELECT lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, p) as any;

        if (row && row.lease_owner && row.lease_owner !== modelId) {
          if (!row.lease_expires_at || row.lease_expires_at > now) {
            // Cannot acquire: file is actively held by another agent.
            return { success: false, lockedBy: row.lease_owner, acquiredPaths: [], error: `File ${p} is locked by ${row.lease_owner}` };
          }
        }
      }

      // 3. Grant leases atomically in database (upserting placeholder if file doesn't exist yet)
      const acquired: string[] = [];
      for (const p of sortedPaths) {
        const fileId = `${buildId}:${p}`;
        const res = this.dbManager.db.prepare(`
          INSERT INTO project_files (
            id, build_id, path, content, version, owner_model,
            lease_owner, lease_expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET 
            lease_owner = excluded.lease_owner,
            lease_expires_at = excluded.lease_expires_at,
            updated_at = excluded.updated_at
          WHERE project_files.lease_owner IS NULL
             OR project_files.lease_owner = excluded.lease_owner
             OR project_files.lease_expires_at <= ?
        `).run(fileId, buildId, p, modelId, modelId, expiry, now, now, now);

        if (res.changes === 0) {
          return { success: false, lockedBy: 'another_agent', acquiredPaths: [], error: `Failed to acquire lease on ${p}: active lease held by another model` };
        }

        acquired.push(p);
      }

      // 4. Update in-memory file objects post-commit
      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        for (const p of acquired) {
          let file = this.getFile(buildId, p);
          if (!file) {
            file = {
              path: p,
              content: '',
              version: 0,
              ownerModel: modelId,
              history: [],
              leaseOwner: modelId,
              leaseExpiresAt: expiry,
              createdAt: now,
              updatedAt: now
            };
            this.getFilesMap(buildId).set(p, file);
          } else {
            file.leaseOwner = modelId;
            file.leaseExpiresAt = expiry;
            file.updatedAt = now;
          }
        }
      });

      return { success: true, acquiredPaths: acquired };
    });
  }

  renewFileLeasesAtomic(
    buildId: string,
    modelId: string,
    filePaths: string[],
    durationMs: number
  ): { success: boolean; error?: string; renewedPaths: string[] } {
    if (!buildId || !modelId || !filePaths || filePaths.length === 0) {
      return { success: false, error: 'buildId, modelId, and filePaths are required', renewedPaths: [] };
    }
    if (typeof durationMs !== 'number' || isNaN(durationMs) || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) {
      return { success: false, error: 'Invalid lease duration: must be a positive finite number <= 24 hours', renewedPaths: [] };
    }
    const now = this.getTime();
    const sortedPaths = [...new Set(filePaths)].sort();
    const expiry = now + durationMs;

    return this.dbManager.transaction(() => {
      // 1. Verify all files exist, are currently owned by modelId, and have not expired
      for (const p of sortedPaths) {
        const row = this.dbManager.db.prepare(
          'SELECT lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, p) as any;

        if (!row) {
          return { success: false, error: `File ${p} not found`, renewedPaths: [] };
        }
        if (!row.lease_owner || row.lease_owner !== modelId) {
          return { success: false, error: `Cannot renew lease: File ${p} is not leased by ${modelId}. Active lease held by another model or not held: ${row.lease_owner || 'none'}`, renewedPaths: [] };
        }
        if (!row.lease_expires_at || row.lease_expires_at <= now) {
          return { success: false, error: `Cannot renew lease: Lease for file ${p} has already expired`, renewedPaths: [] };
        }
      }

      // 2. Perform database renewal
      const renewed: string[] = [];
      for (const p of sortedPaths) {
        const res = this.dbManager.db.prepare(`
          UPDATE project_files 
          SET lease_expires_at = ?, updated_at = ?
          WHERE build_id = ? AND path = ? AND lease_owner = ? AND lease_expires_at > ?
        `).run(expiry, now, buildId, p, modelId, now);

        if (res.changes > 0) {
          renewed.push(p);
        }
      }

      // Ensure all requested leases were renewed or abort transaction completely
      if (renewed.length !== sortedPaths.length) {
        return { success: false, error: `Partial renewal failure: renewed ${renewed.length}/${sortedPaths.length} files`, renewedPaths: [] };
      }

      // 3. Update in-memory cache post-commit
      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        for (const p of renewed) {
          const file = this.getFile(buildId, p);
          if (file) {
            file.leaseExpiresAt = expiry;
          }
        }
      });

      return { success: true, renewedPaths: renewed };
    });
  }

  releaseFileLeasesAtomic(
    buildId: string,
    modelId: string,
    filePaths: string[]
  ): { success: boolean; error?: string; releasedPaths: string[] } {
    if (!buildId || !modelId || !filePaths) {
      return { success: false, error: 'buildId, modelId, and filePaths are required', releasedPaths: [] };
    }
    const now = this.getTime();
    const sortedPaths = [...new Set(filePaths)].sort();

    return this.dbManager.transaction(() => {
      // Pass 1: Strict validation of ALL requested files before making any mutations
      for (const p of sortedPaths) {
        const row = this.dbManager.db.prepare(
          'SELECT lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
        ).get(buildId, p) as any;

        if (!row) continue;

        // If active lease is held by another model, reject release
        if (row.lease_owner && row.lease_owner !== modelId && (!row.lease_expires_at || row.lease_expires_at > now)) {
          return {
            success: false,
            error: `Cannot release lease on ${p}: Active lease is held by ${row.lease_owner}, not ${modelId}`,
            releasedPaths: []
          };
        }

        if (row.lease_owner !== modelId) {
          return {
            success: false,
            error: `Cannot release lease on ${p}: Lease is not held by ${modelId}`,
            releasedPaths: []
          };
        }
      }

      // Pass 2: Database updates
      const releasedPaths: string[] = [];
      for (const p of sortedPaths) {
        const res = this.dbManager.db.prepare(`
          UPDATE project_files 
          SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE build_id = ? AND path = ? AND lease_owner = ?
        `).run(now, buildId, p, modelId);

        if (res.changes > 0) {
          releasedPaths.push(p);
        }
      }

      // Pass 3: In-memory cache update strictly after database updates commit
      this.dbManager.onPostRollback(() => {
        this.resyncFilesMapFromDb(buildId);
      });

      this.dbManager.onPostCommit(() => {
        for (const p of releasedPaths) {
          const file = this.getFile(buildId, p);
          if (file) {
            file.leaseOwner = null;
            file.leaseExpiresAt = null;
          }
        }
      });

      return { success: true, releasedPaths };
    });
  }

  getFileLease(buildId: string, filePath: string): { modelId: string; expiresAt: number } | null {
    const now = this.getTime();
    const file = this.getFile(buildId, filePath);
    if (file && file.leaseOwner && file.leaseExpiresAt && file.leaseExpiresAt > now) {
      return { modelId: file.leaseOwner, expiresAt: file.leaseExpiresAt };
    }
    try {
      const row = this.dbManager.db.prepare(
        'SELECT lease_owner, lease_expires_at FROM project_files WHERE build_id = ? AND path = ?'
      ).get(buildId, filePath) as any;
      if (row && row.lease_owner && row.lease_expires_at && row.lease_expires_at > now) {
        return { modelId: row.lease_owner, expiresAt: row.lease_expires_at };
      }
    } catch {}
    return null;
  }

  // --- Events ---

  getEvents(buildId: string): SwarmEvent[] {
    return this.events.get(buildId) || [];
  }

  addEvent(event: SwarmEvent): SwarmEvent {
    let list = this.events.get(event.buildId);
    if (!list) {
      list = [];
      this.events.set(event.buildId, list);
    }
    list.push(event);
    this.broadcast(event.buildId, 'event_added', event);

    try {
      this.dbManager.db.prepare(`
        INSERT INTO swarm_events (id, build_id, timestamp, type, model_id, task_id, file_path, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, event.buildId, event.timestamp, event.type,
        event.modelId || null, event.taskId || null, event.filePath || null, event.details
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addEvent', err);
    }

    return event;
  }

  // --- Model Runs ---

  getModelRun(buildId: string, modelId: string): ModelRunStatus | undefined {
    let map = this.modelRuns.get(buildId);
    if (!map) return undefined;
    return map.get(modelId);
  }

  getAllModelRuns(buildId: string): ModelRunStatus[] {
    const map = this.modelRuns.get(buildId);
    if (!map) return [];
    return Array.from(map.values());
  }

  updateModelRun(buildId: string, modelId: string, updates: Partial<ModelRunStatus>): ModelRunStatus {
    let map = this.modelRuns.get(buildId);
    if (!map) {
      map = new Map();
      this.modelRuns.set(buildId, map);
    }
    const current = map.get(modelId) || {
      modelId,
      status: 'idle',
      currentTaskId: null,
      patchesApplied: 0,
      patchesRejected: 0,
      tokensUsed: 0,
      estimatedCost: 0,
      lastActive: this.getTime()
    };
    const updated = { ...current, ...updates, lastActive: this.getTime() };
    map.set(modelId, updated);
    this.broadcast(buildId, 'model_run_updated', updated);

    try {
      const runId = `${buildId}:${modelId}`;
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO model_runs (
          id, build_id, model_id, status, role, current_task_id,
          tokens_used, estimated_cost, patches_applied, patches_rejected,
          last_action_summary, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId, buildId, modelId, updated.status, updated.role || null,
        updated.currentTaskId || null, updated.tokensUsed, updated.estimatedCost,
        updated.patchesApplied, updated.patchesRejected, updated.lastActionSummary || null,
        updated.error || null
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('updateModelRun', err);
    }

    return updated;
  }

  // --- Checkpoints ---

  getCheckpoints(buildId: string): Checkpoint[] {
    return this.checkpoints.get(buildId) || [];
  }

  addCheckpoint(checkpoint: Checkpoint): Checkpoint {
    let list = this.checkpoints.get(checkpoint.buildId);
    if (!list) {
      list = [];
      this.checkpoints.set(checkpoint.buildId, list);
    }
    list.push(checkpoint);
    this.broadcast(checkpoint.buildId, 'checkpoint_saved', checkpoint);

    try {
      this.dbManager.db.prepare(`
        INSERT INTO checkpoints (id, build_id, timestamp, description, snapshot)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        checkpoint.id, checkpoint.buildId, checkpoint.timestamp, checkpoint.description,
        JSON.stringify(checkpoint.filesSnapshot || {})
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addCheckpoint', err);
    }

    return checkpoint;
  }

  getLatestCheckpoint(buildId: string): Checkpoint | undefined {
    const list = this.getCheckpoints(buildId);
    return list[list.length - 1];
  }

  // --- Usage Logging & Dashboard Aggregation ---

  addUsageLog(entry: UsageLogEntry): void {
    this.usageLogs.push(entry);
    if (this.usageLogs.length > 5000) {
      this.usageLogs = this.usageLogs.slice(-4000);
    }
    this.broadcast(entry.buildId, 'usage_logged', entry);

    if (entry.userId && !this.users.has(entry.userId)) {
      this.saveUser({
        id: entry.userId,
        email: `${entry.userId}@squadforge.internal`,
        name: entry.userId,
        githubConnected: false,
        costLimitPerBuild: 5.0,
        enabledModelIds: [],
        createdAt: this.getTime()
      });
    }

    try {
      this.dbManager.db.prepare(`
        INSERT INTO usage_logs (
          id, user_id, build_id, timestamp, requested_model_id, actual_model_used,
          provider_used, input_tokens, output_tokens, total_tokens, estimated_cost,
          task_complexity, is_fallback, cached, latency_ms, success, task_id, task_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id, entry.userId, entry.buildId || null, entry.timestamp,
        entry.requestedModelId || entry.modelId, entry.actualModelUsed || entry.modelId,
        entry.provider || 'gemini', entry.inputTokens || 0, entry.outputTokens || 0,
        entry.totalTokens, entry.estimatedCost, entry.taskComplexity || 'standard',
        entry.isFallback ? 1 : 0, entry.cached ? 1 : 0, entry.latencyMs || 0,
        entry.success ? 1 : 0, entry.taskId || null, entry.taskTitle || null
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addUsageLog', err);
    }
  }

  // --- Audit Logging ---

  addAuditLog(entry: { userId?: string; eventType: string; ip?: string; userAgent?: string; details: string }): void {
    const id = `aud_${this.getTime()}_${Math.random().toString(36).substring(2, 7)}`;
    try {
      this.dbManager.db.prepare(`
        INSERT INTO audit_logs (id, user_id, event_type, ip, user_agent, details, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, entry.userId || null, entry.eventType, entry.ip || null,
        entry.userAgent || null, entry.details, this.getTime()
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addAuditLog', err);
    }
  }

  getUsageLogs(userId?: string, buildId?: string, limit: number = 100): UsageLogEntry[] {
    let logs = this.usageLogs;
    if (userId) {
      logs = logs.filter(l => l.userId === userId || l.userId === 'system');
    }
    if (buildId) {
      logs = logs.filter(l => l.buildId === buildId);
    }
    return logs.slice(-limit).reverse();
  }

  getAggregatedUsageStats(userId?: string, buildId?: string): SwarmUsageStats {
    let logs = this.usageLogs;
    if (userId) {
      logs = logs.filter(l => l.userId === userId || l.userId === 'system');
    }
    if (buildId) {
      logs = logs.filter(l => l.buildId === buildId);
    }

    let totalRequests = logs.length;
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalEstimatedTokens = 0;
    let totalActualTokens = 0;
    let totalEstimatedCost = 0;
    let totalBilledCost = 0;

    const providerStats: SwarmUsageStats['providerStats'] = {};
    const modelStats: SwarmUsageStats['modelStats'] = {};

    const agentStats: SwarmUsageStats['agentStats'] = {} as any;
    const allAgents = modelRegistry.getAgentSpecs();
    for (const [role] of Object.entries(allAgents)) {
      agentStats[role as any] = {
        role: role as any,
        requests: 0,
        tokens: 0,
        tasksCompleted: 0,
        estimatedCost: 0
      };
    }

    for (const log of logs) {
      if (log.success) successfulRequests++;
      else failedRequests++;

      totalEstimatedTokens += log.estimatedTokens || log.totalTokens || 0;
      totalActualTokens += log.totalTokens || 0;
      totalEstimatedCost += log.estimatedCost || 0;
      totalBilledCost += log.billedCost || 0;

      const p = log.provider || 'other';
      if (!providerStats[p]) {
        providerStats[p] = {
          requests: 0,
          tokens: 0,
          errors: 0,
          estimatedCost: 0,
          billedCost: 0,
          status: 'healthy'
        };
      }
      providerStats[p].requests++;
      providerStats[p].tokens += log.totalTokens || 0;
      providerStats[p].estimatedCost += log.estimatedCost || 0;
      providerStats[p].billedCost += log.billedCost || 0;
      if (!log.success) providerStats[p].errors++;

      const mId = log.requestedModelId || log.modelId;
      if (!modelStats[mId]) {
        const cfg = modelRegistry.getById(mId);
        modelStats[mId] = {
          modelId: mId,
          displayName: cfg?.displayName || mId,
          requests: 0,
          tokens: 0,
          errors: 0,
          estimatedCost: 0,
          fallbackCount: 0
        };
      }
      modelStats[mId].requests++;
      modelStats[mId].tokens += log.totalTokens || 0;
      modelStats[mId].estimatedCost += log.estimatedCost || 0;
      if (!log.success) modelStats[mId].errors++;
      if (log.isFallback) modelStats[mId].fallbackCount++;

      if (log.agentRole && agentStats[log.agentRole]) {
        agentStats[log.agentRole].requests++;
      }
    }

    const allQuotas = quotaManager.getAllStatuses();
    for (const [, pVal] of Object.entries(allQuotas)) {
      if (providerStats[pVal.provider]) {
        providerStats[pVal.provider].status = pVal.status;
      }
    }

    const taskStats: SwarmUsageStats['taskStats'] = [];
    if (buildId) {
      const buildTasks = this.getTasks(buildId);
      for (const t of buildTasks) {
        taskStats.push({
          taskId: t.id,
          taskTitle: t.title,
          tokensUsed: t.actualTokensUsed || 0,
          cost: t.estimatedCost || 0,
          modelUsed: t.claimedBy || 'unassigned',
          status: t.status,
          isPaused: t.isPaused,
          pausedReason: t.pausedReason
        });

        if (t.assignedRole && agentStats[t.assignedRole]) {
          if (t.status === 'completed' || t.status === 'done') {
            agentStats[t.assignedRole].tasksCompleted++;
          }
          agentStats[t.assignedRole].tokens += t.actualTokensUsed || 0;
          agentStats[t.assignedRole].estimatedCost += t.estimatedCost || 0;
        }
      }
    }

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      totalEstimatedTokens,
      totalActualTokens,
      totalEstimatedCost,
      totalBilledCost,
      cacheStats: safeResultCache.getStats(),
      providerStats,
      modelStats,
      agentStats,
      taskStats,
      activeQuotas: allQuotas,
      localLLM: localLLMService.getConfig()
    };
  }

  public getProjectMemory(projectId: string): ProjectMemory | null {
    const cached = this.projectMemories.get(projectId);
    if (cached) return cached;

    try {
      const row = this.dbManager.db.prepare('SELECT memory_data FROM project_memories WHERE project_id = ?').get(projectId) as { memory_data: string } | undefined;
      if (row && row.memory_data) {
        try {
          const parsed = JSON.parse(row.memory_data);
          this.projectMemories.set(projectId, parsed);
          return parsed;
        } catch (parseErr) {
          console.warn(`[STORAGE] Corrupt project memory data for ${projectId}, recovering cleanly:`, parseErr);
          return null;
        }
      }
    } catch (err: any) {
      console.warn(`[STORAGE] Failed to query project memory for ${projectId}:`, err?.message);
    }
    return null;
  }

  public saveProjectMemory(memory: ProjectMemory): void {
    this.projectMemories.set(memory.projectId, memory);
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO project_memories (project_id, user_id, memory_data, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(memory.projectId, memory.userId, JSON.stringify(memory), memory.lastUpdated || Date.now());
    } catch (err: any) {
      this.handleDatabaseWriteError('saveProjectMemory', err);
    }
  }

  public deleteProjectMemory(projectId: string): void {
    this.projectMemories.delete(projectId);
    try {
      this.dbManager.db.prepare('DELETE FROM project_memories WHERE project_id = ?').run(projectId);
    } catch (err: any) {
      this.handleDatabaseWriteError('deleteProjectMemory', err);
    }
  }

  // =========================================================================
  // PHASE 8: COLLABORATIVE AGENT SWARM STORAGE & QUERY METHODS
  // =========================================================================

  // --- 1. Agent Collaboration Profiles ---
  public saveAgentProfile(profile: AgentProfile): AgentProfile {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO agent_collaboration_profiles (
          id, build_id, role, name, model_id, status, capabilities,
          responsibilities, assigned_task_ids, current_task_id,
          workload_score, collaboration_permissions, work_history,
          last_active, model_status, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        profile.id,
        profile.buildId,
        profile.role,
        profile.name,
        profile.modelId,
        profile.status,
        JSON.stringify(profile.capabilities || []),
        JSON.stringify(profile.responsibilities || []),
        JSON.stringify(profile.assignedTaskIds || []),
        profile.currentTaskId || null,
        profile.workloadScore || 0.0,
        JSON.stringify(profile.collaborationPermissions || []),
        JSON.stringify(profile.workHistory || []),
        profile.lastActive || Date.now(),
        profile.modelStatus || 'idle',
        profile.metadata ? JSON.stringify(profile.metadata) : null
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('saveAgentProfile', err);
    }
    return profile;
  }

  public getAgentProfiles(buildId: string): AgentProfile[] {
    try {
      const rows = this.dbManager.db.prepare(
        'SELECT * FROM agent_collaboration_profiles WHERE build_id = ? ORDER BY role ASC'
      ).all(buildId) as any[];

      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        role: r.role,
        name: r.name,
        modelId: r.model_id,
        status: r.status,
        capabilities: safeJsonParse<string[]>(r.capabilities, []),
        responsibilities: safeJsonParse<string[]>(r.responsibilities, []),
        assignedTaskIds: safeJsonParse<string[]>(r.assigned_task_ids, []),
        currentTaskId: r.current_task_id || null,
        workloadScore: r.workload_score || 0,
        collaborationPermissions: safeJsonParse<string[]>(r.collaboration_permissions, []),
        workHistory: safeJsonParse<any[]>(r.work_history, []),
        lastActive: r.last_active,
        modelStatus: r.model_status || 'idle',
        metadata: r.metadata ? safeJsonParse(r.metadata, undefined) : undefined
      }));
    } catch (err: any) {
      console.warn(`[STORAGE] getAgentProfiles error for ${buildId}:`, err?.message);
      return [];
    }
  }

  public getAgentProfile(buildId: string, roleOrId: string): AgentProfile | undefined {
    try {
      const row = this.dbManager.db.prepare(
        'SELECT * FROM agent_collaboration_profiles WHERE build_id = ? AND (id = ? OR role = ?) LIMIT 1'
      ).get(buildId, roleOrId, roleOrId) as any;

      if (!row) return undefined;
      return {
        id: row.id,
        buildId: row.build_id,
        role: row.role,
        name: row.name,
        modelId: row.model_id,
        status: row.status,
        capabilities: safeJsonParse<string[]>(row.capabilities, []),
        responsibilities: safeJsonParse<string[]>(row.responsibilities, []),
        assignedTaskIds: safeJsonParse<string[]>(row.assigned_task_ids, []),
        currentTaskId: row.current_task_id || null,
        workloadScore: row.workload_score || 0,
        collaborationPermissions: safeJsonParse<string[]>(row.collaboration_permissions, []),
        workHistory: safeJsonParse<any[]>(row.work_history, []),
        lastActive: row.last_active,
        modelStatus: row.model_status || 'idle',
        metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined
      };
    } catch (err: any) {
      console.warn('[STORAGE] getAgentProfile error:', err?.message);
      return undefined;
    }
  }

  public updateAgentStatus(buildId: string, roleOrId: string, status: AgentLifecycleState, summary?: string, taskId?: string): void {
    const existing = this.getAgentProfile(buildId, roleOrId);
    if (!existing) return;

    existing.status = status;
    existing.lastActive = this.getTime();
    if (taskId !== undefined) {
      existing.currentTaskId = taskId;
    }
    if (summary) {
      existing.workHistory = [
        {
          timestamp: existing.lastActive,
          action: `status_change:${status}`,
          details: summary,
          taskId: existing.currentTaskId || undefined
        },
        ...(existing.workHistory || []).slice(0, 24)
      ];
    }
    this.saveAgentProfile(existing);
  }

  // --- 2. Agent Messages ---
  public saveAgentMessage(msg: AgentMessage): AgentMessage {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO agent_messages (
          id, build_id, project_id, sender, sender_role, recipient,
          related_task_id, related_files, relevant_file_versions,
          message_type, content, structured_metadata, parent_message_id,
          depth, timestamp, processing_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msg.id,
        msg.buildId,
        msg.projectId,
        msg.sender,
        msg.senderRole,
        msg.recipient || 'broadcast',
        msg.relatedTaskId || null,
        JSON.stringify(msg.relatedFiles || []),
        msg.relevantFileVersions ? JSON.stringify(msg.relevantFileVersions) : null,
        msg.messageType,
        msg.content,
        msg.structuredMetadata ? JSON.stringify(msg.structuredMetadata) : null,
        msg.parentMessageId || null,
        msg.depth || 0,
        msg.timestamp || this.getTime(),
        msg.processingStatus || 'delivered'
      );

      this.broadcast(msg.buildId, 'agent_message', msg);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveAgentMessage', err);
    }
    return msg;
  }

  public getAgentMessages(
    buildId: string, 
    options?: { messageType?: string; sender?: string; taskId?: string; search?: string; limit?: number; offset?: number }
  ): { messages: AgentMessage[]; total: number } {
    try {
      let query = 'SELECT * FROM agent_messages WHERE build_id = ?';
      const params: any[] = [buildId];

      if (options?.messageType) {
        query += ' AND message_type = ?';
        params.push(options.messageType);
      }
      if (options?.sender) {
        query += ' AND (sender = ? OR sender_role = ?)';
        params.push(options.sender, options.sender);
      }
      if (options?.taskId) {
        query += ' AND related_task_id = ?';
        params.push(options.taskId);
      }
      if (options?.search) {
        query += ' AND content LIKE ?';
        params.push(`%${options.search}%`);
      }

      // Count total
      const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as total');
      const countRow = this.dbManager.db.prepare(countQuery).get(...params) as { total: number };
      const total = countRow?.total || 0;

      query += ' ORDER BY timestamp DESC';
      if (options?.limit) {
        query += ' LIMIT ? OFFSET ?';
        params.push(options.limit, options.offset || 0);
      }

      const rows = this.dbManager.db.prepare(query).all(...params) as any[];
      const messages: AgentMessage[] = rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        projectId: r.project_id,
        sender: r.sender,
        senderRole: r.sender_role,
        recipient: r.recipient,
        relatedTaskId: r.related_task_id || undefined,
        relatedFiles: safeJsonParse<string[]>(r.related_files, []),
        relevantFileVersions: r.relevant_file_versions ? safeJsonParse(r.relevant_file_versions, undefined) : undefined,
        messageType: r.message_type,
        content: r.content,
        structuredMetadata: r.structured_metadata ? safeJsonParse(r.structured_metadata, undefined) : undefined,
        parentMessageId: r.parent_message_id || undefined,
        depth: r.depth || 0,
        timestamp: r.timestamp,
        processingStatus: r.processing_status
      }));

      return { messages, total };
    } catch (err: any) {
      console.warn(`[STORAGE] getAgentMessages error:`, err?.message);
      return { messages: [], total: 0 };
    }
  }

  public getAgentMessage(id: string): AgentMessage | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        projectId: r.project_id,
        sender: r.sender,
        senderRole: r.sender_role,
        recipient: r.recipient,
        relatedTaskId: r.related_task_id || undefined,
        relatedFiles: safeJsonParse<string[]>(r.related_files, []),
        relevantFileVersions: r.relevant_file_versions ? safeJsonParse(r.relevant_file_versions, undefined) : undefined,
        messageType: r.message_type,
        content: r.content,
        structuredMetadata: r.structured_metadata ? safeJsonParse(r.structured_metadata, undefined) : undefined,
        parentMessageId: r.parent_message_id || undefined,
        depth: r.depth || 0,
        timestamp: r.timestamp,
        processingStatus: r.processing_status
      };
    } catch {
      return undefined;
    }
  }

  // --- 3. Code Reviews ---
  public saveCodeReview(review: CodeReview): CodeReview {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO code_reviews (
          id, build_id, task_id, patch_id, author_agent, author_role,
          reviewer_agent, reviewer_role, changed_files, base_versions,
          proposed_changes, requirements_addressed, implementation_explanation,
          test_evidence, verdict, status, review_checks, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        review.id,
        review.buildId,
        review.taskId,
        review.patchId || null,
        review.authorAgent,
        review.authorRole,
        review.reviewerAgent,
        review.reviewerRole,
        JSON.stringify(review.changedFiles || []),
        JSON.stringify(review.baseVersions || {}),
        JSON.stringify(review.proposedChanges || []),
        JSON.stringify(review.requirementsAddressed || []),
        review.implementationExplanation,
        review.testEvidence,
        review.verdict,
        review.status,
        JSON.stringify(review.reviewChecks || {}),
        review.createdAt,
        review.updatedAt || review.createdAt
      );

      // Persist any included comments
      if (Array.isArray(review.comments) && review.comments.length > 0) {
        for (const comment of review.comments) {
          this.addReviewComment(comment);
        }
      }

      this.broadcast(review.buildId, 'code_review_updated', review);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveCodeReview', err);
    }
    return review;
  }

  public getCodeReviews(
    buildId: string, 
    options?: { taskId?: string; status?: string; limit?: number; offset?: number }
  ): { reviews: CodeReview[]; total: number } {
    try {
      let query = 'SELECT * FROM code_reviews WHERE build_id = ?';
      const params: any[] = [buildId];

      if (options?.taskId) {
        query += ' AND task_id = ?';
        params.push(options.taskId);
      }
      if (options?.status) {
        query += ' AND status = ?';
        params.push(options.status);
      }

      const countRow = this.dbManager.db.prepare(query.replace('SELECT *', 'SELECT COUNT(*) as total')).get(...params) as { total: number };
      const total = countRow?.total || 0;

      query += ' ORDER BY created_at DESC';
      if (options?.limit) {
        query += ' LIMIT ? OFFSET ?';
        params.push(options.limit, options.offset || 0);
      }

      const rows = this.dbManager.db.prepare(query).all(...params) as any[];
      const reviews: CodeReview[] = rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id,
        patchId: r.patch_id || undefined,
        authorAgent: r.author_agent,
        authorRole: r.author_role,
        reviewerAgent: r.reviewer_agent,
        reviewerRole: r.reviewer_role,
        changedFiles: safeJsonParse<string[]>(r.changed_files, []),
        baseVersions: safeJsonParse<Record<string, number>>(r.base_versions, {}),
        proposedChanges: safeJsonParse<any[]>(r.proposed_changes, []),
        requirementsAddressed: safeJsonParse<string[]>(r.requirements_addressed, []),
        implementationExplanation: r.implementation_explanation,
        testEvidence: r.test_evidence,
        verdict: r.verdict,
        status: r.status,
        reviewChecks: safeJsonParse<any>(r.review_checks, {
          logicCorrectness: true,
          errorHandling: true,
          security: true,
          inputValidation: true,
          apiCompatibility: true,
          databaseIntegrity: true,
          performance: true,
          maintainability: true,
          architectureConsistency: true,
          dependencyRisks: true,
          testCoverage: true,
          requirementCompliance: true
        }),
        comments: this.getReviewComments(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));

      return { reviews, total };
    } catch {
      return { reviews: [], total: 0 };
    }
  }

  public getCodeReview(id: string): CodeReview | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM code_reviews WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id,
        patchId: r.patch_id || undefined,
        authorAgent: r.author_agent,
        authorRole: r.author_role,
        reviewerAgent: r.reviewer_agent,
        reviewerRole: r.reviewer_role,
        changedFiles: safeJsonParse<string[]>(r.changed_files, []),
        baseVersions: safeJsonParse<Record<string, number>>(r.base_versions, {}),
        proposedChanges: safeJsonParse<any[]>(r.proposed_changes, []),
        requirementsAddressed: safeJsonParse<string[]>(r.requirements_addressed, []),
        implementationExplanation: r.implementation_explanation,
        testEvidence: r.test_evidence,
        verdict: r.verdict,
        status: r.status,
        reviewChecks: safeJsonParse<any>(r.review_checks, {}),
        comments: this.getReviewComments(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    } catch {
      return undefined;
    }
  }

  public updateCodeReview(id: string, updates: Partial<CodeReview>): CodeReview | undefined {
    const existing = this.getCodeReview(id);
    if (!existing) return undefined;

    const merged: CodeReview = {
      ...existing,
      ...updates,
      updatedAt: this.getTime()
    };
    return this.saveCodeReview(merged);
  }

  public addReviewComment(comment: CodeReviewComment): CodeReviewComment {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO code_review_comments (
          id, review_id, build_id, file_path, start_line, end_line,
          severity, explanation, suggested_correction, related_requirement,
          status, author, author_role, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        comment.id,
        comment.reviewId,
        comment.buildId,
        comment.filePath,
        comment.startLine,
        comment.endLine,
        comment.severity,
        comment.explanation,
        comment.suggestedCorrection || null,
        comment.relatedRequirement || null,
        comment.status || 'open',
        comment.author,
        comment.authorRole,
        comment.timestamp || this.getTime()
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addReviewComment', err);
    }
    return comment;
  }

  public getReviewComments(reviewId: string): CodeReviewComment[] {
    try {
      const rows = this.dbManager.db.prepare(
        'SELECT * FROM code_review_comments WHERE review_id = ? ORDER BY start_line ASC'
      ).all(reviewId) as any[];

      return rows.map(r => ({
        id: r.id,
        reviewId: r.review_id,
        buildId: r.build_id,
        filePath: r.file_path,
        startLine: r.start_line,
        endLine: r.end_line,
        severity: r.severity,
        explanation: r.explanation,
        suggestedCorrection: r.suggested_correction || undefined,
        relatedRequirement: r.related_requirement || undefined,
        status: r.status,
        author: r.author,
        authorRole: r.author_role,
        timestamp: r.timestamp
      }));
    } catch {
      return [];
    }
  }

  public updateReviewComment(commentId: string, updates: Partial<CodeReviewComment>): CodeReviewComment | undefined {
    try {
      const row = this.dbManager.db.prepare('SELECT * FROM code_review_comments WHERE id = ?').get(commentId) as any;
      if (!row) return undefined;

      const updated: CodeReviewComment = {
        id: row.id,
        reviewId: row.review_id,
        buildId: row.build_id,
        filePath: updates.filePath || row.file_path,
        startLine: updates.startLine !== undefined ? updates.startLine : row.start_line,
        endLine: updates.endLine !== undefined ? updates.endLine : row.end_line,
        severity: updates.severity || row.severity,
        explanation: updates.explanation || row.explanation,
        suggestedCorrection: updates.suggestedCorrection !== undefined ? updates.suggestedCorrection : (row.suggested_correction || undefined),
        relatedRequirement: updates.relatedRequirement !== undefined ? updates.relatedRequirement : (row.related_requirement || undefined),
        status: updates.status || row.status,
        author: row.author,
        authorRole: row.author_role,
        timestamp: row.timestamp
      };

      this.addReviewComment(updated);
      return updated;
    } catch {
      return undefined;
    }
  }

  // --- 4. Patch Proposals ---
  public savePatchProposal(patch: PatchProposal): PatchProposal {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO patch_proposals (
          id, build_id, author_agent, author_role, related_task_id,
          target_file, base_file_version, base_content_hash, proposed_changes,
          change_explanation, expected_behavior, validation_results,
          review_status, application_status, applied_file_version,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        patch.id,
        patch.buildId,
        patch.authorAgent,
        patch.authorRole,
        patch.relatedTaskId,
        patch.targetFile,
        patch.baseFileVersion,
        patch.baseContentHash,
        JSON.stringify(patch.proposedChanges || {}),
        patch.changeExplanation,
        patch.expectedBehavior,
        JSON.stringify(patch.validationResults || {}),
        patch.reviewStatus,
        patch.applicationStatus,
        patch.appliedFileVersion || null,
        patch.createdAt,
        patch.updatedAt || patch.createdAt
      );

      this.broadcast(patch.buildId, 'patch_proposal_updated', patch);
    } catch (err: any) {
      this.handleDatabaseWriteError('savePatchProposal', err);
    }
    return patch;
  }

  public getPatchProposals(buildId: string, options?: { targetFile?: string; status?: string }): PatchProposal[] {
    try {
      let query = 'SELECT * FROM patch_proposals WHERE build_id = ?';
      const params: any[] = [buildId];

      if (options?.targetFile) {
        query += ' AND target_file = ?';
        params.push(options.targetFile);
      }
      if (options?.status) {
        query += ' AND application_status = ?';
        params.push(options.status);
      }

      query += ' ORDER BY created_at DESC';
      const rows = this.dbManager.db.prepare(query).all(...params) as any[];

      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        authorAgent: r.author_agent,
        authorRole: r.author_role,
        relatedTaskId: r.related_task_id,
        targetFile: r.target_file,
        baseFileVersion: r.base_file_version,
        baseContentHash: r.base_content_hash,
        proposedChanges: safeJsonParse<any>(r.proposed_changes, { actionType: 'patch' }),
        changeExplanation: r.change_explanation,
        expectedBehavior: r.expected_behavior,
        validationResults: safeJsonParse<any>(r.validation_results, {
          syntaxValid: true,
          pathAllowed: true,
          hashMatched: true,
          versionCurrent: true,
          errors: []
        }),
        reviewStatus: r.review_status,
        applicationStatus: r.application_status,
        appliedFileVersion: r.applied_file_version || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
    } catch {
      return [];
    }
  }

  public getPatchProposal(id: string): PatchProposal | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM patch_proposals WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        authorAgent: r.author_agent,
        authorRole: r.author_role,
        relatedTaskId: r.related_task_id,
        targetFile: r.target_file,
        baseFileVersion: r.base_file_version,
        baseContentHash: r.base_content_hash,
        proposedChanges: safeJsonParse<any>(r.proposed_changes, { actionType: 'patch' }),
        changeExplanation: r.change_explanation,
        expectedBehavior: r.expected_behavior,
        validationResults: safeJsonParse<any>(r.validation_results, {
          syntaxValid: true,
          pathAllowed: true,
          hashMatched: true,
          versionCurrent: true,
          errors: []
        }),
        reviewStatus: r.review_status,
        applicationStatus: r.application_status,
        appliedFileVersion: r.applied_file_version || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    } catch {
      return undefined;
    }
  }

  public updatePatchProposal(id: string, updates: Partial<PatchProposal>): PatchProposal | undefined {
    const existing = this.getPatchProposal(id);
    if (!existing) return undefined;

    const merged: PatchProposal = {
      ...existing,
      ...updates,
      updatedAt: this.getTime()
    };
    return this.savePatchProposal(merged);
  }

  // --- 5. File Conflicts ---
  public saveFileConflict(conflict: FileConflict): FileConflict {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO file_conflicts (
          id, build_id, file_path, base_version, conflicting_versions,
          competing_patches, reason, overlapping_hunks, resolution_status,
          resolved_by, resolved_content, resolved_version, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conflict.id,
        conflict.buildId,
        conflict.filePath,
        conflict.baseVersion,
        JSON.stringify(conflict.conflictingVersions || []),
        JSON.stringify(conflict.competingPatches || []),
        conflict.reason,
        JSON.stringify(conflict.overlappingHunks || []),
        conflict.resolutionStatus,
        conflict.resolvedBy || null,
        conflict.resolvedContent || null,
        conflict.resolvedVersion || null,
        conflict.createdAt,
        conflict.resolvedAt || null
      );

      this.broadcast(conflict.buildId, 'file_conflict_updated', conflict);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveFileConflict', err);
    }
    return conflict;
  }

  public getFileConflicts(buildId: string, status?: string): FileConflict[] {
    try {
      let query = 'SELECT * FROM file_conflicts WHERE build_id = ?';
      const params: any[] = [buildId];

      if (status) {
        query += ' AND resolution_status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC';

      const rows = this.dbManager.db.prepare(query).all(...params) as any[];
      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        filePath: r.file_path,
        baseVersion: r.base_version,
        conflictingVersions: safeJsonParse<number[]>(r.conflicting_versions, []),
        competingPatches: safeJsonParse<any[]>(r.competing_patches, []),
        reason: r.reason,
        overlappingHunks: safeJsonParse<any[]>(r.overlapping_hunks, []),
        resolutionStatus: r.resolution_status,
        resolvedBy: r.resolved_by || undefined,
        resolvedContent: r.resolved_content || undefined,
        resolvedVersion: r.resolved_version || undefined,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at || undefined
      }));
    } catch {
      return [];
    }
  }

  public getFileConflict(id: string): FileConflict | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM file_conflicts WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        filePath: r.file_path,
        baseVersion: r.base_version,
        conflictingVersions: safeJsonParse<number[]>(r.conflicting_versions, []),
        competingPatches: safeJsonParse<any[]>(r.competing_patches, []),
        reason: r.reason,
        overlappingHunks: safeJsonParse<any[]>(r.overlapping_hunks, []),
        resolutionStatus: r.resolution_status,
        resolvedBy: r.resolved_by || undefined,
        resolvedContent: r.resolved_content || undefined,
        resolvedVersion: r.resolved_version || undefined,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at || undefined
      };
    } catch {
      return undefined;
    }
  }

  public updateFileConflict(id: string, updates: Partial<FileConflict>): FileConflict | undefined {
    const existing = this.getFileConflict(id);
    if (!existing) return undefined;

    const merged: FileConflict = {
      ...existing,
      ...updates
    };
    return this.saveFileConflict(merged);
  }

  // --- 6. AI Challenges ---
  public saveAIChallenge(challenge: AIChallenge): AIChallenge {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO ai_challenges (
          id, build_id, task_id, subject, original_proposal,
          proposer_agent, proposer_role, challenger_agent, challenger_role,
          current_round, max_rounds, status, outcome, final_decision,
          decision_rationale, participants, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        challenge.id,
        challenge.buildId,
        challenge.taskId || null,
        challenge.subject,
        challenge.originalProposal,
        challenge.proposerAgent,
        challenge.proposerRole,
        challenge.challengerAgent,
        challenge.challengerRole,
        challenge.currentRound || 1,
        challenge.maxRounds || 3,
        challenge.status || 'active',
        challenge.outcome || 'pending',
        challenge.finalDecision || null,
        challenge.decisionRationale || null,
        JSON.stringify(challenge.participants || []),
        challenge.createdAt,
        challenge.updatedAt || challenge.createdAt
      );

      // Save arguments
      if (Array.isArray(challenge.arguments)) {
        for (const arg of challenge.arguments) {
          this.addChallengeArgument(arg);
        }
      }

      this.broadcast(challenge.buildId, 'ai_challenge_updated', challenge);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveAIChallenge', err);
    }
    return challenge;
  }

  public getAIChallenges(buildId: string): AIChallenge[] {
    try {
      const rows = this.dbManager.db.prepare(
        'SELECT * FROM ai_challenges WHERE build_id = ? ORDER BY created_at DESC'
      ).all(buildId) as any[];

      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        subject: r.subject,
        originalProposal: r.original_proposal,
        proposerAgent: r.proposer_agent,
        proposerRole: r.proposer_role,
        challengerAgent: r.challenger_agent,
        challengerRole: r.challenger_role,
        currentRound: r.current_round,
        maxRounds: r.max_rounds,
        status: r.status,
        outcome: r.outcome,
        finalDecision: r.final_decision || undefined,
        decisionRationale: r.decision_rationale || undefined,
        participants: safeJsonParse<string[]>(r.participants, []),
        arguments: this.getChallengeArguments(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
    } catch {
      return [];
    }
  }

  public getAIChallenge(id: string): AIChallenge | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM ai_challenges WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        subject: r.subject,
        originalProposal: r.original_proposal,
        proposerAgent: r.proposer_agent,
        proposerRole: r.proposer_role,
        challengerAgent: r.challenger_agent,
        challengerRole: r.challenger_role,
        currentRound: r.current_round,
        maxRounds: r.max_rounds,
        status: r.status,
        outcome: r.outcome,
        finalDecision: r.final_decision || undefined,
        decisionRationale: r.decision_rationale || undefined,
        participants: safeJsonParse<string[]>(r.participants, []),
        arguments: this.getChallengeArguments(r.id),
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    } catch {
      return undefined;
    }
  }

  public updateAIChallenge(id: string, updates: Partial<AIChallenge>): AIChallenge | undefined {
    const existing = this.getAIChallenge(id);
    if (!existing) return undefined;

    const merged: AIChallenge = {
      ...existing,
      ...updates,
      updatedAt: this.getTime()
    };
    return this.saveAIChallenge(merged);
  }

  public addChallengeArgument(arg: AIChallengeArgument): AIChallengeArgument {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO ai_challenge_arguments (
          id, challenge_id, build_id, round_number, author_agent,
          author_role, argument_type, claim, evidence, proposed_alternative,
          identified_risks, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        arg.id,
        arg.challengeId,
        (arg as any).buildId || this.getAIChallenge(arg.challengeId)?.buildId || '',
        arg.roundNumber,
        arg.authorAgent,
        arg.authorRole,
        arg.argumentType,
        arg.claim,
        arg.evidence,
        arg.proposedAlternative || null,
        JSON.stringify(arg.identifiedRisks || []),
        arg.timestamp || this.getTime()
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('addChallengeArgument', err);
    }
    return arg;
  }

  public getChallengeArguments(challengeId: string): AIChallengeArgument[] {
    try {
      const rows = this.dbManager.db.prepare(
        'SELECT * FROM ai_challenge_arguments WHERE challenge_id = ? ORDER BY round_number ASC, timestamp ASC'
      ).all(challengeId) as any[];

      return rows.map(r => ({
        id: r.id,
        challengeId: r.challenge_id,
        roundNumber: r.round_number,
        authorAgent: r.author_agent,
        authorRole: r.author_role,
        argumentType: r.argument_type,
        claim: r.claim,
        evidence: r.evidence,
        proposedAlternative: r.proposed_alternative || undefined,
        identifiedRisks: safeJsonParse<string[]>(r.identified_risks, []),
        timestamp: r.timestamp
      }));
    } catch {
      return [];
    }
  }

  // --- 7. Collaborative Defects ---
  public saveDefect(defect: CollaborativeDefect): CollaborativeDefect {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO collaborative_defects (
          id, build_id, task_id, title, description, severity, status,
          reproduction_steps, expected_behavior, actual_behavior,
          affected_files, assigned_agents, root_cause, proposed_solutions,
          selected_patch_id, test_evidence, verification_details,
          created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        defect.id,
        defect.buildId,
        defect.taskId || null,
        defect.title,
        defect.description,
        defect.severity,
        defect.status,
        JSON.stringify(defect.reproductionSteps || []),
        defect.expectedBehavior,
        defect.actualBehavior,
        JSON.stringify(defect.affectedFiles || []),
        JSON.stringify(defect.assignedAgents || []),
        defect.rootCause || null,
        JSON.stringify(defect.proposedSolutions || []),
        defect.selectedPatchId || null,
        defect.testEvidence || null,
        defect.verificationDetails ? JSON.stringify(defect.verificationDetails) : null,
        defect.createdAt,
        defect.updatedAt || defect.createdAt,
        defect.resolvedAt || null
      );

      this.broadcast(defect.buildId, 'defect_updated', defect);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveDefect', err);
    }
    return defect;
  }

  public getDefects(buildId: string, options?: { status?: string; severity?: string }): CollaborativeDefect[] {
    try {
      let query = 'SELECT * FROM collaborative_defects WHERE build_id = ?';
      const params: any[] = [buildId];

      if (options?.status) {
        query += ' AND status = ?';
        params.push(options.status);
      }
      if (options?.severity) {
        query += ' AND severity = ?';
        params.push(options.severity);
      }
      query += ' ORDER BY created_at DESC';

      const rows = this.dbManager.db.prepare(query).all(...params) as any[];
      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        title: r.title,
        description: r.description,
        severity: r.severity,
        status: r.status,
        reproductionSteps: safeJsonParse<string[]>(r.reproduction_steps, []),
        expectedBehavior: r.expected_behavior,
        actualBehavior: r.actual_behavior,
        affectedFiles: safeJsonParse<string[]>(r.affected_files, []),
        assignedAgents: safeJsonParse<string[]>(r.assigned_agents, []),
        rootCause: r.root_cause || undefined,
        proposedSolutions: safeJsonParse<any[]>(r.proposed_solutions, []),
        selectedPatchId: r.selected_patch_id || undefined,
        testEvidence: r.test_evidence || undefined,
        verificationDetails: r.verification_details ? safeJsonParse(r.verification_details, undefined) : undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        resolvedAt: r.resolved_at || undefined
      }));
    } catch {
      return [];
    }
  }

  public getDefect(id: string): CollaborativeDefect | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM collaborative_defects WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        title: r.title,
        description: r.description,
        severity: r.severity,
        status: r.status,
        reproductionSteps: safeJsonParse<string[]>(r.reproduction_steps, []),
        expectedBehavior: r.expected_behavior,
        actualBehavior: r.actual_behavior,
        affectedFiles: safeJsonParse<string[]>(r.affected_files, []),
        assignedAgents: safeJsonParse<string[]>(r.assigned_agents, []),
        rootCause: r.root_cause || undefined,
        proposedSolutions: safeJsonParse<any[]>(r.proposed_solutions, []),
        selectedPatchId: r.selected_patch_id || undefined,
        testEvidence: r.test_evidence || undefined,
        verificationDetails: r.verification_details ? safeJsonParse(r.verification_details, undefined) : undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        resolvedAt: r.resolved_at || undefined
      };
    } catch {
      return undefined;
    }
  }

  public updateDefect(id: string, updates: Partial<CollaborativeDefect>): CollaborativeDefect | undefined {
    const existing = this.getDefect(id);
    if (!existing) return undefined;

    const merged: CollaborativeDefect = {
      ...existing,
      ...updates,
      updatedAt: this.getTime()
    };
    return this.saveDefect(merged);
  }

  // --- 8. Human Approval Requests ---
  public saveApprovalRequest(req: HumanApprovalRequest): HumanApprovalRequest {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO approval_requests (
          id, build_id, task_id, patch_id, requesting_agent, requesting_role,
          operation_type, explanation, risk_level, affected_files,
          proposed_changes, review_results, test_results, status,
          approved_by, resolution_notes, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.id,
        req.buildId,
        req.taskId || null,
        req.patchId || null,
        req.requestingAgent,
        req.requestingRole,
        req.operationType,
        req.explanation,
        req.riskLevel || 'medium',
        JSON.stringify(req.affectedFiles || []),
        req.proposedChanges,
        req.reviewResults || null,
        req.testResults || null,
        req.status || 'pending',
        req.approvedBy || null,
        req.resolutionNotes || null,
        req.createdAt,
        req.resolvedAt || null
      );

      this.broadcast(req.buildId, 'approval_request_updated', req);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveApprovalRequest', err);
    }
    return req;
  }

  public getApprovalRequests(buildId: string, status?: string): HumanApprovalRequest[] {
    try {
      let query = 'SELECT * FROM approval_requests WHERE build_id = ?';
      const params: any[] = [buildId];

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC';

      const rows = this.dbManager.db.prepare(query).all(...params) as any[];
      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        patchId: r.patch_id || undefined,
        requestingAgent: r.requesting_agent,
        requestingRole: r.requesting_role,
        operationType: r.operation_type,
        explanation: r.explanation,
        riskLevel: r.risk_level,
        affectedFiles: safeJsonParse<string[]>(r.affected_files, []),
        proposedChanges: r.proposed_changes,
        reviewResults: r.review_results || undefined,
        testResults: r.test_results || undefined,
        status: r.status,
        approvedBy: r.approved_by || undefined,
        resolutionNotes: r.resolution_notes || undefined,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at || undefined
      }));
    } catch {
      return [];
    }
  }

  public getApprovalRequest(id: string): HumanApprovalRequest | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        patchId: r.patch_id || undefined,
        requestingAgent: r.requesting_agent,
        requestingRole: r.requesting_role,
        operationType: r.operation_type,
        explanation: r.explanation,
        riskLevel: r.risk_level,
        affectedFiles: safeJsonParse<string[]>(r.affected_files, []),
        proposedChanges: r.proposed_changes,
        reviewResults: r.review_results || undefined,
        testResults: r.test_results || undefined,
        status: r.status,
        approvedBy: r.approved_by || undefined,
        resolutionNotes: r.resolution_notes || undefined,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at || undefined
      };
    } catch {
      return undefined;
    }
  }

  public updateApprovalRequest(id: string, updates: Partial<HumanApprovalRequest>): HumanApprovalRequest | undefined {
    const existing = this.getApprovalRequest(id);
    if (!existing) return undefined;

    const merged: HumanApprovalRequest = {
      ...existing,
      ...updates
    };
    return this.saveApprovalRequest(merged);
  }

  // --- 9. Shared Technical Knowledge ---
  public saveKnowledgeItem(item: SharedKnowledgeItem): SharedKnowledgeItem {
    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO shared_knowledge_items (
          id, project_id, build_id, source_agent, source_role, source_task_id,
          category, title, content, relevant_files, version,
          previous_version_id, supersedes_id, status, supersede_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.id,
        item.projectId,
        item.buildId,
        item.sourceAgent,
        item.sourceRole,
        item.sourceTaskId || null,
        item.category,
        item.title,
        item.content,
        JSON.stringify(item.relevantFiles || []),
        item.version || 1,
        item.previousVersionId || null,
        item.supersedesId || null,
        item.status || 'active',
        item.supersedeReason || null,
        item.createdAt,
        item.updatedAt || item.createdAt
      );

      this.broadcast(item.buildId, 'knowledge_item_updated', item);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveKnowledgeItem', err);
    }
    return item;
  }

  public getKnowledgeItems(
    buildId: string, 
    options?: { category?: string; status?: string; search?: string }
  ): SharedKnowledgeItem[] {
    try {
      let query = 'SELECT * FROM shared_knowledge_items WHERE build_id = ?';
      const params: any[] = [buildId];

      if (options?.category) {
        query += ' AND category = ?';
        params.push(options.category);
      }
      if (options?.status) {
        query += ' AND status = ?';
        params.push(options.status);
      }
      if (options?.search) {
        query += ' AND (title LIKE ? OR content LIKE ?)';
        params.push(`%${options.search}%`, `%${options.search}%`);
      }

      query += ' ORDER BY created_at DESC';
      const rows = this.dbManager.db.prepare(query).all(...params) as any[];

      return rows.map(r => ({
        id: r.id,
        projectId: r.project_id,
        buildId: r.build_id,
        sourceAgent: r.source_agent,
        sourceRole: r.source_role,
        sourceTaskId: r.source_task_id || undefined,
        category: r.category,
        title: r.title,
        content: r.content,
        relevantFiles: safeJsonParse<string[]>(r.relevant_files, []),
        version: r.version,
        previousVersionId: r.previous_version_id || undefined,
        supersedesId: r.supersedes_id || undefined,
        status: r.status,
        supersedeReason: r.supersede_reason || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }));
    } catch {
      return [];
    }
  }

  public getKnowledgeItem(id: string): SharedKnowledgeItem | undefined {
    try {
      const r = this.dbManager.db.prepare('SELECT * FROM shared_knowledge_items WHERE id = ?').get(id) as any;
      if (!r) return undefined;
      return {
        id: r.id,
        projectId: r.project_id,
        buildId: r.build_id,
        sourceAgent: r.source_agent,
        sourceRole: r.source_role,
        sourceTaskId: r.source_task_id || undefined,
        category: r.category,
        title: r.title,
        content: r.content,
        relevantFiles: safeJsonParse<string[]>(r.relevant_files, []),
        version: r.version,
        previousVersionId: r.previous_version_id || undefined,
        supersedesId: r.supersedes_id || undefined,
        status: r.status,
        supersedeReason: r.supersede_reason || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      };
    } catch {
      return undefined;
    }
  }

  public updateKnowledgeItem(id: string, updates: Partial<SharedKnowledgeItem>): SharedKnowledgeItem | undefined {
    const existing = this.getKnowledgeItem(id);
    if (!existing) return undefined;

    const merged: SharedKnowledgeItem = {
      ...existing,
      ...updates,
      updatedAt: this.getTime()
    };
    return this.saveKnowledgeItem(merged);
  }

  // --- 10. Phase 9 Code Generation Runs ---

  public saveGenerationRun(run: CodeGenerationRun): CodeGenerationRun {
    this.generationRuns.set(run.id, run);

    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO code_generation_runs (
          id, build_id, task_id, user_request, generation_profile,
          model_id, status, current_pass, total_passes, passes,
          files_created, files_modified, patch_ids, contracts_established,
          validation_results, repair_attempts, repair_logs, token_usage,
          cost, error, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.buildId,
        run.taskId || null,
        run.userRequest,
        run.generationProfile,
        run.modelId,
        run.status,
        run.currentPass,
        run.totalPasses,
        JSON.stringify(run.passes || []),
        JSON.stringify(run.filesCreated || []),
        JSON.stringify(run.filesModified || []),
        JSON.stringify(run.patchIds || []),
        JSON.stringify(run.contractsEstablished || []),
        run.validationResults ? JSON.stringify(run.validationResults) : null,
        run.repairAttempts || 0,
        JSON.stringify(run.repairLogs || []),
        run.tokenUsage || 0,
        run.cost || 0.0,
        run.error || null,
        run.createdAt,
        run.completedAt || null
      );

      this.broadcast(run.buildId, 'code_generation_run_updated', run);
    } catch (err: any) {
      this.handleDatabaseWriteError('saveGenerationRun', err);
    }
    return run;
  }

  public getGenerationRun(id: string): CodeGenerationRun | undefined {
    const cached = this.generationRuns.get(id);
    if (cached) return cached;

    try {
      const r = this.dbManager.db.prepare('SELECT * FROM code_generation_runs WHERE id = ?').get(id) as any;
      if (!r) return undefined;

      const run: CodeGenerationRun = {
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        userRequest: r.user_request,
        generationProfile: r.generation_profile,
        modelId: r.model_id,
        status: r.status,
        currentPass: r.current_pass,
        totalPasses: r.total_passes,
        passes: safeJsonParse<any[]>(r.passes, []),
        filesCreated: safeJsonParse<string[]>(r.files_created, []),
        filesModified: safeJsonParse<string[]>(r.files_modified, []),
        patchIds: safeJsonParse<string[]>(r.patch_ids, []),
        contractsEstablished: safeJsonParse<any[]>(r.contracts_established, []),
        validationResults: r.validation_results ? safeJsonParse<any>(r.validation_results, undefined) : undefined,
        repairAttempts: r.repair_attempts,
        repairLogs: safeJsonParse<any[]>(r.repair_logs, []),
        tokenUsage: r.token_usage,
        cost: r.cost,
        error: r.error || undefined,
        createdAt: r.created_at,
        completedAt: r.completed_at || undefined
      };
      this.generationRuns.set(run.id, run);
      return run;
    } catch {
      return undefined;
    }
  }

  public getGenerationRuns(buildId: string): CodeGenerationRun[] {
    try {
      const rows = this.dbManager.db.prepare(
        'SELECT * FROM code_generation_runs WHERE build_id = ? ORDER BY created_at DESC'
      ).all(buildId) as any[];

      return rows.map(r => ({
        id: r.id,
        buildId: r.build_id,
        taskId: r.task_id || undefined,
        userRequest: r.user_request,
        generationProfile: r.generation_profile,
        modelId: r.model_id,
        status: r.status,
        currentPass: r.current_pass,
        totalPasses: r.total_passes,
        passes: safeJsonParse<any[]>(r.passes, []),
        filesCreated: safeJsonParse<string[]>(r.files_created, []),
        filesModified: safeJsonParse<string[]>(r.files_modified, []),
        patchIds: safeJsonParse<string[]>(r.patch_ids, []),
        contractsEstablished: safeJsonParse<any[]>(r.contracts_established, []),
        validationResults: r.validation_results ? safeJsonParse<any>(r.validation_results, undefined) : undefined,
        repairAttempts: r.repair_attempts,
        repairLogs: safeJsonParse<any[]>(r.repair_logs, []),
        tokenUsage: r.token_usage,
        cost: r.cost,
        error: r.error || undefined,
        createdAt: r.created_at,
        completedAt: r.completed_at || undefined
      }));
    } catch {
      return Array.from(this.generationRuns.values()).filter(r => r.buildId === buildId);
    }
  }

  public getGenerationRunsByBuild(buildId: string): CodeGenerationRun[] {
    return this.getGenerationRuns(buildId);
  }
}

export const db = new PersistentDatabase();
export const store = db;
