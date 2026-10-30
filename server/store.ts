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
  SwarmUsageStats
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

interface ClientSSEListener {
  id: string;
  res: any;
  buildId?: string;
}

const DATA_FILE = path.resolve(process.cwd(), '.squadforge_data.json');
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
      if (process.env.NODE_ENV === 'production' && this.dbManager.isMemoryStorage()) {
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
        enabledModelIds: u.enabled_model_ids ? JSON.parse(u.enabled_model_ids) : [],
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
        selectedModels: b.selected_models ? JSON.parse(b.selected_models) : [],
        autoPushGithub: Boolean(b.auto_push_github),
        totalTokens: b.total_tokens || 0,
        totalCost: b.total_cost || 0.0,
        costLimit: b.cost_limit || 5.0,
        tokenBudget: b.token_budget || undefined,
        maxDurationSeconds: b.max_duration_seconds || 300,
        patchesAppliedCount: b.patches_applied_count || 0,
        error: b.error || undefined,
        failureReason: b.failure_reason || undefined,
        techStack: b.tech_stack ? JSON.parse(b.tech_stack) : undefined,
        milestones: b.milestones ? JSON.parse(b.milestones) : undefined,
        testReport: b.test_report ? JSON.parse(b.test_report) : undefined,
        securityAudit: b.security_audit ? JSON.parse(b.security_audit) : undefined,
        verificationReport: b.verification_report ? JSON.parse(b.verification_report) : undefined,
        verificationFeedback: b.verification_feedback || undefined,
        verificationAttempts: b.verification_attempts || 0,
        maxVerificationAttempts: b.max_verification_attempts || 3,
        budgetWarningEmitted: Boolean(b.budget_warning_emitted),
        githubRepoUrl: b.github_repo || undefined,
        gitBranch: b.github_branch || undefined,
        pullRequestUrl: b.github_pr_url || undefined,
        projectType: b.project_type || 'fullstack',
        architectureDecisions: b.architecture_decisions ? JSON.parse(b.architecture_decisions) : undefined,
        requirementsChecklist: b.requirements_checklist ? JSON.parse(b.requirements_checklist) : undefined,
        revisions: b.revisions ? JSON.parse(b.revisions) : undefined,
        livePreviewHtml: b.live_preview_html || undefined
      };
      this.builds.set(build.id, build);
    }

    // 7. Tasks
    const taskRows = sqlite.prepare('SELECT * FROM tasks').all() as any[];
    for (const t of taskRows) {
      const task: Task = {
        id: t.id,
        buildId: t.build_id,
        title: t.title,
        description: t.description,
        filePaths: t.file_paths ? JSON.parse(t.file_paths) : [],
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
        dependencies: t.dependencies ? JSON.parse(t.dependencies) : undefined,
        assignedRole: t.assigned_role || undefined,
        milestone: t.milestone || undefined,
        complexity: t.complexity || undefined,
        tokenBudget: t.token_budget || undefined,
        actualTokensUsed: t.actual_tokens_used || 0,
        estimatedCost: t.estimated_cost || 0.0,
        isPaused: Boolean(t.is_paused),
        pausedReason: t.paused_reason || undefined,
        executionLogs: t.execution_logs ? JSON.parse(t.execution_logs) : undefined
      };
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
        commitMessage: v.commit_message || undefined
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
        updatedAt: f.updated_at
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
        user.id, user.email, user.name, user.passwordHash || null, user.avatarUrl || null,
        user.githubUsername || null, user.githubConnected ? 1 : 0, user.defaultRepo || null,
        user.costLimitPerBuild || 5.0, user.tokenLimitPerBuild || 100000,
        user.routingPreference || 'quality', JSON.stringify(user.enabledModelIds || []),
        user.createdAt, user.updatedAt
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
    this.builds.set(build.id, build);
    this.broadcast(build.id, 'build_updated', build);

    // Ensure referenced user exists in users table to satisfy foreign key constraint integrity
    if (build.userId && !this.users.has(build.userId)) {
      this.saveUser({
        id: build.userId,
        email: `${build.userId}@squadforge.internal`,
        name: build.userId,
        githubConnected: false,
        costLimitPerBuild: 5.0,
        enabledModelIds: [],
        createdAt: this.getTime()
      });
    }

    try {
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO builds (
          id, user_id, idea, status, created_at, updated_at, completed_at,
          selected_models, auto_push_github, total_tokens, total_cost, cost_limit,
          token_budget, max_duration_seconds, patches_applied_count, error, failure_reason,
          tech_stack, milestones, test_report, security_audit, verification_report,
          verification_feedback, verification_attempts, max_verification_attempts,
          budget_warning_emitted, github_repo, github_branch, github_pr_url,
          project_type, architecture_decisions, requirements_checklist, revisions, live_preview_html
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        build.id, build.userId, build.idea, build.status, build.createdAt, build.updatedAt,
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
        build.livePreviewHtml || null
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('saveBuild', err);
    }

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

  getTask(buildId: string, taskId: string): Task | undefined {
    const list = this.getTasks(buildId);
    return list.find(t => t.id === taskId);
  }

  addTask(buildId: string, task: Task): Task {
    let list = this.tasks.get(buildId);
    if (!list) {
      list = [];
      this.tasks.set(buildId, list);
    }
    list.push(task);
    this.broadcast(buildId, 'task_added', task);

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
    }

    return task;
  }

  updateTask(buildId: string, taskId: string, updates: Partial<Task>): Task | null {
    const list = this.getTasks(buildId);
    const index = list.findIndex(t => t.id === taskId);
    if (index === -1) return null;
    const updated = { ...list[index], ...updates };
    list[index] = updated;
    this.tasks.set(buildId, list);
    this.broadcast(buildId, 'task_updated', updated);

    try {
      this.dbManager.db.prepare(`
        UPDATE tasks SET
          status = ?, claimed_by = ?, lease_expires_at = ?, completed_at = ?,
          error = ?, retry_count = ?, last_error = ?, is_paused = ?, paused_reason = ?,
          actual_tokens_used = ?, estimated_cost = ?
        WHERE id = ?
      `).run(
        updated.status, updated.claimedBy || null, updated.leaseExpiresAt || null,
        updated.completedAt || null, updated.error || null, updated.retryCount || 0,
        updated.lastError || null, updated.isPaused ? 1 : 0, updated.pausedReason || null,
        updated.actualTokensUsed || 0, updated.estimatedCost || 0.0, updated.id
      );
    } catch (err: any) {
      this.handleDatabaseWriteError('updateTask', err);
    }

    return updated;
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
    const files = this.getFilesMap(buildId);
    files.set(file.path, file);
    this.broadcast(buildId, 'file_updated', file);

    try {
      const fileId = `${buildId}:${file.path}`;
      this.dbManager.db.prepare(`
        INSERT OR REPLACE INTO project_files (
          id, build_id, path, content, version, owner_model,
          lease_owner, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fileId, buildId, file.path, file.content, file.version, file.ownerModel,
        file.leaseOwner || null, file.leaseExpiresAt || null, file.createdAt, file.updatedAt
      );

      // Latest version in file_versions
      const latestVer = file.history[file.history.length - 1];
      if (latestVer) {
        this.dbManager.db.prepare(`
          INSERT INTO file_versions (file_id, build_id, path, version, content, author_model, commit_message, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(fileId, buildId, file.path, latestVer.version, latestVer.content, latestVer.authorModel, latestVer.commitMessage || null, latestVer.timestamp);
      }
    } catch (err: any) {
      this.handleDatabaseWriteError('setFile', err);
    }

    return file;
  }

  deleteFile(buildId: string, filePath: string): boolean {
    const files = this.getFilesMap(buildId);
    const existed = files.delete(filePath);
    if (existed) {
      this.broadcast(buildId, 'file_deleted', { path: filePath });
      try {
        const fileId = `${buildId}:${filePath}`;
        this.dbManager.db.prepare('DELETE FROM project_files WHERE id = ?').run(fileId);
      } catch (err: any) {
        this.handleDatabaseWriteError('deleteFile', err);
      }
    }
    return existed;
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
    return this.projectMemories.get(projectId) || null;
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
}

export const db = new PersistentDatabase();
export const store = db;
