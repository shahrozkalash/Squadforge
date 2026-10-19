import { 
  AIProvider, 
  ProviderQuotaStatus, 
  ProviderHealthStatus, 
  GatewayErrorCode 
} from './types.js';

export interface RecordRequestOutcome {
  provider: AIProvider;
  modelId: string;
  success: boolean;
  statusCode?: number;
  tokensUsed?: number;
  actualTokens?: boolean;
  headers?: Record<string, string | string[] | undefined>;
  error?: string;
  errorCode?: GatewayErrorCode;
}

export class QuotaManager {
  private static instance: QuotaManager;
  private providerQuotas: Map<string, ProviderQuotaStatus> = new Map();

  // Backoff parameters
  private readonly BASE_BACKOFF_MS = 2000;
  private readonly MAX_BACKOFF_MS = 60000; // 1 minute max backoff

  private constructor() {
    this.initProviders();
  }

  static getInstance(): QuotaManager {
    if (!QuotaManager.instance) {
      QuotaManager.instance = new QuotaManager();
    }
    return QuotaManager.instance;
  }

  private initProviders(): void {
    const defaultProviders: AIProvider[] = ['gemini', 'openrouter', 'local'];
    for (const p of defaultProviders) {
      this.providerQuotas.set(p, {
        provider: p,
        status: 'healthy',
        consecutiveErrors: 0,
        isEstimated: true,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0
      });
    }
  }

  /**
   * Generates key for provider or provider+model
   */
  private getKey(provider: AIProvider, modelId?: string): string {
    return modelId ? `${provider}:${modelId}` : provider;
  }

  /**
   * Retrieves or creates status for provider and model
   */
  getQuotaStatus(provider: AIProvider, modelId?: string): ProviderQuotaStatus {
    const key = this.getKey(provider, modelId);
    let status = this.providerQuotas.get(key);
    if (!status) {
      // Fallback to base provider status if model-specific doesn't exist
      status = this.providerQuotas.get(provider) || {
        provider,
        modelId,
        status: 'healthy',
        consecutiveErrors: 0,
        isEstimated: true,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0
      };
      this.providerQuotas.set(key, status);
    }

    // Check if cooldown has expired
    if (status.status === 'cooldown' || status.status === 'rate_limited') {
      if (status.cooldownUntil && Date.now() >= status.cooldownUntil) {
        status.status = 'healthy';
        status.cooldownUntil = undefined;
        status.retryAfterSeconds = undefined;
      }
    }

    return { ...status };
  }

  /**
   * Checks if a provider or specific model is currently available and not in cooldown/exhausted
   */
  isProviderAvailable(provider: AIProvider, modelId?: string): { available: boolean; reason?: string; retryAfterSeconds?: number } {
    const providerStatus = this.getQuotaStatus(provider);
    const modelStatus = modelId ? this.getQuotaStatus(provider, modelId) : null;

    // Check base provider first
    const activeStatus = (modelStatus && modelStatus.status !== 'healthy') ? modelStatus : providerStatus;
    const now = Date.now();

    if (activeStatus.status === 'quota_exhausted') {
      return {
        available: false,
        reason: `Provider ${provider} quota/credits exhausted. Requires credit top-up or quota reset.`
      };
    }

    if (activeStatus.status === 'auth_error') {
      return {
        available: false,
        reason: `Provider ${provider} authentication failed (invalid API key or permissions).`
      };
    }

    if (activeStatus.status === 'offline') {
      return {
        available: false,
        reason: `Provider ${provider} service is currently offline or unreachable.`
      };
    }

    if (activeStatus.cooldownUntil && activeStatus.cooldownUntil > now) {
      const waitSec = Math.ceil((activeStatus.cooldownUntil - now) / 1000);
      return {
        available: false,
        reason: `Provider ${provider} in cooldown (${waitSec}s remaining due to rate limits or recent errors).`,
        retryAfterSeconds: waitSec
      };
    }

    return { available: true };
  }

