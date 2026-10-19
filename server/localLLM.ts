import { 
  LocalLLMConfig, 
  LocalLLMHealthResult, 
  GatewayResult, 
  ModelActionResponse 
} from './types.js';
import { extractAndParseJson, SILENT_WORKER_SYSTEM_PROMPT } from './gateway.js';

export class LocalLLMService {
  private static instance: LocalLLMService;

  private config: LocalLLMConfig = {
    enabled: false,
    endpointUrl: 'http://localhost:11434/v1',
    modelName: 'llama3.2',
    timeoutMs: 15000,
    contextWindow: 32768,
    status: 'untested'
  };

  private constructor() {}

  static getInstance(): LocalLLMService {
    if (!LocalLLMService.instance) {
      LocalLLMService.instance = new LocalLLMService();
    }
    return LocalLLMService.instance;
  }

  getConfig(): LocalLLMConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<LocalLLMConfig>): LocalLLMConfig {
    this.config = {
      ...this.config,
      ...updates
    };
    return { ...this.config };
  }

  /**
   * Performs an actual connection health check against the configured local LLM endpoint.
   * Real connection test confirms it before claiming local model is working.
   */
  async checkHealth(): Promise<LocalLLMHealthResult> {
    const startTime = Date.now();
    const endpoint = this.config.endpointUrl.replace(/\/+$/, '');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs, 5000));

    try {
      // 1. Try OpenAI-compatible /models endpoint
      let availableModels: string[] = [];
      let res = await fetch(`${endpoint}/models`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });

      if (!res.ok) {
        // 2. Try Ollama native /api/tags if /v1/models fails
        const ollamaBase = endpoint.replace(/\/v1$/, '');
        res = await fetch(`${ollamaBase}/api/tags`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
      }

      clearTimeout(timeoutId);

      if (!res.ok) {
        this.config.status = 'error';
        this.config.lastChecked = Date.now();
        this.config.errorMessage = `Local service returned HTTP ${res.status}`;
        return {
          connected: false,
          endpointUrl: this.config.endpointUrl,
          availableModels: [],
          selectedModelAvailable: false,
          latencyMs: Date.now() - startTime,
          error: `HTTP ${res.status}: ${res.statusText}`
        };
      }

      const body: any = await res.json();
      if (Array.isArray(body?.data)) {
        availableModels = body.data.map((m: any) => m.id || m.name);
      } else if (Array.isArray(body?.models)) {
        availableModels = body.models.map((m: any) => m.name || m.model);
      }

      const selectedAvailable = availableModels.some(m => 
        m.toLowerCase().includes(this.config.modelName.toLowerCase())
      );

      this.config.status = 'connected';
      this.config.lastChecked = Date.now();
      this.config.availableModels = availableModels;
      this.config.errorMessage = undefined;

      return {
        connected: true,
        endpointUrl: this.config.endpointUrl,
        availableModels,
        selectedModelAvailable: selectedAvailable,
        latencyMs: Date.now() - startTime
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isAbort = err.name === 'AbortError';
      const errMsg = isAbort ? 'Connection timed out' : (err.message || 'Connection refused');

      this.config.status = 'disconnected';
      this.config.lastChecked = Date.now();
      this.config.errorMessage = errMsg;

      return {
        connected: false,
        endpointUrl: this.config.endpointUrl,
        availableModels: [],
        selectedModelAvailable: false,
        latencyMs: Date.now() - startTime,
        error: errMsg
      };
    }
  }

  /**
   * Executes inference through the local model endpoint using OpenAI compatible /chat/completions
   */
  async callLocalModel(params: {
    prompt: string;
    systemInstruction?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<GatewayResult> {
    const startTime = Date.now();
    const endpoint = this.config.endpointUrl.replace(/\/+$/, '');
    const model = this.config.modelName;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: params.systemInstruction || SILENT_WORKER_SYSTEM_PROMPT },
            { role: 'user', content: params.prompt }
          ],
          temperature: params.temperature ?? 0.2,
          max_tokens: params.maxTokens ?? 3000,
          response_format: { type: 'json_object' }
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          rawText: '',
          parsedResponse: null,
          tokensUsed: 0,
          modelId: `local-${model}`,
          actualModelUsed: model,
          providerUsed: 'local',
          isFallback: false,
          isLocal: true,
          latencyMs: Date.now() - startTime,
          error: `Local model call failed with HTTP ${response.status}`,
          errorCode: 'PROVIDER_ERROR'
        };
      }

      const data: any = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const parsed = extractAndParseJson(content);
      const inputTokens = data.usage?.prompt_tokens;
      const outputTokens = data.usage?.completion_tokens;
      const totalTokens = data.usage?.total_tokens || 500;

      return {
        success: parsed !== null,
        rawText: content,
        parsedResponse: parsed,
        tokensUsed: totalTokens,
        inputTokens,
        outputTokens,
        modelId: `local-${model}`,
        actualModelUsed: model,
        providerUsed: 'local',
        isFallback: false,
        isLocal: true,
        latencyMs: Date.now() - startTime,
        estimatedCost: 0, // Local inference costs $0
        actualCost: 0,
        error: parsed === null ? 'Malformed output from local model' : undefined,
        errorCode: parsed === null ? 'MALFORMED_OUTPUT' : undefined
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      const isAbort = err.name === 'AbortError';
      const errMsg = isAbort ? 'Local model request timed out' : (err.message || 'Local connection error');

      return {
        success: false,
        rawText: '',
        parsedResponse: null,
        tokensUsed: 0,
        modelId: `local-${model}`,
        actualModelUsed: model,
        providerUsed: 'local',
        isFallback: false,
        isLocal: true,
        latencyMs: Date.now() - startTime,
        error: errMsg,
        errorCode: 'LOCAL_LLM_OFFLINE'
      };
    }
  }
}

export const localLLMService = LocalLLMService.getInstance();
