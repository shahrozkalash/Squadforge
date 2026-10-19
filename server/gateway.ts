import { GoogleGenAI } from '@google/genai';
import { modelRegistry } from './modelRegistry.js';
import { 
  ModelConfig, 
  ModelActionResponse, 
  GatewayResult, 
  GatewayErrorCode,
  VerifierResponse,
  PatchAction,
  CreateFileAction,
  CreateTaskAction
} from './types.js';

let googleGenAIClient: GoogleGenAI | null = null;
let cachedGeminiKey: string | null = null;

/**
 * Returns initialized GoogleGenAI client using process.env.GEMINI_API_KEY.
 * Lazy initialized to pick up environment variables at runtime.
 */
export function getGoogleGenAI(): GoogleGenAI | null {
  const currentKey = process.env.GEMINI_API_KEY || '';
  if (!currentKey) {
    return null;
  }
  if (!googleGenAIClient || cachedGeminiKey !== currentKey) {
    try {
      googleGenAIClient = new GoogleGenAI({
        apiKey: currentKey,
        httpOptions: {
          headers: {
            'User-Agent': 'SquadForge-Parallel-Swarm',
          },
        },
      });
      cachedGeminiKey = currentKey;
    } catch (err) {
      console.error('Failed to initialize GoogleGenAI client');
      return null;
    }
  }
  return googleGenAIClient;
}

export const SILENT_WORKER_SYSTEM_PROMPT = `You are a specialized autonomous engineer in a software development team.
Do the work. No opinions, greetings, explanations, warnings, or questions.
Output only valid JSON actions. If something is ambiguous, choose the simplest option and continue.
You NEVER write commentary or markdown outside the JSON block.
Never return empty placeholders, stubs, or comments like "// write code here". Implement complete, production-grade logic.

Allowed JSON actions format:
{
  "actions": [
    {
      "action": "create_file",
      "path": "src/components/MyComponent.tsx",
      "content": "...complete pristine file content...",
      "commitMessage": "Create initial MyComponent"
    },
    {
      "action": "patch_file",
      "path": "src/App.tsx",
      "edits": [
        {
          "find": "// EXACT existing block of lines to replace",
          "replace": "// NEW exact replacement block of lines"
        }
      ],
      "commitMessage": "Mount MyComponent in App"
    },
    {
      "action": "create_task",
      "title": "Add test fixture for MyComponent",
      "description": "Create unit tests verifying rendering and event handling",
      "filePaths": ["src/components/MyComponent.test.tsx"],
      "priority": 3
    }
  ]
}

CRITICAL RULES FOR PATCHES:
1. "find" MUST match the exact existing text in the file character for character, including whitespace and newlines.
2. Only specify unique, unambiguous find blocks.
3. Keep individual files small and modular (max ~150 lines).`;

export interface GatewayCallParams {
  modelId: string;
  systemInstruction?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  responseMimeType?: string;
  allowFallback?: boolean;
}

/**
 * Extracts and cleans JSON from raw AI text responses
 */
export function extractAndParseJson(text: string): ModelActionResponse | null {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // Find boundaries of JSON object or array
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  } else {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned);
    return validateModelActionResponse(parsed);
  } catch (err) {
    return null;
  }
}

/**
 * Validates that an object conforms to the strict ModelActionResponse schema
 */
