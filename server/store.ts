import fs from 'fs';
import path from 'path';
import { 
  User, 
  SafeUser,
  Session,
  Build, 
  Task, 
  ProjectFile, 
  SwarmEvent, 
  ModelRunStatus, 
  Checkpoint,
  PasswordResetToken,
  UsageLogEntry,
  SwarmUsageStats,
  LocalLLMConfig
} from './types.js';
import { encryptToken, decryptToken, hashSessionToken, generateSessionToken } from './crypto.js';
import { INITIAL_MODEL_REGISTRY, modelRegistry } from './modelRegistry.js';
import { quotaManager } from './quotaManager.js';
import { safeResultCache } from './cache.js';
import { localLLMService } from './localLLM.js';

interface ClientSSEListener {
  id: string;
  res: any;
  buildId?: string;
}

const DATA_FILE = path.resolve(process.cwd(), '.squadforge_data.json');
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class PersistentDatabase {
  // Persistence maps
  public users: Map<string, User> = new Map(); // userId -> User
  public usersByEmail: Map<string, string> = new Map(); // normalizedEmail -> userId
  public sessions: Map<string, Session> = new Map(); // hashedSessionToken -> Session
  public passwordResetTokens: Map<string, PasswordResetToken> = new Map(); // hashedResetToken -> PasswordResetToken
  public encryptedGithubTokens: Map<string, string> = new Map(); // userId -> encryptedToken
  public builds: Map<string, Build> = new Map();
  public tasks: Map<string, Task[]> = new Map(); // buildId -> tasks
  public files: Map<string, Map<string, ProjectFile>> = new Map(); // buildId -> (filePath -> ProjectFile)
  public events: Map<string, SwarmEvent[]> = new Map(); // buildId -> events
  public modelRuns: Map<string, Map<string, ModelRunStatus>> = new Map(); // buildId -> (modelId -> ModelRunStatus)
  public checkpoints: Map<string, Checkpoint[]> = new Map(); // buildId -> Checkpoints
  public usageLogs: UsageLogEntry[] = []; // In-memory usage log entries

  // In-memory rate limiter: identifier -> { attempts: number, lockUntil: number }
  private rateLimits: Map<string, { attempts: number; lockUntil: number }> = new Map();

  // Active SSE listeners for real-time updates
  private sseListeners: ClientSSEListener[] = [];
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);

        if (parsed.users && Array.isArray(parsed.users)) {
          for (const u of parsed.users) {
            this.users.set(u.id, u);
            if (u.email) {
              this.usersByEmail.set(u.email.toLowerCase().trim(), u.id);
            }
          }
        }

        if (parsed.sessions && Array.isArray(parsed.sessions)) {
          const now = Date.now();
          for (const s of parsed.sessions) {
            if (s.expiresAt > now) {
              this.sessions.set(s.id, s);
            }
          }
        }

        if (parsed.passwordResetTokens && Array.isArray(parsed.passwordResetTokens)) {
          const now = Date.now();
          for (const prt of parsed.passwordResetTokens) {
            if (prt.expiresAt > now) {
              this.passwordResetTokens.set(prt.id, prt);
            }
          }
        }

        if (parsed.encryptedGithubTokens) {
          for (const [uId, enc] of Object.entries(parsed.encryptedGithubTokens)) {
            this.encryptedGithubTokens.set(uId, enc as string);
          }
        }

        if (parsed.builds) {
          for (const b of parsed.builds) this.builds.set(b.id, b);
        }

        if (parsed.tasks) {
          for (const [bId, tList] of Object.entries(parsed.tasks)) {
            this.tasks.set(bId, tList as Task[]);
          }
        }

        if (parsed.files) {
          for (const [bId, fileMapObj] of Object.entries(parsed.files)) {
            const map = new Map<string, ProjectFile>();
            for (const [p, f] of Object.entries(fileMapObj as Record<string, ProjectFile>)) {
              map.set(p, f);
            }
            this.files.set(bId, map);
          }
        }

        if (parsed.events) {
          for (const [bId, eList] of Object.entries(parsed.events)) {
            this.events.set(bId, eList as SwarmEvent[]);
          }
        }

        if (parsed.checkpoints) {
          for (const [bId, cList] of Object.entries(parsed.checkpoints)) {
            this.checkpoints.set(bId, cList as Checkpoint[]);
          }
        }
      }
    } catch (err) {
      console.warn('Could not load persistent database from disk:', err);
    }
  }

  public scheduleDiskSave() {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      try {
        const serializedFiles: Record<string, Record<string, ProjectFile>> = {};
        for (const [bId, map] of this.files.entries()) {
          serializedFiles[bId] = Object.fromEntries(map.entries());
        }

        const data = {
          users: Array.from(this.users.values()),
          sessions: Array.from(this.sessions.values()),
          passwordResetTokens: Array.from(this.passwordResetTokens.values()),
          encryptedGithubTokens: Object.fromEntries(this.encryptedGithubTokens.entries()),
          builds: Array.from(this.builds.values()),
          tasks: Object.fromEntries(this.tasks.entries()),
          files: serializedFiles,
          events: Object.fromEntries(this.events.entries()),
          checkpoints: Object.fromEntries(this.checkpoints.entries())
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
      } catch (err) {
        // Disk write failed gracefully
      }
    }, 800);

    if (this.saveDebounceTimer.unref) {
      this.saveDebounceTimer.unref();
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
    user.updatedAt = Date.now();
    this.users.set(user.id, user);
    this.usersByEmail.set(normalized, user.id);
    this.scheduleDiskSave();
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
      expiresAt: Date.now() + SESSION_DURATION_MS,
      createdAt: Date.now(),
      ip,
      userAgent
    };
    this.sessions.set(hashed, session);
    this.scheduleDiskSave();
    return session;
  }

  getSession(plainToken: string): Session | undefined {
    if (!plainToken) return undefined;
    const hashed = hashSessionToken(plainToken);
    const session = this.sessions.get(hashed);
    if (!session) return undefined;

    // Check expiration
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(hashed);
      this.scheduleDiskSave();
      return undefined;
    }
    return session;
  }

  deleteSession(plainToken: string): boolean {
    if (!plainToken) return false;
    const hashed = hashSessionToken(plainToken);
    const existed = this.sessions.delete(hashed);
    if (existed) {
      this.scheduleDiskSave();
    }
    return existed;
  }

  deleteUserSessions(userId: string): void {
    let deleted = false;
    for (const [id, s] of this.sessions.entries()) {
      if (s.userId === userId) {
        this.sessions.delete(id);
        deleted = true;
      }
    }
    if (deleted) {
      this.scheduleDiskSave();
    }
  }

  // --- Password Reset Tokens (1 hour TTL, one-time use) ---

  createPasswordResetToken(email: string): string | null {
    const user = this.findUserByEmail(email);
    if (!user) return null;

    const plainToken = generateSessionToken();
    const hashed = hashSessionToken(plainToken);
    const resetToken: PasswordResetToken = {
      id: hashed,
      userId: user.id,
      email: user.email,
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour
      createdAt: Date.now()
    };
    this.passwordResetTokens.set(hashed, resetToken);
    this.scheduleDiskSave();
    return plainToken;
  }

  verifyAndConsumePasswordResetToken(plainToken: string): { valid: boolean; userId?: string } {
    if (!plainToken) return { valid: false };
    const hashed = hashSessionToken(plainToken);
    const record = this.passwordResetTokens.get(hashed);
    if (!record) return { valid: false };

    if (record.expiresAt < Date.now()) {
      this.passwordResetTokens.delete(hashed);
      this.scheduleDiskSave();
      return { valid: false };
    }

    // One-time use: consume immediately
    this.passwordResetTokens.delete(hashed);
    this.scheduleDiskSave();
    return { valid: true, userId: record.userId };
  }

  // --- Login Rate Limiting (5 failed attempts = 15 min lock) ---

  checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const record = this.rateLimits.get(key);
    if (!record) return { allowed: true, retryAfterSeconds: 0 };

    const now = Date.now();
    if (record.lockUntil > now) {
      return { 
        allowed: false, 
        retryAfterSeconds: Math.ceil((record.lockUntil - now) / 1000) 
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  recordFailedLogin(key: string): void {
    const now = Date.now();
    const record = this.rateLimits.get(key) || { attempts: 0, lockUntil: 0 };
    record.attempts += 1;

    // After 5 attempts, lock for 15 minutes
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
    const encrypted = encryptToken(plainToken);
    this.encryptedGithubTokens.set(userId, encrypted);
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
    const user = this.users.get(userId);
    if (user) {
      user.githubConnected = false;
      user.githubUsername = undefined;
      this.saveUser(user);
    }
  }

  // --- Builds (Scoped to User) ---

  getBuild(buildId: string): Build | undefined {
    return this.builds.get(buildId);
  }

  saveBuild(build: Build): Build {
    this.builds.set(build.id, build);
    this.broadcast(build.id, 'build_updated', build);
    this.scheduleDiskSave();
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
    const list = this.getTasks(buildId);
    list.push(task);
    this.tasks.set(buildId, list);
    this.broadcast(buildId, 'task_added', task);
    this.scheduleDiskSave();
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
    this.scheduleDiskSave();
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
    this.scheduleDiskSave();
    return file;
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
    this.scheduleDiskSave();
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
      lastActive: Date.now()
    };
    const updated = { ...current, ...updates, lastActive: Date.now() };
    map.set(modelId, updated);
    this.broadcast(buildId, 'model_run_updated', updated);
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
    this.scheduleDiskSave();
    return checkpoint;
  }

  getLatestCheckpoint(buildId: string): Checkpoint | undefined {
    const list = this.getCheckpoints(buildId);
    return list[list.length - 1];
  }

  // --- Usage Logging & Dashboard Aggregation ---

  addUsageLog(entry: UsageLogEntry): void {
    this.usageLogs.push(entry);
    // Keep last 5000 entries in memory
    if (this.usageLogs.length > 5000) {
      this.usageLogs = this.usageLogs.slice(-4000);
    }
    this.broadcast(entry.buildId, 'usage_logged', entry);
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

    for (const log of logs) {
      if (log.success) successfulRequests++;
      else failedRequests++;

      totalEstimatedTokens += log.estimatedTokens || log.totalTokens || 0;
      totalActualTokens += log.totalTokens || 0;
      totalEstimatedCost += log.estimatedCost || 0;
      totalBilledCost += log.billedCost || 0;

      // Provider aggregation
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

      // Model aggregation
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

      // Agent aggregation from logs
      if (log.agentRole && agentStats[log.agentRole]) {
        agentStats[log.agentRole].requests++;
      }
    }

    // Set provider status from quota manager
    const allQuotas = quotaManager.getAllStatuses();
    for (const [pKey, pVal] of Object.entries(allQuotas)) {
      if (providerStats[pVal.provider]) {
        providerStats[pVal.provider].status = pVal.status;
      }
    }

    // Agent Stats
    const agentStats: SwarmUsageStats['agentStats'] = {} as any;
    const allAgents = modelRegistry.getAgentSpecs();
    for (const [role, spec] of Object.entries(allAgents)) {
      agentStats[role as any] = {
        role: role as any,
        requests: 0,
        tokens: 0,
        tasksCompleted: 0,
        estimatedCost: 0
      };
    }

    // Aggregate tasks if buildId provided
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
}

export const db = new PersistentDatabase();
