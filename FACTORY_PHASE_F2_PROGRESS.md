# Factory Phase F2 — Progress Log

**Phase:** F2 — Delegation and Parallel Execution Gauntlet
**Date:** 2026-11-27
**Status:** Complete. Gauntlet suite 5/5; one genuine chain defect found and fixed; no push (owner's batch push comes after all Factory work).

## What was built

`tests/factory_phase_f2_gauntlet.test.ts` — a whole-chain gauntlet that drives the **real** `SwarmOrchestrator.startSwarm` end-to-end over the repository's established stub seam (`smartRouter.executeSmartRequest`, mocked per test with `t.mock.method`, the Phase 9 pattern; `server/gateway.ts` delegates to the router, so planner, worker and verifier calls all pass through it). Three swarm builds plus two adapter regression tests:

1. **Happy-path gauntlet** — a habit-tracker build (models gemini/claude/deepseek) runs the full chain: planner → deterministic dependency-aware seeding → parallel worker loops → approval gate (an approval pump answers held sensitive-file tasks as the owner would) → merge → sandbox integrity → verifier → completion. Asserts dependency ordering from the event log, parallelism via a deterministic rendezvous barrier, final-tree hash equality with the expected merge, and the verification stage's own evidence (sandbox "passed cleanly", checkpoint saved, `verifier_approved`, `build_completed`).
2. **Cancellation gauntlet** — worker calls block until aborted; `stopSwarm` mid-run must abort the in-flight call, end the build `stopped`, and leave zero completed tasks.
3. **Failure gauntlet** — the first claimed task's transport fails all 3 of its in-task attempts; the task must be released with the failure on record, then complete (retry or reassignment), and the build must still complete.
4. **Two regression tests** for the defect below (green run reported green; red run stays red), calling `ExecutionAdapter.runIsolatedTests` directly.

## Flow audit (how a build task flows today)

- **Decomposition:** `runInitialPlanner` combines deterministic analyzers (architecture/database/API/frontend/test plans; `ConnectedApplicationPlanner` for application-shaped ideas) with ONE planner gateway call. The planner call's own `create_task` actions carry **no dependencies**, so the dependency-aware graph comes from `seedMilestoneTasks` when fewer than 4 tasks exist: the application-plan branch chains tiers (each task depends on the previous tier's last task) plus a devops task; the fallback fullstack graph is domain → {engine, store, main view} → app entry, QA on engine+store, security on engine, devops on QA.
- **Assignment:** one worker loop per selected model (`Promise.all`). `TaskManager.claimTask` is dependency-gated (`areDependenciesMet`), role-scored, avoids file paths locked by in-progress tasks, and claims atomically via `db.claimTaskAtomic` with 90 s leases. Idle workers poll every 1–1.8 s.
- **Execution:** `executeTaskWork` calls the gateway with the task and the swarm's `AbortSignal`; up to 3 attempts. Sensitive files (Dockerfile, CI workflows, `package.json`, `.env`, security/auth/token paths…) are held by `ApprovalGateService`: the task pauses, the owner's approval applies the held changes via `resolveHeldTask`. Every 5 applied patches, `SandboxRunner.runIntegrityCheck` runs and spawns targeted fix tasks on failure.
- **Completion:** `checkProjectCompletion` — all tasks terminal and ≥1 file → sandbox integrity (esbuild syntax + security audit + isolated test execution) → verifier model call → `IntegrationAgent` contract analysis → `HonestVerificationService` readiness → preview → status `completed`.
- **Cancellation:** `stopSwarm` sets the stop flag, aborts the per-build `AbortController` (the signal reaches `executeSmartRequest`), pauses in-progress tasks, ends the build `stopped`.
- **Failure:** 3 failed attempts → `TaskManager.releaseTask` (retryCount + 1, `task_released` event carrying the error) → any worker may re-claim; at 3 releases the task is failed and `checkProjectCompletion` fails the build honestly.

Before F2, this chain had only ever been tested per-module (planner, claim, merge, sandbox, verifier in separate suites); no test drove `startSwarm` through a complete multi-task build.

## Defect found by the gauntlet (fixed)

**`ExecutionAdapter.parseTestOutput` misreported every passing test run as failed on this Node version.** It understood only TAP output. Node 24's test runner emits the spec reporter (`✔ name (1.2ms)` lines, `ℹ fail 0` summary) where CI's Node 22 emits TAP, so locally a green run produced no TAP lines and fell into the no-evidence fallback — which marked a test failed whenever the output contained the word `fail`, including the passing summary's own `fail 0`. Consequences, all reproduced before the fix: `SandboxRunner` spawned endless `Fix Error in tests/…` tasks and **no build containing tests could ever complete locally** (first gauntlet probe: 25+ fix tasks for the same test file, build stuck `running`).

Fix (`server/swarm/executionAdapter.ts`, minimal, in-pattern): parse spec-reporter ✔/✖ result lines as first-class evidence, and make the fallback derive failure from the run's own summary (`ℹ fail N` / `# fail N` counts) instead of the bare word `fail`. Failing-then-passing evidence: a 4-test green fixture reported `failed / 0 passed / 4 failed` before, `passed / 4 passed / 0 failed` after; the gauntlet's two regression tests pin both directions (a genuinely failing test still reports failed).

**Side effect:** the two long-standing *local-only* failures — `tests/orchestration.test.ts:334` (sandbox-integrity checkpoint) and `tests/phase4_production_reliability.test.ts` test 19 — were this same defect (green in CI on Node 22/TAP, red locally on Node 24/spec). Both now pass locally; see verification counts in the acceptance report.

## Observed, documented, not fixed

- **`task_claimed` event-type overloading** (`TaskManager.createNewTask`/`resumeTask` emit it with no `modelId` when a task is added to or returned to the board). The event *details* are honest; only the type label is shared. The gauntlet asserts ordering on genuine claims (events carrying a `modelId`). Renaming event types would ripple into other consumers and is beyond F2's minimal scope.
- **Stuck dependents on permanent failure:** if a task exhausts retries and fails, its dependents stay `pending` forever and the build remains `running` until the `maxDurationSeconds` cap stops it (observed in the first probe, where the real router refused all calls for missing keys). The designed escalation exists (duration cap; build-failed when the failed task is the last incomplete one) but there is no fail-fast propagation to dependents. Recorded as a limitation for a future phase, not silently patched here.

## Scratch work

Three throwaway probe drivers (`tests/f2probe.*.ts`) were used to validate the design empirically and deleted after the suite passed; the gauntlet suite is the durable artifact.
