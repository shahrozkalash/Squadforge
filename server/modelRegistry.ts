import { ModelConfig, AgentRole, AgentSpec } from './types.js';

export const AGENT_SPECS: Record<AgentRole, AgentSpec> = {
  project_manager: {
    role: 'project_manager',
    title: 'Project Manager Agent',
    description: 'Understands user requirements, establishes specifications, creates milestones, and schedules dependency-aware tasks.',
    assignedModelId: 'gpt-4o',
    responsibilities: [
      'Analyze natural language requirements and clarify missing specifications',
      'Create project milestones and dependency-aware task boards',
      'Track real-time progress and coordinate team agents',
      'Maintain shared project state and milestone completion'
    ]
  },
  software_architect: {
    role: 'software_architect',
    title: 'Software Architect Agent',
    description: 'Selects optimal architecture and tech stack, designs modular component hierarchy, and identifies technical risks.',
    assignedModelId: 'claude',
    responsibilities: [
      'Select frontend, backend, database, and infrastructure stack based on requirements',
      'Design modular file structure (files under ~150 lines)',
      'Produce implementation blueprints and interface contracts',
      'Identify architectural bottlenecks and technical risks upfront'
    ]
  },
  frontend_developer: {
    role: 'frontend_developer',
    title: 'Frontend Developer Agent',
    description: 'Builds responsive user interfaces, pages, forms, loading and error states with accessibility.',
    assignedModelId: 'llama',
    responsibilities: [
      'Implement interactive UI components and views',
      'Ensure responsive layouts on desktop and mobile',
      'Handle forms, user input validation, and loading/error states',
      'Follow modern design guidelines with clean typography'
    ]
  },
  backend_developer: {
    role: 'backend_developer',
    title: 'Backend Developer Agent',
    description: 'Implements REST/WebSocket APIs, business logic, authentication, request validation, and safe concurrency.',
    assignedModelId: 'mistral',
    responsibilities: [
      'Develop server routes, middleware, and business logic controllers',
      'Handle concurrent requests safely with proper validation',
      'Implement secure authentication and token handling',
      'Provide structured error handling and status codes'
    ]
  },
  database_specialist: {
    role: 'database_specialist',
    title: 'Database Agent',
    description: 'Designs schemas, entity relationships, migration scripts, and validated data store interfaces.',
    assignedModelId: 'nemotron',
    responsibilities: [
      'Design relational schemas and document models',
      'Generate database migrations and entity validation rules',
      'Integrate data store layer safely without assuming external DB availability',
      'Optimize queries, indexes, and concurrency locks'
    ]
  },
  integration_specialist: {
    role: 'integration_specialist',
    title: 'Integration Agent',
    description: 'Combines outputs across all agents, aligns imports, validates types, and detects conflict markers.',
    assignedModelId: 'gemini',
    responsibilities: [
      'Ensure cross-module import consistency and type alignments',
      'Validate API contracts between frontend and backend',
      'Detect and resolve file conflicts and merge friction',
      'Verify end-to-end integration across the codebase'
    ]
  },
  qa_testing_specialist: {
    role: 'qa_testing_specialist',
    title: 'QA & Testing Agent',
    description: 'Generates automated test suites (unit, integration, E2E) and executes checks to prevent regressions.',
    assignedModelId: 'deepseek',
    responsibilities: [
      'Author unit tests for domain logic and API routes',
      'Generate integration test fixtures and component tests',
      'Execute sandbox test runner and verify expected outputs',
      'Prevent false completions by enforcing rigorous assertions'
    ]
  },
  debugging_specialist: {
    role: 'debugging_specialist',
    title: 'Debugging Agent',
    description: 'Diagnoses genuine runtime and compilation errors, identifies root causes, and applies targeted surgical patches.',
    assignedModelId: 'qwen',
    responsibilities: [
      'Analyze compiler diagnostics, syntax errors, and stack traces',
      'Identify root causes rather than random patch generation',
      'Generate exact find/replace patches targeting faulty lines',
      'Respect retry limits and prevent infinite retry loops'
    ]
  },
  security_specialist: {
    role: 'security_specialist',
    title: 'Security Agent',
    description: 'Audits authentication, authorization, secret handling, input sanitization, and OWASP Top 10 vulnerabilities.',
    assignedModelId: 'grok',
    responsibilities: [
      'Scan for exposed secrets, passwords, tokens, or private keys',
      'Audit authorization checks and input sanitization boundaries',
      'Detect dangerous patterns (eval, prototype pollution, command injection)',
      'Produce verifiable security audits without false claims'
    ]
  },
  devops_release_specialist: {
    role: 'devops_release_specialist',
    title: 'DevOps & Release Agent',
    description: 'Prepares Dockerfile, CI/CD GitHub workflows, environment config, and Git feature branches for deployment.',
    assignedModelId: 'codex',
    responsibilities: [
      'Generate Dockerfile and container configuration',
      'Create GitHub Actions CI workflows for tests and builds',
      'Prepare environment configurations and setup documentation',
      'Prepare Git feature branch and pull request when authorized'
    ]
  }
};

