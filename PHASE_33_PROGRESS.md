# Phase 33 Progress — AI Reliability and Production Security

Status: implemented and verified on 2026-11-25, except the genuine
cloud-provider repair run, which was attempted four times and is
documented honestly below as not yet demonstrated. Final acceptance
remains the project owner's decision.

## What was wrong (found by inspection)

1. **Every cloud provider call timed out after 8 seconds.**
   `smartRouter` used a hard-coded `AbortSignal.timeout(8000)` for
   OpenRouter and an 8 s race for Gemini. Real model generations
   routinely take longer, so healthy providers looked flaky and
   fallbacks churned.
2. **The Gemini "timeout" did not stop the request.** The old code
   raced a timer against the SDK call; when the timer won, the SDK
   request kept running.
3. **No retries on transient failures.** A single 429 or 503 ended
   the call (or burned the one fallback) with no recovery attempt.
4. **The production deployment approval gate could be bypassed from
   the client.** `POST /api/builds/:id/deployments` read
   `skipApprovalGate` from the request body and passed it to the
   service, so any owner could skip the human approval gate for a
   production deployment by sending one flag.
5. **No structured audit log** for approvals, deployments, execution
   sessions, rollbacks or GitHub connections.

## What was built

### Provider reliability (`server/providerReliability.ts`, `server/smartRouter.ts`, `server/gateway.ts`)
- One explicit policy module: `PROVIDER_TIMEOUT_MS` (default
  120 000 ms, clamped 1 s–600 s) and `PROVIDER_MAX_RETRIES` (default
  2, clamped 0–5), retryable-status/code classification, abort-aware
  exponential backoff.
- OpenRouter: fetch now uses the configured timeout and retries
  transient statuses (408/429/5xx) and network failures with
  backoff. Caller aborts and non-retryable statuses stop the loop
  immediately. `OPENROUTER_BASE_URL` env override added (proxies,
  transport tests).
- Gemini: split into a retry wrapper + single-attempt method.
  Transient classifications (rate limit, network, timeout, 5xx) are
  retried with backoff; auth failures, quota exhaustion, malformed
  output and cancellations are never retried. The SDK receives an
  abort signal that genuinely cancels the request: the caller's own
  signal when one is supplied (the Phase 9 contract — the exact
  signal reaches the provider), otherwise an internal controller
  carrying the timeout, so a timeout aborts the SDK request itself.
  `GEMINI_BASE_URL` env override added via `httpOptions.baseUrl`.
- Fallback behaviour is unchanged in shape (OpenRouter → Gemini with
  a recorded reason) and now operates on top of per-provider retries;
  the fallback result carries the original request's parsed payload,
  model id and fallback reason (state is not lost).

### Security fix (`server/deployment/deploymentRoutes.ts`)
- The route no longer reads `skipApprovalGate` from the request
  body. Production deployments over HTTP always require approval.
  The service parameter remains for internal/test use only.
- The Phase 15 route tests that relied on the bypass (Routes 5, 6, 8)
  were updated to release through the real approval gate
  (create → 202 pending → POST approve), per the rule that
  authorization is not weakened to make tests pass.

### Audit log (`server/auditLog.ts`)
- Structured JSON audit events (in-memory ring + optional append to
  `AUDIT_LOG_PATH`) with structural secret redaction: keys matching
  token/secret/password/api-key/authorization/cookie/credential are
  replaced with `[REDACTED]` at any depth, common credential value
  shapes (Bearer, sk-, ghp_, AIza, xox…) are redacted, long strings
  are truncated. Logging never throws.
- Wired into: approval responses (`approval.respond`), deployment
  creation (`deployment.create`), execution session create/stop/
  destroy, repair rollback (`repair.rollback`), checkpoint and file
  rollbacks (`build.rollback_checkpoint`, `build.rollback_file`),
  GitHub OAuth/PAT connect and disconnect (`github.connect`,
  `github.disconnect`). Only ids, actors and outcomes are recorded —
  never prompts, file contents or credentials.

