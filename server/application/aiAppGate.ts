import { modelRegistry } from '../modelRegistry.js';
import {
  probeWebAppRuntime,
  type WebAppFileInput,
  type WebRouteProbe,
  type WebRuntimeProbeReport
} from './webRuntimeProbe.js';

/**
 * Factory Phase F12 — the AI-behaviour gate for generated AI
 * applications.
 *
 * An AI application is an application that itself calls AI models at
 * runtime, through SquadForge's replaceable provider layer (the
 * model registry + smart router, reached via the platform gateway).
 * This gate is the workflow's evidence that a delivered AI
 * application behaves honestly, and it reuses the F9 runtime probe
 * (probeWebAppRuntime) to start the delivered application for real
 * and probe it over HTTP. Three runs:
 *
 *   Run 1 — no provider configured. The host injects only the
 *     platform gateway binding (SQUADFORGE_GATEWAY_MODULE). The
 *     application's non-AI surface (health, UI, data routes) must
 *     work, and its AI endpoint must fail LOUDLY with the router's
 *     own named error — the key-gate refusal the F1 phase pinned
 *     (errorCode NO_PROVIDER, the message naming the missing key) —
 *     surfaced through the application. A response carrying an
 *     answer in this run is a fabricated answer and fails the gate
 *     on its own, whatever its status.
 *
 *   Runs 2..n — stubbed provider transport. The host additionally
 *     injects a dummy provider key and OPENROUTER_BASE_URL pointing
 *     at a stub transport (the Phase 33 seam: the router's real HTTP
 *     transport, redirected by configuration). For each configured
 *     model id (AI_MODEL_ID — application configuration, not code),
 *     the AI endpoint must complete a real round trip through the
 *     application's own code path — request → bridge → gateway →
 *     router → stub transport → parsed report answer → rendered
 *     response — and report the registry's upstream model id for
 *     the configured model. Changing AI_MODEL_ID between runs must
 *     change the reported upstream model with the delivered files
 *     byte-identical: that is the replaceability evidence.
 *
 * Scope honesty: the stub runs prove the application's wiring
 * against the platform's real router code over a stubbed transport.
 * They are not live model generations (F1 verdict: no provider key
 * exists in this environment, and no model is live-proven).
 */

export interface AiAppContract {
  /** Readiness route polled until it answers 200. Default '/api/health'. */
  healthPath?: string;
  /** The non-AI surface: health, UI, and data routes, probed in run 1. */
  surfaceProbes: WebRouteProbe[];
  /** The AI endpoint, e.g. '/api/chat'. */
  chatPath: string;
  /** A valid AI request body (a question the endpoint accepts). */
  chatBody: unknown;
  /** Probe name for the AI endpoint. Default 'AI chat endpoint'. */
  chatProbeName?: string;
  /** Text the no-provider error must name (the missing key). */
  noProviderErrorIncludes: string;
}

export interface AiStubProvider {
  /** Base URL of the stub OpenRouter transport (the Phase 33 seam). */
  baseUrl: string;
  /** Dummy key; the stub transport accepts any Authorization header. */
  apiKey: string;
}

export interface AiAppGateOptions {
  /** Absolute path of the platform gateway module the host injects. */
  gatewayModulePath: string;
  /** Stub transport for the round-trip runs. */
  stubProvider?: AiStubProvider;
  /** Configured model ids for the round-trip runs. Default ['gpt-4o']. */
  modelIds?: string[];
}

export interface AiNoProviderResult {
  passed: boolean;
  status?: number;
  errorCode?: string;
  error?: string;
  /** True when the no-provider response carried an answer anyway. */
  fabricatedAnswer: boolean;
  detail: string;
}

export interface AiStubRunResult {
  modelId: string;
  passed: boolean;
  status?: number;
  answer?: string;
  /** The upstream model id the application reported for this run. */
  actualModelUsed?: string;
  providerUsed?: string;
  detail: string;
}

export interface AiAppGateReport {
  /**
   * True only when the surface worked, the no-provider run failed
   * loudly with the named error and no fabricated answer, and every
   * requested stub round trip completed.
   */
  passed: boolean;
  /** Run 1's full probe report (surface + AI endpoint, no provider). */
  noProviderRun: WebRuntimeProbeReport;
  noProvider: AiNoProviderResult;
  stubRuns: AiStubRunResult[];
  errors: string[];
}

function parseJsonBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Runs the AI-behaviour gate against a delivered application's
 * files. Never throws for application faults — every failure lands
 * in the report.
 */
