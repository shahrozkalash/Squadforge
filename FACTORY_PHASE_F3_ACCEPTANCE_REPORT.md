# Factory Phase F3 — Acceptance Report

**Phase:** F3 — Shared Context and Project Memory Hardening
**Date:** 2026-11-27
**Verdict:** **Complete.** A build hard-killed mid-run — after a
checkpoint, with tasks in flight under live leases — resumes from
persisted state alone through the platform's own `resumeSwarm` path
and completes with no task, file, checkpoint, or memory loss or
duplication, and a final tree identical to an uninterrupted run. Three
genuine memory defects found by the audit were fixed with regression
tests: silent fact contradictions, pinned facts being budgeted out of
worker context, and revision pruning dropping confirmed facts.

## Stub-transport honesty statement

No live model exists in this environment (Factory Phase F1). The
kill-and-resume test drives the real orchestrator over the F2 stub
transport: it proves restart-recovery, lease reclaim, memory
persistence, conflict recording and context-assembly mechanics. It
proves nothing about live generation quality, and no such claim is
made. Environment note: under the test runner the store's SQL layer
is the harness's in-memory SQLite (`DatabaseManager` argv-based test
detection); the simulated restart discards every in-memory cache and
reloads through the genuine `loadFromSqlite` path — the same code a
production restart runs against its file database.

## Acceptance criteria (roadmap) — results

| # | Criterion | Result |
| :-- | :-- | :-- |
| 1 | Kill-and-resume test: a build interrupted after ≥1 checkpoint resumes from persisted memory and completes; resumed workers' context contains the pre-kill facts/decisions (asserted on content, not just non-emptiness) | **Pass.** Killed after ≥2 completed tasks and a `SandboxRunner` checkpoint, with tasks in flight. Post-restart: lapsed-lease task returned to the board by the startup cleanup; valid leases still honoured (the atomic claim gate refuses another worker); completed tasks, files (content + version), checkpoints and the full fact/ADR multisets intact exactly once. Resumed via `resumeSwarm` to `completed` through the chain's own verifier gate; no pre-kill completed task re-executed (absent from post-resume worker calls, exactly one completion event each); every in-flight task recovered and executed; final tree deep-equal to the uninterrupted control run and hash-matched to the expected merge. Content assertions: `retrieveTaskContext` at the production 1600-char budget contains the pre-kill pinned fact and ADR decision, and at least one post-resume worker **prompt** contains both. |
| 2 | Two workers given contradictory facts produce a recorded conflict, not silent divergence (conflict appears in the build record) | **Pass — after fixing a genuine defect.** Pre-fix, an assumption contradicting a confirmed fact was refused silently and a confirmed-vs-confirmed contradiction was stored undetected (probe-verified). Post-fix both are refused and record a `fact_conflict` event naming both statements; memory holds exactly one side (the confirmed original). ADR contradictions record `architectural_conflict` (pre-existing, now pinned by test). |
| 3 | Context assembly respects its token budget under a large-project fixture (asserted size bound) while retaining pinned facts | **Pass — after fixing a genuine defect.** Pre-fix, the pinned confirmed fact was truncated away at budgets 1800/1600/1200 on the large fixture (facts were assembled fifth of six sections). Post-fix facts are packed immediately after the header: output within budget at all three budgets with the pinned fact present. |
| 4 | Memory/project-context tests pass; lint and build pass | **Pass.** New F3 suite 5/5; `tests/project_memory.test.ts` + authorization-hardening + orchestration + phase1/phase5 concurrency **65/65**; F2 gauntlet + phase4 + phase9 (5 suites) + phase11 **282/282** (includes both tests F2 fixed — still green, no regression); `npm run lint` exit 0; `npm run build` exit 0. |

## Kill-and-resume evidence (from the suite run)

- Kill point: ≥2 tasks completed, ≥1 checkpoint recorded, ≥1 worker
  call hung mid-flight, persisted-state snapshot stable across ~2.4 s
  of polling and bit-identical 2.5 s after the kill; build row left
  `running`; zero `build_stopped`/`build_completed` events written by
  the kill.
- Recovery split exactly as designed: the task whose lease lapsed
  during downtime came back `pending`/unclaimed (startup cleanup);
  still-leased tasks stayed `in_progress` with claimants and were
  refused to another worker by `claimTaskAtomic`, then reclaimed
  through the claim sweep once their leases lapsed.
- Final tree of the killed/resumed build is deep-equal (paths,
  contents, **versions**) to the uninterrupted control build's tree —
  the strongest available statement that kill + restart + resume lost
  and duplicated nothing.
- The whole kill-and-resume test runs in ~22 s on this VM.

## Defects

