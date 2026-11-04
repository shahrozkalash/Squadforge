# Phase 9 Acceptance Report

**Recommendation:** Do not accept yet. Acceptance is the project owner's decision.
**Assessed commit:** `b8554f7` on `feature/agent-context-and-lockfile`
**Date:** 2026-11-04
**Environment:** Linux container, Node 22.23.4

## Why acceptance is not recommended

All checks pass, but an independent review found open problems in approval handling. The most important is that an approval covers a file path, not the change the owner reviewed (finding F4). Passing tests do not settle these, because the tests do not cover them.

## Check results

| Check | Result |
| :--- | :--- |
| `npm ci` | Pass |
| `npm run lint` | Pass |
| `npm test` | 496 of 496 pass |
| `npm run build` | Pass |

These ran locally in a Linux container. No real AI provider was called. Windows has known local failures, listed in `PHASE_9_PROGRESS.md`.

## Independent review

The `invariant-reviewer` agent reviewed the branch at `d929a34` by reading and tracing code. It did not run anything. It made 13 findings.

### Fixed in `b8554f7`, with regression tests

| Finding | Problem | Fix |
| :--- | :--- | :--- |
| F1 | Generated preview code ran on the app's origin and could approve its own requests | Previews get an opaque origin through a CSP `sandbox` policy, and the iframe no longer has `allow-same-origin` |
| F2 | A request could claim the `system` actor and skip the sensitive-file gate | `proposePatch` and `resolveConflict` reject the reserved actor |
| F3 | Batch renames did not check the destination path | Every path in a batch action is now checked |
| F5 | Stop did not stop model requests or file writes | Stop aborts swarm requests, blocks later writes, and cancels active code generation runs |
| F6 | Any session could register a model with the id `system` | The id is reserved, and updates cannot change a model's id |

The F1 test covers the header on the static preview route. The bundled React preview path was not traced, and no browser test was run.

### Still open

| Finding | Severity | Problem |
| :--- | :--- | :--- |
| F4 | High | An approval covers a path, not reviewed content. Later runs can write different content, approvals are not consumed, rejection does not revoke an earlier approval, and an approved request cannot be withdrawn. This needs a design decision |
| F7 | Medium | Sensitive-path patterns miss common files, such as `src/authService.ts`, `config/credentials.json`, `.npmrc`, `.github/workflows/ci.yml`, and `Dockerfile` |
| F8 | Medium | An approved request can stay usable for almost 48 hours after creation. The owner should decide when the 24 hours starts |
| F9 | Medium if multi-process | The in-memory cache hides a cancellation made by another process, so that process can keep running and write files |
| F10 | Low | The stored cancellation guard is not reached by the pipeline in one process, and `cancellationReason` can be lost |
| F11 | Low | Cancelling while an OpenRouter error body is read records a false provider failure |
| F12 | Low | Cancelled requests log an invented cost |
| F13 | Low | The cancel route reports success when nothing was cancelled |

Two related problems also remain:

- `applyApprovedPatch` does not check that a patch passed review.
- `PUT /api/models/:id` lets any session change a model for every tenant.

## Requirement status

| Requirement | Status |
| :--- | :--- |
| Approval decisions come only from the build owner's session | Verified |
| Sensitive changes need approval | Partial: see F4 and F7 |
| Cancellation of active generation | Verified with stubbed network |
| Stop halts swarm work | Verified with stubbed network |
| Finalization rejects unresolved validation errors | Verified, including a defect appearing after validation passed |
| Reproducible dependency installation | Partial: the lockfile is restored on this branch, but what keeps deleting it is unknown |
| Other Phase 9 capabilities: profiles, multi-pass generation, incremental editing, repair | Implemented, not assessed requirement by requirement |

## Owner decisions

1. Accept Phase 9 with these items open, or require F4, F7, and F8 first.
2. Decide what an approval should cover, and when its validity period starts.
3. Confirm whether `GEMINI_API_KEY` stays required. It was added to `.env.example` so CI passes, which does not settle the question.
