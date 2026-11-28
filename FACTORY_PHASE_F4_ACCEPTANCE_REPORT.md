# Factory Phase F4 — Acceptance Report

**Phase:** F4 — Verification and Failure-Recovery Gauntlet
**Date:** 2026-11-27
**Verdict:** **Complete.** The completion chain — sandbox integrity
gate → verifier model → integration contract gate → honest
requirements gate — is now proven as one loop by an 11-case
fault-injection gauntlet with **zero false completions** in scope
(statement and scope below). Two genuine defects that produced false
or unrepairable outcomes were found by probe and fixed:
the sandbox gate never consumed the TypeScript compiler report (a
build with a real TS2322 was marked `completed`), and failing-test
repair tasks were addressed to a hardcoded file that does not exist
in most projects (the repair loop could never repair a failing test).

## Stub-transport honesty statement

No live model exists in this environment (Factory Phase F1). The
gauntlet runs over the F2/F3 stub transport, and its verifier stub is
deliberately **lenient — it approves every tree unconditionally**. That
is the adversarial worst case for false completions: anything the
gauntlet stops was stopped by the platform's deterministic gates, not
by model judgement. The gauntlet proves detection, repair-loop,
re-verification and failure-accounting mechanics. It proves nothing
about live generation quality, and no such claim is made.

## Acceptance criteria (roadmap) — results

| # | Criterion | Result |
| :-- | :-- | :-- |
| 1 | Each injected defect class is either repaired and re-verified green by the verifier chain, or escalated as failed with the defect named; no build with an unrepaired defect is ever marked complete (the `HonestVerificationService` gate) | **Pass.** 10 full builds + 1 direct engine probe (table below). Every `completed` build's final tree is asserted defect-free (byte-equal to the clean fixture; the import case additionally re-passes `IntegrationAgent` analysis). Every unrepaired case ends `failed` with the defect/task named in the failure reason and no `build_completed` event. |
| 2 | Repair attempts respect the existing retry limits (attempt counts asserted); exhausted retries end in an honest failure state | **Pass.** Malformed-output case: exactly **9** worker calls (3 in-task attempts × 3 claims, `TaskManager` policy) before the task records `Exhausted retries (3/3)` and the build fails. Unrepairable-defect case: the sandbox fix task exhausts the same policy (≥9 calls), ends `failed`, and the build fails naming it. |
| 3 | Phase 11 and Phase 12 suites pass unchanged; lint and build pass | **Pass.** Phase 11 **146/146**, Phase 12 **12/12**, lint exit 0, build exit 0. (Also: Phase 9 suites 112/112, orchestration + Phase 4 41/41, F2 gauntlet 5/5, F3 suite 5/5.) |

## Fault-class table

| Defect class | Detection | Repair | Bound | Terminal state | Gauntlet |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Syntax-broken file (unbalanced braces) | `ExecutionAdapter.validateSyntax` (esbuild + bracket balance) via SandboxRunner | Sandbox fix task → worker patch → gate re-verifies | Task policy 3×3 | Repaired → `completed` | ✔ repaired |
| **TypeScript type error (compile error)** | Real tsc program in `runTypeCheck` — report was computed but **never consumed by the gate (defect, fixed)** | Sandbox fix task naming the diagnostic (`TS2322`) | 3×3 | Repaired → `completed` | ✔ repaired; **pre-fix probe: build `completed` with the error in the tree — a false completion** |
| Invalid JSON config | `validateSyntax` JSON.parse | Sandbox fix task | 3×3 | Repaired → `completed` | Covered by the orchestration suite (pre-existing) |
| Hardcoded secret (token-shaped) | `auditSecurity` high finding | Sandbox fix task | 3×3 | Repaired → `completed`; final recorded audit passes; no secret remains in any file | ✔ repaired |
| Dangerous `eval()` | `auditSecurity` high finding | Sandbox fix task | 3×3 | Repaired → `completed`; no `eval(` remains | ✔ repaired |
| Failing generated test | Real test execution (`runIsolatedTests`) — **fix task was addressed to hardcoded `tests/engine.test.ts` (defect, fixed)** | Sandbox fix task targeting the real test file | 3×3 | Repaired → `completed` | ✔ repaired; pre-fix the loop targeted a phantom file and the build hung |
| Runtime crash at import time | Test execution (runner exit + file-level failures in the report) | Sandbox fix task; worker repairs the root-cause module; suite re-runs green | 3×3 | Repaired → `completed` | ✔ repaired |
| Broken import graph (missing imported file) | `IntegrationAgent` AST analysis (`missing_imported_file`, error); post-fix also tsc TS2307 at the sandbox gate | Whichever gate trips first spawns a targeted fix task; IntegrationAgent spawns its own bounded, deduplicated task (ProjectMemory repair limit 3) | 3×3; integration repair limit 3 | Repaired → `completed`; final tree passes contract analysis | ✔ repaired (chain) + ✔ engine probe (exactly one bounded fix task; re-analysis spawns no duplicate) |
| Malformed / unparseable worker output | `executeTaskWork` response validation (gateway action validator upstream) | In-task retry ×3 → release → re-claim | **9 calls, asserted exactly** | Task `failed` (`Exhausted retries (3/3)`) → build `failed` naming the task | ✔ honest failure |
| Verifier-bait: required file omitted, decoy file applied, lenient verifier approves | `TaskManager.verifyTaskExecution` at task completion (every declared file must exist, non-empty) | None — refusal is terminal for the task | — | Task `failed` naming the missing file → build `failed`; never reached verifier approval | ✔ honest failure |
| Unrepairable defect (repair worker never produces a valid fix) | SandboxRunner (syntax class) | Fix task cycles the standard retry policy | ≥9 calls; fix task `failed` with exhaustion recorded | Build `failed` naming the fix task; the defective file remains visibly defective | ✔ honest failure |
| Verifier-model rejection / malformed verdict | `parseVerifierResponse` (strict boolean) | Missing-requirement fix tasks | `maxVerificationAttempts = 3` | Repaired → `completed`, or build `failed` after 3 attempts | Pre-existing coverage (orchestration / Phase 9 suites); not re-probed in F4 |

