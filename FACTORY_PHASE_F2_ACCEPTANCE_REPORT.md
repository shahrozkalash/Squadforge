# Factory Phase F2 — Acceptance Report

**Phase:** F2 — Delegation and Parallel Execution Gauntlet
**Date:** 2026-11-27
**Verdict:** **Complete.** The whole swarm chain — decomposition, dependency-ordered delegation, parallel per-model workers, approval holds, merge, failure recovery, cancellation, and the completion verification stage — is now proven end-to-end by one gauntlet suite driving the real orchestrator. One genuine chain-breaking defect was found by the gauntlet and fixed with regression tests.

## Stub-transport honesty statement

No live model exists in this environment (Factory Phase F1 closed as a documented negative: no provider keys). The gauntlet therefore runs over a **stub transport** — `smartRouter.executeSmartRequest` replaced per test, the repository's own established seam (Phase 9 pattern). The stub returns deterministic fixture content. **This proves delegation, scheduling, dependency ordering, parallelism, cancellation and recovery mechanics. It proves nothing about live generation quality**, and no such claim is made anywhere in this phase.

## Acceptance criteria (roadmap) — results

| # | Criterion | Result |
| :-- | :-- | :-- |
| 1 | Gauntlet suite passes: dependent tasks never start before dependencies complete (ordering from the task log); parallel workers' writes never corrupt each other (final tree hash-matches expected merge) | **Pass.** Ordering asserted over every dependency edge of the seeded graph (8 tasks): each dependent's first genuine claim (the `task_claimed` event carrying a `modelId`) comes after its dependency's `task_completed` event. Final tree SHA-256 over sorted path+content pairs equals the expected merge computed from the task list. |
| 2 | Cancellation stops in-flight model calls (no task completes after the cancel point); build ends cancelled, not silent success | **Pass.** The stub transport observed its `AbortSignal` fire; build status `stopped`; zero tasks completed; no `build_completed` event; no `task_completed` after `build_stopped` in the log. |
| 3 | One worker's tasks are retried/reassigned per policy; build still completes with the failure recorded | **Pass.** The first claimed task's transport failed all 3 in-task attempts → `task_released` event attributed to the failing model with the injected error in its details, task `retryCount ≥ 1`, release precedes the task's eventual completion in the log; build `completed`; zero tasks failed. |
| 4 | `tests/orchestration.test.ts` and the concurrency suites (phase1/phase5) pass; lint and build pass | **Pass.** orchestration + phase1_task_concurrency + phase5_concurrency_hardening: **44/44**. Lint (`tsc --noEmit`) exit 0. Build (`vite build`) exit 0. |
| + | (Brief) Final merged output passes the patch-validation/verification stage the chain normally applies | **Pass.** The happy-path build reached `completed` only through the chain's own gates: a `sandbox_check` event reporting "passed cleanly", a saved checkpoint, a `verifier_approved` event, and zero fix tasks required. |

Parallelism evidence is deterministic, not timing-based: the stub holds the first worker call at a **rendezvous barrier** until a second worker call is concurrently in flight (a serial executor would sit out the 10 s barrier timeout alone and fail the test). The barrier was met, max in-flight model calls ≥ 2, and tasks were completed by ≥ 2 distinct models.

## Defects

| Defect | Severity | Disposition |
| :-- | :-- | :-- |
| `ExecutionAdapter.parseTestOutput` understood only TAP test output; on Node versions emitting the spec reporter (local Node 24; CI pins Node 22/TAP), a fully passing run was reported 100% failed (fallback keyed on the bare word `fail`, which a passing summary itself prints as `fail 0`). SandboxRunner then spawned unbounded "Fix Error in tests/…" tasks — **no build containing tests could complete** on such a Node version. | Chain-breaking | **Fixed** in `server/swarm/executionAdapter.ts` (parse ✔/✖ spec lines; fallback reads the summary fail count). Pinned by two gauntlet regression tests (green stays green, red stays red). This was also the root cause of the two known local-only failures (`orchestration.test.ts:334`, `phase4` test 19) — both now pass locally. |
| `task_claimed` event type is overloaded (board-add and resume emit it without a `modelId`). | Cosmetic (details text is honest) | Documented, not fixed — event taxonomy change is beyond F2's minimal scope; the gauntlet asserts on genuine claims. |
| Dependents of a permanently failed task stay `pending`; the build waits for the duration cap instead of failing fast. | Liveness wart | Documented in the progress log as a limitation for a future phase; not patched under F2's minimal-fix mandate. |

## Verification (exact counts, from printed summaries)

| Run | Result |
| :-- | :-- |
| `tests/factory_phase_f2_gauntlet.test.ts` | **5/5 pass, 0 fail** (~25 s) |
| `tests/orchestration.test.ts` + `tests/phase1_task_concurrency.test.ts` + `tests/phase5_concurrency_hardening.test.ts` | **44/44 pass, 0 fail** (includes the previously local-only-failing `orchestration.test.ts:334`, now green) |
| `tests/execution_adapter.test.ts` + `tests/phase12_automated_testing_qa.test.ts` + `tests/phase9_limitations.test.ts` + `tests/phase9_gate_bypass.test.ts` + `tests/phase33_live_provider_proof.test.ts` + `tests/factory_phase_f1_capability.test.ts` | **43/43 pass, 0 fail** |
| `tests/phase10_execution.test.ts` + `tests/file_operations.test.ts` + `tests/fullstack_agent_and_concurrency.test.ts` + `tests/phase3_typescript_verification.test.ts` | **111/111 pass, 0 fail** |
| `tests/phase4_production_reliability.test.ts` | **19/19 pass, 0 fail** (test 19, the other known local-only failure, now green) |
| `npm run lint` (`tsc --noEmit`) | exit 0, no diagnostics |
| `npm run build` (`vite build`) | exit 0 |

The full suite (~1,650 tests, 30+ min on this VM) was not re-run for this phase; the batches above cover the orchestrator, task/concurrency, execution-adapter, sandbox-adjacent and F1 surfaces the phase touched.

## Files changed

- `tests/factory_phase_f2_gauntlet.test.ts` (new) — the gauntlet + parser regression tests.
- `server/swarm/executionAdapter.ts` — the `parseTestOutput` fix (spec-reporter parsing; summary-based fallback).
- `FACTORY_PHASE_F2_PROGRESS.md` (new), `FACTORY_PHASE_F2_ACCEPTANCE_REPORT.md` (new), one `AGENTS.md` status row.

Nothing was pushed; F3 was not started.

## Limitations

- Stub transport only (see honesty statement): live delegation quality awaits provider keys (F1 unblock).
- The gauntlet exercises the application-plan seed graph produced for the fixture idea (tier-chained tasks + devops root) — the richest graph the current seeding produces without a live planner; the fallback fullstack graph's fan-out shape is covered per-module by existing suites, not by this gauntlet.
- Cancellation is proven for calls in flight at stop time; tasks already merged before a stop keep their files (by design — the build ends `stopped`, work is not rolled back).
- The stuck-dependents liveness wart (above) remains: a permanently failing task's dependents wait for the duration cap.