export async function probeAiAppBehaviour(
  files: WebAppFileInput,
  contract: AiAppContract,
  options: AiAppGateOptions
): Promise<AiAppGateReport> {
  const errors: string[] = [];
  const chatName = contract.chatProbeName ?? 'AI chat endpoint';
  const modelIds = options.modelIds ?? ['gpt-4o'];

  // ---- Run 1: no provider configured -------------------------------
  const noProviderChatProbe: WebRouteProbe = {
    name: chatName,
    method: 'POST',
    path: contract.chatPath,
    body: contract.chatBody,
    expectStatus: 503,
    expectJsonSubset: { errorCode: 'NO_PROVIDER' },
    expectTextIncludes: contract.noProviderErrorIncludes
  };
  const noProviderRun = await probeWebAppRuntime(files, {
    healthPath: contract.healthPath,
    probes: [...contract.surfaceProbes, noProviderChatProbe],
    extraEnv: { SQUADFORGE_GATEWAY_MODULE: options.gatewayModulePath }
  });

  const chatResult = noProviderRun.probes.find(p => p.name === chatName);
  const chatBody = parseJsonBody(chatResult?.body);
  const fabricatedAnswer =
    !!chatBody && typeof chatBody.answer === 'string' && (chatBody.answer as string).trim().length > 0;
  const surfacePassed = noProviderRun.probes
    .filter(p => p.name !== chatName)
    .every(p => p.passed);
  const noProviderErrorCode = typeof chatBody?.errorCode === 'string' ? (chatBody.errorCode as string) : undefined;
  const noProviderError = typeof chatBody?.error === 'string' ? (chatBody.error as string) : undefined;
  const noProvider: AiNoProviderResult = {
    passed: !!chatResult?.passed && !fabricatedAnswer,
    status: chatResult?.actualStatus,
    errorCode: noProviderErrorCode,
    error: noProviderError,
    fabricatedAnswer,
    detail: !chatResult
      ? 'the AI endpoint probe did not run'
      : fabricatedAnswer
        ? `the AI endpoint returned an answer with no provider configured — a fabricated answer. Body: ${(chatResult.body ?? '').slice(0, 300)}`
        : chatResult.passed
          ? `the AI endpoint failed loudly as required: 503 with the router's named error (${noProviderErrorCode ?? 'NO_PROVIDER'}).`
          : `the AI endpoint did not produce the required named failure: ${chatResult.detail}`
  };
  if (!surfacePassed) {
    errors.push('the non-AI surface failed in the no-provider run: ' +
      noProviderRun.probes.filter(p => p.name !== chatName && !p.passed).map(p => `${p.name}: ${p.detail}`).join('; '));
  }
  if (!noProviderRun.started) {
    errors.push('the application did not start in the no-provider run: ' + noProviderRun.errors.join('; '));
  }

  // ---- Runs 2..n: stubbed provider transport -----------------------
  const stubRuns: AiStubRunResult[] = [];
  if (!options.stubProvider) {
    errors.push('no stub provider transport was supplied, so no round-trip run was made; a verified AI delivery requires one');
  } else {
    for (const modelId of modelIds) {
      const expectedUpstream = modelRegistry.getById(modelId)?.providerModel;
      const run = await probeWebAppRuntime(files, {
        healthPath: contract.healthPath,
        probes: [{
          name: chatName,
          method: 'POST',
          path: contract.chatPath,
          body: contract.chatBody,
          expectStatus: 200,
          expectJsonSubset: { provider: 'openrouter' }
        }],
        extraEnv: {
          SQUADFORGE_GATEWAY_MODULE: options.gatewayModulePath,
          OPENROUTER_API_KEY: options.stubProvider.apiKey,
          OPENROUTER_BASE_URL: options.stubProvider.baseUrl,
          AI_MODEL_ID: modelId
        }
      });
      const result = run.probes.find(p => p.name === chatName);
      const body = parseJsonBody(result?.body);
      const answer = typeof body?.answer === 'string' ? (body.answer as string) : undefined;
      const actualModelUsed = typeof body?.model === 'string' ? (body.model as string) : undefined;
      const providerUsed = typeof body?.provider === 'string' ? (body.provider as string) : undefined;
      const modelMatches = expectedUpstream !== undefined && actualModelUsed === expectedUpstream;
      const passed = !!result?.passed && !!answer && answer.trim().length > 0 && modelMatches;
      stubRuns.push({
        modelId,
        passed,
        status: result?.actualStatus,
        answer,
        actualModelUsed,
        providerUsed,
        detail: !run.started
          ? 'the application did not start: ' + run.errors.join('; ')
          : passed
            ? `round trip completed for configured model "${modelId}": the application reported upstream model "${actualModelUsed}" via provider "${providerUsed}" and returned the transport's answer`
            : `round trip failed for configured model "${modelId}": ${result?.detail ?? 'probe did not run'} (reported model: ${actualModelUsed ?? 'none'}, expected upstream: ${expectedUpstream ?? 'unregistered model'})`
      });
    }
  }

  const passed =
    noProviderRun.started &&
    surfacePassed &&
    noProvider.passed &&
    !!options.stubProvider &&
    stubRuns.length === modelIds.length &&
    stubRuns.every(r => r.passed);

  return { passed, noProviderRun, noProvider, stubRuns, errors };
}
