export type ModelStrength = 
  | 'frontend' 
  | 'backend' 
  | 'database' 
  | 'testing' 
  | 'security' 
  | 'docs' 
  | 'debugging' 
  | 'architecture';

export type AgentRole = 
  | 'project_manager'
  | 'software_architect'
  | 'frontend_developer'
  | 'backend_developer'
  | 'database_specialist'
  | 'integration_specialist'
  | 'qa_testing_specialist'
  | 'debugging_specialist'
  | 'security_specialist'
  | 'devops_release_specialist';

export interface AgentSpec {
  role: AgentRole;
  title: string;
  description: string;
  assignedModelId: string;
  responsibilities: string[];
}

export interface ModelConfig {
  id: string;
  displayName: string;
  providerModel: string;
  agentRole?: AgentRole;
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
  costLimitPerBuild: number;
  enabledModelIds: string[];
  createdAt: number;
  updatedAt?: number;
}

export type SafeUser = User;

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
  ip?: string;
  userAgent?: string;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  email: string;
  expiresAt: number;
  createdAt: number;
}

export type TaskStatus = 
  | 'pending'
  | 'planning'
  | 'in_progress'
  | 'testing'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'open'
  | 'claimed'
  | 'done';

export type TaskPriority = 1 | 2 | 3 | 4 | 5;

export interface Task {
  id: string;
  buildId: string;
  title: string;
  description: string;
  filePaths: string[];
  priority: TaskPriority;
  status: TaskStatus;
  claimedBy: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  completedAt?: number;
  error?: string;
  isFixTask?: boolean;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
  dependencies?: string[];
  assignedRole?: AgentRole;
  milestone?: string;
  executionLogs?: string[];
  verificationOutput?: {
    syntaxPassed?: boolean;
    testsPassed?: boolean;
    errors?: string[];
  };
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
  | 'milestone_reached'
  | 'task_claimed'
  | 'task_released'
  | 'patch_submitted'
  | 'patch_applied'
  | 'patch_rejected'
  | 'file_created'
  | 'file_leased'
  | 'sandbox_check'
  | 'tests_executed'
  | 'security_audit'
  | 'checkpoint_saved'
  | 'checkpoint_reverted'
  | 'task_completed'
  | 'task_failed'
  | 'verifier_started'
  | 'verifier_rejected'
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
  role?: AgentRole;
  status: 'idle' | 'claiming' | 'working' | 'patching' | 'testing' | 'retrying' | 'done' | 'failed';
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
  filesSnapshot: Record<string, string>;
  patchCount: number;
}

export type BuildStatus = 
  | 'pending'
  | 'planning'
  | 'in_progress'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'failed';

export interface TechStackConfig {
  frontend: string;
  backend: string;
  database: string;
  testing: string;
  security: string;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  taskIds: string[];
}

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
  gitBranch?: string;
  pullRequestUrl?: string;
  totalTokens: number;
  totalCost: number;
  costLimit: number;
  maxDurationSeconds: number;
  patchesAppliedCount: number;
  error?: string;
  verificationAttempts?: number;
  maxVerificationAttempts?: number;
  verificationFeedback?: string;
  failureReason?: string;
  techStack?: TechStackConfig;
  milestones?: Milestone[];
  testReport?: {
    total: number;
    passed: number;
    failed: number;
    details: Array<{ name: string; passed: boolean; message?: string }>;
  };
  securityAudit?: {
    passed: boolean;
    score: number;
    findings: Array<{ severity: 'low' | 'medium' | 'high'; message: string }>;
  };
}

export interface ConcurrencyTestReport {
  success: boolean;
  testBuildId: string;
  targetFile: string;
  initialVersion: number;
  finalVersion: number;
  totalModels: number;
  allModelsPresent: boolean;
  modelResults: Array<{
    modelId: string;
    modelName: string;
    attempts: number;
    success: boolean;
    appliedVersion?: number;
    editSignature: string;
  }>;
  finalContent: string;
  elapsedMs: number;
  verdict: string;
}

export interface ConfigStatusResponse {
  gemini: {
    configured: boolean;
    model: string;
    statusText: string;
  };
  openrouter: {
    configured: boolean;
    modelCount: number;
    statusText: string;
  };
  github: {
    oauthConfigured: boolean;
    userConnected: boolean;
    username?: string;
    statusText: string;
  };
}
