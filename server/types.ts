export type ModelStrength = 
  | 'frontend' 
  | 'backend' 
  | 'database' 
  | 'testing' 
  | 'security' 
  | 'docs' 
  | 'debugging' 
  | 'architecture';

export interface ModelConfig {
  id: string;
  displayName: string;
  providerModel: string;
  strengths: ModelStrength[];
  maxTokens: number;
  enabled: boolean;
  avatarColor: string;
  badge: string;
  description: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  githubUsername?: string;
  githubConnected: boolean;
  defaultRepo?: string;
  costLimitPerBuild: number; // in USD
  enabledModelIds: string[];
  createdAt: number;
}

export type TaskStatus = 'open' | 'claimed' | 'done' | 'failed';
export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1 is highest / fix task

export interface Task {
  id: string;
  buildId: string;
  title: string;
  description: string;
  filePaths: string[];
  priority: TaskPriority;
  status: TaskStatus;
  claimedBy: string | null; // modelId
  leaseExpiresAt: number | null; // epoch timestamp ms
  createdAt: number;
  completedAt?: number;
  error?: string;
  isFixTask?: boolean;
}

export interface FileVersion {
  version: number;
  content: string;
  authorModel: string;
  timestamp: number;
  commitMessage?: string;
}

export interface ProjectFile {
  path: string;
  content: string;
  version: number;
  ownerModel: string;
  history: FileVersion[];
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export type EventType = 
  | 'build_started'
  | 'plan_created'
  | 'task_claimed'
  | 'task_released'
  | 'patch_submitted'
  | 'patch_applied'
  | 'patch_rejected'
  | 'file_created'
  | 'file_leased'
  | 'sandbox_check'
  | 'checkpoint_saved'
  | 'checkpoint_reverted'
  | 'task_completed'
  | 'verifier_started'
  | 'verifier_approved'
  | 'github_pushed'
  | 'build_completed'
  | 'build_stopped'
  | 'build_failed';

export interface SwarmEvent {
  id: string;
  buildId: string;
  timestamp: number;
  type: EventType;
  modelId?: string;
  taskId?: string;
  filePath?: string;
  details: string;
  meta?: Record<string, any>;
}

export interface ModelRunStatus {
  modelId: string;
  status: 'idle' | 'claiming' | 'working' | 'patching' | 'retrying' | 'done' | 'failed';
  currentTaskId: string | null;
  patchesApplied: number;
  patchesRejected: number;
  tokensUsed: number;
  estimatedCost: number;
  lastActive: number;
  lastActionSummary?: string;
  error?: string;
}

export interface Checkpoint {
  id: string;
  buildId: string;
  timestamp: number;
  description: string;
  filesSnapshot: Record<string, string>; // path -> content
  patchCount: number;
}

export type BuildStatus = 'planning' | 'running' | 'verifying' | 'completed' | 'stopped' | 'failed';

export interface Build {
  id: string;
  userId: string;
  idea: string;
  status: BuildStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  selectedModels: string[];
  autoPushGithub: boolean;
  githubRepoUrl?: string;
  totalTokens: number;
  totalCost: number;
  costLimit: number;
  maxDurationSeconds: number;
  patchesAppliedCount: number;
  error?: string;
}

export interface PatchEdit {
  find: string;
  replace: string;
}

export interface PatchAction {
  action: 'patch_file';
  path: string;
  edits: PatchEdit[];
  taskId?: string;
  commitMessage?: string;
}

export interface CreateFileAction {
  action: 'create_file';
  path: string;
  content: string;
  taskId?: string;
  commitMessage?: string;
}

export interface CreateTaskAction {
  action: 'create_task';
  title: string;
  description: string;
  filePaths: string[];
  priority?: TaskPriority;
}

export interface ModelActionResponse {
  actions: Array<PatchAction | CreateFileAction | CreateTaskAction>;
  error?: string;
}
