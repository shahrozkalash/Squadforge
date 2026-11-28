# Factory Phase F5 — Category Team Definitions and Selection: Acceptance Report

**Date:** 2026-11-27. **Verdict: F5 criteria met**, with the scope
statements and limitations below recorded plainly. Implemented and
verified locally; not pushed. F6 not started.

## Criterion-by-criterion verdict (roadmap acceptance criteria)

### 1. Team-selection tests: one representative request per target category selects the expected team and generation profile — **MET**

`tests/factory_phase_f5_category_teams.test.ts` runs 13 representative
requests through `CategoryTeamRegistry.selectForRequest` (which
classifies with the architecture engine's own
`SoftwareRequirementsAnalyzer.detectCategory`) and asserts the selected
team's category, profile, and display name:

| Request (abridged) | Team | Profile |
| :-- | :-- | :-- |
| 2D platformer game | Game Development Team | game_creative_application |
| generative art canvas app | Creative Software Team | game_creative_application |
| web application for team notes | Web Development Team | website_and_web_app |
| multi-tenant SaaS dashboard, KPI | Web — SaaS Platform | saas_platform |
| e-commerce store, catalog, checkout | Web — E-Commerce | ecommerce_app |
| Android app, Kotlin, Jetpack Compose | Mobile — Android | android_mobile_application |
| cross-platform desktop app, Electron | Desktop — Cross-Platform | desktop_application |
| REST API backend service, Express | Backend — API Service | rest_api_backend |
| CLI tool for parsing logs | Developer Tools — CLI | cli_tool_developer_utility |
| automation bot, cron scraping | Automation Team | automation_software |
| data processing ETL pipeline | Data Engineering Team | data_processing_application |
| video editor with timeline | Creative — Multimedia | multimedia_application |
| landing page, hero, waitlist | Web — Landing Page | website_and_web_app |

The roadmap's "testing/QA team" is not a build category: QA is a role
(`qa_testing_specialist`) and a verification chain present in **every**
team, asserted over all 24 categories (below).

Convergence evidence: on all 13 requests, the Phase 9 engine's keyword
profile matcher (`matchProfileForRequest`, behaviour unchanged and
still pinned by the Phase 9 suites) picks the same profile the team
data assigns to the classified category.

### 2. Every team member resolves to a registered model + an existing agent role (no dangling references — asserted over the registry) — **MET**

For all 24 canonical categories the suite resolves the full team and
asserts: the referenced profile is registered; member roles are
unique and stage-ordered; every member, every planner-assignable role,
and every verification-chain role resolves to a registered model; and
the two registry bindings agree — `getByRole(role).id ===
AGENT_SPECS[role].assignedModelId` — for every role, aliases included.

### 3. Replaceability test: changing a role's `assignedModelId` in the registry changes the team's model with no code change — **MET, proven in a full swarm run**

Two levels of proof in the suite:

- **Resolution level:** reassigning `qa_testing_specialist` deepseek →
  qwen in `AGENT_SPECS` data changes the resolved game team's QA model
  to qwen (restored after; asserted both ways).
- **Orchestrator level:** with `software_architect`'s `assignedModelId`
  swapped claude → gpt-4o (data only, restored after), a full
  `startSwarm` run of the standard fixture **completed**, and every
  verifier call the orchestrator's completion chain made used
  **gpt-4o** — the pre-F5 code hardcoded `'claude'` for that call. In
  the same run, the seeded task graph deep-equals the pre-F5 pin and
  the planner prompt's role list is byte-identical to the pre-F5
  hardcoded string, i.e. the swap changed the team's model and
  nothing else.

Division of labour between the registry's two bindings (documented in
the resolver and the progress doc): `assignedModelId` is the
assignment of record for team resolution and role-directed model calls
(verifier today); `ModelConfig.agentRole` governs which tasks a worker
loop claims. In the shipped registry they agree for all 17 roles
(pinned). A reassignment therefore swaps role-directed calls
immediately; for claim-based work the target model must also be the
model registered for the role (or be selected for the build).

### 4. Orchestration + registry suites pass; lint and build pass — **MET**

Exact counts in "Verification" below — including the F2 gauntlet, F3,
and F4 suites over the same orchestration chain, unchanged and green.

## The per-category team table (as data)

All 24 canonical categories have exactly one team definition in
`server/swarm/categoryTeams.ts`. Verification chain is identical for
every team today (category-invariant platform behaviour): sandbox
integrity gate on; verifier role `software_architect` (→ claude);
integration role `integration_specialist` (→ gemini); repair role
`debugging_specialist` (→ qwen).

| Category | Profile | Members |
| :-- | :-- | :-- |
| landing_page | website_and_web_app | **reduced:** architect, frontend, QA, security, devops |
| portfolio, blog, web_application, fullstack, custom | website_and_web_app | connected-application team |
| saas | saas_platform | connected-application team |
| ecommerce | ecommerce_app | connected-application team |
| api_service, backend_service | rest_api_backend | connected-application team |
| desktop_application, windows_application, cross_platform_desktop | desktop_application | connected-application team |
| android_application, cross_platform_mobile | android_mobile_application | connected-application team |
| cli_tool, developer_tool | cli_tool_developer_utility | connected-application team |
| automation_tool | automation_software | connected-application team |
| data_application, engineering_application | data_processing_application | connected-application team |
| game_application, creative_application, 3d_application | game_creative_application | connected-application team |
| multimedia_application | multimedia_application | connected-application team |

