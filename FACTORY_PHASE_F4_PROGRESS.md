# Factory Phase F4 — Progress Log

**Phase:** F4 — Verification and Failure-Recovery Gauntlet
**Date:** 2026-11-27
**Status:** Complete. See `FACTORY_PHASE_F4_ACCEPTANCE_REPORT.md`.

## Objective (roadmap)

Chain runtime verification → patch validation → automatic repair into
one proven loop with zero false completions: every injected defect is
either repaired and re-verified green, or escalated as failed with the
defect named; repair attempts respect the existing retry limits;
exhausted retries end in an honest failure state.

## Audit (before any code changed)

The completion chain in `SwarmOrchestrator.checkProjectCompletion`,
in order:

1. All tasks terminal; any `failed` task fails the build, naming it.
2. At least one file exists.
3. `SandboxRunner.runIntegrityCheck` — consumes from
   `ExecutionAdapter.runCompleteVerification`: syntax errors (esbuild +
   bracket balance + JSON parse), high-severity security findings, and
   failing-test counts. On failure it spawns targeted fix tasks
   (priority 1, `debugging_specialist`, ≤5 per check) and the gate
   returns; the build continues.
4. Verifier model (strict-JSON verdict via `parseVerifierResponse`);
   rejection spawns missing-requirement fix tasks; malformed verdicts
   and rejections are bounded by `maxVerificationAttempts = 3`, then
   the build fails.
5. `IntegrationAgent.analyzeProjectContracts` — AST contract analysis
   (missing imported files, unexported identifiers, invalid default
   imports, incompatible call interfaces are errors). On error it
   spawns its own bounded fix tasks (dedupe by title, ProjectMemory
   repair limit 3) and the gate returns.
6. `HonestVerificationService.evaluateProjectReadiness` — the
   orchestrator gates only on its per-requirement results
   (failed/blocked → fix tasks, bounded by the same verification
   attempts). The service's overall verdict is recorded on the build
   but is **not** consulted by the gate.
7. Preview generation (non-gating), then `completed`.

Repair machinery wiring, as found:

- In the swarm chain, repair = the fix-task loops above, executed by
  workers through `executeTaskWork` (3 in-task attempts →
  `TaskManager.releaseTask`; retry exhaustion at `maxRetries = 3`
  marks the task `failed`). Task completion itself is verified by
  `TaskManager.verifyTaskExecution` (every declared file must exist
  with non-empty content).
- `AutomaticRepairEngine` (bounded 3 attempts, re-verifies five
  validation dimensions after each patch, applies to a copy first via
  `RepairPatchValidator`) serves the Phase 9 `codeGenerationEngine`
  path and the debugging static-check worker — not the swarm gate.
- `CollaborativeDebuggingEngine` serves the debugging
  `RepairCoordinator` flow. `PatchValidationPipeline` is used by
  `IncrementalEditor`. `AIChallengeEngine` has **no call sites**
  (a dead import in `swarmOrchestrator.ts`). `BrowserRuntimeVerifier`
  feeds `HonestVerificationService` and `PreviewGenerator`; its
  findings reach the gate only when they map to a failed/blocked
  requirement.
- `SandboxRunner` did not consume two things the adapter already
  computes: `typeCheckReport` and `configErrors`.

## Probes (scratch, deleted after use — findings preserved here)

Probe-driven, before writing the gauntlet:

1. **Clean fixture ground truth.** A clean F2/F3-style build completes;
   its tree genuinely passes tsc (type report `passed`, 0 errors), so
   wiring the type report into the gate cannot break the clean path.
