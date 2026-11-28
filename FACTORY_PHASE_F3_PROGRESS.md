# Factory Phase F3 — Progress Log

**Phase:** F3 — Shared Context and Project Memory Hardening
**Date:** 2026-11-27
**Status:** Complete. Kill-and-resume proven end-to-end; three genuine
memory defects found by audit probe and fixed with regression tests;
conflict surfacing, context budgets, parallel-writer invariants and
fact pruning all pinned by the new suite
(`tests/factory_phase_f3_memory_resume.test.ts`, 5/5).

## Audit: what state a running build holds, and where it lives

| State | Where it persists | In-memory only |
| :-- | :-- | :-- |
| Build record (status, budgets, plan, milestones) | `builds` table via `db.saveBuild` (write-through) | the live object in `db.builds` (getBuild returns it) |
| Tasks (status, claimant, **lease expiry**, retries, dependencies) | `tasks` table; claims/completions are conditional SQL updates (`claimTaskAtomic`, `completeTaskAtomic`) | list cache `db.tasks` |
| Project files + version history + file leases | `project_files` / `file_versions` tables | map cache `db.files` (live objects — copy before holding across an await) |
| Swarm event log | `swarm_events` table | list cache `db.events` |
| Checkpoints (file snapshots) | `checkpoints` table via `MergeManager.createCheckpoint` (called by `SandboxRunner.runIntegrityCheck` on a pass) | list cache `db.checkpoints` |
| **Project memory** (facts, ADRs, requirements, defects, module graph, revisions, planning artifacts) | `project_memories` table — one JSON blob per project, replaced wholesale by `db.saveProjectMemory` on every service call | the live object in `db.projectMemories`; `ProjectMemoryService` methods are synchronous read-modify-write on it |
| Shared knowledge items, repair lessons | `shared_knowledge_items` table (read straight from SQL, no cache) | — |
| Agent profiles, approval requests, model runs | SQL tables (profiles/requests read fresh; model runs write-through) | model-run map cache |
| Swarm control (stop flag, AbortController, worker loops) | **nowhere — by design** | `SwarmOrchestrator.activeSwarms` |

### What process death leaves behind
The build row stays `running`; claimed tasks stay `in_progress` under
their 90 s leases; the last saved memory blob, files, events and
checkpoints are exactly what the dead process last wrote (every store
mutation is a synchronous SQL write before the cache changes, so there
is no dirty-cache window beyond a single statement, which SQLite makes
atomic). Nothing rolls anything back — recovery is entirely a
resume-side concern.

### Resume paths that exist today (all exercised by the test)
1. **`SwarmOrchestrator.resumeSwarm`** — relaunches worker loops over
   the persisted board with no re-planning (contrast `startSwarm`,
   which plans from scratch); returns approval-held tasks whose
   requests are gone back to the board.
2. **Startup lease cleanup** in `loadFromSqlite`: tasks in
   `in_progress`/`claimed`/`working` whose leases already expired are
   reset to `pending` in SQL during load (no retry increment, no event).
3. **`TaskManager.cleanExpiredLeases`** — runs at the head of every
   `claimTask`: expired leases are released with a retry increment and
   a `task_released` event, or failed when retries are exhausted.
4. **`db.claimTaskAtomic`** — the SQL claim itself accepts a task whose
   lease has expired, so reclaim is race-safe even between two live
   workers.

### Gaps the audit found (state on disk vs. what the logic trusts)
- **Fact contradictions were silent** (defects 1a/1b below).
- **Pinned facts could be budgeted out of worker context** (defect 2).
- **`recordRevision` pruning could drop confirmed facts** (defect 3).
- `PersistentDatabase.initialize()` / `loadFromSqlite` assumes empty
  caches (the fresh-process path); calling it on a live instance would
  append duplicates to the list caches. Not a production defect — a
  process restart constructs a new instance — but the kill test's
  restart simulation therefore clears every cache before calling it,
  mirroring a fresh process exactly.
- `db.addCheckpoint` pushes to the cache before its plain `INSERT`;
  a duplicate checkpoint id would desync cache and disk. Checkpoint
  ids are timestamp+random and no duplicate path exists in practice;
  documented, not fixed.
- **Checkpoint cadence observation:** automatic mid-build checkpoints
  depend on `SandboxRunner` being invoked by the worker loop when
  `patchesAppliedCount % 5 === 0`, and that counter increments on
  *patch* operations only (`store.ts` `applyPatchAtomic`). A
  create-only stretch of a build therefore produces no automatic
  mid-run checkpoint; the completion gate's check is the reliable
  checkpoint producer. The kill test establishes its pre-kill
  checkpoint by invoking the platform's own `runIntegrityCheck` — the
  identical call the orchestrator makes — after two tasks complete.
  Changing the cadence is a product decision beyond this phase's
  minimal scope; recorded here as an observation.

