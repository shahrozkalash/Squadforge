import { 
  ModelConfig, 
  Task, 
  GatewayResult, 
  GatewayErrorCode,
  AIProvider,
  ModelCapabilityLevel,
  UsageLogEntry
} from './types.js';
import { modelRegistry } from './modelRegistry.js';
import { quotaManager } from './quotaManager.js';
import { localLLMService } from './localLLM.js';
import { safeResultCache } from './cache.js';
import { tokenOptimizer } from './tokenOptimizer.js';
import { getGoogleGenAI, SILENT_WORKER_SYSTEM_PROMPT, extractAndParseJson } from './gateway.js';
import { db } from './store.js';

export interface RouteDecision {
  selectedModel: ModelConfig;
  isAlternative: boolean;
  routeReason: string;
  useLocal: boolean;
  useCache: boolean;
}

export interface SmartExecutionParams {
  requestedModelId: string;
  task?: Task;
  taskComplexity?: 'lightweight' | 'standard' | 'flagship';
  prompt: string;
  systemInstruction?: string;
  buildId?: string;
  userId?: string;
  maxTokens?: number;
  temperature?: number;
  allowFallback?: boolean;
  bypassCache?: boolean;
  routingPreference?: 'cost' | 'latency' | 'quality';
}

export class SmartModelRouter {
  private static instance: SmartModelRouter;

  private constructor() {}

  static getInstance(): SmartModelRouter {
    if (!SmartModelRouter.instance) {
      SmartModelRouter.instance = new SmartModelRouter();
    }
    return SmartModelRouter.instance;
  }

  /**
   * Assesses the inherent complexity of a development task to select the most economical model
   * that can fulfill the requirements without waste.
   */
  classifyTaskComplexity(task?: Task, prompt?: string): 'lightweight' | 'standard' | 'flagship' {
    if (task?.complexity) {
      return task.complexity;
    }

    const title = (task?.title || '').toLowerCase();
    const desc = (task?.description || '').toLowerCase();
    const pText = (prompt || '').toLowerCase();
    const combined = `${title} ${desc} ${pText}`;

    // Flagship tasks: Software Architecture, Security Audits, Multi-file Refactoring, Complex Verifications
    if (
      task?.assignedRole === 'software_architect' ||
      task?.assignedRole === 'security_specialist' ||
      task?.isFixTask ||
      combined.includes('architect') ||
      combined.includes('verify software completion') ||
      combined.includes('security audit') ||
      combined.includes('vulnerability') ||
      combined.includes('root cause analysis')
    ) {
      return 'flagship';
    }

    // Lightweight tasks: Documentation, README, file summaries, linting, simple types, small helpers
    if (
      task?.assignedRole === 'devops_release_specialist' ||
      combined.includes('readme') ||
      combined.includes('summary') ||
      combined.includes('outline') ||
      combined.includes('docs') ||
      combined.includes('type definition') ||
      combined.includes('dockerfile') ||
      (task?.filePaths.length === 1 && task.filePaths[0].endsWith('.md'))
    ) {
      return 'lightweight';
    }

    // Standard tasks: UI components, API routes, database storage, test suites
    return 'standard';
  }

