# Phase 33 Acceptance Report — AI Reliability and Production Security

**Status:** Implemented and verified on 2026-11-25, with one item
explicitly incomplete (see "Not demonstrated"). Final acceptance
remains the project owner's decision.
**Recommendation:** The reliability and security changes are safe to
keep. Do not treat live cloud repair as verified until the gated
live test passes in an environment with a real provider key.

## What this phase delivered

| # | Requirement | Result |
| :--- | :--- | :--- |
| 1 | Debugging/repair with a genuine cloud provider | **Not demonstrated.** Four genuine attempts through the owner's AI Studio credential returned real API responses (503 high demand; 404 model retired) or died on egress read timeouts. Reachability/auth proven; a successful generation is not claimed. Gated live test stands ready (`LIVE_PROVIDER_TEST=1`). |
| 2 | Cancellation stops actual work | **Verified.** Stub servers observe the client disconnect on caller abort for OpenRouter, Gemini (SDK) and the local provider; Phase 9 suite (21/21) also passes. |
| 3 | Timeouts, retries, failure recovery | **Verified.** 8 s hard-coded timeout replaced by configurable policy (default 120 s); bounded retries with abort-aware backoff for transient failures only; transport tests prove 429-retry, no-retry-on-401, timeout-abort. |
| 4 | Fallback without losing state | **Verified.** Timeout on OpenRouter falls back to Gemini and returns the original request's parsed payload with `isFallback` and the reason recorded. |
| 5 | Tenant isolation audit | **Verified by inspection + tests.** Ownership wrappers precede actions on every build-scoped route family audited; deployment route test proves foreign-user rejection; session detail strips token hashes. |
| 6 | GitHub OAuth, sessions, stored credentials | **Verified by inspection.** Tokens encrypted at rest; OAuth success page uses a restricted postMessage origin; session cookie httpOnly + secure on HTTPS/production. No change needed. |
| 7 | Approval gates for sensitive changes/deployments | **Gap found and fixed.** The deployment route accepted `skipApprovalGate` from the request body, bypassing the production gate. Removed; Phase 15 route tests updated to use the real approval flow (33/33). |
| 8 | Rollback conflict detection and permissions | **Verified by inspection.** Repair rollback has conflict detection and an approval state machine; merge rollback rejects files leased by another model; legacy rollback routes check ownership. Audit logging added to all rollback routes. |
| 9 | Automated security regression tests | **Done.** `tests/phase33_ai_reliability_security.test.ts` (13 pass, 1 gated skip) covers the gate fix, isolation rejection, redaction and the honest no-provider failure. |
| 10 | Structured audit logs without secrets | **Done.** `server/auditLog.ts` with structural redaction, wired into approvals, deployments, execution sessions, rollbacks and GitHub connect/disconnect; redaction proven by test at any nesting depth. |

## Check results

| Check | Result |
| :--- | :--- |
| Phase 33 tests | 13 pass, 1 skipped (gated live cloud test) |
| Phase 9 + Phase 33 together | 34 pass, 0 fail |
| Phase 15 deployment suites | 33/33 after test updates |
| Full suite | 1,127 tests: 1,121 pass, 5 fail, 1 skipped — 2 failures are the known pre-existing pair; 3 are timing-sensitive tests under parallel load that pass in isolation |
| Lint / typecheck | Pass (`tsc --noEmit`) |
| Production build | Pass |

## Not demonstrated / limitations

- **Live cloud repair generation** (item 1) — see the progress file
  for the four attempts and their real provider responses.
- Gemini timeout with a caller-supplied signal returns control at
  the deadline; the request itself is owned by the caller's signal
  (Phase 9 exact-signal contract). Without a caller signal the
  timeout aborts the SDK request directly (proven by test).
- Audit log has no rotation or external shipping yet.
- The isolation audit is code inspection plus tests, not a
  penetration test.
