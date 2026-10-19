import { ModelConfig } from './types.js';

// Pre-configured registry of 10+ AI Models
export const INITIAL_MODEL_REGISTRY: ModelConfig[] = [
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o (ChatGPT)',
    providerModel: 'openai/gpt-4o',
    strengths: ['frontend', 'backend', 'architecture', 'testing'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    badge: 'GPT',
    description: 'High-speed reasoning, full-stack orchestration & test fixtures'
  },
  {
    id: 'codex',
    displayName: 'Codex Turbo',
    providerModel: 'openai/gpt-4o-mini',
    strengths: ['frontend', 'backend', 'debugging'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
    badge: 'Codex',
    description: 'Rapid code generation, surgical syntax repairs, micro-functions'
  },
  {
    id: 'claude',
    displayName: 'Claude 3.5 Sonnet',
    providerModel: 'anthropic/claude-3.5-sonnet',
    strengths: ['frontend', 'backend', 'security', 'architecture', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    badge: 'Claude',
    description: 'Nuanced architecture, defensive typing, comprehensive documentation'
  },
  {
    id: 'gemini',
    displayName: 'Gemini 3.8 Flash',
    providerModel: 'google/gemini-3.8-flash',
    strengths: ['frontend', 'backend', 'database', 'debugging', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    badge: 'Gemini',
    description: 'Ultra low latency, wide context window, end-to-end full stack'
  },
  {
    id: 'grok',
    displayName: 'Grok-2',
    providerModel: 'x-ai/grok-2',
    strengths: ['backend', 'database', 'debugging', 'security'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    badge: 'Grok',
    description: 'Aggressive problem solver, algorithmic efficiency & API routes'
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek V3',
    providerModel: 'deepseek/deepseek-chat',
    strengths: ['backend', 'database', 'testing', 'debugging'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
    badge: 'DeepSeek',
    description: 'Specialized code reasoning, edge case detection, unit verification'
  },
  {
    id: 'nemotron',
    displayName: 'Nemotron 70B',
    providerModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
    strengths: ['backend', 'security', 'database', 'docs'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-lime-500/20 text-lime-300 border-lime-500/30',
    badge: 'Nemotron',
    description: 'Enterprise data modeling, security hardening, schema validation'
  },
  {
    id: 'llama',
    displayName: 'Llama 3.3 70B',
    providerModel: 'meta-llama/llama-3.3-70b-instruct',
    strengths: ['frontend', 'backend', 'docs', 'testing'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
    badge: 'Llama',
    description: 'Open-weights powerhouse, modular component design, clean APIs'
  },
  {
    id: 'mistral',
    displayName: 'Mistral Large',
    providerModel: 'mistralai/mistral-large-2407',
    strengths: ['backend', 'database', 'security', 'debugging'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    badge: 'Mistral',
    description: 'Concise server logic, low-overhead microservices, token efficiency'
  },
  {
    id: 'qwen',
    displayName: 'Qwen 2.5 Coder',
    providerModel: 'qwen/qwen-2.5-coder-32b-instruct',
    strengths: ['frontend', 'backend', 'debugging', 'testing'],
    maxTokens: 4096,
    enabled: true,
    avatarColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    badge: 'Qwen',
    description: 'Deep code synthesis, precision diff creation, bug remediation'
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
}

export const modelRegistry = new ModelRegistryManager();