## Defects found (probe-first) and fixed

Each defect was demonstrated against the pre-fix code with a scratch
probe before any change, then re-probed after the fix.

### 1. Fact contradictions were silent — FIXED (`server/swarm/projectMemory.ts`)
- (a) An assumption contradicting a confirmed fact was refused
  (correctly) but left **no trace** in the build record.
- (b) A *confirmed* fact contradicting an existing confirmed fact was
  **not detected at all**: both contradictory confirmed facts were
  stored, and both could reach worker context — silent divergence.
- Fix: `recordFact` now checks every incoming fact against established
  confirmed facts in the same category (the existing negation
  heuristic, extracted as `statementsContradict`). On a contradiction
  it records a `fact_conflict` event naming both statements and the
  incoming source, and refuses the incoming fact — the confirmed fact
  remains the single authoritative version. ADR conflicts already
  recorded an `architectural_conflict` event; that behaviour is now
  pinned by test as well. `'fact_conflict'` and
  `'architectural_conflict'` were added to the `EventType` union in
  `server/types.ts` (the latter was previously emitted through a cast).

### 2. Pinned confirmed facts could be truncated out of worker context — FIXED
`retrieveTaskContext` assembled sections in the order header → ADRs →
requirements → defects → repair lessons → **confirmed facts** →
conventions, and its budget packer keeps sections in that order. On a
large-project fixture the pinned confirmed fact was absent at every
budget probed (1800/1600/1200 chars) while the output stayed within
budget — the budget mechanism worked, the priority order defeated it.
Fix: the ESTABLISHED FACTS section is now packed immediately after the
header, ahead of ADRs/requirements/defects; the documented priority is
now "Pinned Confirmed Facts > Accepted ADRs > Requirements > Active
Defects > Conventions". Section content and the budget packer are
otherwise unchanged (the Phase 7-era project-memory test that pins
context contents passes unchanged).

### 3. `recordRevision` pruning dropped confirmed facts — FIXED
`recordFact` prunes the 40-fact cap by dropping the oldest assumptions
and never a confirmed fact; `recordRevision` pruned with a plain
`slice(0, 40)`, dropping the *oldest* facts — which are the initial
confirmed facts derived from the user's own prompt (probe: after one
revision at the cap, the initial "Project classification" confirmed
fact was gone). Fix: both paths share one `pruneFacts` helper with the
never-drop-confirmed invariant (when confirmed facts alone exceed the
cap, the cap yields rather than losing one).

## The kill-and-resume test (design)

Fixture and stub are the F2 gauntlet's (same deterministic
`contentFor`, same seeded task graph). Flow:

1. **Control run** — the same fixture built uninterrupted; its final
   tree (paths, contents, versions) and task-title set are the
   reference.
2. **Killed build** — project memory is pre-seeded with one pinned
   confirmed fact and one accepted ADR (as planner/architect output
   would exist mid-build). The build runs; after ≥2 tasks complete,
   the test invokes `SandboxRunner.runIntegrityCheck` (asserted
   passing) to record the mid-run checkpoint, then arms the hang gate:
   from that moment the stub never settles a worker call — the
   in-process equivalent of a process dying mid-call.
3. **Freeze proof** — the test polls a snapshot of the persisted state
   (task statuses/claimants/retries, file versions, event count,
   checkpoint count) until it is identical across ~2.4 s (longer than
   any worker poll/sleep cycle) with ≥1 hung call, ≥1 task in flight,
   ≥2 completed, ≥1 checkpoint, no paused tasks and no pending
   approvals. Only a genuinely dead build freezes like that.
4. **The kill** — the orchestrator's in-memory control is abandoned:
   `stopRequested` is set on the control object (an in-memory-only
   write that lets non-suspended loops exit without touching task
   state) and the `activeSwarms` entry is deleted. `stopSwarm` is
   deliberately NOT called — it would persist `stopped` + an event,
   which is a graceful stop, not a crash. The test then asserts the
   persisted snapshot is bit-identical after a further 2.5 s: the dead
   process wrote nothing more. Build row still `running`; no
   `build_stopped`/`build_completed` event exists.
5. **Downtime** — one in-flight task's lease is lapsed directly in its
   persisted row (the standard crash case: the process was gone longer
   than the 90 s lease); the other in-flight leases stay valid.
6. **Restart** — every in-memory cache of the singleton store is
   discarded and `db.initialize()` reloads purely from the persisted
   store through the real `loadFromSqlite` path.
