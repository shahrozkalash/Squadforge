# Factory Phase F5 — Category Team Definitions and Selection: Progress

**Date:** 2026-11-27. **Status:** implemented and verified locally; not
pushed. F6 not started.

## Objective (from UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md)

Formalize specialized AI teams — game development, creative software,
web development, mobile development, desktop software, backend
engineering, and testing/QA — as data over the existing `AGENT_SPECS` +
generation profiles, with team selection driven by project category.

## Audit: how a category's "team" was determined before F5

| Decision | Before F5 | Kind |
| :-- | :-- | :-- |
| Request → category | `SoftwareRequirementsAnalyzer.detectCategory` (Phase 7): deterministic regex classification to a `CanonicalProjectType`; `SwarmOrchestrator.detectProjectType` is a second, legacy classifier | hardcoded logic (classification) |
| Category → generation profile | **No mapping existed.** The Phase 9 engine re-classified raw request text with its own keyword matcher (`GenerationProfileRegistry.matchProfileForRequest`); two repair flows hardcoded `get('website_and_web_app')` | duplicated logic + hardcoded literal |
| Profiles themselves | `GenerationProfileRegistry` — 11 profiles | **data** ✓ |
| Roles receiving tasks (swarm) | `ConnectedApplicationPlanner.buildTieredFilePlan`/`buildCoordinatedTasks`: tier→role literals (tiers 0–6); `SwarmOrchestrator.seedMilestoneTasks`: a hardcoded `landing_page` branch, the application-plan branch, and a hardcoded fullstack fallback graph; plus a hardcoded orchestrator release task | hardcoded literals |
| Planner's assignable roles | Hardcoded string in `runInitialPlanner`'s planner prompt ("Available Agent Roles: …") | hardcoded literal |
| Role → model binding | Two data sources that **disagreed for 3 roles**: `AGENT_SPECS[role].assignedModelId` vs `ModelConfig.agentRole` (the binding worker loops and `getByRole` actually use). `ui_ux_designer`: llama vs claude-uiux; `performance_engineer`: qwen vs deepseek-perf; `documentation_engineer`: gpt-4o vs mistral-docs | **data, but inconsistent** |
| Role aliases | `database_engineer`, `integration_engineer`, `qa_engineer` exist in `AGENT_SPECS` (specs duplicated from the canonical specialists, same assigned models) but no registry entry carries them as `agentRole`, so `getByRole()` returned `undefined` (F1 finding, pinned) | **data, unresolvable** |
| Verification chain | `SwarmOrchestrator.checkProjectCompletion`: verifier model hardcoded as the literal `'claude'`; fix tasks hardcoded `assignedRole: 'debugging_specialist'` (2 sites); `SandboxRunner` fix tasks → `'debugging_specialist'`; `IntegrationAgent` fix tasks → `'integration_specialist'` | hardcoded literals |
| Collaboration seats | `CollaborationManager.initializeBuildAgents`: 12 roles filled **positionally** from the user's selected models, with per-role fallback literals that match the registry `agentRole` binding (incl. claude-uiux / deepseek-perf / mistral-docs for the three divergent roles above) | hardcoded positional table |
| Who claims a task | `TaskManager.claimTask`: `task.assignedRole === model.agentRole` (exact), plus a hardcoded `fullstack_developer` special case (may claim frontend/backend tasks) | data-driven + one hardcoded rule |

Key facts the design rests on:

- `AGENT_SPECS.assignedModelId` had **no production consumer** before
  F5 (only tests read it) — production role resolution ran entirely on
  `ModelConfig.agentRole`. The registry binding is therefore the
  operational truth, and `CollaborationManager`'s fallbacks agree with
  it on all 12 of its roles — including exactly the three roles where
  `AGENT_SPECS` disagreed. `AGENT_SPECS` was the stale copy.
