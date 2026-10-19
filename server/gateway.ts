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
  DeleteFileAction,
  RenameFileAction,
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
  task?: any;
  taskComplexity?: 'lightweight' | 'standard' | 'flagship';
  systemInstruction?: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  responseMimeType?: string;
  allowFallback?: boolean;
  bypassCache?: boolean;
  buildId?: string;
  userId?: string;
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

  const validActions: Array<PatchAction | CreateFileAction | DeleteFileAction | RenameFileAction | CreateTaskAction> = [];

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
    } else if (act.action === 'delete_file') {
      if (typeof act.path === 'string' && act.path.trim().length > 0) {
        validActions.push({
          action: 'delete_file',
          path: act.path.trim(),
          commitMessage: typeof act.commitMessage === 'string' ? act.commitMessage : undefined
        });
      }
    } else if (act.action === 'rename_file') {
      if (typeof act.oldPath === 'string' && act.oldPath.trim().length > 0 && typeof act.newPath === 'string' && act.newPath.trim().length > 0) {
        validActions.push({
          action: 'rename_file',
          oldPath: act.oldPath.trim(),
          newPath: act.newPath.trim(),
          commitMessage: typeof act.commitMessage === 'string' ? act.commitMessage : undefined
        });
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
/**
 * Unified gateway call for every model in the registry.
 * Accurately tracks requested model vs actual model used and provider used.
 * Powered by SmartModelRouter for token optimization, rate limiting, and safe fallbacks.
 */
export async function callUnifiedGateway(params: GatewayCallParams): Promise<GatewayResult> {
  const { smartRouter } = await import('./smartRouter.js');
  return smartRouter.executeSmartRequest({
    requestedModelId: params.modelId,
    task: params.task,
    taskComplexity: params.taskComplexity,
    prompt: params.prompt,
    systemInstruction: params.systemInstruction,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    allowFallback: params.allowFallback,
    bypassCache: params.bypassCache,
    buildId: params.buildId,
    userId: params.userId
  });
}