  /**
   * Selects an optimal model based on task complexity, provider health, quotas, context window, and user settings
   */
  selectOptimalModel(params: {
    requestedModelId: string;
    complexity: 'lightweight' | 'standard' | 'flagship';
    estimatedInputTokens: number;
    enabledModelIds?: string[];
    allowFallback?: boolean;
    routingPreference?: 'cost' | 'latency' | 'quality';
  }): RouteDecision {
    const requested = modelRegistry.getById(params.requestedModelId);
    if (!requested) {
      throw new Error(`Requested model "${params.requestedModelId}" is not registered.`);
    }

    // If fallback is explicitly disabled, strictly honor requested model
    if (params.allowFallback === false) {
      return {
        selectedModel: requested,
        isAlternative: false,
        routeReason: `Explicitly requested model: ${requested.displayName} (fallback disabled)`,
        useLocal: requested.provider === 'local',
        useCache: true
      };
    }

    // Check if local LLM is enabled and suitable
    const localCfg = localLLMService.getConfig();
    if (localCfg.enabled && localCfg.status === 'connected') {
      const localModel = modelRegistry.getById(`local-${localCfg.modelName}`);
      if (localModel && localModel.contextWindow && localModel.contextWindow >= params.estimatedInputTokens + 2000) {
        // Can route lightweight and standard tasks to local inference to save cloud tokens
        if (params.complexity === 'lightweight' || params.complexity === 'standard' || params.routingPreference === 'cost') {
          return {
            selectedModel: localModel,
            isAlternative: true,
            routeReason: `Routed to local ${localCfg.modelName} for economical local execution`,
            useLocal: true,
            useCache: true
          };
        }
      }
    }

    // Check if user specifically requested cost optimization: prefer free/economical tier models for lightweight tasks
    if (params.routingPreference === 'cost' && params.complexity === 'lightweight' && requested.tier === 'paid') {
      const geminiModel = modelRegistry.getById('gemini');
      if (geminiModel && quotaManager.isProviderAvailable('gemini').available) {
        return {
          selectedModel: geminiModel,
          isAlternative: true,
          routeReason: `Cost preference optimization: routed ${params.complexity} task to high-efficiency Gemini 3.8 Flash`,
          useLocal: false,
          useCache: true
        };
      }
    }

    // Check if requested model's provider is available and healthy
    const provider = requested.provider || (requested.id === 'gemini' ? 'gemini' : 'openrouter');
    const quotaCheck = quotaManager.isProviderAvailable(provider, requested.id);

    if (quotaCheck.available) {
      // Check if context fits
      const contextWindow = requested.contextWindow || 32768;
      if (params.estimatedInputTokens + 2000 <= contextWindow) {
        return {
          selectedModel: requested,
          isAlternative: false,
          routeReason: `Optimal match: ${requested.displayName} (${requested.capabilityLevel || 'standard'})`,
          useLocal: false,
          useCache: true
        };
      }
    }

    // If requested provider is rate-limited, cooling down, or out of quota, find best alternative without repeated errors
    const enabledModels = (params.enabledModelIds || modelRegistry.getEnabled().map(m => m.id))
      .map(id => modelRegistry.getById(id))
      .filter((m): m is ModelConfig => !!m && m.enabled && m.id !== requested.id);

    // Filter by available provider
    const availableAlternatives = enabledModels.filter(m => {
      const prov = m.provider || (m.id === 'gemini' ? 'gemini' : 'openrouter');
      const check = quotaManager.isProviderAvailable(prov, m.id);
      const fits = (m.contextWindow || 32768) >= params.estimatedInputTokens + 2000;
      return check.available && fits;
    });

    if (availableAlternatives.length > 0) {
      // Pick best matching capability
      let chosen = availableAlternatives.find(m => m.capabilityLevel === requested.capabilityLevel);
      if (!chosen) {
        chosen = availableAlternatives.find(m => m.id === 'gemini') || availableAlternatives[0];
      }

      return {
        selectedModel: chosen,
        isAlternative: true,
        routeReason: `Primary provider for ${requested.displayName} is ${quotaCheck.reason || 'unavailable'}; fallback to ${chosen.displayName}`,
        useLocal: chosen.provider === 'local',
        useCache: true
      };
    }

    // Gemini native fallback check
    const geminiModel = modelRegistry.getById('gemini');
    if (geminiModel && quotaManager.isProviderAvailable('gemini').available) {
      return {
        selectedModel: geminiModel,
        isAlternative: true,
        routeReason: `Primary provider unavailable; routing to server-side Gemini 3.8 Flash`,
        useLocal: false,
        useCache: true
      };
    }

    // Default to requested model (will fail with clear diagnostic in gateway if truly unavailable)
    return {
      selectedModel: requested,
      isAlternative: false,
      routeReason: `No healthy alternative available. Attempting requested model: ${requested.displayName}`,
      useLocal: false,
      useCache: true
    };
  }