- The ConnectedApplicationPlanner is **category-blind**: whatever the
  classified category, it plans the same tiered full-stack topology and
  the same tier→role assignments. Only `landing_page` gets a different
  seeded graph. So in the swarm build path, per-category team
  differentiation before F5 was: classification + (in the Phase 9
  engine) profile — not roles. The dedicated category engines (games
  Phases 21/24, video, image, desktop, mobile) live outside the swarm
  path; they are F7–F12 workflow material, not F5 team data.

## What was implemented

### 1. `server/swarm/categoryTeams.ts` (new) — teams as data

`CategoryTeamRegistry`, following the `GenerationProfileRegistry`
pattern, holding one `CategoryTeamDefinition` per canonical category
(24). A definition carries: `displayName`, `profileId` (the category →
profile mapping that did not exist), `members` (roles in stage order),
`assignableRoles` (what the planner may assign), and `verification`
(the completion chain: sandbox gate flag, verifier role, integration
role, repair role). Model bindings are deliberately **not** stored in
team data — roles resolve through the registry at use time.

Member sets record what the platform actually assembles today:

- **Connected-application team** (23 categories): devops (foundation) →
  architect (architecture) → database (data) → backend + security
  (backend) → frontend (frontend) → fullstack (integration) → QA
  (verification) — the ConnectedApplicationPlanner tier graph plus the
  orchestrator's release task; the fullstack fallback graph assigns the
  same roles.
- **Landing-page team**: architect, frontend, QA, security, devops —
  the reduced seeded graph (no backend/database/fullstack tasks).

Selection: `selectForCategory` (normalizes any raw project type to a
canonical category — total over all inputs) and `selectForRequest`
(classifies with the architecture engine's own `detectCategory`, the
same classification the swarm runs).

Resolution: `resolveRoleModel` / `resolve` validate and resolve through
the registry. Unknown role, unregistered assigned model, unknown
profile reference, or a duplicated member role each throw a
`CategoryTeamResolutionError` **naming the offender** — no silent
fallback anywhere in the resolver.

### 2. Registry data corrections (`server/modelRegistry.ts`)

- `AGENT_ROLE_ALIASES` + `canonicalAgentRole()`: the three F1 aliases
  are now declared data, and `getByRole()` canonicalizes through them.
  All 17 `AGENT_SPECS` roles now resolve via `getByRole()`.
- `AGENT_SPECS.assignedModelId` aligned to the registry binding for the
  three divergent roles: `ui_ux_designer` llama → **claude-uiux**,
  `performance_engineer` qwen → **deepseek-perf**,
  `documentation_engineer` gpt-4o → **mistral-docs**. After this, for
  every one of the 17 roles, `getByRole(role).id ===
  AGENT_SPECS[role].assignedModelId` — pinned by the updated F1 suite
  and by F5 test (a). Behaviour-preserving: `assignedModelId` had no
  production consumer, and worker claiming (on `agentRole`) is
  untouched.

### 3. Orchestrator wiring (`server/swarm/swarmOrchestrator.ts`)

Three hardcoded literals replaced by team-data resolution, each
producing **identical values with the shipped data**:

- `checkProjectCompletion`: verifier model `'claude'` →
  `CategoryTeamRegistry.resolveForCategory(build.projectType).verifierModelId`
  (verifier role `software_architect` → claude).
- Both verification fix-task sites: `assignedRole:
  'debugging_specialist'` → `resolvedTeam.team.verification.repairRole`
  (same value).
- `runInitialPlanner`: the planner prompt's "Available Agent Roles"
  list → the selected team's `assignableRoles` (the standard team's
  list is byte-identical to the old hardcoded string — asserted in the
  swap test; the landing-page prompt now advertises only the landing
  team's roles, and the fullstack guidance sentence is emitted only
  when the team includes `fullstack_developer`).

### Deliberately NOT migrated (documented, with reasons)

