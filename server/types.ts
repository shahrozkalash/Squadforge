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
  | 'devops_release_specialist'
  | 'fullstack_developer';

export interface AgentSpec {
  role: AgentRole;
  title: string;
  description: string;
  assignedModelId: string;
  responsibilities: string[];
}

export type ModelTier = 'free' | 'paid' | 'local';
export type ModelCapabilityLevel = 'lightweight' | 'standard' | 'advanced' | 'flagship';
export type AIProvider = 'gemini' | 'openrouter' | 'local' | 'direct' | 'none';

export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  currency: 'USD';
}

export interface ModelConfig {
  id: string;
  displayName: string;
  providerModel: string;
  provider?: AIProvider;
  tier?: ModelTier;
  agentRole?: AgentRole;
  strengths: ModelStrength[];
  capabilityLevel?: ModelCapabilityLevel;
  contextWindow?: number;
  pricing?: ModelPricing;
  isLocal?: boolean;
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
  passwordHash?: string;
  avatarUrl?: string;
  githubUsername?: string;
  githubConnected: boolean;
  defaultRepo?: string;
  costLimitPerBuild: number; // in USD
  tokenLimitPerBuild?: number;
  routingPreference?: 'cost' | 'latency' | 'quality';
  enabledModelIds: string[];
  createdAt: number;
  updatedAt?: number;
  isAnonymous?: boolean;
}

export type SafeUser = Omit<User, 'passwordHash'>;

export interface Session {
  id: string; // SHA-256 of session token
  userId: string;
  expiresAt: number; // epoch ms
  createdAt: number;
  ip?: string;
  userAgent?: string;
}

export interface PasswordResetToken {
  id: string; // SHA-256 of reset token
  userId: string;
  email: string;
  expiresAt: number; // epoch ms
  createdAt: number;
}

export interface PasswordResetCodeRecord {
  id: string; // unique ID
  userId: string;
  email: string; // normalized email
  codeHash: string; // Keyed HMAC-SHA256 of 6-digit code
  createdAt: number; // epoch ms
  expiresAt: number; // exactly createdAt + 300_000 (300 seconds / 5 minutes)
  attempts: number; // max 5
  consumed: boolean;
  invalidated: boolean;
}

