import { 
  User, 
  Build, 
  Task, 
  ProjectFile, 
  SwarmEvent, 
  ModelRunStatus, 
  Checkpoint 
} from './types.js';
import { encryptToken, decryptToken } from './crypto.js';
import { INITIAL_MODEL_REGISTRY } from './modelRegistry.js';

interface ClientSSEListener {
  id: string;
  res: any;
  buildId?: string;
}

class MemoryDatabase {
  // Persistence maps
  public users: Map<string, User> = new Map();
  public encryptedGithubTokens: Map<string, string> = new Map(); // userId -> encryptedToken
  public builds: Map<string, Build> = new Map();
  public tasks: Map<string, Task[]> = new Map(); // buildId -> tasks
  public files: Map<string, Map<string, ProjectFile>> = new Map(); // buildId -> (filePath -> ProjectFile)
  public events: Map<string, SwarmEvent[]> = new Map(); // buildId -> events
  public modelRuns: Map<string, Map<string, ModelRunStatus>> = new Map(); // buildId -> (modelId -> ModelRunStatus)
  public checkpoints: Map<string, Checkpoint[]> = new Map(); // buildId -> Checkpoints

  // Active SSE listeners for real-time updates
  private sseListeners: ClientSSEListener[] = [];

  constructor() {
    // Seed default demo user
    const defaultUser: User = {
      id: 'usr_default_admin',
      email: 'builder@squadforge.dev',
      name: 'SquadForge Architect',
      githubUsername: 'squadforge-dev',
      githubConnected: true,
      defaultRepo: 'squadforge-output',
      costLimitPerBuild: 5.0,
      enabledModelIds: INITIAL_MODEL_REGISTRY.map(m => m.id),
      createdAt: Date.now() - 86400000
    };
    this.users.set(defaultUser.id, defaultUser);
    this.encryptedGithubTokens.set(defaultUser.id, encryptToken('ghp_demo_valid_token_squadforge_2026'));
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
          // Listener might have disconnected
        }
      }
    }
  }

  // --- Users & GitHub Connections ---

  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  saveUser(user: User): User {
    this.users.set(user.id, user);
    return user;
  }

  setGithubToken(userId: string, plainToken: string, username?: string): void {
    const encrypted = encryptToken(plainToken);
    this.encryptedGithubTokens.set(userId, encrypted);
    const user = this.users.get(userId);
    if (user) {
      user.githubConnected = true;
      if (username) user.githubUsername = username;
      this.users.set(userId, { ...user });
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
      this.users.set(userId, { ...user });
    }
  }

  // --- Builds ---

  getBuild(buildId: string): Build | undefined {
    return this.builds.get(buildId);
  }

  saveBuild(build: Build): Build {
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

  getTask(buildId: string, taskId: string): Task | undefined {
    const list = this.getTasks(buildId);
    return list.find(t => t.id === taskId);
  }

  addTask(buildId: string, task: Task): Task {
    const list = this.getTasks(buildId);
    list.push(task);
    this.tasks.set(buildId, list);
    this.broadcast(buildId, 'task_added', task);
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
    return checkpoint;
  }

  getLatestCheckpoint(buildId: string): Checkpoint | undefined {
    const list = this.getCheckpoints(buildId);
    return list[list.length - 1];
  }
}

export const db = new MemoryDatabase();
