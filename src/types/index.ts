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
  routingPreference?: 'cost' | 'latency' | 'quality';
  enabledModelIds: string[];
  createdAt: number;
  updatedAt?: number;
  isAnonymous?: boolean;
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
  | 'paused'
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
  tokenBudget?: number;
  actualTokensUsed?: number;
  estimatedCost?: number;
  isPaused?: boolean;
  pausedReason?: string;
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
  tokenBudget?: number;
  routingPreference?: 'cost' | 'latency' | 'quality';
  budgetWarningEmitted?: boolean;
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
  verificationReport?: VerificationReport;
  projectType?: ProjectType;
  architectureDecisions?: ArchitectureDecision[];
  requirementsChecklist?: RequirementItem[];
  revisions?: ProjectRevision[];
  livePreviewHtml?: string;
  previewMode?: 'real_application' | 'static_html' | 'fallback_preview';
  previewDiagnostic?: string;
  previewRuntimeErrors?: string[];
  previewEntryPoint?: string;
}

export type ProjectType = 
  | 'landing_page' 
  | 'saas_dashboard' 
  | 'ecommerce' 
  | 'portfolio' 
  | 'blog_content'
  | 'blog_publication'
  | 'fullstack' 
  | 'fullstack_app'
  | 'api_service' 
  | 'internal_tool';

export interface ArchitectureDecision {
  id: string;
  title: string;
  status: 'proposed' | 'accepted' | 'superseded';
  context: string;
  decision: string;
  rationale?: string;
  consequences?: string;
  timestamp: number;
}

export type RequirementStatus = 
  | 'implemented' 
  | 'partially_implemented' 
  | 'unverified' 
  | 'blocked' 
  | 'failed' 
  | 'satisfied' 
  | 'pending';

export interface RequirementItem {
  id: string;
  title?: string;
  category?: string;
  description: string;
  priority: 'must_have' | 'should_have' | 'nice_to_have';
  satisfied: boolean;
  status?: RequirementStatus;
  satisfiedByFiles?: string[];
  evidence?: string;
  verificationNotes?: string;
  testsExecuted?: Array<{ name: string; passed: boolean; message?: string }>;
  deterministicChecksPassed?: boolean;
}

export interface ProjectRevision {
  id: string;
  prompt: string;
  createdAt: number;
  status: 'pending' | 'in_progress' | 'executing' | 'completed' | 'failed';
  revisionNumber?: number;
  tasksGenerated?: string[];
  affectedFiles?: string[];
  summary?: string;
}

export interface LivePreviewBundle {
  html: string;
  title: string;
  generatedAt: number;
  viewport?: 'desktop' | 'tablet' | 'mobile';
  mode?: 'real_application' | 'static_html' | 'fallback_preview';
  diagnosticInfo?: string;
  runtimeErrors?: string[];
  entryPoint?: string;
}

export type VerificationVerdict = 
  | 'pending'
  | 'running'
  | 'in_progress' 
  | 'blocked' 
  | 'failed' 
  | 'partially_verified' 
  | 'passed'
  | 'verified';

export interface VerificationCheckItem {
  category: 'requirements' | 'files' | 'syntax' | 'types' | 'tests' | 'build' | 'security' | 'config' | 'preview';
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
  evidence?: string;
  reasonIfSkipped?: string;
}

export interface VerificationReport {
  verdict: VerificationVerdict;
  evaluatedAt: number;
  checks: VerificationCheckItem[];
  requirementsCoveragePercent: number;
  requirementsReport?: {
    originalRequirements: string;
    total: number;
    implemented: number;
    partiallyImplemented: number;
    unverified: number;
    failed: number;
    blocked: number;
    items: RequirementItem[];
  };
  compilationStatus?: {
    syntaxPassed: boolean;
    typePassed: boolean;
    previewBundlePassed: boolean;
    errors?: string[];
  };
  runtimeStatus?: {
    mode: 'real_application' | 'static_html' | 'fallback_preview';
    entryPoint?: string;
    interactiveState: boolean;
    errors?: string[];
  };
  knownLimitations?: string[];
  finalOutcome?: {
    verdict: VerificationVerdict;
    summary: string;
  };
  syntaxChecksPassed: boolean;
  typeChecksPassed: boolean;
  previewMode?: 'real_application' | 'static_html' | 'fallback_preview';
  previewPassed?: boolean;
  testExecution: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    details: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; message?: string }>;
  };
  buildPassed: boolean;
  buildOutput?: string;
  securityAuditPassed: boolean;
  securityScore: number;
  knownDefects: string[];
  missingEnvironmentVars: string[];
  unresolvedCriteria: string[];
  unresolvedRisks: string[];
  evidenceSummary: string;
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

export type ProviderHealthStatus = 
  | 'healthy' 
  | 'rate_limited' 
  | 'quota_exhausted' 
  | 'auth_error' 
  | 'cooldown' 
  | 'offline';

export interface ProviderQuotaStatus {
  provider: string;
  modelId?: string;
  status: ProviderHealthStatus;
  consecutiveErrors: number;
  cooldownUntil?: number;
  retryAfterSeconds?: number;
  reportedLimit?: number;
  reportedRemaining?: number;
  reportedResetTime?: number;
  isEstimated: boolean;
  lastError?: string;
  lastErrorCode?: string;
  lastUsedAt?: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
}

export interface LocalLLMConfig {
  enabled: boolean;
  endpointUrl: string;
  modelName: string;
  timeoutMs: number;
  contextWindow: number;
  status: 'untested' | 'connected' | 'disconnected' | 'error';
  lastChecked?: number;
  errorMessage?: string;
  availableModels?: string[];
}

export interface LocalLLMHealthResult {
  connected: boolean;
  endpointUrl: string;
  availableModels: string[];
  selectedModelAvailable: boolean;
  latencyMs: number;
  error?: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entriesCount: number;
  tokensSaved: number;
  estimatedCostSaved: number;
}

export interface UsageLogEntry {
  id: string;
  timestamp: number;
  buildId: string;
  taskId?: string;
  taskTitle?: string;
  agentRole?: AgentRole;
  userId: string;
  modelId: string;
  requestedModelId: string;
  actualModelUsed: string;
  provider: string;
  isFallback: boolean;
  fallbackReason?: string;
  isLocal: boolean;
  estimatedTokens: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  totalTokens: number;
  estimatedCost: number;
  billedCost: number;
  isCached: boolean;
  latencyMs: number;
  success: boolean;
  error?: string;
  errorCode?: string;
}

export interface SwarmUsageStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalEstimatedTokens: number;
  totalActualTokens: number;
  totalEstimatedCost: number;
  totalBilledCost: number;
  cacheStats: CacheStats;
  providerStats: Record<string, {
    requests: number;
    tokens: number;
    errors: number;
    estimatedCost: number;
    billedCost: number;
    status: ProviderHealthStatus;
  }>;
  modelStats: Record<string, {
    modelId: string;
    displayName: string;
    requests: number;
    tokens: number;
    errors: number;
    estimatedCost: number;
    fallbackCount: number;
  }>;
  agentStats: Record<string, {
    role: AgentRole;
    requests: number;
    tokens: number;
    tasksCompleted: number;
    estimatedCost: number;
  }>;
  taskStats: Array<{
    taskId: string;
    taskTitle: string;
    tokensUsed: number;
    cost: number;
    modelUsed: string;
    status: TaskStatus;
    isPaused?: boolean;
    pausedReason?: string;
  }>;
  activeQuotas: Record<string, ProviderQuotaStatus>;
  localLLM: LocalLLMConfig;
}
