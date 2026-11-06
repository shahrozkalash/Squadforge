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
  | 'database_engineer'
  | 'integration_specialist'
  | 'integration_engineer'
  | 'qa_testing_specialist'
  | 'qa_engineer'
  | 'debugging_specialist'
  | 'security_specialist'
  | 'devops_release_specialist'
  | 'fullstack_developer'
  | 'ui_ux_designer'
  | 'performance_engineer'
  | 'documentation_engineer';

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
  contentHash?: string;
}

export interface ProjectFile {
  id?: string;
  buildId?: string;
  path: string;
  content: string;
  version: number;
  ownerModel?: string;
  history?: FileVersion[];
  leaseOwner?: string | null;
  leaseExpiresAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  originalPath?: string;
  isRenamed?: boolean;
  isDeleted?: boolean;
  isRecreated?: boolean;
  contentHash?: string;
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
  | 'task_cancelled'
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
  | 'build_failed'
  | 'agent_message_sent'
  | 'task_delegated'
  | 'code_review_requested'
  | 'code_review_completed'
  | 'patch_proposed'
  | 'file_conflict_detected'
  | 'file_conflict_resolved'
  | 'ai_challenge_started'
  | 'ai_challenge_concluded'
  | 'defect_reported'
  | 'defect_resolved'
  | 'approval_requested'
  | 'approval_responded'
  | 'knowledge_shared'
  | 'codegen_started'
  | 'codegen_pass_started'
  | 'codegen_pass_completed'
  | 'codegen_approval_required'
  | 'codegen_completed_with_warnings'
  | 'codegen_finalized'
  | 'codegen_failed'
  | 'codegen_cancelled'
  | 'repair_started'
  | 'repair_applied'
  | 'repair_verified'
  | 'repair_failed'
  | 'repair_rolled_back';

export interface SwarmEvent {
  id: string;
  buildId: string;
  timestamp: number;
  type: EventType;
  modelId?: string;
  taskId?: string;
  filePath?: string;
  details: string;
  message?: string;
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
  architectureBlueprint?: ArchitectureBlueprint;
  requirementsAnalysis?: RequirementsAnalysis;
  complexityAssessment?: ProjectComplexityAssessment;
  fileStructurePlan?: FileStructurePlan;
  dependencyPlan?: ArchitectureDependencyPlan;
  applicationPlan?: FullStackApplicationPlan;
  connectedValidation?: ConnectedValidationReport;
}

export type CanonicalProjectType = 
  | 'landing_page' 
  | 'portfolio' 
  | 'blog' 
  | 'ecommerce' 
  | 'saas' 
  | 'web_application' 
  | 'api_service' 
  | 'backend_service' 
  | 'desktop_application' 
  | 'windows_application' 
  | 'cross_platform_desktop' 
  | 'android_application' 
  | 'cross_platform_mobile' 
  | 'cli_tool' 
  | 'developer_tool' 
  | 'automation_tool' 
  | 'data_application' 
  | 'creative_application' 
  | 'multimedia_application' 
  | '3d_application' 
  | 'engineering_application' 
  | 'game_application' 
  | 'fullstack' 
  | 'custom';

export type LegacyProjectType = 
  | 'saas_dashboard' 
  | 'blog_content' 
  | 'blog_publication' 
  | 'fullstack_app' 
  | 'internal_tool';

export type ProjectType = CanonicalProjectType | LegacyProjectType | (string & {});

export const CANONICAL_PROJECT_TYPES: CanonicalProjectType[] = [
  'landing_page', 'portfolio', 'blog', 'ecommerce', 'saas', 'web_application',
  'api_service', 'backend_service', 'desktop_application', 'windows_application',
  'cross_platform_desktop', 'android_application', 'cross_platform_mobile',
  'cli_tool', 'developer_tool', 'automation_tool', 'data_application',
  'creative_application', 'multimedia_application', '3d_application',
  'engineering_application', 'game_application', 'fullstack', 'custom'
];

export const LEGACY_PROJECT_TYPES: LegacyProjectType[] = [
  'saas_dashboard', 'blog_content', 'blog_publication', 'fullstack_app', 'internal_tool'
];

export function normalizeProjectType(rawType?: string | null): CanonicalProjectType {
  if (!rawType || typeof rawType !== 'string') return 'custom';
  const clean = rawType.toLowerCase().trim();
  
  if (clean === 'saas_dashboard') return 'saas';
  if (clean === 'blog_content' || clean === 'blog_publication') return 'blog';
  if (clean === 'fullstack_app') return 'fullstack';
  if (clean === 'internal_tool') return 'developer_tool';
  
  if (CANONICAL_PROJECT_TYPES.includes(clean as CanonicalProjectType)) {
    return clean as CanonicalProjectType;
  }
  
  return 'custom';
}

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
  edits?: PatchEdit[];
  find?: string;
  replace?: string;
  taskId?: string;
  commitMessage?: string;
  explanation?: string;
  expectedVersion?: number;
  expectedContentHash?: string;
}

export interface CreateFileAction {
  action: 'create_file';
  path: string;
  content: string;
  taskId?: string;
  commitMessage?: string;
  explanation?: string;
}

export interface DeleteFileAction {
  action: 'delete_file';
  path: string;
  taskId?: string;
  commitMessage?: string;
  explanation?: string;
}

