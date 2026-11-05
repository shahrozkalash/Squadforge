# Phase 9 Progress: Advanced Code Generation Engine

**Status:** Fixes complete except for the limitations in `PHASE_9_ACCEPTANCE_REPORT.md`. Formal acceptance is the owner's decision.
**Latest assessment:** see `PHASE_9_ACCEPTANCE_REPORT.md`. The tables below were recorded at `472de53`, and several limitations listed here have since been fixed there.
**Date:** 2026-11-04

This file covers the approval authorization and cancellation work. The rest of Phase 9 has not been re-assessed requirement by requirement.

## Check results

Results for commit `472de53`. No real AI provider was called.

| Check | Linux, Node 22.23.4 | Windows, Node 24.3.0 |
| :--- | :--- | :--- |
| `npm ci` | Pass | Pass |
| `npm run lint` | Pass | Pass |
| `npm test` | 487 of 488 pass | 478 of 482 pass |
| `npm run build` | Pass | Fail |

Test totals differ between platforms because `tests/public_access.test.ts` cannot load on Windows.

### Failing tests

| Test | Platform | Cause | Introduced by this work |
| :--- | :--- | :--- | :--- |
| `.env.example documents all required and optional environment keys` | Both | `.env.example` omits `GEMINI_API_KEY`, which the test requires | No |
| `tests/public_access.test.ts`, and `npm run build` | Windows | The lockfile has no `@rolldown/binding-win32-x64-msvc` entry | No |
| Phase 4 test 14, skipped tests | Windows | Not diagnosed. Passes on Linux | No |
| Phase 4 test 16, invalid TypeScript configuration | Windows | Not diagnosed. Passes on Linux | No |

All four failures also occur on the commit before this work, `975606e`.

## Approval authorization

| Requirement | Status | Evidence |
| :--- | :--- | :--- |
| Only the authenticated build owner can decide | Verified | `respondToApproval` compares the session user with `build.userId`, and rejects a missing identity or a build with no owner |
| Remove the `human_reviewer` exception | Verified | Removed from `server.ts` and `approvalGateService.ts` |
| `approvedBy` is not proof of identity | Verified | The recorded approver is always the session user. `approvedBy` can only block a decision |
| Request must belong to the same build | Verified | Regression test |
| Reject other users, agents, and repeated decisions | Verified | Regression tests |
| Reject expired requests | Verified | Pending requests expire 24 hours after `createdAt`. No schema change was needed |
| Guests keep working, but stay isolated | Verified on Linux | Test using real `resolveUser` guest sessions in `tests/public_access.test.ts`, which cannot load on Windows |

The approval routes were not tested with real HTTP requests. The tests call the service directly, and the route also runs `verifyBuildOwnership`.

## Cancellation

| Requirement | Status | Evidence |
| :--- | :--- | :--- |
| Cancellation mechanism for active requests | Verified | `cancelRun` aborts a per-run `AbortController` |
| Propagate into model requests | Verified with stubbed network | The signal reaches OpenRouter `fetch`, Gemini `abortSignal`, and local model `fetch` |
| No fallback after cancellation | Verified with stubbed network | A cancelled OpenRouter request does not start Gemini |
| Check before file modification and patch application | Verified | `MergeManager.applyBatchActions` checks the signal after the patch queue wait, immediately before writing |
| Cancelled runs cannot be finalized | Verified in one process | Checks after each awaited step and before finalization |
| Late responses cannot overwrite a cancelled run | Verified in one process | Regression test for a late model response. The stale writer test only proves the storage rule, which the pipeline does not reach in one process |
| Keep files completed before cancellation | Verified | Regression test. Applied files stay in place and are listed on the run |
| Clean up state after every run | Verified | Regression tests for cancelled and failed runs |

`applyBatchActionsAtomic` is one synchronous SQLite transaction, so nothing can cancel between its actions. The single check before it covers every file in the batch. This is the only way the generation and repair passes write files.

Running the new test file against the previous code gave 9 failures and 4 cancelled tests, so these tests do detect the old behavior.

## Known limitations

- Aborting does not guarantee a provider stops work or billing. The Gemini SDK abort is client side only.
- The abort controller is in memory, and the run cache hides stored cancellation. In a multi-process deployment, another process keeps running and can write files until a save trips the storage guard.
- `cancellationReason` and `cancelledAt` have no database columns. They can be lost after a restart or a cache eviction, and `GET .../runs` never returns them. The reason is still available in `error`.
- Cancelling a run leaves its pending approval requests pending, and approving one later still unlocks the file for other runs.
- No run resumes automatically after an approval is granted.

## Remaining before acceptance

1. Resolve the open review findings in `PHASE_9_ACCEPTANCE_REPORT.md`, starting with F4.
2. Test cancellation against a real provider.
3. Find out what keeps deleting `package-lock.json`, and decide whether the lockfile should support Windows.
4. Get the owner's acceptance decision.