  /**
   * Central execution pipeline: Optimizes context, checks cache, selects model, invokes provider,
   * handles fallback on rate limit/quota, records quota and usage metrics.
   */
  async executeSmartRequest(params: SmartExecutionParams): Promise<GatewayResult> {
    const startTime = Date.now();
    const requestedModelId = params.requestedModelId;
    const requestedModel = modelRegistry.getById(requestedModelId);

    if (!requestedModel) {
      return {
        success: false,
        rawText: '',
        parsedResponse: null,
        tokensUsed: 0,
        modelId: requestedModelId,
        actualModelUsed: 'none',
        providerUsed: 'none',
        isFallback: false,
        latencyMs: Date.now() - startTime,
        error: `Model "${requestedModelId}" is not registered in the model registry.`,
        errorCode: 'UNSUPPORTED_MODEL'
      };
    }

    // 1. Task Complexity & Token Estimation
    const complexity = params.taskComplexity || this.classifyTaskComplexity(params.task, params.prompt);
    const estInputTokens = tokenOptimizer.estimateTokens(params.prompt);
    const maxOutputTokens = params.maxTokens || requestedModel.maxTokens || 4096;

    // 2. Dynamic Context Optimization: deduplicate and compress if needed
    const { systemInstruction: cleanSys, prompt: cleanPrompt } = tokenOptimizer.deduplicatePrompt(
      params.systemInstruction || SILENT_WORKER_SYSTEM_PROMPT,
      params.prompt
    );

    // 3. Shared Context & Result Caching check
    const isDeterministic = complexity === 'lightweight' || cleanPrompt.includes('summary') || cleanPrompt.includes('outline');
    if (isDeterministic && !params.bypassCache) {
      const cachedResponse = safeResultCache.get({
        category: 'deterministic_analysis',
        userId: params.userId,
        buildId: params.buildId,
        modelId: requestedModelId,
        inputs: cleanPrompt,
        bypassCache: params.bypassCache
      });

      if (cachedResponse) {
        return {
          success: true,
          rawText: cachedResponse.rawText,
          parsedResponse: cachedResponse.parsedResponse,
          tokensUsed: 0, // 0 network tokens used on cache hit!
          inputTokens: 0,
          outputTokens: 0,
          isEstimatedTokens: false,
          modelId: requestedModelId,
          actualModelUsed: `${requestedModel.displayName} (Cached)`,
          providerUsed: requestedModel.provider || 'gemini',
          isFallback: false,
          cached: true,
          latencyMs: Date.now() - startTime,
          estimatedCost: 0,
          actualCost: 0
        };
      }
    }

    // 4. Select Optimal Model & Route
    const preference = params.routingPreference || 
      (params.buildId ? db.getBuild(params.buildId)?.routingPreference : undefined) ||
      (params.userId ? db.getUser(params.userId)?.routingPreference : undefined);

    const decision = this.selectOptimalModel({
      requestedModelId,
      complexity,
      estimatedInputTokens: estInputTokens,
      allowFallback: params.allowFallback,
      routingPreference: preference
    });

    const activeModel = decision.selectedModel;
    const isFallback = decision.isAlternative || activeModel.id !== requestedModelId;
    const fallbackReason = isFallback ? decision.routeReason : undefined;

    // 5. Check Context Window
    const contextCheck = tokenOptimizer.checkContextWindow(
      cleanPrompt, 
      maxOutputTokens, 
      activeModel.contextWindow || 32768
    );

    if (!contextCheck.fitsWithinContext) {
      return {
        success: false,
        rawText: '',
        parsedResponse: null,
        tokensUsed: 0,
        modelId: requestedModelId,
        actualModelUsed: activeModel.providerModel,
        providerUsed: activeModel.provider || 'none',
        isFallback,
        fallbackReason,
        latencyMs: Date.now() - startTime,
        error: contextCheck.reason,
        errorCode: 'CONTEXT_OVERFLOW'
      };
    }

    // 6. Execute Provider Call with Circuit Breaker and Quota Handling
    let result: GatewayResult;

    // 6a. Local LLM route
    if (decision.useLocal) {
      result = await localLLMService.callLocalModel({
        prompt: cleanPrompt,
        systemInstruction: cleanSys,
        temperature: params.temperature,
        maxTokens: maxOutputTokens
      });
      result.modelId = requestedModelId;
      result.isFallback = isFallback;
      result.fallbackReason = fallbackReason;
    } else {
      // 6b. Cloud Provider Route (OpenRouter or Gemini)
      result = await this.executeCloudCall({
        model: activeModel,
        prompt: cleanPrompt,
        systemInstruction: cleanSys,
        temperature: params.temperature,
        maxTokens: maxOutputTokens,
        allowFallback: params.allowFallback ?? true
      });
      result.modelId = requestedModelId;
      if (isFallback) {
        result.isFallback = true;
        result.fallbackReason = fallbackReason || result.fallbackReason;
      }
    }

    // 7. Record Quota & Health Metrics
    const provider = result.providerUsed;
    if (provider !== 'none') {
      quotaManager.recordOutcome({
        provider,
        modelId: activeModel.id,
        success: result.success,
        tokensUsed: result.tokensUsed,
        error: result.error,
        errorCode: result.errorCode
      });
    }

    // 8. Cache successful deterministic results
    if (result.success && isDeterministic && result.parsedResponse) {
      safeResultCache.set({
        category: 'deterministic_analysis',
        userId: params.userId,
        buildId: params.buildId,
        modelId: requestedModelId,
        inputs: cleanPrompt,
        data: {
          rawText: result.rawText,
          parsedResponse: result.parsedResponse
        },
        estimatedTokensSaved: result.tokensUsed || 500,
        ttlSeconds: 3600
      });
    }

    // 9. Calculate exact and estimated pricing
    const pricing = activeModel.pricing || { inputCostPerMillion: 0.15, outputCostPerMillion: 0.60 };
    const inTokens = result.inputTokens || Math.floor((result.tokensUsed || 500) * 0.7);
    const outTokens = result.outputTokens || Math.floor((result.tokensUsed || 500) * 0.3);
    const estCost = ((inTokens * pricing.inputCostPerMillion) + (outTokens * pricing.outputCostPerMillion)) / 1000000;

    result.estimatedCost = estCost;
    result.actualCost = activeModel.tier === 'free' || activeModel.isLocal ? 0 : estCost;

    // 10. Record detailed Usage Log in database store
    this.recordUsageLog(params, result);

    return result;
  }