7. **Post-reload assertions** — the lapsed task is back on the board
   (`pending`, unclaimed) via the startup cleanup; validly-leased
   tasks are still in flight with their claimants, and
   `db.claimTaskAtomic` refuses to hand one to another worker while
   the lapsed one is claimable through the same gate; completed tasks
   are still completed; the task count is unchanged; the file tree is
   deep-equal to the pre-kill tree; memory facts/ADRs match the
   pre-kill multisets exactly (markers present exactly once);
   checkpoints are all present; and `retrieveTaskContext` at the
   production budget (1600 chars, the exact call `executeTaskWork`
   makes) contains the pre-kill fact and decision **on content**.
8. **Resume** — remaining in-flight leases are lapsed through the
   store's persisted update path (downtime passing), the hang gate is
   disarmed (the new process serves calls normally), and
   `resumeSwarm` completes the build.
9. **Final assertions** — build `completed` through the chain's own
   gates (verifier approval event present); every planned task
   completed with **exactly one** `task_completed` event; no pre-kill
   completed task appears in post-resume worker calls (no
   re-execution); every in-flight-at-kill task does (recovery actually
   happened); the final tree is deep-equal to the control tree and
   hash-matches the expected merge of its own task list; memory
   markers are still present exactly once, initial facts are not
   duplicated, the module graph was rebuilt by resumed workers,
   checkpoints were not lost; and at least one post-resume worker
   **prompt** contains the pre-kill fact and decision (content-level
   proof that resumed workers worked from pre-kill memory).

Kill-point rationale: ≥2 completed tasks + ≥1 checkpoint + ≥1 task in
flight is the earliest point at which every recovery mechanism has
something real to protect — completed work that must not repeat, a
checkpoint that must survive, and live claims that must be reclaimed
without duplication.

### Test-environment note
Under the test runner, `DatabaseManager` selects an in-memory SQLite
database (argv-based test detection), so the "persisted store" the
restart reloads from is that SQL store. The simulation discards every
cache and re-reads through the genuine `loadFromSqlite` path — the
same code a production restart runs against its file database. SQLite
file/WAL durability itself is the engine's guarantee and is not
re-proven here.

### Failure history of this suite (for the record)
The first two runs of the kill-and-resume test failed for test-design
and environment reasons, not platform defects: (1) the hang gate
required a mid-run checkpoint that a create-only build never produces
automatically (the cadence observation above) — and that run's leaked
approval-pump interval left a zombie process behind, later found and
killed; the pump is now stopped via a `t.after` hook; (2) with the
checkpoint established, the resumed build hung because the test left
its own hang gate armed into the resume phase — disarming it is now
an explicit, commented step. Both fixes are in the test, not the
platform.

## Other tests in the suite
- **Conflicts** — ADR contradiction records exactly one
  `architectural_conflict` event naming both decisions (pre-existing
  behaviour, pinned); assumption-vs-confirmed and confirmed-vs-
  confirmed fact contradictions are each refused and record exactly
  one `fact_conflict` event naming both statements; memory ends with
  exactly one of the two contradictory statements (the confirmed
  original); a compatible fact in the same category records cleanly
  with no conflict event.
- **Budget** — the probe's large-project fixture (10 ADRs, 12
  requirements, 4 defects) at budgets 1800/1600/1200: output within
  budget and the pinned confirmed fact present at every budget.
- **Parallel writers** — 24 concurrent async workers each recording a
  fact, an ADR, a defect and a knowledge item (with interleaved
  context reads): every item present exactly once afterwards, no
  conflict events, and after cache eviction the persisted memory blob
  re-parses from SQLite with identical counts (no lost updates, no
  torn writes).
- **Pruning** — memory filled to the 40-fact cap (30 confirmed + 10
  assumptions), then a revision: all 31 confirmed facts (incl. both
  initial facts and the revision fact) retained, assumptions pruned
  to 9, cap holds.

## Files changed
- `server/swarm/projectMemory.ts` — the three fixes (`statementsContradict`
  + conflict recording in `recordFact`; shared `pruneFacts`; facts-first
  section order in `retrieveTaskContext`).
- `server/types.ts` — `'fact_conflict'` and `'architectural_conflict'`
  added to the `EventType` union.
- `tests/factory_phase_f3_memory_resume.test.ts` (new) — 5 tests.
- `FACTORY_PHASE_F3_PROGRESS.md`, `FACTORY_PHASE_F3_ACCEPTANCE_REPORT.md`
  (new), one `AGENTS.md` status row.

Nothing was pushed; F4 was not started.
