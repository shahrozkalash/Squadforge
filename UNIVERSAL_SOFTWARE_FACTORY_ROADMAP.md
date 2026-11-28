# SquadForge — Universal AI Software Factory Roadmap

**STATUS 2026-11-28: ROADMAP COMPLETE — Factory Phases F1–F14 all implemented and verified locally (staged, not yet pushed; the push is a separate owner step, and final acceptance is the owner's — no self-acceptance).** F1 closed as a **documented negative result**: no provider keys exist in this environment, so no live cloud generation has ever been proven — the per-model truth is published in `CAPABILITY_MATRIX.md`, and every later phase's proof is machinery proven over the stub transport, labelled as such. F2–F4 hardened the orchestration core (delegation/parallel gauntlet; kill-and-resume memory hardening; zero-false-completions verification gauntlet — 10 genuine defects were found and fixed across the roadmap, ledger in `FACTORY_PHASE_F14_ACCEPTANCE_REPORT.md`). F5 made category AI teams data (25 categories after F12 added `ai_application`); F6 established one environment contract for the web and desktop surfaces; F7–F12 delivered the category workflows (games; creative editors incl. the Lightroom-class photo base; web/SaaS/API; mobile; desktop & OS tools; AI applications); F13 unified them behind the single describe→delivered pipeline (`deliverFromDescription`, 12/12); F14 published the capability matrix and the factory release report. Do not start new Factory phases or re-open closed ones without the owner's explicit instruction.
This document replaces the *planning direction* of SquadForge only. It does not
replace, remove, or re-open any completed phase. Factory phases are numbered
**F1, F2, …** so they can never be confused with SquadForge's own phase
numbers (1–60), the Graphics Editor Roadmap (Phases 44–60), or the Video
Editor Roadmap (Phases 1–4).

## Vision (owner's direction, 2026-11-27)

SquadForge is a website — a **Universal AI Software Development Platform**
powered by its 10 AI models working together. A user describes an
application; SquadForge plans it, builds it, tests it, and packages it.
The platform must eventually be capable of building complex,
production-quality software in every major category:

- Advanced games — 2D, 3D, and multiplayer
- Video editors comparable to CapCut
- Image editors comparable to Photoshop
- Photo editing software comparable to Lightroom
- Desktop applications and operating-system tools
- Android and iOS applications
- Websites, SaaS platforms, APIs, and enterprise systems
- AI applications and other custom software

SquadForge itself is **not** any one of those applications. The editors,
engines, and generators already inside the repo are the platform's
*capabilities* — the things it can build — not the product's identity.

## Principles

1. **Preserve everything.** Completed phases and engines are the foundation.
   Nothing is rebuilt from scratch and nothing is removed without a written
   justification in that phase's progress document.
2. **Providers and models stay replaceable.** The 10 registered models are
   configuration (registry entries routed through OpenRouter, the native
   Gemini path, or local models), never hard-coded identities. Any phase
   that binds behaviour to one vendor's model fails its own acceptance.
3. **Evidence-based acceptance.** A phase is complete only when its
   acceptance criteria are demonstrated in this repo's evidence style:
   real builds, artifact inspection (PE/ELF/APK/Mach-O/ffprobe), named
   test suites passing, and CI runs where the phase touches CI-proven
   surfaces. "The code exists" is never acceptance.
4. **Honest capability claims.** Registered-but-unproven is labelled
   unproven. A category is "supported" only when an end-to-end build in
   that category has been verified; anything less is "partial" and the
   roadmap says which part is missing.
5. **One phase at a time.** Each Factory phase is started only on the
   owner's explicit instruction, finished (code, tests, docs) before the
   next begins, and the owner keeps final acceptance of every phase.

## Audit summary — where the platform stands (2026-11-27, file-verified)

Full findings are in `FACTORY_REDESIGN_REPORT.md`. The short version:

### The 10-model layer — real routing, unproven live cloud generation
- `server/modelRegistry.ts` registers **10 base models** (gpt-4o, claude,
  llama, mistral, nemotron, gemini, deepseek, qwen, grok, codex) plus 4
  specialized variants (gemini-fullstack, claude-uiux, deepseek-perf,
  mistral-docs) and dynamically discovered local models. 17 agent roles
  (`AGENT_SPECS`) map roles → models.
- 8 of the 10 base models route through **OpenRouter**; gemini and
  gemini-fullstack use the **native Gemini** path (`server/gateway.ts`,
  `GEMINI_API_KEY`). Local models run through Ollama
  (`server/localLLM.ts`).
- `server/smartRouter.ts` genuinely routes: task-complexity
  classification, quota/cooldown-aware provider choice
  (`server/quotaManager.ts`), OpenRouter→Gemini fallback on failure or
  missing key, per-model fallback, cancellation, and the Phase 33
  reliability policy (`server/providerReliability.ts` — 120 s default
  timeout with real abortion, bounded retries for transient failures
  only). Routing, fallback, and failure classification are test-proven
  against real HTTP transport stubs.
- **Honest verdict:** no successful *live cloud* generation has ever been
  demonstrated in this repo. Phase 33 recorded four genuine Gemini
  attempts returning 503/404 or egress timeouts; the gated live test
  (`LIVE_PROVIDER_TEST=1`) has never passed. A local model (Ollama) is
  the only provider class that has run a real repair (Phase 11). Every
  cloud model is therefore **registered and routing-proven, but
  generation-unproven live**. This is the platform's single largest gap
  and is why Factory Phase F1 exists.

### Orchestration (`server/swarm/`, ~14,200 lines) — substantially built
Task decomposition and dependency-aware scheduling (`taskManager.ts`),
parallel per-model worker loops (`swarmOrchestrator.ts`), contract-first
generation, code generation/review engines, shared context
(`projectContextEngine.ts`), persistent project memory — facts, defects,
ADRs, module relationships (`projectMemory.ts`), a shared workspace with
merge management and file leases, a patch-validation pipeline,
browser runtime verification (`runtimeVerifier.ts`), an honest
verification service (`server/verificationService.ts`), and an automatic
repair engine fed by the debugging subsystem (`server/debugging/` —
root-cause engine, repair coordinator, static checks). Approval gates
are real and server-side (`approvalGateService.ts`). What is missing is
not machinery but *proof at platform scale*: the pieces have been
exercised per-phase, not yet as one gauntlet (see F2–F4).

### Execution / preview / test / debug / deploy environment — built, CI-proven in part
Sandboxed execution only through `ExecutionBackend` (Docker backend,
TLS-only remote workers that fail closed, gVisor `runsc` verification,
resource limits, HMAC-signed preview links — Phase 32, CI-proven against
a genuine TLS + runsc dockerd). Preview generation and sessions exist
(`server/swarm/previewGenerator.ts`, `server/execution/preview*`).
Testing: sandbox test running plus file-level coverage analysis
(Phase 12). Debugging/repair: Phase 11 subsystem. Deployment: a service
with six adapters (Cloudflare Pages, Netlify, Vercel, Docker, static
host, webhook), pre-deployment validation, and production builds
(Phase 15) — but AGENTS.md still records, correctly, that no production
worker, production URL, or live deployment is verified. Deployment is
**implemented and test-proven, not live-proven**.

### Large projects — memory and recovery exist; version control is real
Project memory persists facts/defects/decisions; builds checkpoint and
can recover; GitHub lifecycle (connect, branch, PR) is implemented and
tested (Phase 14, `server/github/`). The IDE engine adds a real Git
service (Phase 22). Known fragile areas (AGENTS.md) remain: long-running
generation progress reporting, and `db.getFile`/`db.getAllFiles`
returning live objects.

### Category coverage — engines exist for every target category
| Owner's target | Engine in repo | Maturity evidence |
| :--- | :--- | :--- |
| Games 2D/3D/multiplayer | `server/gameEngine/` + `server/scene3d/` | Phase 24 (14 tests: playable HTML5 platformer simulated in tests, deterministic engine, authoritative multiplayer foundation with cheat-resistance proofs) + Phase 21 (17 tests: 3D scene graph, software renderer, OBJ/glTF export) |
| Video editors (CapCut-class) | `server/videoEditor/` | Phases 20/26/27/28/29/30/31 + native ClipForge apps (Phases 34/35, CI-proven builds; Phase 37 export parity 11/11 genuine checks) + Video Editor Roadmap Phases 1–4 |
| Image editors (Photoshop-class) | `server/imageEditor/` | Phase 19 + Graphics Roadmap Phases 44–60 (480-test final regression; PSD import/export; 16-bit workflow; v1.0.0 release packages) |
| Photo editors (Lightroom-class) | *No dedicated engine* — `server/imageEditor/` adjustments/filters are the base | **Gap, stated plainly:** no photo-workflow (catalog, non-destructive develop, batch) engine exists; F8 must define and build it on the image engine rather than claim it exists |
| Desktop apps & OS tools | `server/desktop/` + `server/ide/` + `server/release/` | Phases 18/36 (genuine PE + ELF builds), 22 (IDE), 23 (release packaging with tamper detection) |
| Android / iOS apps | `server/android/` + `server/ios/` | Phase 17 + 34 (CI-proven APK), Phase 25 + 35 (CI-proven Mach-O builds on macOS runners) |
| Websites / SaaS / APIs / enterprise | `server/application/` + `server/architecture/` + 11 generation profiles (`server/swarm/generationProfiles.ts`) | Phases 7/9/13/16 (architecture engine, code generation, application generation, end-to-end lifecycle) |
| AI applications | The provider layer itself (registry + router) as the build target's runtime | No dedicated workflow yet; F12 defines it |

### The describe → plan → build → test → package path — exists, per-category
A user prompt enters through the build flow (`server.ts` +
`SwarmOrchestrator`): planner → parallel model workers over a shared
workspace → sandbox verification → repair → integration. Category shape
comes from the 11 generation profiles and the architecture engine
(requirements → stack selection → file-structure plan). Packaging exists
per category (release packager, APK/AAB, desktop installers, deployment
adapters). What does **not** yet exist is a *single* proven pipeline that
takes one text description per category all the way to a packaged,
verified artifact with the whole chain in one run — that is the Factory
roadmap's endgame (F13).

## Disposition of prior roadmaps

- **SquadForge Phases 1–60 stand** as the completed foundation. Their
  status rows in `AGENTS.md` are unchanged and remain the record.
- **Graphics Editor Roadmap (Phases 44–60): complete.** Closed by
  Phase 60 (v1.0.0 release) and its CI fix (main CI #193 green).
- **Video Editor Roadmap: closed by the owner on 2026-11-27.** Phases
  1–4 are complete and remain part of the platform's video capability;
  Phases 5–8 were abandoned (the roadmap was a mis-prompt — SquadForge
  is not becoming a CapCut-like app). It is not resumed.
- **This roadmap (Factory Phases F1–F14)** is now the forward plan.

## The Factory plan

### Arc A — Orchestration core: prove the 10 models work as one system

#### F1 — Live provider proof and model capability baseline
- **Objective:** Close the platform's oldest open wound: demonstrate at
  least one live cloud generation end-to-end, and classify every
  registered model with evidence.
- **Scope (in):** run the gated live suite (`LIVE_PROVIDER_TEST=1`) for
  the Gemini path and an equivalent gated live check for the OpenRouter
  path; record per-model results (success / HTTP status / timeout) in a
  capability matrix doc; fix only what blocks a *correct* call (model
  ids, base URLs, request shape) — no routing redesign.
- **Scope (out):** new providers; cost optimization; UI changes.
- **Dependencies:** Phase 33 (reliability policy), Phase 11 (local model
  path). Needs the owner's API keys present in the environment.
- **Acceptance criteria:**
  1. At least one cloud path completes a real generation in a gated live
     run, with the raw result recorded (model id, latency, output
     validity) in the phase's acceptance report.
  2. Every registry entry (10 base + 4 variants + local) is classified
     `callable` / `registered-unproven` / `broken` in the capability
     matrix, each with the evidence (run output or error) behind it.
  3. `tests/phase33_ai_reliability_security.test.ts` and
     `tests/orchestration.test.ts` pass; lint and production build pass.
  4. If no cloud path can succeed from this environment, the phase
     reports exactly that with the verbatim errors — a documented
     negative result closes F1; a claim without a run does not.

#### F2 — Delegation and parallel execution at platform scale
- **Objective:** Prove the swarm's task delegation, dependency-aware
  scheduling, parallel worker execution, and cancellation as one system,
  not per-module.
- **Scope (in):** an end-to-end orchestration gauntlet over transport
  stubs: a multi-file project decomposed into dependency-ordered tasks,
  executed by ≥3 model workers in parallel over the shared workspace,
  with a mid-run cancellation and a worker-failure injection.
- **Scope (out):** live providers (F1 covers them); new task types.
- **Dependencies:** Phases 1–6 (concurrency foundations), Phase 9,
  F1 not required (stubs), but F2's report must state stub-vs-live.
- **Acceptance criteria:**
  1. New gauntlet suite passes: child tasks never start before their
     dependencies complete (ordering asserted from the task log);
     parallel workers' file writes never corrupt each other (final tree
     hash-matches the expected merge).
  2. Cancellation test: cancelling the build stops in-flight model calls
     (no task completes after the cancel point in the log) and the build
     ends in a cancelled state, not a silent success.
  3. Worker-failure test: one worker's tasks are retried/reassigned per
     policy and the build still completes with the failure recorded.
  4. Existing `tests/orchestration.test.ts` and concurrency suites
     (phase1/phase5) pass; lint and build pass.

#### F3 — Shared context and project memory hardening
- **Objective:** Make `ProjectMemory` + `ProjectContextEngine` the single
  proven context source for every worker, surviving restarts mid-build.
- **Scope (in):** restart-recovery path (persist → kill → resume),
  context assembly budgets, ADR/fact conflict surfacing to workers.
- **Scope (out):** new memory features beyond what recovery requires.
- **Dependencies:** Phase 9/11 memory work; F2's gauntlet as the harness.
- **Acceptance criteria:**
  1. Kill-and-resume test: a build interrupted after ≥1 checkpoint
     resumes from persisted memory and completes; resumed workers'
     context contains the pre-kill facts/decisions (asserted on content,
     not just non-emptiness).
  2. Two workers given contradictory facts produce a recorded conflict,
     not silent divergence (conflict appears in the build record).
  3. Context assembly respects its token budget under a large-project
     fixture (asserted size bound) while retaining pinned facts.
  4. Memory/project-context tests pass; lint and build pass.

#### F4 — Verification and failure-recovery gauntlet
- **Objective:** Chain runtime verification → patch validation →
  automatic repair into one proven loop with zero false completions.
- **Scope (in):** an injected-defect suite against generated projects:
  compile error, failing test, runtime crash, broken import graph.
- **Scope (out):** new repair strategies beyond wiring the existing
  engines in sequence.
- **Dependencies:** Phase 11 (debugging/repair), Phase 12 (testing),
  F2/F3 harness.
- **Acceptance criteria:**
  1. Each injected defect class is either repaired and **re-verified
     green by the verifier** or escalated as failed with the defect
     named — the suite asserts no build with an unrepaired defect is
     ever marked complete (the `HonestVerificationService` gate).
  2. Repair attempts respect the existing retry limits (attempt counts
     asserted); exhausted retries end in an honest failure state.
  3. Phase 11 and Phase 12 suites pass unchanged; lint and build pass.

### Arc B — Specialized AI teams

#### F5 — Category team definitions and selection
- **Objective:** Formalize specialized AI teams — game development,
  creative software, web development, mobile development, desktop
  software, backend engineering, and testing/QA — as data over the
  existing `AGENT_SPECS` + generation profiles, with team selection
  driven by project category.
- **Scope (in):** team specs (roles, assigned models, profile,
  verification chain per category); a selector mapping a classified
  project request → team; registry-swap behaviour.
- **Scope (out):** new agent roles that duplicate existing ones; prompt
  rewrites beyond team assembly.
- **Dependencies:** Phase 7 (architecture/category classification),
  Phase 9; Arc A not strictly required but F5's acceptance uses stubs.
- **Acceptance criteria:**
  1. Team-selection tests: one representative request per target
     category selects the expected team and generation profile.
  2. Every team member resolves to a registered model + an existing
     agent role (no dangling references — asserted over the registry).
  3. Replaceability test: changing a role's `assignedModelId` in the
     registry changes the team's model with no code change (the
     platform's provider-independence principle, proven).
  4. Orchestration + registry suites pass; lint and build pass.

### Arc C — Universal environment

#### F6 — One environment contract for build / preview / test / debug / deploy
- **Objective:** Consolidate the existing execution, preview, testing,
  debugging, and deployment subsystems behind one environment contract
  every category workflow uses, and close the environment-level open
  items recorded in `AGENTS.md` (production worker decision, preview
  domain) as documented decisions or proven runs.
- **Scope (in):** the contract + adapters wiring existing subsystems;
  a two-category lifecycle proof (one web project, one desktop project)
  through execute → preview → test → deploy-dry-run.
- **Scope (out):** buying/hosting real infrastructure; new deployment
  targets.
- **Dependencies:** Phase 10/32 (execution), Phase 12 (testing),
  Phase 15 (deployment), Phase 22/23.
- **Acceptance criteria:**
  1. Lifecycle suite passes for both proof categories through the same
     environment API (no category-specific back doors in the test).
  2. Deploy step runs as a validated dry-run against the existing
     adapters with the approval gate enforced (a request without
     approval does not deploy — asserted).
  3. Execution stays sandbox-only: a test asserts project code never
     runs on a plain host process (the repo's standing invariant).
  4. Phase 10/15/32 suites pass; lint and build pass; the AGENTS.md
     open items touched are updated with the decision taken.

### Arc D — Category workflows (describe → plan → build → test → package)

Each Arc D phase takes ONE category from a text description to a
packaged, verified artifact using the Arc A–C machinery and the existing
category engine. The stub-vs-live rule applies throughout: a workflow
proven over transport stubs is reported as stub-proven; claiming
live-proven requires an F1-class live run in that workflow.

#### F7 — Games workflow (2D, 3D, multiplayer)
- **Objective:** One described game idea → playable, packaged game.
- **Dependencies:** `server/gameEngine/`, `server/scene3d/`
  (Phases 21/24), F5 game team, F6 environment.
- **Acceptance criteria:**
  1. A described 2D game builds end-to-end; the shipped game code is
     simulated in tests (the Phase 24 evidence style) and the package
     loads/runs headlessly with no runtime errors.
  2. A described 3D scene/game variant exports a real OBJ or glTF that
     parses with the repo's own importers.
  3. The multiplayer foundation is exercised: two simulated clients
     stay in sync and a cheat attempt is rejected (Phase 24 proofs
     re-run inside the workflow).
  4. Phase 21 + Phase 24 suites pass; lint and build pass.

#### F8 — Creative editors workflow (video, image, photo)
- **Objective:** Described editor → generated editor application for
  each of: video (CapCut-class), image (Photoshop-class), photo
  (Lightroom-class).
- **Dependencies:** `server/videoEditor/` (Phases 20–31, 34/35, 37,
  Video Editor Roadmap 1–4), `server/imageEditor/` (Phases 19, 44–60),
  F5 creative team, F6.
- **Acceptance criteria:**
  1. Video: a described editor variant generates the ClipForge-class app;
     the genuine-export checks (Phase 37 style, ffprobe + pixel/RMS
     verification) pass for its export path.
  2. Image: a described editor variant generates the PixelForge-class
     app; it compiles genuinely (PE-verified) and its engine passes the
     graphics regression suites.
  3. Photo: the phase first **defines the Lightroom-class gap honestly**
     (catalog + non-destructive develop workflow) and builds that
     workflow on the image engine; acceptance is a real
     import → develop (non-destructive edits) → batch-export run with
     byte-level before/after evidence. If the gap cannot be closed in
     one phase, the phase delivers the definition + the largest working
     slice and says so.
  4. Relevant engine suites pass; lint and build pass.

#### F9 — Web, SaaS, API, and enterprise workflow
- **Objective:** Described web product → running, tested web
  application/API with deployment package.
- **Dependencies:** `server/application/`, `server/architecture/`,
  generation profiles (Phases 7/9/13/16), F5 web + backend teams, F6.
- **Acceptance criteria:**
  1. One described SaaS-style app and one described REST API each build
     end-to-end; their generated test suites run green in the sandbox.
  2. The produced app serves real HTTP responses in the preview
     environment (status + body asserted, not just file existence).
  3. A deployment dry-run package is produced and passes the Phase 15
     pre-deployment validator.
  4. Phase 13/15/16 suites pass; lint and build pass.

#### F10 — Mobile workflow (Android and iOS)
- **Objective:** Described mobile app → genuine Android and iOS builds.
- **Dependencies:** `server/android/` (Phases 17/34), `server/ios/`
  (Phases 25/35), F5 mobile team, F6.
- **Acceptance criteria:**
  1. Android: the workflow's app builds in CI to a signed-verifiable APK
     (apksigner pass, nonzero size, hash recorded — the Phase 17/34
     evidence style).
  2. iOS: the workflow's app builds on a macOS runner to a Mach-O
     universal executable (Phase 25 evidence style); IPA only with a
     signing team, never fabricated.
  3. A deliberately broken generated source file fails the workflow
     honestly (negative test, both platforms where the harness allows).
  4. Phase 17/25 suites pass; lint and build pass.

#### F11 — Desktop applications and OS tools workflow
- **Objective:** Described desktop app / OS utility → packaged desktop
  release for Windows and Linux.
- **Dependencies:** `server/desktop/` (Phases 18/36), `server/ide/`
  (Phase 22), `server/release/` (Phase 23), F5 desktop team, F6.
- **Acceptance criteria:**
  1. Windows package: genuine `dotnet publish` output, PE-verified exe,
     SHA-256 manifest, and the Phase 23 package/install validation
     passes incl. tamper detection.
  2. Linux package: ELF-verified apphost that actually launches
     (`--smoke` state persistence, the Phase 36/60 evidence style).
  3. An OS-tool variant (CLI utility) is built and its real output on
     fixture input is asserted.
  4. Phase 18/22/23/36 suites pass; lint and build pass.

#### F12 — AI applications workflow
- **Objective:** Described AI app → an application that itself calls AI
  models through SquadForge's replaceable provider layer.
- **Dependencies:** model registry + smart router (as the generated
  app's runtime dependency), F5, F6, F1's capability matrix.
- **Acceptance criteria:**
  1. The generated app calls a model through the provider abstraction;
     swapping the configured model id changes the provider used with no
     code change (asserted in the app's own tests).
  2. With no provider key configured, the app fails with a named,
     actionable error — never a fake canned response presented as AI
     output.
  3. A stubbed-provider end-to-end run of the generated app passes; if
     F1 proved a live path, one live run is recorded too (labelled).
  4. Registry/router suites pass; lint and build pass.

### Arc E — The describe-to-delivered pipeline and factory release

#### F13 — Describe → delivered: the unified pipeline
- **Objective:** One entry point: the user describes any application;
  the platform classifies the category, selects the team and profile,
  plans, builds in parallel, verifies, repairs, packages, and presents
  the result — the whole Factory chain in a single run.
- **Scope (in):** pipeline wiring over F1–F12 outputs; progress and
  failure reporting to the user that matches reality (invariant 5:
  failed validation stays visible).
- **Scope (out):** new category capabilities (those are Arc D).
- **Dependencies:** F1–F12 (at minimum F1, F2, F5, F6, and the Arc D
  workflows it claims to unify — the phase must list which).
- **Acceptance criteria:**
  1. One small real application per major category (games, creative,
     web/API, mobile, desktop, AI app) is produced from a text prompt
     through the single pipeline, each meeting its Arc D acceptance
     evidence standard.
  2. An impossible/contradictory request fails honestly at planning
     with the reason surfaced — no partial fake delivery.
  3. Every delivered artifact carries its verification record (what was
     run, what passed) — a delivery without a record is a failed test.
  4. Full test suite run is reported with exact counts; lint and build
     pass.

#### F14 — Factory release and published capability matrix
- **Objective:** Close the Factory roadmap: a release of the platform
  whose public claims match its proofs.
- **Scope (in):** full-suite + CI verification, documentation pass, and
  a published capability matrix (per category: proven / partial /
  unproven, each linked to its evidence).
- **Scope (out):** new features.
- **Dependencies:** F13.
- **Acceptance criteria:**
  1. Main CI is green on the release commit (exact counts reported),
     including the gated suites' status stated honestly (which gates
     remain and why).
  2. The capability matrix contains no claim without a linked run,
     suite, or artifact hash in this repo.
  3. `AGENTS.md` and this roadmap are updated to the final state; the
     owner accepts or the phase stays open — no self-acceptance.

## Sequencing notes

- F1 can run first and independently — it needs only the owner's keys
  and settles the platform's biggest unknown.
- F2–F4 harden the core before teams (F5) and the environment contract
  (F6) build on it. Arc D phases are mutually independent once F5+F6
  land, and can be taken in any order the owner chooses.
- F13/F14 close the roadmap and must not be started early: their
  acceptance is defined over the earlier phases' evidence.
- As everywhere in this repo: one phase at a time, owner's word starts
  a phase, owner's acceptance closes it.