## Zero-false-completions statement (exact scope)

Across the gauntlet's 10 end-to-end builds — each injecting one
defect class into the seeded application-plan project for the fixture
idea, driven through the real orchestrator with a verifier that
approves everything — **no build with an unrepaired injected defect
was marked complete**. Builds that completed did so only after the
detecting gate re-verified the repaired tree; builds whose defects
were not repaired ended `failed` with the defect named. The scope is
exactly: the stub transport, this seeded graph, and the fault classes
in the table. It is not a claim about live models, other project
shapes, or defect classes the platform does not claim to detect
(see Limitations).

## Defects

| Defect | Severity | Disposition |
| :-- | :-- | :-- |
| Sandbox gate ignored the adapter's TypeScript report. With type errors present the adapter defers tests (failed = 0), so a compiler-broken project passed the sandbox, the verifier and the requirements mapping, and was marked `completed` — while `HonestVerificationService` reported the same tree `failed`. Probe-verified end-to-end before fixing. | **False completion** | **Fixed** in `server/swarm/sandboxRunner.ts`: type diagnostics (except TS18003, below) are sandbox errors; the fix task targets the file carrying the diagnostic and names it. Gauntlet 2 pins the behaviour. |
| Failing-test fix tasks were addressed to a hardcoded `tests/engine.test.ts`. In any project whose tests live elsewhere (including the platform's own seeded graph), the repair loop patched a phantom file forever and the build hung — the failing test could never be repaired. Probe-verified (two identical phantom tasks for one crashed suite). | Repair loop broken for the class | **Fixed**: attribution now resolves to a test file actually in the tree (`tests/engine.test.ts` only when present). Gauntlet 5 pins it, including a no-phantom-task assertion. |
| Duplicate fix tasks for one error (a crashed test file is reported by the runner in-line and again in its recap → two identical errors → two identical tasks racing to patch one file). | Repair-loop hygiene | **Fixed**: fix-task spawning dedupes identical (file, message) errors; the 5-task cap counts spawned tasks. |
| TS18003 ("No inputs were found") treated as a gating type error by the first version of the type fix — it fires on any tree whose tsconfig includes match nothing yet (the normal state before the first TS file lands) and broke F3's mid-run integrity check during regression. | Regression introduced by this phase's first fix iteration | **Fixed** by excluding TS18003 from the sandbox's type gate (rationale in code): an empty program is a tree-stage statement, not a file defect; the honest verdict likewise treats no-TypeScript as skipped, not failed. Caught by the regression batch, root-caused by reproducing F3's exact check point, F3 restored to 5/5 with its assertions unchanged. |
| Dependents of a permanently failed task stay `pending`; the build's terminal `failed` transition then waits for the duration cap instead of firing (the task itself is flagged `failed` immediately, with the defect named). `resolveHeldTask` already fail-fasts this case for approval-held tasks; the plain worker path does not. | Liveness (documented in F2; re-verified by F4 probe 3) | **Documented, not fixed.** Build-level fail-fast on task failure is a scheduling-policy change beyond this phase's minimal scope. The gauntlet's exhaustion cases therefore target leaf tasks, where the honest `failed` terminal state is reached promptly and asserted. |
| `SandboxRunner` also does not consume the adapter's `configErrors` (package/tsconfig shape validation). The JSON-syntax subset is gated via `validateSyntax`; config-shape results remain advisory in the sandbox and are enforced in the honest report. | Observation | Documented, not changed — no gauntlet class exercises it and it produced no false completion in the audit. |
| `AIChallengeEngine` has no call sites; `PatchValidationPipeline` / `AutomaticRepairEngine` / `CollaborativeDebuggingEngine` serve other flows (incremental editing, Phase 9 generation, debugging coordinator), not the swarm completion gate. | Audit clarity | Documented so the chain's actual composition is on record; no wiring changed (roadmap scope: wire existing engines in sequence — the gate chain above is that sequence). |

## Verification (exact counts, from printed summaries)

| Run | Result |
| :-- | :-- |
| `tests/factory_phase_f4_verification_repair.test.ts` | **11/11 pass, 0 fail** (~85 s; run twice — before and after the TS18003 refinement) |
| `tests/factory_phase_f3_memory_resume.test.ts` | **5/5 pass, 0 fail** |
| `tests/factory_phase_f2_gauntlet.test.ts` | **5/5 pass, 0 fail** |
| `tests/orchestration.test.ts` + `tests/phase4_production_reliability.test.ts` | **41/41 pass, 0 fail** |
| Phase 9 suites (5 files) | **112/112 pass, 0 fail** |
| `tests/phase12_automated_testing_qa.test.ts` | **12/12 pass, 0 fail** |
| `tests/phase11_debugging_repair.test.ts` | **146/146 pass, 0 fail** (standalone run, ~477 s on this VM) |
| `npm run lint` (`tsc --noEmit`) | exit 0, no diagnostics |
| `npm run build` (`vite build`) | exit 0 |

The full suite (~1,650 tests, 30+ min on this VM) was not re-run for
this phase; the batches above cover the sandbox gate, orchestration,
concurrency, memory/resume, Phase 9 generation gates, Phase 11 repair
and Phase 12 QA surfaces the phase touched.

## Files changed

- `server/swarm/sandboxRunner.ts` — type-report consumption with the
  TS18003 exclusion, real-file attribution for failing tests, and
  fix-task deduplication.
- `tests/factory_phase_f4_verification_repair.test.ts` (new) — the
  gauntlet (11 tests).
- `FACTORY_PHASE_F4_PROGRESS.md` (new), `FACTORY_PHASE_F4_ACCEPTANCE_REPORT.md`
  (new), one `AGENTS.md` status row.
- Four scratch probe files were created, used for the evidence above,
  and deleted; they are not deliverables.

Nothing was pushed; F5 was not started.

## Limitations

- Stub transport only (see honesty statement): repair *mechanics* are
  proven; whether a live model produces a correct repair is a
  generation-quality question no stub can answer (F1 unblock).
- Secret detection is pattern-based by design (token shapes `sk-`,
  `ghp_`, `AIzaSy`, `AKIA`, path-traversal literals, `eval(`,
  `new Function()` at medium severity, unsanitized `child_process`
  input). A generic hardcoded password string is outside the claimed
  class and is not detected — unchanged by this phase.
- Failing-test attribution is exact for single-test-file projects and
  whenever `tests/engine.test.ts` is the real file; with several test
  files and no `tests/engine.test.ts`, failures are attributed to the
  first test file in the tree (the adapter's report names tests, not
  files; the repair worker still receives the failing test names in
  the task description). Per-file attribution would require adapter
  report changes.
- `parseTestOutput` can double-count a crashed test file in
  `build.testReport` (the runner prints the failure in-line and in
  its recap). Fix-task spawning is deduped; the report counts are not
  changed by this phase.
- The dependents-of-a-failed-task liveness wart stands (see Defects):
  task-level failure is immediate and named; the build-level terminal
  state can wait for the duration cap when the failed task has
  dependents.
- The integration gate's exhaustion path (repair limit reached, tree
  still contract-broken, no active fix task) returns with the build
  `running`; in the full chain the sandbox gate now repairs import
  defects first, so this path is pinned at engine level (Gauntlet 8)
  rather than as a full-chain exhaustion case.