Connected-application team (stage order): devops_release_specialist
(foundation) → software_architect (architecture) → database_specialist
(data) → backend_developer, security_specialist (backend) →
frontend_developer (frontend) → fullstack_developer (integration) →
qa_testing_specialist (verification).

**Stated plainly:** member sets are identical for 23 of 24 categories
because that is what the platform assembles today — the
ConnectedApplicationPlanner's tier graph is category-blind and only
`landing_page` seeds a different graph. What differs per category in
the data is the team identity, the generation profile (the category →
profile mapping is new; it did not exist before F5), and — from here
on — anything an owner changes per category becomes a data change
instead of a code branch. F5 does not claim per-category role
differentiation the platform does not have; the dedicated category
engines (games, video, image, desktop, mobile) remain separate
capabilities whose workflow integration is F7–F12.

## What moved from code to data

| Was | Now |
| :-- | :-- |
| Verifier model literal `'claude'` in `checkProjectCompletion` | Team data: verification.verifierRole → registry resolution |
| Fix-task role literal `'debugging_specialist'` (2 sites in `checkProjectCompletion`) | Team data: verification.repairRole |
| Planner prompt's hardcoded "Available Agent Roles" list | Selected team's `assignableRoles` (byte-identical output for the standard team; landing prompt now lists only landing roles) |
| Category → generation profile: *did not exist* (Phase 9 engine re-classified raw text; two repair flows hardcoded the web profile) | Team data: one `profileId` per category, selected from the classified category |
| Role aliases: implicit, unresolvable via `getByRole` | `AGENT_ROLE_ALIASES` data + canonicalizing `getByRole` |
| `AGENT_SPECS` vs registry binding disagreement (3 roles) | Data aligned to the operational binding; agreement pinned for all 17 roles |

Not migrated, with reasons recorded in the progress doc: the Phase 9
engine's keyword profile matcher (pinned behaviour; different input),
the two repair-prompt profile literals (prompt flavour for repairs,
not team assembly), `CollaborationManager`'s positional collaboration
seats (a Phase 8 communication layer, not category teams), and the
task-graph producers' internal tier→role literals (the graphs
themselves are pinned as behaviour; the orchestrator's chain — the
F5 brief's consumption point — now runs on team data).

## Alias resolution (F1 finding — closed)

`database_engineer` → `database_specialist`,
`integration_engineer` → `integration_specialist`, `qa_engineer` →
`qa_testing_specialist`, declared in `AGENT_ROLE_ALIASES`;
`modelRegistry.getByRole()` canonicalizes through the map. The F1
suite was updated to pin the resolved state (alias set still pinned
by name, plus a canonicalization assertion), and addenda were added
to `FACTORY_PHASE_F1_PROGRESS.md`,
`FACTORY_PHASE_F1_ACCEPTANCE_REPORT.md`, and `CAPABILITY_MATRIX.md`
(note 2). The F5 suite additionally proves an alias role used inside
team data resolves to the canonical model (qa_engineer → deepseek).

## Verification (counts from printed summaries)

- F5 suite (`tests/factory_phase_f5_category_teams.test.ts`): **8/8**.
- One run — F1 capability (updated pins), orchestration, Phase 9 ×5,
  Phase 13, Phase 7, Phase 8, fullstack agent/concurrency: **184/184**.
- F2 gauntlet + F3 memory/resume: **10/10**. F4 gauntlet: **11/11**.
- Phase 4 + Phase 1 concurrency + Phase 5 concurrency: **41/41**.
  Both F2-fixed tests (`orchestration.test.ts:334`, phase4 test 19)
  remain green — no regression.
- `npm run lint`: clean. `npm run build`: succeeds.
- Behaviour preservation: pre-F5 seeded graph + planner role list
  captured by probe from the pre-change code, pinned literally in the
  F5 suite, and re-asserted from a live post-change swarm run.

## Limitations

- **Stub transport** for the full-run proof (F2/F3 pattern): team
  resolution and orchestration mechanics are proven; no live model
  exists in this environment (F1 verdict stands).
- **Two text classifiers remain.** The architecture analyzer (used by
  the swarm and the team selector) and the Phase 9 profile keyword
  matcher agree on all 13 representative requests (asserted), but
  disagree on some edge phrasings (e.g. a bare "store" request
  classifies as fullstack for the analyzer but ecommerce for the
  matcher; "creative suite" classifies as creative for the analyzer
  but falls to the web default in the matcher). F5 did not merge them
  — the matcher's behaviour is pinned by Phase 9 suites — and the
  team selector follows the analyzer, the classification the swarm
  itself runs on. Recorded as a known divergence, not hidden.
- **Nearest-profile mappings:** `3d_application` and
  `creative_application` map to `game_creative_application`, and
  `engineering_application` to `data_processing_application`, because
  no dedicated 3D/engineering generation profile exists among the 11.
  The mapping is explicit data, changeable when such profiles exist.
- **Claim-based work follows `agentRole`, not `assignedModelId`** (see
  criterion 3): reassigning a role whose work is claimed by worker
  loops also requires the target model to be the role's registered
  model or selected for the build. Role-directed calls (the verifier)
  follow team data immediately.
- `SandboxRunner`'s and `IntegrationAgent`'s internal fix-task role
  literals (`debugging_specialist`, `integration_specialist`) are
  unchanged: they are engine-internal and category-invariant, and the
  values match every team's verification chain. The orchestrator's
  own fix-task sites — the ones in the completion chain — are the
  ones F5 wired to team data.
- Full test suite not re-run (30+ min on this VM); the batches above
  cover every touched surface (registry, profiles, planner,
  orchestrator chain, collaboration, concurrency).