export interface RenameFileAction {
  action: 'rename_file';
  oldPath: string;
  newPath: string;
  taskId?: string;
  commitMessage?: string;
  explanation?: string;
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
  explanation?: string;
}

export interface ModelActionResponse {
  actions: Array<PatchAction | CreateFileAction | DeleteFileAction | RenameFileAction | CreateTaskAction>;
  thinking?: string;
  error?: string;
  /** Structured answer from an agent that investigates or reviews. */
  report?: Record<string, unknown>;
}

export type GatewayErrorCode = 
  | 'CANCELLED'
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

// ============================================================================
// Phase 7: Universal Software Architecture Engine Types
// ============================================================================

export type TargetPlatform = 
  | 'web' 
  | 'windows' 
  | 'macos' 
  | 'linux' 
  | 'android' 
  | 'ios' 
  | 'cross_platform' 
  | 'cli' 
  | 'cloud' 
  | 'embedded';

export interface ConfirmedRequirement {
  id: string;
  statement: string;
  category: 'functional' | 'ui' | 'backend' | 'data' | 'security' | 'integration' | 'performance';
  priority: 'must_have' | 'should_have' | 'nice_to_have';
  source: 'user_prompt';
}

export interface TechnicalAssumption {
  id: string;
  statement: string;
  category: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  validated: boolean;
}

export interface UnresolvedQuestion {
  id: string;
  question: string;
  category: string;
  impact: string;
  suggestedResolution?: string;
}

export interface RequirementsAnalysis {
  mainPurpose: string;
  targetUsers: string[];
  applicationCategory: CanonicalProjectType;
  targetPlatforms: TargetPlatform[];
  requiredFeatures: string[];
  coreFunctionality: string[];
  uiRequirements: string[];
  backendRequirements: string[];
  dataStorageRequirements: string[];
  externalIntegrations: string[];
  performanceRequirements: string[];
  securityRequirements: string[];
  deploymentRequirements: string[];
  technicalConstraints: string[];
  confirmedRequirements: ConfirmedRequirement[];
  assumptions: TechnicalAssumption[];
  unresolvedQuestions: UnresolvedQuestion[];
  originalPrompt: string;
  analyzedAt: number;
}

export type TechCategory = 
  | 'frontend' 
  | 'backend' 
  | 'fullstack' 
  | 'desktop' 
  | 'mobile' 
  | 'systems' 
  | 'database' 
  | 'graphics_3d' 
  | 'tooling' 
  | 'testing' 
  | 'security';

export type CompatibilityStatus = 
  | 'verified' 
  | 'candidate' 
  | 'experimental' 
  | 'external_runtime_required';

export interface TechRegistryEntry {
  id: string;
  displayName: string;
  category: TechCategory;
  supportedPlatforms: TargetPlatform[];
  programmingLanguages: string[];
  projectTypes: CanonicalProjectType[];
  compatibilityRequirements?: string[];
  runtimeRequirements: string[];
  buildTooling: string[];
  packageManager?: string;
  testingEcosystem: string[];
  deploymentOptions: string[];
  knownLimitations: string[];
  documentationReference: string;
  compatibilityStatus: CompatibilityStatus;
}

export interface TechStackBlueprint {
  name: string;
  frontend?: string;
  backend?: string;
  desktopFramework?: string;
  mobileFramework?: string;
  runtime?: string;
  database?: string;
  testing?: string;
  buildTool?: string;
  packageManager?: string;
  primaryLanguage: string;
  uiFramework?: string;
  graphicsApi?: string;
}

export interface StackSelectionResult {
  recommendedStack: TechStackBlueprint;
  alternativeStack: TechStackBlueprint;
  explanation: string;
  compatibilityWarnings: string[];
  knownLimitations: string[];
  requiredDevelopmentTools: string[];
  runtimeRequirements: string[];
  buildAndTestingRequirements: string[];
  isPreservedStack?: boolean;
}

export interface ArchitectureLayer {
  name: string;
  responsibility: string;
  components: string[];
  technologies: string[];
}

export interface ArchitectureModule {
  id: string;
  name: string;
  description: string;
  layer: string;
  responsibilities: string[];
  files: string[];
  dependencies: string[];
  exports: string[];
}

export interface ApiContract {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'IPC' | 'WS' | 'CLI_ARG';
  description: string;
  requestPayload?: string;
  responsePayload?: string;
}

export interface DataFlowStep {
  step: number;
  from: string;
  to: string;
  data: string;
  mechanism: string;
}

export interface SecurityBoundary {
  name: string;
  trustZone: 'public' | 'authenticated' | 'internal' | 'native_os' | 'storage';
  controls: string[];
}

export interface ArchitectureRisk {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigation: string;
}

