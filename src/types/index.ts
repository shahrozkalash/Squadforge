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
  taskResult?: AgentTaskResult;
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
    durationMs?: number;
    error?: string;
  }>;
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
  changeType?: 'added' | 'removed' | 'modified' | 'reverted' | 'merged';
  isFormattingOnly?: boolean;
}

export type FileHistory = FileVersion;

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
  | 'task_cancelled'
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
  architectureBlueprint?: ArchitectureBlueprint;
  requirementsAnalysis?: RequirementsAnalysis;
  complexityAssessment?: ProjectComplexityAssessment;
  fileStructurePlan?: FileStructurePlan;
  dependencyPlan?: ArchitectureDependencyPlan;
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
    status?: 'passed' | 'failed';
    syntaxPassed: boolean;
    typePassed: boolean;
    previewBundlePassed: boolean;
    errors?: string[];
  } | string;
  runtimeStatus?: {
    status?: 'passed' | 'failed';
    mode: 'real_application' | 'static_html' | 'fallback_preview';
    entryPoint?: string;
    interactiveState: boolean;
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
  score: number;
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
  id: string;
  buildId: string;
  role: AgentRole;
  name: string;
  modelId: string;
  status: AgentLifecycleState;
  capabilities: string[];
  responsibilities: string[];
  assignedTaskIds: string[];
  currentTaskId: string | null;
  workloadScore: number;
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
  recipient: string;
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
  testEvidence: string;
  verdict: CodeReviewVerdict;
  status: 'pending' | 'under_review' | 'completed' | 'revising';
  reviewChecks: CodeReviewChecks;
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
  reviewStatus: 'pending' | 'reviewed' | 'approved' | 'changes_requested' | 'rejected';
  applicationStatus: 'proposed' | 'validating' | 'approved' | 'applied' | 'rejected' | 'conflict';
  appliedFileVersion?: number;
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
  | 'Database design'
  | 'database_design'
  | 'API contracts'
  | 'Security'
  | 'Performance'
  | 'Algorithms'
  | 'Dependencies'
  | 'Implementation strategy'
  | 'Testing strategy'
  | 'Maintainability';

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
  maxRounds: number;
  roundsCount?: number;
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
  | 'multi_file_wide_modification';

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
  createdAt: number;
  resolvedAt?: number;
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