  /**
   * Records the outcome of an API call to update provider health, metrics, and rate limit tracking
   */
  recordOutcome(params: RecordRequestOutcome): void {
    const { provider, modelId, success, statusCode, error, errorCode, headers } = params;
    const now = Date.now();

    const providerEntry = this.getOrCreateEntry(provider);
    const modelEntry = this.getOrCreateEntry(provider, modelId);

    const updateTarget = (entry: ProviderQuotaStatus) => {
      entry.totalRequests++;
      entry.lastUsedAt = now;

      if (success) {
        entry.successfulRequests++;
        entry.consecutiveErrors = 0;
        entry.status = 'healthy';
        entry.lastError = undefined;
        entry.lastErrorCode = undefined;
        entry.cooldownUntil = undefined;
        entry.retryAfterSeconds = undefined;

        // Extract provider-reported rate limits from response headers if present
        if (headers) {
          this.parseRateLimitHeaders(entry, headers);
        }
      } else {
        entry.failedRequests++;
        entry.consecutiveErrors++;
        entry.lastError = error;
        entry.lastErrorCode = errorCode;

        // Determine specific failure type and calculate backoff
        if (statusCode === 429 || errorCode === 'RATE_LIMITED') {
          entry.status = 'rate_limited';
          
          // Check for Retry-After header
          let retryAfterSec = this.extractRetryAfter(headers);
          if (!retryAfterSec) {
            // Exponential backoff with jitter: base * 2^errors + jitter
            const exponent = Math.min(entry.consecutiveErrors, 5);
            const baseMs = Math.min(this.MAX_BACKOFF_MS, this.BASE_BACKOFF_MS * Math.pow(2, exponent));
            const jitterMs = Math.floor(Math.random() * 1000);
            retryAfterSec = Math.ceil((baseMs + jitterMs) / 1000);
          }

          entry.retryAfterSeconds = retryAfterSec;
          entry.cooldownUntil = now + (retryAfterSec * 1000);
          entry.isEstimated = !this.hasProviderReportedHeader(headers);
        } else if (statusCode === 402 || errorCode === 'QUOTA_EXHAUSTED') {
          entry.status = 'quota_exhausted';
          entry.cooldownUntil = undefined; // Hard stop until user refills
          entry.isEstimated = false;
        } else if (statusCode === 401 || statusCode === 403 || errorCode === 'INVALID_API_KEY') {
          entry.status = 'auth_error';
          entry.cooldownUntil = undefined; // Hard stop until key corrected
          entry.isEstimated = false;
        } else if (statusCode && statusCode >= 500) {
          entry.status = 'cooldown';
          // Temporary backoff for 5xx server errors
          const backoffSec = Math.min(30, 2 * Math.pow(2, Math.min(entry.consecutiveErrors, 4)));
          entry.cooldownUntil = now + (backoffSec * 1000);
          entry.retryAfterSeconds = backoffSec;
          entry.isEstimated = true;
        } else {
          entry.status = 'cooldown';
          const backoffSec = 5;
          entry.cooldownUntil = now + (backoffSec * 1000);
          entry.retryAfterSeconds = backoffSec;
          entry.isEstimated = true;
        }
      }
    };

    updateTarget(providerEntry);
    updateTarget(modelEntry);
  }

  /**
   * Manually resets cooldown/error state for a provider (e.g. after user updates key or settings)
   */
  resetProvider(provider: AIProvider): void {
    const entry = this.getOrCreateEntry(provider);
    entry.status = 'healthy';
    entry.consecutiveErrors = 0;
    entry.cooldownUntil = undefined;
    entry.retryAfterSeconds = undefined;
    entry.lastError = undefined;
    entry.lastErrorCode = undefined;
  }

  /**
   * Returns a snapshot of all active provider quota statuses for the dashboard
   */
  getAllStatuses(): Record<string, ProviderQuotaStatus> {
    const result: Record<string, ProviderQuotaStatus> = {};
    for (const [key, val] of this.providerQuotas.entries()) {
      result[key] = { ...val };
    }
    return result;
  }

  private getOrCreateEntry(provider: AIProvider, modelId?: string): ProviderQuotaStatus {
    const key = this.getKey(provider, modelId);
    let entry = this.providerQuotas.get(key);
    if (!entry) {
      entry = {
        provider,
        modelId,
        status: 'healthy',
        consecutiveErrors: 0,
        isEstimated: true,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0
      };
      this.providerQuotas.set(key, entry);
    }
    return entry;
  }

  private extractRetryAfter(headers?: Record<string, string | string[] | undefined>): number | null {
    if (!headers) return null;
    const headerVal = headers['retry-after'] || headers['Retry-After'];
    if (!headerVal) return null;

    const str = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const seconds = parseInt(str, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds;
    }

    // Try parsing as HTTP-date
    const parsedDate = Date.parse(str);
    if (!isNaN(parsedDate)) {
      const diffSec = Math.ceil((parsedDate - Date.now()) / 1000);
      return diffSec > 0 ? diffSec : 1;
    }

    return null;
  }

  private hasProviderReportedHeader(headers?: Record<string, string | string[] | undefined>): boolean {
    if (!headers) return false;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase().includes('ratelimit') || k.toLowerCase().includes('retry-after')) {
        return true;
      }
    }
    return false;
  }

  private parseRateLimitHeaders(entry: ProviderQuotaStatus, headers: Record<string, string | string[] | undefined>): void {
    const getHeader = (pattern: string): string | undefined => {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase().includes(pattern.toLowerCase())) {
          return Array.isArray(v) ? v[0] : v;
        }
      }
      return undefined;
    };

    const limitStr = getHeader('ratelimit-limit') || getHeader('x-ratelimit-limit-requests');
    const remainingStr = getHeader('ratelimit-remaining') || getHeader('x-ratelimit-remaining-requests');
    const resetStr = getHeader('ratelimit-reset') || getHeader('x-ratelimit-reset-requests');

    if (limitStr) {
      const num = parseInt(limitStr, 10);
      if (!isNaN(num)) {
        entry.reportedLimit = num;
        entry.isEstimated = false;
      }
    }

    if (remainingStr) {
      const num = parseInt(remainingStr, 10);
      if (!isNaN(num)) {
        entry.reportedRemaining = num;
        entry.isEstimated = false;
      }
    }

    if (resetStr) {
      const num = parseInt(resetStr, 10);
      if (!isNaN(num)) {
        // Could be seconds from now or unix timestamp in seconds
        entry.reportedResetTime = num > 1000000000 ? num * 1000 : Date.now() + (num * 1000);
        entry.isEstimated = false;
      }
    }
  }
}

export const quotaManager = QuotaManager.getInstance();