export interface ArchitectureBlueprint {
  projectClassification: CanonicalProjectType;
  projectSummary: string;
  targetPlatforms: TargetPlatform[];
  technologyDecisions: Record<string, string>;
  applicationLayers: ArchitectureLayer[];
  moduleStructure: ArchitectureModule[];
  componentResponsibilities: Record<string, string[]>;
  frontendArchitecture?: {
    framework: string;
    routing: string;
    stateManagement: string;
    styling: string;
    responsiveBreakpoints: string[];
  };
  backendArchitecture?: {
    framework: string;
    pattern: string;
    apiStyle: 'rest' | 'graphql' | 'grpc' | 'ipc' | 'cli' | 'event_driven';
    endpoints?: string[];
  };
  databaseArchitecture?: {
    engine: string;
    paradigm: 'relational' | 'document' | 'key_value' | 'sqlite' | 'embedded' | 'in_memory' | 'none';
    schemaSummary: string;
  };
  apiContracts?: ApiContract[];
  dataFlow: DataFlowStep[];
  authRequirements?: {
    mechanism: string;
    roles: string[];
    tokenHandling: string;
  };
  fileStorageRequirements?: {
    strategy: string;
    allowedFormats: string[];
    maxSizeBytes?: number;
  };
  externalIntegrations: string[];
  errorHandlingStrategy: string;
  securityBoundaries: SecurityBoundary[];
  testingStrategy: {
    unit: string;
    integration: string;
    e2e?: string;
    automatedCoverageGoalPercent: number;
  };
  buildStrategy: {
    tool: string;
    artifactType: string;
    productionCommand: string;
  };
  deploymentStrategy: {
    target: string;
    containerized: boolean;
    configFiles: string[];
  };
  architectureRisks: ArchitectureRisk[];
  technicalAssumptions: string[];
  generatedAt: number;
}

export type ProjectComplexityLevel = 
  | 'small' 
  | 'medium' 
  | 'large' 
  | 'very_large' 
  | 'enterprise_scale';

export interface ProjectComplexityAssessment {
  level: ProjectComplexityLevel;
  score: number; // 1 to 100
  estimatedModulesCount: number;
  approximateImplementationStages: string[];
  requiredSpecialistRoles: AgentRole[];
  integrationComplexity: 'low' | 'moderate' | 'high' | 'critical';
  testingComplexity: 'low' | 'moderate' | 'high' | 'critical';
  expectedRuntimeRequirements: string[];
  externalDependenciesCount: number;
  majorTechnicalRisks: string[];
  rationale: string;
}

export interface PlannedDirectory {
  path: string;
  purpose: string;
}

export interface PlannedFile {
  path: string;
  responsibility: string;
  role: AgentRole;
  priority: number;
}

export interface FileStructurePlan {
  rootDirectories: PlannedDirectory[];
  suggestedFiles: PlannedFile[];
  ecosystemConventions: string[];
}

export interface ArchitectureDependencyItem {
  name: string;
  version?: string;
  category: 'runtime' | 'dev' | 'system' | 'sdk';
  purpose: string;
  verifiedInEnvironment: boolean;
}

export interface ArchitectureDependencyPlan {
  requiredDependencies: ArchitectureDependencyItem[];
  optionalDependencies: ArchitectureDependencyItem[];
  incompatibleVersionsDetected: string[];
  osSpecificDependencies: Array<{ os: string; dependencies: string[] }>;
  missingRuntimeRequirements: string[];
  unnecessaryDuplicates: string[];
  nativeCompilationRequired: boolean;
  installationPrerequisites: string[];
  unverifiableDependencies: string[];
}

// ==========================================
// PHASE 8: COLLABORATIVE AI DEVELOPMENT SYSTEM
// ==========================================

export type AgentLifecycleState = 
  | 'idle'
  | 'assigned'
  | 'analyzing'
  | 'working'
  | 'awaiting_review'
  | 'revising'
  | 'blocked'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

export interface AgentWorkHistoryItem {
  timestamp: number;
  action: string;
  details: string;
  taskId?: string;
  relatedFile?: string;
}

export interface AgentProfile {
  id: string; // role or model-scoped unique ID
  buildId: string;
  role: AgentRole;
  name: string;
  modelId: string;
  status: AgentLifecycleState;
  capabilities: string[];
  responsibilities: string[];
  assignedTaskIds: string[];
  currentTaskId: string | null;
  workloadScore: number; // 0-100
  collaborationPermissions: string[];
  workHistory: AgentWorkHistoryItem[];
  lastActive: number;
  modelStatus: string;
  metadata?: Record<string, any>;
}

export type AgentMessageType = 
  | 'task_assignment'
  | 'task_update'
  | 'progress_report'
  | 'implementation_proposal'
  | 'review_request'
  | 'review_response'
  | 'code_comment'
  | 'bug_report'
  | 'debugging_request'
  | 'architecture_question'
  | 'architecture_proposal'
  | 'architecture_decision'
  | 'patch_proposal'
  | 'patch_update'
  | 'test_report'
  | 'conflict_report'
  | 'approval_request'
  | 'approval_response'
  | 'knowledge_share';

export interface AgentMessage {
  id: string;
  buildId: string;
  projectId: string;
  sender: string;
  senderRole: AgentRole;
  recipient: string; // 'broadcast' | agent role | agent ID
  relatedTaskId?: string;
  relatedFiles: string[];
  relevantFileVersions?: Record<string, number>;
  messageType: AgentMessageType;
  content: string;
  structuredMetadata?: Record<string, any>;
  parentMessageId?: string;
  depth: number;
  timestamp: number;
  processingStatus: 'delivered' | 'processed' | 'pending' | 'flagged';
}