| Defect | Severity | Disposition |
| :-- | :-- | :-- |
| `recordFact`: assumption-vs-confirmed contradictions refused with no build-record trace; confirmed-vs-confirmed contradictions not detected at all — both contradictory confirmed facts stored and eligible for worker context (silent divergence) | Memory integrity | **Fixed** in `server/swarm/projectMemory.ts`: contradiction check for every incoming fact against confirmed facts, `fact_conflict` event recorded with both statements, incoming fact refused. Regression-pinned in the F3 conflicts test. |
| `retrieveTaskContext`: confirmed facts assembled fifth of six sections; the budget packer truncates later sections first, so on a large project the pinned facts never reached workers at any probed budget | Context correctness | **Fixed**: ESTABLISHED FACTS packed immediately after the header; documented priority order updated. Regression-pinned in the F3 budget test at 1800/1600/1200 chars. |
| `recordRevision`: fact-cap pruning used a plain slice that dropped the oldest facts — including the initial confirmed facts derived from the user's own prompt — while `recordFact`'s pruning protected them | Memory integrity | **Fixed**: both paths share `pruneFacts` (oldest assumptions first; confirmed facts never dropped; the cap yields if confirmed facts alone exceed it). Regression-pinned in the F3 pruning test. |
| Automatic mid-build checkpoints depend on the patch-count cadence (`patchesAppliedCount % 5`), which counts patch operations only — a create-only stretch produces no automatic mid-run checkpoint | Observation | Documented in the progress log, not changed: checkpoint *creation* works (every passed `runIntegrityCheck` records one, including the completion gate's); the cadence policy is a product decision beyond this phase's minimal scope. The kill test drives the platform's own check explicitly to establish its pre-kill checkpoint. |
| `PersistentDatabase.initialize()` assumes empty caches (fresh-process path); `db.addCheckpoint` writes cache before its SQL insert | Observation | Documented, not changed: neither is reachable as a defect on the production restart path (new instance; unique checkpoint ids). The restart simulation mirrors the fresh-process contract. |
| `task_claimed` event-type overloading (noted in F2) | Cosmetic | Unchanged; the F3 suite asserts on statuses and completion events, not on claim-event flavours. |

## Verification (exact counts, from printed summaries)

| Run | Result |
| :-- | :-- |
| `tests/factory_phase_f3_memory_resume.test.ts` | **5/5 pass, 0 fail** (~27 s total; kill-and-resume ~22 s) |
| `tests/project_memory.test.ts` + `tests/project_memory_authorization_hardening.test.ts` + `tests/orchestration.test.ts` + `tests/phase1_task_concurrency.test.ts` + `tests/phase5_concurrency_hardening.test.ts` | **65/65 pass, 0 fail** |
| `tests/factory_phase_f2_gauntlet.test.ts` + `tests/phase4_production_reliability.test.ts` + `tests/phase9_code_generation_engine.test.ts` + `tests/phase9_limitations.test.ts` + `tests/phase9_gate_bypass_regression.test.ts` + `tests/phase9_final_hardening_regression.test.ts` + `tests/phase9_approval_and_cancellation.test.ts` + `tests/phase11_debugging_repair.test.ts` | **282/282 pass, 0 fail** |
| `npm run lint` (`tsc --noEmit`) | exit 0, no diagnostics |
| `npm run build` (`vite build`) | exit 0 |

The full suite (~1,650 tests, 30+ min on this VM) was not re-run for
this phase; the batches above cover the memory, context, store,
orchestration, concurrency, execution and repair surfaces the phase
touched.

## Files changed

- `server/swarm/projectMemory.ts` — conflict detection + recording in
  `recordFact` (`statementsContradict` helper), shared `pruneFacts`
  used by `recordFact` and `recordRevision`, facts-first section order
  in `retrieveTaskContext`.
- `server/types.ts` — `EventType` union gains `'fact_conflict'` and
  `'architectural_conflict'` (the latter was already emitted via cast).
- `tests/factory_phase_f3_memory_resume.test.ts` (new) — kill-and-resume,
  conflicts, budget, parallel writers, pruning.
- `FACTORY_PHASE_F3_PROGRESS.md` (new), `FACTORY_PHASE_F3_ACCEPTANCE_REPORT.md`
  (new), one `AGENTS.md` status row.

Nothing was pushed; F4 was not started.

## Limitations

- Stub transport only (see honesty statement): recovery mechanics are
  proven; live-model behaviour across a restart is not — it awaits
  provider keys (F1 unblock).
- The kill is simulated in-process (orchestrator state abandoned,
  caches discarded, store reloaded) per the phase brief; an actual
  OS-process kill mid-write is bounded by SQLite's per-statement
  atomicity, which is the engine's guarantee, not re-proven here.
  Under the test runner the SQL store is in-memory (harness property,
  shared by every suite in this repo).
- One kill point is proven (≥2 completions + checkpoint + in-flight
  claims). A kill during the planner phase, or during the completion
  verification itself, is not covered; the state those phases hold is
  the same persisted board + memory the proven path resumes from.
- The fact-contradiction detector keeps the codebase's existing
  negation heuristic (same-category, "not"-pattern). It does not
  attempt semantic contradiction detection beyond that pattern; ADR
  conflicts use the richer existing detector.
- The checkpoint-cadence observation stands: create-only builds get
  no automatic mid-run checkpoint. If the owner wants mid-build
  checkpoints guaranteed, the cadence (or a time/file-count trigger)
  is a small follow-up — deliberately not bundled into this phase.