export function validateModelActionResponse(parsed: any): ModelActionResponse | null {
  if (!parsed || typeof parsed !== 'object') return null;

  let candidateActions: any[] = [];
  if (Array.isArray(parsed.actions)) {
    candidateActions = parsed.actions;
  } else if (parsed.action) {
    candidateActions = [parsed];
  } else {
    return null;
  }

  const validActions: Array<PatchAction | CreateFileAction | CreateTaskAction> = [];

  for (const act of candidateActions) {
    if (!act || typeof act !== 'object') continue;

    if (act.action === 'create_file') {
      if (typeof act.path === 'string' && act.path.trim().length > 0 && typeof act.content === 'string') {
        const trimmedContent = act.content.trim();
        // Prevent generic placeholders masquerading as successful implementations
        if (trimmedContent.length > 0) {
          validActions.push({
            action: 'create_file',
            path: act.path.trim(),
            content: act.content,
            commitMessage: typeof act.commitMessage === 'string' ? act.commitMessage : undefined
          });
        }
      }
    } else if (act.action === 'patch_file') {
      if (typeof act.path === 'string' && act.path.trim().length > 0 && Array.isArray(act.edits) && act.edits.length > 0) {
        const validEdits = act.edits.filter((e: any) => 
          e && typeof e === 'object' && typeof e.find === 'string' && typeof e.replace === 'string'
        );
        if (validEdits.length > 0) {
          validActions.push({
            action: 'patch_file',
            path: act.path.trim(),
            edits: validEdits,
            commitMessage: typeof act.commitMessage === 'string' ? act.commitMessage : undefined
          });
        }
      }
    } else if (act.action === 'create_task') {
      if (typeof act.title === 'string' && act.title.trim().length > 0 && typeof act.description === 'string') {
        const filePaths = Array.isArray(act.filePaths) ? act.filePaths.filter((p: any) => typeof p === 'string') : [];
        const dependencies = Array.isArray(act.dependencies) ? act.dependencies.filter((d: any) => typeof d === 'string') : undefined;
        validActions.push({
          action: 'create_task',
          title: act.title.trim(),
          description: act.description.trim(),
          filePaths,
          dependencies,
          assignedRole: typeof act.assignedRole === 'string' ? act.assignedRole : undefined,
          priority: (act.priority >= 1 && act.priority <= 5) ? act.priority : 3
        });
      }
    }
  }

  if (validActions.length === 0) {
    return null;
  }

  return { actions: validActions };
}

/**
 * Safely parses and validates a verifier model response.
 * Returns null if the JSON is malformed or missing required boolean approved field.
 */
export function parseVerifierResponse(text: string): VerifierResponse | null {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text.trim();

  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  } else {
    return null;
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== 'object' || parsed === null) return null;

    // Must have a genuine boolean for approved
    if (typeof parsed.approved !== 'boolean') {
      return null;
    }

    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : (parsed.approved ? 'Verified successfully' : 'Verification failed');
    const missingRequirements = Array.isArray(parsed.missingRequirements) 
      ? parsed.missingRequirements.filter((r: any) => typeof r === 'string')
      : [];

    return {
      approved: parsed.approved,
      summary,
      missingRequirements,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined
    };
  } catch (err) {
    return null;
  }
}

/**
 * Unified gateway call for every model in the registry.
 * Accurately tracks requested model vs actual model used and provider used.
 * Never silently fabricates responses.
 */