export type CodeReviewVerdict = 
  | 'approved'
  | 'approved_with_suggestions'
  | 'changes_requested'
  | 'rejected'
  | 'blocked';

export interface CodeReviewChecks {
  logicCorrectness: boolean;
  errorHandling: boolean;
  security: boolean;
  inputValidation: boolean;
  apiCompatibility: boolean;
  databaseIntegrity: boolean;
  performance: boolean;
  maintainability: boolean;
  architectureConsistency: boolean;
  dependencyRisks: boolean;
  testCoverage: boolean;
  requirementCompliance: boolean;
}

export interface CodeReviewComment {
  id: string;
  reviewId: string;
  buildId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  severity: 'nit' | 'suggestion' | 'warning' | 'critical';
  explanation: string;
  suggestedCorrection?: string;
  relatedRequirement?: string;
  status: 'open' | 'addressed' | 'dismissed';
  author: string;
  authorRole: AgentRole;
  timestamp: number;
}

export interface CodeReview {
  id: string;
  buildId: string;
  taskId: string;
  patchId?: string;
  authorAgent: string;
  authorRole: AgentRole;
  reviewerAgent: string;
  reviewerRole: AgentRole;
  changedFiles: string[];
  baseVersions: Record<string, number>;
  proposedChanges: Array<{ filePath: string; action: string; diffSnippet?: string }>;
  requirementsAddressed: string[];
  implementationExplanation: string;
  explanation?: string;
  testEvidence: string;
  verdict: CodeReviewVerdict | 'pending';
  status: 'pending' | 'under_review' | 'completed' | 'revising';
  reviewChecks: CodeReviewChecks;
  checks?: Record<string, boolean>;
  comments: CodeReviewComment[];
  createdAt: number;
  updatedAt: number;
}

export interface PatchProposalHunk {
  actionType: 'patch' | 'create' | 'delete' | 'rename';
  find?: string;
  replace?: string;
  content?: string;
  oldPath?: string;
  newPath?: string;
}

export interface PatchProposal {
  id: string;
  buildId: string;
  authorAgent: string;
  authorRole: AgentRole;
  relatedTaskId: string;
  targetFile: string;
  baseFileVersion: number;
  baseContentHash: string;
  proposedChanges: PatchProposalHunk;
  changeExplanation: string;
  expectedBehavior: string;
  validationResults: {
    syntaxValid: boolean;
    pathAllowed: boolean;
    hashMatched: boolean;
    versionCurrent: boolean;
    errors: string[];
  };
  validationStatus?: string;
  reviewStatus: 'pending' | 'reviewed' | 'approved' | 'changes_requested' | 'rejected';
  applicationStatus: 'proposed' | 'validating' | 'approved' | 'applied' | 'rejected' | 'conflict' | 'pending';
  appliedFileVersion?: number;
  hunks?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; content: string }>;
  createdAt: number;
  updatedAt: number;
}

export interface CompetingPatchHunk {
  patchId: string;
  authorAgent: string;
  authorRole?: AgentRole;
  proposedHunk: string;
  timestamp: number;
}

export interface OverlappingHunk {
  startLine: number;
  endLine: number;
  conflictSummary: string;
}

export interface FileConflict {
  id: string;
  buildId: string;
  filePath: string;
  targetFile?: string;
  baseVersion: number;
  baseFileVersion?: number;
  conflictingVersions: number[];
  competingPatches: CompetingPatchHunk[];
  reason: string;
  overlappingHunks: OverlappingHunk[];
  resolutionStatus: 'open' | 'investigating' | 'resolved' | 'abandoned';
  status?: 'open' | 'investigating' | 'resolved' | 'abandoned' | 'detected' | 'resolving';
  resolvedBy?: string;
  resolvedContent?: string;
  resolvedVersion?: number;
  createdAt: number;
  resolvedAt?: number;
}

export type AIChallengeSubject = 
  | 'Architecture'
  | 'architecture'
  | 'Database design'
  | 'database_design'
  | 'API contracts'
  | 'api_contracts'
  | 'Security'
  | 'security'
  | 'Performance'
  | 'performance'
  | 'Algorithms'
  | 'algorithms'
  | 'Dependencies'
  | 'dependencies'
  | 'Implementation strategy'
  | 'implementation_strategy'
  | 'Testing strategy'
  | 'testing_strategy'
  | 'Maintainability'
  | 'maintainability';

export type AIChallengeOutcome = 
  | 'pending'
  | 'accepted'
  | 'accepted_with_changes'
  | 'rejected'
  | 'deferred'
  | 'escalated_to_human';

export interface AIChallengeArgument {
  id: string;
  challengeId: string;
  roundNumber: number;
  authorAgent: string;
  authorRole: AgentRole;
  agentRole?: AgentRole;
  round?: number;
  argument?: string;
  argumentType: 'pro' | 'con' | 'alternative' | 'counter_evidence';
  claim: string;
  evidence: string;
  proposedAlternative?: string;
  identifiedRisks: string[];
  timestamp: number;
}