2. **Type error — FALSE COMPLETION CONFIRMED.** The same build with
   `export const storeVersion: number = 'one';` appended to the store
   file was marked **`completed`**: the adapter defers tests when type
   errors exist (test report `skipped`, failed = 0), the sandbox —
   which never read the type report — printed "passed cleanly
   (0 tests passed)", the verifier approved, and requirements mapped
   clean. The platform's own `HonestVerificationService` verdict for
   the identical tree was **`failed`** ("1 TypeScript type error(s)
   detected"). The gate simply never looked at evidence the platform
   already computes.
3. **Omitted planned file.** A worker that applied a decoy file
   instead of its task's files had the task marked `failed` by
   `verifyTaskExecution`, naming the missing file — the task-level
   refusal works. But because that task had dependents, the build
   then hung in `running` until the duration cap: the completion gate
   never fires while dependents sit `pending` (the F2-documented
   liveness wart, re-verified here; `resolveHeldTask` handles exactly
   this case for approval-held tasks, the plain worker path does not).
4. **Runtime crash.** A module throwing at import time, imported by
   the generated test file: test report `status=failed, failed=2`
   (the runner's file-level failure lines), sandbox fails — detection
   works — but both spawned fix tasks targeted the hardcoded
   `tests/engine.test.ts`, a file that does not exist in this project.
   The real failing test could never be repaired by its own repair
   loop.

## Fixes (all in `server/swarm/sandboxRunner.ts`)

1. **Consume the type report.** `runIntegrityCheck` now adds
   `typeCheckReport.errors` to its error list (message names the
   diagnostic code, e.g. `TypeScript error [TS2322]: ...`), so type
   errors fail the sandbox, spawn a fix task for the file carrying the
   diagnostic, and completion requires a re-verified clean typecheck.
   This makes the code match the class's own documentation ("Runs
   automated lint, type-check, and security audit").
   **Refinement (regression-driven):** TS18003 ("No inputs were found
   in config file") is excluded. The first version of this fix broke
   F3's mid-run integrity check: before the first TypeScript file
   lands, the project's tsconfig includes match nothing and tsc
   reports TS18003 as a fatal config error. An empty program is a
   statement about the tree's stage, not a defect in a file — a fix
   task cannot repair it — and on a finished tree the honest verdict
   treats a no-TypeScript project as skipped, not failed. Every real
   diagnostic still gates.
2. **Attribute failing tests to a real file.** Failing-test errors now
   use `failingTestFilePath(files)`: `tests/engine.test.ts` when the
   tree actually contains it (legacy behaviour preserved for projects
   that use it), otherwise the first test file present (same predicate
   the adapter uses to select test files).
3. **Dedupe fix tasks.** Identical errors (same file + message — e.g.
   a crashed test file the runner reports in-line and again in its
   recap) now spawn one fix task, not duplicates racing to patch the
   same file. The 5-task cap counts spawned tasks.

## Gauntlet (`tests/factory_phase_f4_verification_repair.test.ts`, 11 tests)

Drives the real chain over the F2/F3 stub transport with a **lenient
verifier stub that approves everything** — the worst case for false
completions — one defect class per build: syntax-broken file,
TypeScript type error, hardcoded secret, dangerous `eval()`, failing
generated test, runtime crash at import, broken import graph, a
direct `IntegrationAgent` probe (detection + bounded, deduplicated
fix-task spawning), malformed worker output (exactly 9 bounded calls
asserted: 3 attempts × 3 claims), verifier-bait (decoy applied,
required file omitted), and an unrepairable defect (repair worker
never produces a valid fix). Assertions are on the event log, the
task board, and the final tree — never on mocks of the checkers.

Result: **11/11 pass** (run twice — before and after the TS18003
refinement).

## Verification (exact counts, from printed summaries)

| Run | Result |
| :-- | :-- |
| `tests/factory_phase_f4_verification_repair.test.ts` | **11/11 pass, 0 fail** (~85 s), twice |
| `tests/orchestration.test.ts` + `tests/phase4_production_reliability.test.ts` | **41/41 pass, 0 fail** (incl. `orchestration.test.ts:334` and phase4 test 19 — still green) |
| `tests/factory_phase_f2_gauntlet.test.ts` | **5/5 pass, 0 fail** |
| `tests/factory_phase_f3_memory_resume.test.ts` | **5/5 pass, 0 fail** (after the TS18003 refinement; see Fixes) |
| Phase 9 suites (code generation, limitations, gate bypass, final hardening, approval/cancellation) | **112/112 pass, 0 fail** |
| `tests/phase12_automated_testing_qa.test.ts` | **12/12 pass, 0 fail** |
| `tests/phase11_debugging_repair.test.ts` | **146/146 pass, 0 fail** (standalone; ~477 s on this VM — it is a heavy suite, which is why a combined 280 s batch window timed out mid-run; not a hang) |
| `npm run lint` (`tsc --noEmit`) | exit 0, no diagnostics |
| `npm run build` (`vite build`) | exit 0 |

The full suite (~1,650 tests, 30+ min on this VM) was not re-run; the
batches above cover every surface the phase touched (sandbox gate,
orchestration, task/concurrency, memory/resume, Phase 9 generation
gates, Phase 11 repair, Phase 12 QA).

## Regression honesty

The type-gate fix initially regressed F3 (its mid-run check runs on a
tree with no TypeScript inputs yet → TS18003). The combined regression
batch caught it; the root cause was identified by reproducing F3's
exact check point on a live build; the fix was refined (TS18003
excluded, rationale in code and in the acceptance report); F3 returned
to 5/5 and the gauntlet stayed 11/11. No test was weakened: F3's
assertion (`midCheck.passed === true`) stands unchanged, and the
gauntlet's type-error test fails on the pre-fix code by construction
(probe 2 is the pre-fix evidence).