export interface PasswordResetAuthRecord {
  id: string; // SHA-256 of reset authorization token
  userId: string;
  email: string;
  createdAt: number;
  expiresAt: number; // epoch ms
  consumed: boolean;
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

export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1 is highest / fix task

export interface Task {
  id: string;
  buildId: string;
  title: string;
  description: string;
  filePaths: string[];
  priority: TaskPriority;
  status: TaskStatus;
  claimedBy?: string | null; // modelId
  leaseExpiresAt?: number | null; // epoch timestamp ms
  createdAt: number;
  completedAt?: number;
  error?: string;
  isFixTask?: boolean;
  retryCount?: number;
  maxRetries?: number;
  lastError?: string;
  dependencies?: string[]; // IDs of tasks that must be completed first
  assignedRole?: AgentRole;
  milestone?: string;
  complexity?: 'lightweight' | 'standard' | 'flagship';
  tokenBudget?: number;
  actualTokensUsed?: number;
  estimatedCost?: number;
  isPaused?: boolean;
  pausedReason?: string;
  executionLogs?: string[];
  verificationOutput?: {
    syntaxPassed?: boolean;
    testsPassed?: boolean;
    filesVerified?: boolean;
    status?: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'not_run';
    errors?: string[];
    evidence?: string;
    durationMs?: number;
    command?: string;
    exitCode?: number;
  };
  verificationHistory?: Array<{
    timestamp: number;
    verifier: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'not_run';
    syntaxPassed?: boolean;
    testsPassed?: boolean;
    filesVerified?: boolean;
    evidence?: string;
    details?: string;
    command?: string;
    exitCode?: number;
    durationMs?: number;
    output?: string;
    executionSource?: string;
  }>;
  taskResult?: AgentTaskResult;
}

export interface TaskExecutionEvidence {
  command?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  output?: string;
  executionSource?: string;
  testResults?: Array<{
    name: string;
    passed: boolean;
    status: 'passed' | 'failed' | 'skipped' | 'not_run';
    error?: string;
  }>;
  filesVerified?: Array<{ path: string; exists: boolean; modified: boolean }>;
  verifiedAt: number;
}

export interface AgentTaskResult {
  taskId: string;
  agentModelId: string;
  agentRole?: AgentRole;
  workCompleted: string;
  filesCreated: string[];
  filesModified: string[];
  dependencies: string[];
  architecturalDecisionsUsed: string[];
  issuesDiscovered: string[];
  testsExecuted: Array<{
    name: string;
    passed: boolean;
    status?: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'not_run';
    command?: string;
    exitCode?: number;
    durationMs?: number;
    error?: string;
    output?: string;
  }>;
  executionEvidence?: TaskExecutionEvidence;
  remainingWork?: string[];
  confidence: number;
  evidence: string;
  timestamp: number;
}

export interface FileVersion {
  version: number;
  content: string;
  authorModel: string;
  timestamp: number;
  commitMessage?: string;
  taskId?: string;
  changeType?: 'added' | 'removed' | 'modified' | 'reverted' | 'merged' | 'recreated';
  isFormattingOnly?: boolean;
}

export interface ProjectFile {
  path: string;
  content: string;
  version: number;
  ownerModel?: string;
  history: FileVersion[];
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  originalPath?: string;
  isRenamed?: boolean;
  isDeleted?: boolean;
  isRecreated?: boolean;
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
  | 'file_deleted'
  | 'file_leased'
  | 'sandbox_check'
  | 'tests_executed'
  | 'security_audit'
  | 'checkpoint_saved'
  | 'checkpoint_reverted'
  | 'task_completed'
  | 'task_failed'
  | 'task_rejected'
  | 'task_paused'
  | 'task_resumed'
  | 'budget_warning'
  | 'quota_warning'
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
  filesSnapshot: Record<string, string>; // path -> content
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

export type ADRStatus = 'proposed' | 'accepted' | 'rejected' | 'superseded';

export interface ADRHistoryEntry {
  timestamp: number;
  action: 'created' | 'modified' | 'accepted' | 'rejected' | 'superseded' | 'reconsidered';
  author?: string;
  note?: string;
}

export interface ArchitectureDecision {
  id: string;
  title: string;
  status: ADRStatus;
  context: string;
  proposedSolution?: string;
  decision: string;
  alternativesConsidered?: string[];
  advantages?: string[];
  disadvantages?: string[];
  rationale?: string;
  consequences?: string;
  relatedRequirements?: string[];
  affectedFiles?: string[];
  affectedModules?: string[];
  history?: ADRHistoryEntry[];
  supersededBy?: string;
  supersedes?: string;
  timestamp: number;
}

export type RequirementStatus = 
  | 'pending'
  | 'implemented' 
  | 'verified'
  | 'partially_implemented' 
  | 'unverified' 
  | 'blocked' 
  | 'failed' 
  | 'satisfied' 
  | 'unmet';

export interface RequirementItem {
  id: string;
  title?: string;
  category?: string;
  description: string;
  priority?: 'must_have' | 'should_have' | 'nice_to_have';
  satisfied: boolean;
  status?: RequirementStatus;
  satisfiedByFiles?: string[];
  relevantFiles?: string[];
  verificationMethod?: 'automated_test_suite' | 'static_ast_and_syntax' | 'browser_runtime_inspection' | 'manual_pending' | string;
  evidence?: string;
  verificationNotes?: string;
  testsExecuted?: Array<string | { name: string; passed: boolean; message?: string }>;
  testResults?: Array<{ name: string; passed: boolean; message?: string }>;
  remainingLimitations?: string[];
  remainingProblems?: string[];
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
  category: 'requirements' | 'files' | 'syntax' | 'types' | 'tests' | 'build' | 'security' | 'config' | 'preview' | 'runtime';
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
  passed?: boolean;
  evidence?: string;
  details?: string;
  reasonIfSkipped?: string;
}

export interface BrowserRuntimeCheck {
  name: string;
  category: 'document' | 'mount' | 'dependencies' | 'content' | 'interactivity' | 'layout' | 'errors';
  status: 'passed' | 'failed' | 'skipped';
  message: string;
  details?: string;
}

export interface BrowserRuntimeVerificationReport {
  verified: boolean;
  verdict: 'verified' | 'partially_verified' | 'failed';
  timestamp: number;
  checks: BrowserRuntimeCheck[];
  errors: string[];
  domMountVerified: boolean;
  meaningfulContentRendered: boolean;
  interactiveControlsVerified: boolean;
  responsiveLayoutVerified: boolean;
  dependencyIntegrityVerified: boolean;
}

export interface VerificationReport {
  verdict: VerificationVerdict;
  evaluatedAt: number;
  checks: VerificationCheckItem[];
  requirementsCoveragePercent: number;
  requirementsReport?: {
    originalRequirements?: string;
    total: number;
    implemented: number;
    partiallyImplemented: number;
    unverified: number;
    failed: number;
    blocked: number;
    items: RequirementItem[];
  } | RequirementItem[];
  compilationStatus?: {
    syntaxPassed: boolean;
    typePassed: boolean;
    previewBundlePassed?: boolean;
    errors?: string[];
  } | string;
  runtimeStatus?: {
    mode: 'real_application' | 'static_html' | 'fallback_preview';
    entryPoint?: string;
    interactiveState?: boolean;
    errors?: string[];
  } | string;
  functionalStatus?: {
    status: 'passed' | 'failed' | 'partial';
    navigationPassed?: boolean;
    formsPassed?: boolean;
    responsiveLayoutPassed?: boolean;
    apiIntegrationPassed?: boolean;
    requirementsCompleted?: number;
    totalRequirements?: number;
    regressionFailures?: string[];
    details?: string;
  } | string;
  browserRuntimeVerification?: BrowserRuntimeVerificationReport;
  knownLimitations?: string[];
  finalOutcome?: {
    verdict: VerificationVerdict;
    summary: string;
  } | string;
  syntaxChecksPassed: boolean;
  typeChecksPassed: boolean;
  previewMode?: 'real_application' | 'static_html' | 'fallback_preview';
  previewPassed?: boolean;
  testExecution: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    details: Array<{ name: string; status: 'passed' | 'failed' | 'skipped' | boolean; message?: string }>;
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
  verdictExplanation?: string;
}

export interface PatchEdit {
  find: string;
  replace: string;
}

export interface PatchAction {
  action?: 'patch_file';
  path: string;
  edits: PatchEdit[];
  taskId?: string;
  commitMessage?: string;
  expectedVersion?: number;
}

export interface CreateFileAction {
  action: 'create_file';
  path: string;
  content: string;
  taskId?: string;
  commitMessage?: string;
}

export interface DeleteFileAction {
  action: 'delete_file';
  path: string;
  taskId?: string;
  commitMessage?: string;
}

export interface RenameFileAction {
  action: 'rename_file';
  oldPath: string;
  newPath: string;
  taskId?: string;
  commitMessage?: string;
}

export interface CreateTaskAction {
  action: 'create_task';
  title: string;
  description: string;
  filePaths: string[];
  priority?: TaskPriority;
  dependencies?: string[];
  assignedRole?: AgentRole;
  milestone?: string;
}

export interface ModelActionResponse {
  actions: Array<PatchAction | CreateFileAction | DeleteFileAction | RenameFileAction | CreateTaskAction>;
  error?: string;
}

export type GatewayErrorCode = 
  | 'INVALID_API_KEY' 
  | 'RATE_LIMITED' 
  | 'NETWORK_ERROR' 
  | 'UNSUPPORTED_MODEL' 
  | 'MALFORMED_OUTPUT' 
  | 'PROVIDER_ERROR' 
  | 'NO_PROVIDER'
  | 'QUOTA_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'CONTEXT_OVERFLOW'
  | 'COOLDOWN_ACTIVE'
  | 'LOCAL_LLM_OFFLINE'
  | 'AUTHENTICATION_REQUIRED';

export interface GatewayResult {
  success: boolean;
  rawText: string;
  parsedResponse: ModelActionResponse | null;
  tokensUsed: number;
  inputTokens?: number;
  outputTokens?: number;
  isEstimatedTokens?: boolean;
  modelId: string;
  actualModelUsed: string;
  providerUsed: 'openrouter' | 'gemini' | 'local' | 'direct' | 'none';
  isFallback: boolean;
  fallbackReason?: string;
  isLocal?: boolean;
  latencyMs: number;
  estimatedCost?: number;
  actualCost?: number;
  cached?: boolean;
  error?: string;
  errorCode?: GatewayErrorCode;
}

export interface VerifierResponse {
  approved: boolean;
  summary: string;
  missingRequirements?: string[];
  confidence?: number;
}

// --- QUOTA & RATE LIMITING TYPES ---
export type ProviderHealthStatus = 
  | 'healthy' 
  | 'rate_limited' 
  | 'quota_exhausted' 
  | 'auth_error' 
  | 'cooldown' 
  | 'offline';

export interface ProviderQuotaStatus {
  provider: AIProvider;
  modelId?: string;
  status: ProviderHealthStatus;
  consecutiveErrors: number;
  cooldownUntil?: number; // epoch ms
  retryAfterSeconds?: number;
  reportedLimit?: number; // requests or tokens per minute/day if reported by provider
  reportedRemaining?: number; // remaining quota if reported by provider
  reportedResetTime?: number; // epoch ms if reported by provider
  isEstimated: boolean; // true if estimated locally, false if provider-reported
  lastError?: string;
  lastErrorCode?: GatewayErrorCode;
  lastUsedAt?: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
}

// --- LOCAL LLM TYPES ---
export interface LocalLLMConfig {
  enabled: boolean;
  endpointUrl: string; // e.g. http://localhost:11434/v1
  modelName: string;   // e.g. llama3.2, mistral, qwen2.5-coder
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

// --- RESULT CACHING TYPES ---
export type CacheCategory = 
  | 'repo_summary' 
  | 'architecture_analysis' 
  | 'dependency_info' 
  | 'file_summary' 
  | 'deterministic_analysis';

export interface CacheEntry<T = any> {
  key: string;
  category: CacheCategory;
  userId?: string; // strictly isolated between users
  buildId?: string;
  modelId: string;
  inputHash: string;
  data: T;
  estimatedTokensSaved: number;
  hits: number;
  createdAt: number;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entriesCount: number;
  tokensSaved: number;
  estimatedCostSaved: number;
}

// --- TOKEN OPTIMIZATION & BUDGETING TYPES ---
export interface TokenBudgetConfig {
  maxInputTokens: number;
  maxOutputTokens: number;
  reservedForOutput: number;
}

export interface TokenEstimationResult {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  totalEstimatedTokens: number;
  contextWindow: number;
  fitsWithinContext: boolean;
  reason?: string;
}

// --- USAGE TRACKING & DASHBOARD TYPES ---
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
  provider: AIProvider;
  providerUsed?: string;
  isFallback: boolean;
  fallbackReason?: string;
  isLocal?: boolean;
  estimatedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  totalTokens: number;
  estimatedCost: number;
  billedCost?: number;
  taskComplexity?: 'low' | 'standard' | 'high' | 'expert';
  isCached?: boolean;
  cached?: boolean;
  latencyMs: number;
  success: boolean;
  error?: string;
  errorCode?: GatewayErrorCode;
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