export interface AIChallenge {
  id: string;
  buildId: string;
  taskId?: string;
  subject: AIChallengeSubject;
  originalProposal: string;
  proposerAgent: string;
  proposerRole: AgentRole;
  challengerAgent: string;
  challengerRole: AgentRole;
  currentRound: number;
  maxRounds: number; // strictly limited to e.g. 3 rounds
  status: 'active' | 'evaluating' | 'concluded';
  outcome: AIChallengeOutcome;
  finalDecision?: string;
  decisionRationale?: string;
  participants: string[];
  arguments: AIChallengeArgument[];
  createdAt: number;
  updatedAt: number;
}

export type DefectSeverity = 'low' | 'medium' | 'high' | 'critical';
export type DefectStatus = 
  | 'open'
  | 'investigating'
  | 'identified'
  | 'fixing'
  | 'awaiting_review'
  | 'verifying'
  | 'resolved'
  | 'reopened';

export interface DefectSolution {
  solutionId: string;
  author: string;
  authorRole?: AgentRole;
  proposal: string;
  patchId?: string;
  score?: number;
}

export interface CollaborativeDefect {
  id: string;
  buildId: string;
  taskId?: string;
  title: string;
  description: string;
  severity: DefectSeverity;
  status: DefectStatus;
  reproductionSteps: string[];
  expectedBehavior: string;
  actualBehavior: string;
  affectedFiles: string[];
  assignedAgents: string[];
  rootCause?: string;
  proposedSolutions: DefectSolution[];
  selectedPatchId?: string;
  testEvidence?: string;
  verificationEvidence?: string;
  verificationDetails?: {
    syntaxPassed: boolean;
    testsPassed: boolean;
    evidenceText: string;
    verifiedAt: number;
  };
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

export type ApprovalOperationType = 
  | 'destructive_file_op'
  | 'major_architecture_change'
  | 'database_migration'
  | 'security_sensitive_change'
  | 'large_dependency_change'
  | 'project_rollback'
  | 'multi_file_wide_modification'
  | 'code_execution'
  | 'dependency_install'
  | 'install_scripts';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface HumanApprovalRequest {
  id: string;
  buildId: string;
  taskId?: string;
  patchId?: string;
  requestingAgent: string;
  requestingRole: AgentRole;
  requestedByRole?: AgentRole;
  operationType: ApprovalOperationType;
  explanation: string;
  rationale?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedFiles: string[];
  proposedChanges: string;
  reviewResults?: string;
  testResults?: string;
  status: ApprovalStatus;
  approvedBy?: string;
  resolutionNotes?: string;
  /** Ties an execution approval to one exact workspace. */
  scopeHash?: string;
  /** Fingerprint of the reviewed change for each file. */
  contentHashes?: Record<string, string>;
  /** Files this approval has already been used for. Approvals work once per file. */
  consumedFiles?: string[];
  /** The exact reviewed changes, applied when the owner approves. */
  proposedActions?: any[];
  createdAt: number;
  resolvedAt?: number;
}

export type ExecutionSessionStatus =
  | 'creating'
  | 'ready'
  | 'installing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'destroyed'
  | 'failed';

export type ExecutionEndReason =
  | 'exited'
  | 'failed'
  | 'stopped'
  | 'timed_out'
  | 'out_of_memory'
  | 'disk_limit';

export type DependencyStatus =
  | 'not_started'
  | 'not_required'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'unsupported';

export interface ExecutionSession {
  id: string;
  buildId: string;
  userId: string;
  status: ExecutionSessionStatus;
  backend: string;
  workspaceHash: string;
  script?: string;
  processId?: string;
  exitCode?: number;
  endReason?: ExecutionEndReason;
  failureReason?: string;
  dependencyStatus: DependencyStatus;
  missingDependencies: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  stoppedAt?: number;
  lastActivityAt: number;
}

export interface ExecutionLogEntry {
  id: number;
  sessionId: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  createdAt: number;
}

export interface DependencyInstallRecord {
  id: string;
  sessionId: string;
  buildId: string;
  packageManager: string;
  command: string;
  status: 'installing' | 'installed' | 'failed';
  error?: string;
  lockfileGenerated: boolean;
  startedAt: number;
  finishedAt?: number;
}

export interface PreviewSession {
  id: string;
  sessionId: string;
  buildId: string;
  userId: string;
  status: 'active' | 'closed';
  port: number;
  relayHost: string;
  relayPort: number;
  /** Sent to the relay only. Must never reach a client. */
  relayToken?: string;
  tokenHash?: string;
  tokenExpiresAt?: number;
  cookieHash?: string;
  createdAt: number;
  lastAccessAt: number;
}

export type KnowledgeCategory = 
  | 'architecture_decision'
  | 'adr'
  | 'pattern'
  | 'interface_contract'
  | 'implementation_discovery'
  | 'resolved_defect'
  | 'known_limitation'
  | 'reusable_solution'
  | 'dependency_decision'
  | 'testing_requirement'
  | 'important_warning'
  | 'unresolved_question';

export interface SharedKnowledgeItem {
  id: string;
  projectId: string;
  buildId: string;
  sourceAgent: string;
  sourceRole: AgentRole;
  sourceTaskId?: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  relevantFiles: string[];
  version: number;
  previousVersionId?: string;
  supersedesId?: string;
  status: 'active' | 'superseded' | 'deprecated';
  supersedeReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CollaborationOverview {
  activeAgents: AgentProfile[];
  agentProfiles?: AgentProfile[];
  messageCount: number;
  pendingReviewsCount: number;
  proposedPatchesCount: number;
  activeChallengesCount: number;
  openDefectsCount: number;
  activeConflictsCount: number;
  pendingApprovalsCount: number;
  knowledgeItemsCount: number;
}

// ==========================================
// PHASE 9: INTELLIGENT CODE GENERATION ENGINE
// ==========================================

export type GenerationProfileType =
  | 'website_and_web_app'
  | 'saas_platform'
  | 'ecommerce_app'
  | 'rest_api_backend'
  | 'desktop_application'
  | 'android_mobile_application'
  | 'cli_tool_developer_utility'
  | 'automation_software'
  | 'data_processing_application'
  | 'game_creative_application'
  | 'multimedia_application';

export interface GenerationProfilePlatformConstraints {
  supported: boolean;
  supportedRuntimes: string[];
  limitationNotice?: string;
  recommendedPackaging?: string;
}

export interface GenerationProfile {
  id: GenerationProfileType;
  displayName: string;
  category: string;
  description: string;
  architectureOverview: string;
  defaultFileOrganization: string[];
  typicalDependencies: string[];
  requiredContracts: string[];
  codingConventions: string[];
  validationRules: string[];
  platformConstraints: GenerationProfilePlatformConstraints;
}

export type ProjectContractType = 
  | 'typescript_interface'
  | 'api_schema'
  | 'database_model'
  | 'component_props'
  | 'service_interface'
  | 'module_dependency'
  | 'shared_constant';

export interface ContractField {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ProjectContract {
  id: string;
  type: ProjectContractType;
  name: string;
  filePath: string;
  signature: string;
  description: string;
  fieldsOrParams?: ContractField[];
  returnOrResponseType?: string;
  relatedContracts?: string[];
}

export interface DiscoveredFileContext {
  path: string;
  reason: string;
  priority: number;
  contentSnippet?: string;
  byteLength: number;
  lastModified?: number;
}

export interface DiscoveredComponent {
  name: string;
  path: string;
  propsContract?: string;
  isExported: boolean;
  importedBy?: string[];
}

export interface DiscoveredApiEndpoint {
  method: string;
  path: string;
  requestType?: string;
  responseType?: string;
  handlerFunction?: string;
}

export interface DiscoveredDatabaseModel {
  name: string;
  fields: string[];
  relations?: string[];
}

export interface ProjectContext {
  relevantFiles: DiscoveredFileContext[];
  establishedContracts: ProjectContract[];
  detectedComponents: DiscoveredComponent[];
  apiEndpoints: DiscoveredApiEndpoint[];
  databaseModels: DiscoveredDatabaseModel[];
  codingConventions: string[];
  dependencies: Record<string, string>;
  tokenUsageEstimate: number;
}

export type GenerationPassName = 
  | 'planning'
  | 'generation'
  | 'integration'
  | 'validation'
  | 'repair'
  | 'finalization';

export type GenerationPassStatus = 'pending' | 'in_progress' | 'passed' | 'failed' | 'skipped';

export interface GenerationPass {
  passNumber: number;
  passName: GenerationPassName;
  status: GenerationPassStatus;
  summary: string;
  diagnostics?: string[];
  durationMs?: number;
}

export type CodeGenerationStatus = 
  | 'planning'
  | 'generating'
  | 'integrating'
  | 'validating'
  | 'repairing'
  | 'finalizing'
  | 'finalized'
  | 'completed_with_warnings'
  | 'pending_approval'
  | 'cancelled'
  | 'failed';

export interface RepairAttemptLog {
  attempt: number;
  file: string;
  defect: string;
  action: string;
  outcome: 'resolved' | 'unresolved';
  timestamp: number;
}

export interface CodeGenerationRun {
  id: string;
  buildId: string;
  taskId?: string;
  userRequest: string;
  generationProfile: GenerationProfileType;
  modelId: string;
  status: CodeGenerationStatus;
  requiresApproval?: boolean;
  currentPass: number;
  totalPasses: number;
  passes: GenerationPass[];
  filesCreated: string[];
  filesModified: string[];
  patchIds: string[];
  contractsEstablished: ProjectContract[];
  validationResults?: any;
  repairAttempts: number;
  repairLogs: RepairAttemptLog[];
  tokenUsage: number;
  cost: number;
  error?: string;
  cancellationReason?: string;
  cancelledAt?: number;
  createdAt: number;
  completedAt?: number;
}

export interface IncrementalFileEdit {
  filePath: string;
  action: 'create' | 'patch' | 'delete' | 'rename';
  targetSymbol?: string;
  findSnippet?: string;
  replacementContent: string;
  expectedBaseVersion: number;
  expectedContentHash: string;
  explanation: string;
}

export interface AutomaticRepairResult {
  success: boolean;
  resolvedDefects: string[];
  unresolvedDefects: string[];
  repairAttemptsCount: number;
  modifiedFiles: string[];
  validationEvidence: any;
}

// --- Phase 11: debugging and repair ---

export type DiagnosticKind =
  | 'syntax'
  | 'type'
  | 'build'
  | 'runtime'
  | 'api'
  | 'dependency'
  | 'test'
  | 'integration'
  | 'contract'
  | 'config';

/** Only static diagnostics can be re-checked without running the project. */
export type DiagnosticSource = 'static' | 'sandbox' | 'reported';

export interface DebugDiagnostic {
  /** Stable across line moves, so the same problem can be followed through a repair. */
  fingerprint: string;
  kind: DiagnosticKind;
  source: DiagnosticSource;
  message: string;
  filePath?: string;
  /** Another file the message points at, such as the module missing an export. */
  relatedFile?: string;
  line?: number;
  column?: number;
  code?: string;
  stack?: string[];
  sessionId?: string;
  /** The script that failed, which a session can later replace with another. */
  script?: string;
  occurrences: number;
}

export interface DiagnosticCheck {
  name: DiagnosticKind;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}

export interface DiagnosticReport {
  buildId: string;
  workspaceHash: string;
  diagnostics: DebugDiagnostic[];
  /** From runs of an older workspace. Shown, but never a repair target. */
  staleDiagnostics: DebugDiagnostic[];
  checks: DiagnosticCheck[];
  collectedAt: number;
}

export type RootCauseCategory =
  | 'syntax_error'
  | 'missing_dependency'
  | 'missing_module'
  | 'missing_export'
  | 'undefined_symbol'
  | 'null_access'
  | 'type_mismatch'
  | 'contract_violation'
  | 'config_error'
  | 'build_failure'
  | 'test_failure'
  | 'api_failure'
  | 'runtime_crash'
  | 'resource_limit';

export interface RootCause {
  id: string;
  category: RootCauseCategory;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  primaryFile?: string;
  line?: number;
  affectedFiles: string[];
  fingerprints: string[];
  /** Diagnostics explained by this cause rather than being separate problems. */
  cascadedFingerprints: string[];
  evidence: string[];
  leadAgent: AgentRole;
}

export type RepairStatus =
  | 'collecting'
  | 'analyzing'
  | 'investigating'
  | 'proposing'
  | 'validating'
  | 'applying'
  | 'verifying'
  | 'awaiting_approval'
  | 'awaiting_test_approval'
  | 'verified'
  | 'applied_unverified'
  | 'no_action'
  | 'failed'
  | 'rejected'
  | 'rolled_back'
  | 'cancelled';

export interface RepairInvestigation {
  agent: string;
  role: AgentRole;
  hypothesis: string;
  citedFingerprints: string[];
  filesToChange: string[];
  /** False when the agent's answer had no usable evidence, so only the static analysis stands. */
  supported: boolean;
}

export interface PatchValidationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface RepairPatchValidation {
  passed: boolean;
  patchFingerprint: string;
  checks: PatchValidationCheck[];
  changedLines: number;
  clearedFingerprints: string[];
  remainingFingerprints: string[];
  newDiagnostics: string[];
  /** Targets that only a real run can confirm. */
  needsRuntimeProof: string[];
  /** Errors that were hidden until the patch, outside the lines it touched. */
  revealedDiagnostics: string[];
}

export interface RepairAttempt {
  attempt: number;
  agent: string;
  role: AgentRole;
  outcome: 'model_failed' | 'validation_failed' | 'review_rejected' | 'apply_failed' | 'applied' | 'held_for_approval';
  explanation: string;
  actions: any[];
  validation?: RepairPatchValidation;
  review?: { agent: string; role: AgentRole; approved: boolean; reason: string };
  detail?: string;
  timestamp: number;
}

export interface RepairFileChange {
  path: string;
  created: boolean;
  beforeVersion: number;
  beforeHash: string;
  /** Kept only when file history does not hold the earlier version. */
  beforeContent?: string;
  afterVersion: number;
  afterHash: string;
  /** Whole lines to swap back, so a rollback can leave later edits to other lines alone. */
  undoEdits?: Array<{ find: string; replace: string }>;
}

export interface RepairTestEvidence {
  status: 'passed' | 'failed' | 'none_affected' | 'not_run';
  scope?: 'affected' | 'full';
  affectedTests: string[];
  sessionId?: string;
  exitCode?: number;
  endReason?: string;
  detail: string;
}

export interface HttpProbeResult {
  path: string;
  status?: number;
  error?: string;
}

/** What happened when the failed script ran again in the sandbox. */
export interface RepairRuntimeEvidence {
  script: string;
  sessionId: string;
  /** A server stayed up, or a script exited cleanly. */
  survived: boolean;
  /** Whether a server opened a port, and how long it stayed up after that. */
  listening: boolean;
  uptimeMs: number;
  /** Target fingerprints that appeared again. */
  reproduced: string[];
  probes: HttpProbeResult[];
  detail: string;
}

export interface RepairVerification {
  clearedFingerprints: string[];
  remainingFingerprints: string[];
  newDiagnostics: string[];
  needsRuntimeProof: string[];
  /** Problems from checks that could not run before the repair. Shown, never hidden. */
  unmaskedDiagnostics: string[];
  tests: RepairTestEvidence;
  runtime?: RepairRuntimeEvidence;
  checkedAt: number;
}

export interface RepairRollback {
  state: 'pending_approval' | 'conflict' | 'failed' | 'done';
  reason: string;
  conflicts: string[];
  automatic: boolean;
  /** Files where later edits by someone else were kept. */
  keptLaterEdits?: string[];
  at: number;
}

export interface RepairRun {
  id: string;
  buildId: string;
  userId: string;
  status: RepairStatus;
  modelId: string;
  maxAttempts: number;
  /** What the run ended with, in plain words. */
  outcome?: string;
  workspaceHash?: string;
  report?: DiagnosticReport;
  rootCauses: RootCause[];
  targetRootCauseId?: string;
  investigation?: RepairInvestigation;
  attempts: RepairAttempt[];
  patchFingerprint?: string;
  fileChanges: RepairFileChange[];
  /** The project right after the patch, to tell whether anything else changed since. */
  appliedWorkspaceHash?: string;
  verification?: RepairVerification;
  rollback?: RepairRollback;
  pendingApproval?: { requestId: string; purpose: 'apply' | 'tests' | 'rollback' };
  /** The sandbox session in use, so a cancel can stop it. */
  activeSessionId?: string;
  /** False when the session already existed, so the run must not remove it. */
  activeSessionOwned?: boolean;
  /** Continue with the next root cause after this one is verified. */
  repairAll?: boolean;
  chainDepth?: number;
  defectId?: string;
  memoryDefectId?: string;
  tokenUsage: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface RepairLesson {
  id: string;
  outcome: 'verified' | 'failed';
  fingerprints: string[];
  category: RootCauseCategory;
  patchFingerprint?: string;
  summary: string;
  evidence: string;
  files: string[];
  repairId: string;
  /** Every repair that reached this lesson, when there was more than one. */
  repairIds?: string[];
  timesSeen: number;
  createdAt: number;
}

// ============================================================================
// Phase 13: Advanced Application Development Interfaces
// ============================================================================

export type ApplicationProjectMode = 'greenfield' | 'modification';

export interface DatabaseColumnDefinition {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  defaultValue?: string | number;
  references?: string;
}

export interface DatabaseTableDefinition {
  name: string;
  description: string;
  columns: DatabaseColumnDefinition[];
  indices?: string[];
}

export interface DatabaseTopology {
  engine: 'sqlite' | 'in_memory';
  schemaPath: string;
  migrationsDir: string;
  storePath: string;
  migrationRunnerPath: string;
  tables: DatabaseTableDefinition[];
}

export interface ApiEndpointDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  authRequired: boolean;
  roles?: string[];
  requestSchema?: string;
  responseSchema: string;
  rateLimited?: boolean;
}

export interface BackendTopology {
  framework: 'express';
  serverPath: string;
  routesPath: string;
  servicesPath: string;
  middlewarePath: string;
  endpoints: ApiEndpointDefinition[];
}

export interface FrontendComponentDefinition {
  name: string;
  path: string;
  role: 'ui_primitive' | 'domain_widget' | 'layout' | 'view';
  responsibilities: string[];
  responsiveBreakpoints?: string[];
}

export interface FrontendTopology {
  framework: 'react';
  clientApiPath: string;
  hooksPath: string;
  componentsDir: string;
  viewsDir: string;
  entryPath: string;
  components: FrontendComponentDefinition[];
}

export interface SecurityTopology {
  authMechanism: 'session_cookie' | 'bearer_token';
  passwordHashing: 'bcryptjs';
  roles: string[];
  protectedRoutes: string[];
  csrfProtection?: boolean;
}

export interface ConfigurationVariableDefinition {
  key: string;
  description: string;
  required: boolean;
  defaultValue?: string;
  isSecret?: boolean;
}

export interface ConfigurationTopology {
  envExamplePath: string;
  envKeys: ConfigurationVariableDefinition[];
}

export interface ApplicationTopology {
  database: DatabaseTopology;
  backend: BackendTopology;
  frontend: FrontendTopology;
  security: SecurityTopology;
  configuration: ConfigurationTopology;
}

export interface ConnectedDataFlow {
  id: string;
  name: string;
  userAction: string;
  frontendHook: string;
  apiEndpoint: string;
  serviceMethod: string;
  dbModel: string;
  migrationVersion: string;
}

export interface PlannedTieredFile {
  path: string;
  tier: number; // 0 to 6
  purpose: string;
  role: AgentRole;
  isSensitive?: boolean;
  dependsOnFiles?: string[];
}

export interface FullStackApplicationPlan {
  id: string;
  buildId: string;
  mode: ApplicationProjectMode;
  appName: string;
  description: string;
  category: CanonicalProjectType;
  topology: ApplicationTopology;
  connectedFlows: ConnectedDataFlow[];
  plannedFiles: PlannedTieredFile[];
  tasks: Array<{
    title: string;
    description: string;
    filePaths: string[];
    role: AgentRole;
    priority: TaskPriority;
    dependencies: string[];
    tier: number;
  }>;
  createdAt: number;
}

export interface ConnectedValidationCheck {
  category: 'database' | 'api' | 'frontend' | 'security' | 'integration' | 'tests';
  title: string;
  passed: boolean;
  details: string;
  evidence?: string;
}

export interface ConnectedValidationReport {
  verdict: 'verified' | 'passed_with_warnings' | 'rejected';
  score: number; // 0-100
  checks: ConnectedValidationCheck[];
  connectedFlowsVerified: number;
  totalConnectedFlows: number;
  unresolvedIssues: string[];
  timestamp: number;
}

