/**
 * Phase 33: shared provider reliability policy.
 *
 * Before this module, every cloud provider call had a hard-coded
 * 8000 ms timeout — far shorter than a real model generation — and no
 * retry on transient failures, so healthy providers looked flaky and
 * fallbacks churned. The policy is now explicit and configurable:
 *
 * - Timeout: `PROVIDER_TIMEOUT_MS` (default 120 s, clamped 1 s..600 s).
 *   A timeout aborts the underlying request; it never just stops
 *   waiting while the request runs on.
 * - Retries: `PROVIDER_MAX_RETRIES` (default 2, clamped 0..5) with
 *   exponential backoff, ONLY for transient failures (HTTP 408/429/
 *   5xx, rate-limit / network / provider error codes). Auth failures,
 *   quota exhaustion, malformed output and cancellations are never
 *   retried.
 */

export function providerTimeoutMs(): number {
  const raw = Number(process.env.PROVIDER_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 120_000;
  return Math.min(600_000, Math.max(1_000, Math.floor(raw)));
}

export function providerMaxRetries(): number {
  const raw = Number(process.env.PROVIDER_MAX_RETRIES);
  if (!Number.isFinite(raw) || raw < 0) return 2;
  return Math.min(5, Math.floor(raw));
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function isRetryableErrorCode(code: string | undefined): boolean {
  return code === 'RATE_LIMITED' || code === 'NETWORK_ERROR' || code === 'PROVIDER_ERROR';
}

/**
 * Sleep between retries (500 ms, 1 s, 2 s, … plus small jitter).
 * Resolves false immediately if the caller's signal aborts, so a
 * cancellation during backoff stops the retry loop at once.
 */
export function backoffSleep(attempt: number, signal?: AbortSignal): Promise<boolean> {
  const ms = Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 150);
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    // The timer must NOT be unref'd: callers await this sleep, and an
    // unref'd timer does not keep the event loop alive — when nothing
    // else is pending, the loop drains while the sleep is still
    // outstanding (node --test cancels such a test with "Promise
    // resolution is still pending but the event loop has already
    // resolved"; a production process could exit mid-retry). The
    // promise always settles — the timer fires, or an abort clears
    // it — so a ref'd timer cannot hold the process open either.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** OpenRouter API base (env-overridable for proxies and transport tests). */
export function openRouterBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
}