  /**
   * Dispatches call to OpenRouter or Gemini with rate limit and failure classification
   */
  private async executeCloudCall(params: {
    model: ModelConfig;
    prompt: string;
    systemInstruction: string;
    temperature?: number;
    maxTokens?: number;
    allowFallback: boolean;
  }): Promise<GatewayResult> {
    const startTime = Date.now();
    const model = params.model;
    const isDirectGemini = model.id === 'gemini';
    const openRouterKey = process.env.OPENROUTER_API_KEY || '';
    const genAI = getGoogleGenAI();

    // Primary: OpenRouter for 3P models
    if (!isDirectGemini && openRouterKey) {
      // Check quota cooldown first
      const check = quotaManager.isProviderAvailable('openrouter', model.id);
      if (!check.available && params.allowFallback && genAI) {
        // Skip straight to Gemini fallback rather than failing repeatedly
        return this.executeGeminiCall({
          model,
          prompt: params.prompt,
          systemInstruction: params.systemInstruction,
          temperature: params.temperature,
          isFallbackRun: true,
          fallbackReason: `OpenRouter in cooldown (${check.reason}); auto-routed to Gemini`
        });
      }

      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openRouterKey}`,
            'HTTP-Referer': 'https://squadforge.dev',
            'X-Title': 'SquadForge Swarm'
          },
          body: JSON.stringify({
            model: model.providerModel,
            messages: [
              { role: 'system', content: params.systemInstruction },
              { role: 'user', content: params.prompt }
            ],
            temperature: params.temperature ?? 0.2,
            max_tokens: params.maxTokens ?? 3000,
            response_format: { type: 'json_object' }
          })
        });

        // Headers for rate limit tracking
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => { headers[k] = v; });

        if (!response.ok) {
          let errCode: GatewayErrorCode = 'PROVIDER_ERROR';
          let errMsg = `OpenRouter HTTP ${response.status}`;

          if (response.status === 401 || response.status === 403) {
            errCode = 'INVALID_API_KEY';
            errMsg = 'OpenRouter API key is invalid or unauthorized.';
          } else if (response.status === 429) {
            errCode = 'RATE_LIMITED';
            errMsg = 'OpenRouter rate limit exceeded.';
          } else if (response.status === 402) {
            errCode = 'QUOTA_EXHAUSTED';
            errMsg = 'OpenRouter credit balance exhausted.';
          } else {
            try {
              const errBody: any = await response.json();
              if (errBody?.error?.message) {
                errMsg = `OpenRouter error: ${errBody.error.message}`;
              }
            } catch (_) {}
          }

          quotaManager.recordOutcome({
            provider: 'openrouter',
            modelId: model.id,
            success: false,
            statusCode: response.status,
            headers,
            error: errMsg,
            errorCode: errCode
          });

          // Check fallback eligibility
          if (params.allowFallback && genAI && quotaManager.isProviderAvailable('gemini').available) {
            return this.executeGeminiCall({
              model,
              prompt: params.prompt,
              systemInstruction: params.systemInstruction,
              temperature: params.temperature,
              isFallbackRun: true,
              fallbackReason: `Primary provider OpenRouter failed (${errMsg}); executed via configured Gemini fallback`
            });
          }

          return {
            success: false,
            rawText: '',
            parsedResponse: null,
            tokensUsed: 0,
            modelId: model.id,
            actualModelUsed: model.providerModel,
            providerUsed: 'openrouter',
            isFallback: false,
            latencyMs: Date.now() - startTime,
            error: errMsg,
            errorCode: errCode
          };
        }

        const data: any = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const parsed = extractAndParseJson(content);
        const inputTokens = data.usage?.prompt_tokens;
        const outputTokens = data.usage?.completion_tokens;
        const totalTokens = data.usage?.total_tokens || 500;

        quotaManager.recordOutcome({
          provider: 'openrouter',
          modelId: model.id,
          success: true,
          statusCode: 200,
          tokensUsed: totalTokens,
          headers
        });

        return {
          success: parsed !== null,
          rawText: content,
          parsedResponse: parsed,
          tokensUsed: totalTokens,
          inputTokens,
          outputTokens,
          isEstimatedTokens: false,
          modelId: model.id,
          actualModelUsed: model.providerModel,
          providerUsed: 'openrouter',
          isFallback: false,
          latencyMs: Date.now() - startTime,
          error: parsed === null ? 'Response from OpenRouter did not contain valid structured JSON actions.' : undefined,
          errorCode: parsed === null ? 'MALFORMED_OUTPUT' : undefined
        };
      } catch (netErr: any) {
        quotaManager.recordOutcome({
          provider: 'openrouter',
          modelId: model.id,
          success: false,
          error: netErr.message,
          errorCode: 'NETWORK_ERROR'
        });

        if (params.allowFallback && genAI && quotaManager.isProviderAvailable('gemini').available) {
          return this.executeGeminiCall({
            model,
            prompt: params.prompt,
            systemInstruction: params.systemInstruction,
            temperature: params.temperature,
            isFallbackRun: true,
            fallbackReason: `Network error connecting to OpenRouter; executed via Gemini fallback`
          });
        }

        return {
          success: false,
          rawText: '',
          parsedResponse: null,
          tokensUsed: 0,
          modelId: model.id,
          actualModelUsed: model.providerModel,
          providerUsed: 'openrouter',
          isFallback: false,
          latencyMs: Date.now() - startTime,
          error: `Network failure connecting to OpenRouter: ${netErr.message || 'Connection error'}`,
          errorCode: 'NETWORK_ERROR'
        };
      }
    }

    // Direct Gemini or Fallback to Gemini (ONLY if allowFallback is true)
    if (genAI && (isDirectGemini || params.allowFallback)) {
      return this.executeGeminiCall({
        model,
        prompt: params.prompt,
        systemInstruction: params.systemInstruction,
        temperature: params.temperature,
        isFallbackRun: !isDirectGemini,
        fallbackReason: !isDirectGemini 
          ? `Primary provider for ${model.displayName} requires OPENROUTER_API_KEY; executed via configured Gemini fallback` 
          : undefined
      });
    }

    // No Provider
    return {
      success: false,
      rawText: '',
      parsedResponse: null,
      tokensUsed: 0,
      modelId: model.id,
      actualModelUsed: 'none',
      providerUsed: 'none',
      isFallback: false,
      latencyMs: Date.now() - startTime,
      error: `Model "${model.displayName}" requires OPENROUTER_API_KEY. Configure key or enable fallback.`,
      errorCode: 'NO_PROVIDER'
    };
  }

  /**
   * Direct Gemini 3.8 Flash call via official SDK
   */
  private async executeGeminiCall(params: {
    model: ModelConfig;
    prompt: string;
    systemInstruction: string;
    temperature?: number;
    isFallbackRun: boolean;
    fallbackReason?: string;
  }): Promise<GatewayResult> {
    const startTime = Date.now();
    const genAI = getGoogleGenAI();

    if (!genAI) {
      return {
        success: false,
        rawText: '',
        parsedResponse: null,
        tokensUsed: 0,
        modelId: params.model.id,
        actualModelUsed: 'none',
        providerUsed: 'none',
        isFallback: params.isFallbackRun,
        fallbackReason: params.fallbackReason,
        latencyMs: Date.now() - startTime,
        error: 'No valid AI provider configured on server (GEMINI_API_KEY required).',
        errorCode: 'NO_PROVIDER'
      };
    }

    const specializedSys = params.isFallbackRun
      ? `${params.systemInstruction}\n\nYou are operating as fallback for AI Model: ${params.model.displayName}. Output only valid JSON actions.`
      : params.systemInstruction;

    try {
      const genAiCall = genAI.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: params.prompt,
        config: {
          systemInstruction: specializedSys,
          temperature: params.temperature ?? 0.2,
          responseMimeType: 'application/json',
        }
      });

      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Gateway timeout (8000ms)')), 8000)
      );

      const response: any = await Promise.race([genAiCall, timeoutPromise]);
      const text = response?.text || '';
      const parsed = extractAndParseJson(text);

      // Extract token usage from Gemini response if available
      const usageMetadata = response?.usageMetadata;
      const inputTokens = usageMetadata?.promptTokenCount;
      const outputTokens = usageMetadata?.candidatesTokenCount;
      const totalTokens = usageMetadata?.totalTokenCount || 650;

      quotaManager.recordOutcome({
        provider: 'gemini',
        modelId: params.model.id,
        success: true,
        tokensUsed: totalTokens
      });

      return {
        success: parsed !== null,
        rawText: text,
        parsedResponse: parsed,
        tokensUsed: totalTokens,
        inputTokens,
        outputTokens,
        isEstimatedTokens: !usageMetadata,
        modelId: params.model.id,
        actualModelUsed: 'gemini-3.8-flash',
        providerUsed: 'gemini',
        isFallback: params.isFallbackRun,
        fallbackReason: params.fallbackReason,
        latencyMs: Date.now() - startTime,
        error: parsed === null ? 'Response from Gemini did not contain valid structured JSON actions.' : undefined,
        errorCode: parsed === null ? 'MALFORMED_OUTPUT' : undefined
      };
    } catch (err: any) {
      let errCode: GatewayErrorCode = 'PROVIDER_ERROR';
      const msg = err?.message || String(err);

      if (msg.includes('API_KEY') || msg.includes('401') || msg.includes('403')) {
        errCode = 'INVALID_API_KEY';
      } else if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
        errCode = 'RATE_LIMITED';
      } else if (msg.includes('timeout') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
        errCode = 'NETWORK_ERROR';
      }

      quotaManager.recordOutcome({
        provider: 'gemini',
        modelId: params.model.id,
        success: false,
        error: msg,
        errorCode: errCode
      });

      return {
        success: false,
        rawText: '',
        parsedResponse: null,
        tokensUsed: 0,
        modelId: params.model.id,
        actualModelUsed: 'gemini-3.8-flash',
        providerUsed: 'gemini',
        isFallback: params.isFallbackRun,
        fallbackReason: params.fallbackReason,
        latencyMs: Date.now() - startTime,
        error: `Gemini API execution failed: ${msg}`,
        errorCode: errCode
      };
    }
  }

  /**
   * Persists an audit log entry for the usage dashboard
   */
  private recordUsageLog(params: SmartExecutionParams, result: GatewayResult): void {
    const logEntry: UsageLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      buildId: params.buildId || 'ad_hoc',
      taskId: params.task?.id,
      taskTitle: params.task?.title,
      agentRole: params.task?.assignedRole,
      userId: params.userId || 'system',
      modelId: params.requestedModelId,
      requestedModelId: params.requestedModelId,
      actualModelUsed: result.actualModelUsed,
      provider: result.providerUsed,
      isFallback: result.isFallback,
      fallbackReason: result.fallbackReason,
      isLocal: Boolean(result.isLocal),
      estimatedTokens: result.tokensUsed,
      actualInputTokens: result.inputTokens,
      actualOutputTokens: result.outputTokens,
      totalTokens: result.tokensUsed,
      estimatedCost: result.estimatedCost || 0,
      billedCost: result.actualCost || 0,
      isCached: Boolean(result.cached),
      latencyMs: result.latencyMs,
      success: result.success,
      error: result.error,
      errorCode: result.errorCode
    };

    db.addUsageLog(logEntry);
  }
}

export const smartRouter = SmartModelRouter.getInstance();