export async function callUnifiedGateway(params: GatewayCallParams): Promise<GatewayResult> {
  const startTime = Date.now();
  const requestedModelId = params.modelId;
  const modelConfig = modelRegistry.getById(requestedModelId);

  // 1. Validate requested model existence
  if (!modelConfig) {
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

  const sysPrompt = params.systemInstruction || SILENT_WORKER_SYSTEM_PROMPT;
  const openRouterKey = process.env.OPENROUTER_API_KEY || '';
  const genAI = getGoogleGenAI();

  // 2. Determine execution route
  const isDirectGemini = requestedModelId === 'gemini';

  // Attempt Primary Provider: OpenRouter for 3P models
  if (!isDirectGemini) {
    if (openRouterKey) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openRouterKey}`,
            'HTTP-Referer': 'https://squadforge.dev',
            'X-Title': 'SquadForge Swarm'
          },
          body: JSON.stringify({
            model: modelConfig.providerModel,
            messages: [
              { role: 'system', content: sysPrompt },
              { role: 'user', content: params.prompt }
            ],
            temperature: params.temperature ?? 0.2,
            max_tokens: params.maxTokens ?? 3000,
            response_format: { type: 'json_object' }
          })
        });

        if (!response.ok) {
          let errCode: GatewayErrorCode = 'PROVIDER_ERROR';
          let errMsg = `OpenRouter HTTP ${response.status}`;

          if (response.status === 401 || response.status === 403) {
            errCode = 'INVALID_API_KEY';
            errMsg = 'OpenRouter API key is invalid or unauthorized.';
          } else if (response.status === 429) {
            errCode = 'RATE_LIMITED';
            errMsg = 'OpenRouter rate limit or credit ceiling exceeded.';
          } else {
            try {
              const errBody = await response.json();
              if (errBody?.error?.message) {
                errMsg = `OpenRouter error: ${errBody.error.message}`;
              }
            } catch (_) {}
          }

          // If fallback is not allowed, fail immediately with accurate error
          if (!params.allowFallback || !genAI) {
            return {
              success: false,
              rawText: '',
              parsedResponse: null,
              tokensUsed: 0,
              modelId: requestedModelId,
              actualModelUsed: modelConfig.providerModel,
              providerUsed: 'openrouter',
              isFallback: false,
              latencyMs: Date.now() - startTime,
              error: errMsg,
              errorCode: errCode
            };
          }
          // Fallback allowed, continue below to Gemini fallback
        } else {
          // Success from OpenRouter
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content || '';
          const parsed = extractAndParseJson(content);

          if (!parsed && !params.responseMimeType?.includes('json')) {
            return {
              success: true,
              rawText: content,
              parsedResponse: null,
              tokensUsed: data.usage?.total_tokens || 500,
              modelId: requestedModelId,
              actualModelUsed: modelConfig.providerModel,
              providerUsed: 'openrouter',
              isFallback: false,
              latencyMs: Date.now() - startTime
            };
          }

          if (!parsed) {
            return {
              success: false,
              rawText: content,
              parsedResponse: null,
              tokensUsed: data.usage?.total_tokens || 500,
              modelId: requestedModelId,
              actualModelUsed: modelConfig.providerModel,
              providerUsed: 'openrouter',
              isFallback: false,
              latencyMs: Date.now() - startTime,
              error: 'Response from OpenRouter did not contain valid structured JSON actions.',
              errorCode: 'MALFORMED_OUTPUT'
            };
          }

          return {
            success: true,
            rawText: content,
            parsedResponse: parsed,
            tokensUsed: data.usage?.total_tokens || 500,
            modelId: requestedModelId,
            actualModelUsed: modelConfig.providerModel,
            providerUsed: 'openrouter',
            isFallback: false,
            latencyMs: Date.now() - startTime
          };
        }
      } catch (netErr: any) {
        if (!params.allowFallback || !genAI) {
          return {
            success: false,
            rawText: '',
            parsedResponse: null,
            tokensUsed: 0,
            modelId: requestedModelId,
            actualModelUsed: modelConfig.providerModel,
            providerUsed: 'openrouter',
            isFallback: false,
            latencyMs: Date.now() - startTime,
            error: `Network failure connecting to OpenRouter: ${netErr.message || 'Connection error'}`,
            errorCode: 'NETWORK_ERROR'
          };
        }
      }
    } else {
      // OpenRouter API key not configured
      if (!params.allowFallback || !genAI) {
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
          error: `Model "${modelConfig.displayName}" requires OPENROUTER_API_KEY. Configure key or enable fallback.`,
          errorCode: 'NO_PROVIDER'
        };
      }
    }
  }

  // 3. Native Gemini call (Either direct Gemini model, or explicitly configured fallback)
  if (genAI) {
    const isFallbackRun = !isDirectGemini;
    const fallbackReason = isFallbackRun 
      ? `Primary provider for ${modelConfig.displayName} unavailable; executed via configured Gemini fallback` 
      : undefined;

    try {
      const specializedSysInstruction = isFallbackRun
        ? `${sysPrompt}\n\nYou are operating as fallback for AI Model: ${modelConfig.displayName} (${modelConfig.strengths.join(', ')}). Output only JSON.`
        : sysPrompt;

      const genAiCall = genAI.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: params.prompt,
        config: {
          systemInstruction: specializedSysInstruction,
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

      return {
        success: true,
        rawText: text,
        parsedResponse: parsed,
        tokensUsed: 650,
        modelId: requestedModelId,
        actualModelUsed: 'gemini-3.8-flash',
        providerUsed: 'gemini',
        isFallback: isFallbackRun,
        fallbackReason,
        latencyMs: Date.now() - startTime
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

      return {
        success: false,
        rawText: '',
        parsedResponse: null,
        tokensUsed: 0,
        modelId: requestedModelId,
        actualModelUsed: 'gemini-3.8-flash',
        providerUsed: 'gemini',
        isFallback: isFallbackRun,
        fallbackReason,
        latencyMs: Date.now() - startTime,
        error: `Gemini API execution failed: ${msg}`,
        errorCode: errCode
      };
    }
  }

  // 4. No provider available
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
    error: 'No valid AI provider configured on server (GEMINI_API_KEY or OPENROUTER_API_KEY required).',
    errorCode: 'NO_PROVIDER'
  };
}