- **`GenerationProfileRegistry.matchProfileForRequest`** stays the
  Phase 9 engine's selector: Phase 9 suites pin its keyword behaviour,
  and it classifies raw text, a different input from the team
  selector's classified category. F5 test (b) proves the two agree on
  all 13 representative category requests. Known edge divergences
  between the two pre-existing text classifiers (e.g. a bare "store"
  request, "creative suite" phrasing) are recorded in the acceptance
  report as a limitation, not silently papered over.
- **Repair-prompt profile literals** (`automaticRepairEngine`,
  `debugAgentTeam` hardcode `get('website_and_web_app')` when compiling
  a *repair* prompt): the profile there only flavours a repair prompt
  header for an already-built project; it is not category team
  assembly. Left as-is and recorded.
- **`CollaborationManager` positional seats**: a communication layer
  that fills 12 collaboration profiles positionally from the
  user-selected models by design (Phase 8). Its fallback literals
  already agree with the registry binding. Not a category team;
  recorded in the audit so the distinction is explicit.
- **`TaskManager`'s fullstack claim special case** and the
  tier→role literals inside `ConnectedApplicationPlanner` /
  `seedMilestoneTasks`: these *produce* the task graphs. F5 makes the
  team layer the data the orchestrator's chain consumes and pins the
  graphs as behaviour (below); rewriting the graph producers onto team
  data is a larger change than F5's scope and is not needed for the
  roadmap's acceptance criteria.

## Behaviour preservation evidence

Captured from the pre-F5 code with a scratch probe (F2 stub pattern,
deleted after capture): the standard fixture's ("Build a habit tracker
application with streaks and reminders") seeded graph — 8 tasks,
titles/roles/milestones/priorities/file paths/dependency titles — and
the planner prompt's role list. Both are pinned as literal expectations
in `tests/factory_phase_f5_category_teams.test.ts`:

- the pure `ConnectedApplicationPlanner` graph deep-equals the pin;
- the full-run swap test re-derives the seeded graph from a live
  `startSwarm` run and deep-equals it against the pin, and asserts the
  captured planner prompt role line is byte-identical to the pre-F5
  string;
- F2 gauntlet, F3, F4 suites (which drive the same chain) re-run green
  unchanged — see the acceptance report for exact counts.

## Verification (counts from printed summaries)

- New suite `tests/factory_phase_f5_category_teams.test.ts`: **8/8**
  (completeness over all 24 categories; default-chain pin; 13-case
  selection + profile-matcher convergence; landing team shape; loud
  failures + alias positive control; plan-graph pin; resolution-level
  member swap; full-run verifier swap with seeded-graph pin).
- Fast batch in one run — F1 capability (updated pins), orchestration,
  Phase 9 ×5 (code generation engine, approval/cancellation, final
  hardening, gate bypass, limitations), Phase 13, Phase 7, Phase 8,
  fullstack agent/concurrency: **184/184**.
- F2 gauntlet + F3 memory/resume in one run: **10/10**.
- F4 verification/repair gauntlet: **11/11**.
- `npm run lint` (tsc --noEmit): clean. `npm run build` (vite):
  succeeds.
- Phase 4 production reliability + Phase 1 task concurrency + Phase 5
  concurrency hardening in one run: **41/41** — so both tests F2 fixed
  (`orchestration.test.ts:334` in the fast batch, phase4 test 19 here)
  remain green; no regression.

## Development notes (honest log)

- The first resolver draft also required the assigned model's
  `agentRole` to agree with the role at resolution time. The swap test
  caught that this nullifies replaceability itself (any reassignment
  to a model registered under another role threw). The check was
  removed from the resolver: `assignedModelId` is the assignment of
  record for team resolution (existence enforced loudly); agreement of
  the two bindings is an invariant of the shipped data, pinned by
  tests over the default registry. The division of labour between the
  bindings is documented in the resolver's doc comment and the
  acceptance report.
- The first swap-test run failed on a fixture bug in the new suite
  (a dropped digit-guard made `001_initial_schema.ts` generate an
  invalid identifier; the sandbox correctly failed that build). Fixed
  in the fixture; the platform behaved correctly throughout.