### Audit findings that needed no change (verified by reading + tests)
- Tenant isolation: `verifyBuildOwnership` (404 missing / 403
  foreign) guards the build-scoped route families; the deployment,
  execution, debugging, IDE, release, game and video routers all run
  their ownership wrapper before acting; the store keys files by
  build, and the execution session detail route strips token hashes
  from its response.
- GitHub OAuth/session: tokens are stored encrypted at rest
  (`encryptToken` in the store), the OAuth success page posts to a
  restricted origin, the session cookie is httpOnly with `secure`
  on HTTPS/production.
- Approvals: `ApprovalGateService` fingerprints actions, expires
  stale requests and consumes approvals once; repair rollback goes
  through its own approval state machine with conflict detection
  (`rollbackPlan`) and lease checks in `MergeManager`; the legacy
  `/rollback-checkpoint` and `/rollback-file` routes check ownership
  and delegate to the same lease-checked merge rollback.

## Verification

- `tests/phase33_ai_reliability_security.test.ts`: **13 pass, 1
  skipped** (the gated live test). The transport tests run the real
  adapters over real HTTP against an in-process stub server — a
  transport fixture, not a model: OpenRouter success, 429-retry
  (3 attempts), 401-never-retried, cancellation observed by the
  server as a client disconnect, timeout abort + Gemini fallback
  preserving the parsed result, Gemini SDK success, Gemini 429-retry,
  Gemini timeout aborting the SDK request (disconnect observed),
  local-provider cancellation, honest `NO_PROVIDER` failure with no
  keys configured, the deployment gate fix at route level (202
  pending even with the old flag in the body; foreign user rejected),
  and audit-log redaction.
- Phase 9 cancellation suite: 21/21 alone; 34/34 together with
  Phase 33. Phase 15 deployment suites: 33/33 after the test updates.
- Full suite: 1,127 tests, 1,121 pass, 5 fail, 1 skipped. Two
  failures are the known pre-existing pair (orchestration sandbox
  integrity; Phase 4 test 19). Three were timing-sensitive Phase 9 /
  Phase 15 route tests under full parallel load; each passes in
  isolation (Phase 9 21/21; Phase 15 33/33).
- Lint (`tsc --noEmit`) and production build pass.

## Genuine cloud provider attempt (item 1) — NOT yet demonstrated

No provider key exists in this server's environment (keys stay in
secure storage by design), so SquadForge's own provider path cannot
run live here. A genuine Gemini call was attempted four times
through the owner's connected Google AI Studio credential (the
sanctioned connector helper, key never exposed):

1. Default model: Google returned a real **503 UNAVAILABLE**
   ("high demand") — the credential and API path are genuinely live.
2. `gemini-2.5-flash`: real **404** — Google states the model "is no
   longer available to new users" and recommends
   `models/gemini-3.8-flash` (which also confirms the registry's
   3.8-flash id is a real current model).
3–4. `gemini-3.8-flash`: both attempts died on read timeouts through
   this VM's egress after the helper's own retries (~5.5 and ~7
   minutes).

So: provider reachability and authentication are proven by real API
responses; a successful live repair generation is **not** claimed.
The suite's live test (`LIVE_PROVIDER_TEST=1` + a real
`GEMINI_API_KEY`) runs the actual smartRouter debugging-style call
in any environment that has the key, and the transport behaviour it
depends on (timeout, retry, cancellation, fallback) is fully proven
by the stub-server tests above.

## Limitations

- With a caller-supplied abort signal, the Gemini timeout returns
  control at the deadline but the underlying SDK request is owned by
  the caller's lifecycle (the exact-signal contract from Phase 9);
  with no caller signal, the timeout aborts the request itself.
- Retries add latency on genuinely failing providers (bounded:
  at most (1 + retries) attempts per provider per call, backoff
  capped at ~8 s).
- The audit log is append-only JSONL plus an in-memory ring; it is
  not shipped to an external SIEM and has no rotation policy yet.
- Tenant isolation was audited by code inspection plus the route
  tests in this and earlier phases; it was not penetration-tested.