// Pre-configured registry of 10+ AI Models, each mapped to a specialized agent role
export const INITIAL_MODEL_REGISTRY: ModelConfig[] = [
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o (Project Manager)',
    providerModel: 'openai/gpt-4o',
    agentRole: 'project_manager',
    strengths: ['architecture', 'backend', 'frontend', 'testing'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    badge: 'PM',
    description: 'Project Manager: requirements breakdown, milestones, dependency-aware task scheduling'
  },
  {
    id: 'claude',
    displayName: 'Claude 3.5 (Software Architect)',
    providerModel: 'anthropic/claude-3.5-sonnet',
    agentRole: 'software_architect',
    strengths: ['architecture', 'security', 'frontend', 'backend', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    badge: 'ARCH',
    description: 'Software Architect: technology stack selection, component design, file structure, risk analysis'
  },
  {
    id: 'llama',
    displayName: 'Llama 3.3 (Frontend Dev)',
    providerModel: 'meta-llama/llama-3.3-70b-instruct',
    agentRole: 'frontend_developer',
    strengths: ['frontend', 'backend', 'docs', 'testing'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
    badge: 'FE',
    description: 'Frontend Developer: responsive UI, pages, components, accessibility, forms, and interaction states'
  },
  {
    id: 'mistral',
    displayName: 'Mistral Large (Backend Dev)',
    providerModel: 'mistralai/mistral-large-2407',
    agentRole: 'backend_developer',
    strengths: ['backend', 'database', 'security', 'debugging'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    badge: 'BE',
    description: 'Backend Developer: REST & WebSocket APIs, controllers, validation, and business logic'
  },
  {
    id: 'nemotron',
    displayName: 'Nemotron 70B (Database Specialist)',
    providerModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    agentRole: 'database_specialist',
    strengths: ['database', 'backend', 'security', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-lime-500/20 text-lime-300 border-lime-500/30',
    badge: 'DB',
    description: 'Database Specialist: schemas, migrations, relations, queries, and persistent models'
  },
  {
    id: 'gemini',
    displayName: 'Gemini 3.8 Flash (Integration Agent)',
    providerModel: 'google/gemini-3.8-flash',
    agentRole: 'integration_specialist',
    strengths: ['frontend', 'backend', 'database', 'debugging', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    badge: 'INT',
    description: 'Integration Agent: cross-module imports, contracts, conflict resolution, and verification'
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek V3 (QA & Testing)',
    providerModel: 'deepseek/deepseek-chat',
    agentRole: 'qa_testing_specialist',
    strengths: ['testing', 'backend', 'database', 'debugging'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    badge: 'QA',
    description: 'QA & Testing Agent: unit, integration, and E2E test suites with rigorous assertion coverage'
  },
  {
    id: 'qwen',
    displayName: 'Qwen 2.5 Coder (Debugging Agent)',
    providerModel: 'qwen/qwen-2.5-coder-32b-instruct',
    agentRole: 'debugging_specialist',
    strengths: ['debugging', 'frontend', 'backend', 'testing'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    badge: 'DBG',
    description: 'Debugging Agent: root cause analysis, stack trace diagnosis, and surgical bug remediation'
  },
  {
    id: 'grok',
    displayName: 'Grok-2 (Security Agent)',
    providerModel: 'x-ai/grok-2',
    agentRole: 'security_specialist',
    strengths: ['security', 'backend', 'database', 'debugging'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    badge: 'SEC',
    description: 'Security Agent: OWASP vulnerability audit, secret exposure defense, and input sanitization'
  },
  {
    id: 'codex',
    displayName: 'Codex Turbo (DevOps & Release)',
    providerModel: 'openai/gpt-4o-mini',
    agentRole: 'devops_release_specialist',
    strengths: ['backend', 'frontend', 'debugging', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
    badge: 'OPS',
    description: 'DevOps & Release: Dockerfile, CI/CD workflows, build scripts, and Git feature branches'
  }
];

class ModelRegistryManager {
  private models: Map<string, ModelConfig> = new Map();

  constructor() {
    INITIAL_MODEL_REGISTRY.forEach(m => this.models.set(m.id, { ...m }));
  }

  getAll(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  getById(id: string): ModelConfig | undefined {
    return this.models.get(id);
  }

  getByRole(role: AgentRole): ModelConfig | undefined {
    return this.getAll().find(m => m.agentRole === role);
  }

  getEnabled(): ModelConfig[] {
    return this.getAll().filter(m => m.enabled);
  }

  registerModel(config: ModelConfig): void {
    this.models.set(config.id, { ...config });
  }

  updateModel(id: string, updates: Partial<ModelConfig>): ModelConfig | null {
    const existing = this.models.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates };
    this.models.set(id, updated);
    return updated;
  }

  deleteModel(id: string): boolean {
    return this.models.delete(id);
  }

  resetToDefaults(): void {
    this.models.clear();
    INITIAL_MODEL_REGISTRY.forEach(m => this.models.set(m.id, { ...m }));
  }

  getAgentSpecs(): Record<AgentRole, AgentSpec> {
    return AGENT_SPECS;
  }
}

export const modelRegistry = new ModelRegistryManager();
