# Factory Redesign Report — SquadForge as a Universal AI Software Factory

**Date:** 2026-11-27. **Scope:** roadmap redesign and documentation only.
No code was changed, no phase was started, nothing was pushed.

## Why this redesign

The owner's direction (2026-11-27): SquadForge is not to become a
single-category app (the Video Editor Roadmap was a mis-prompt and is
closed). SquadForge is a website — a Universal AI Software Development
Platform powered by its 10 AI models — that must eventually build
complex, production-quality software from user instructions across every
major category: advanced games (2D/3D/multiplayer), video editors
(CapCut-class), image editors (Photoshop-class), photo editors
(Lightroom-class), desktop applications and OS tools, Android and iOS
apps, websites/SaaS/APIs/enterprise systems, and AI applications.

## Audit findings (all file-verified)

### (a) The 10-model layer
- **Registry** (`server/modelRegistry.ts`, 617 lines): 10 base models —
  gpt-4o, claude, llama, mistral, nemotron, gemini, deepseek, qwen, grok,
  codex — plus 4 specialized variants (gemini-fullstack, claude-uiux,
  deepseek-perf, mistral-docs), plus dynamically discovered local
  models. Each entry carries provider model id, tier, pricing, context
  window, capabilities. 17 agent roles (`AGENT_SPECS`) map roles →
  models (project manager → gpt-4o, architect → claude, QA → deepseek,
  debugging → qwen, security → grok, devops → codex, …).
- **Routing reality:** 8 of 10 base models route through **OpenRouter**
  (`OPENROUTER_API_KEY`); gemini + gemini-fullstack use the **native
  Gemini** path (`server/gateway.ts` → GoogleGenAI, `GEMINI_API_KEY`);
  local models use **Ollama** (`server/localLLM.ts`, OpenAI-compatible).
  So "10 models" = 10 logical models over 2 cloud transports + local.
- **SmartRouter** (`server/smartRouter.ts`, 977 lines) genuinely routes:
  task-complexity classification (lightweight/standard/flagship),
  explicit-model honouring, quota/cooldown-aware selection
  (`server/quotaManager.ts` — per-provider/model availability, cooldown
  windows), OpenRouter→Gemini fallback on failure, on rate-limit
  cooldown, and on missing `OPENROUTER_API_KEY`; per-model fallback
  chains; cancellation plumbed into in-flight calls; usage logging.
- **Reliability policy** (`server/providerReliability.ts`, Phase 33):
  `PROVIDER_TIMEOUT_MS` (default 120 s) with genuine request abortion;
  `PROVIDER_MAX_RETRIES` (default 2) only for transient failures
  (408/429/5xx, rate-limit/network/provider codes) — auth, quota,
  malformed output, and cancellations are never retried; exponential
  backoff whose timer is deliberately ref'd (the unref'd-timer bug class
  that once cancelled CI tests is documented in the file).
- **Callable-vs-registered verdict (the honest part):** routing,
  fallback, and failure classification are proven by tests over real
  HTTP transport stubs (`tests/orchestration.test.ts`,
  `tests/phase33_ai_reliability_security.test.ts`). But **no successful
  live cloud generation has ever been demonstrated**: Phase 33 recorded
  four genuine Gemini attempts via the owner's AI Studio credential
  returning real 503/404 responses or egress timeouts, and the gated
  live test (`LIVE_PROVIDER_TEST=1`) has never been run to a pass. The
  only provider class with a real end-to-end generation on record is a
  **local model** (Phase 11 repairs via Ollama). Every cloud model is
  therefore *registered and routing-proven, generation-unproven live*.
  This is the platform's largest known gap → Factory Phase F1.

### (b) Orchestration (`server/swarm/`, 24 modules, ~14,200 lines)
Present and real: dependency-aware task decomposition and scheduling
(`taskManager.ts`, 816 lines — retry exhaustion and blocked-child
semantics are test-pinned); parallel per-model worker loops over a
shared workspace (`swarmOrchestrator.ts`, 1,792 lines); contract-first
generation (`contractFirstEngine.ts`); code generation and review
engines; collaborative debugging; shared context
(`projectContextEngine.ts`); persistent **project memory**
(`projectMemory.ts`, 1,589 lines — facts, defects, ADRs with conflict
detection, module relationships); shared workspace with merge manager
and file leases (`sharedWorkspaceService.ts`, `mergeManager.ts`);
patch-validation pipeline (`patchValidationPipeline.ts`); browser
runtime verification (`runtimeVerifier.ts`); the honest verification
service (`server/verificationService.ts` — strict `approved: true`
semantics, false-completion prevention is test-pinned); automatic
repair (`automaticRepairEngine.ts`) fed by `server/debugging/`
(root-cause engine, repair coordinator, diagnostic collector, static
checks); approval gates (`approvalGateService.ts`); prompt compilation,
dependency resolution, incremental editing, AI challenge checks.
**Assessment:** the machinery for delegation, shared context, parallel
execution, verification, and failure recovery all exists and is
test-covered per module. What has never been proven is the whole chain
in one gauntlet at platform scale → Factory Phases F2–F4.

### (c) Execution / preview / test / debug / deploy environment
- **Execution:** `server/execution/` — `ExecutionBackend` abstraction
  with a Docker backend and a disabled backend; AGENTS.md invariant
  enforced (project code never runs as a plain host process). Phase 32
  hardened it: TLS-only remote workers that fail closed, gVisor `runsc`
  verified against the daemon before execution is offered, resource
  limits, HMAC-signed preview links bound to preview+session+owner,
  worker health monitoring and orphan sweeps. **CI-proven** against a
  genuine TLS + runsc dockerd (run 45669432584, integration 7/7). No
  Docker daemon exists on this dev VM and no production worker exists.
- **Preview:** `server/swarm/previewGenerator.ts` (1,012 lines) +
  `server/execution/previewSessionService.ts` / `previewProxy.ts`.
- **Testing:** sandbox test execution + `server/testing/
  testCoverageAnalyzer.ts` (Phase 12 — file-level coverage wired into
  verification, with a test-output parsing honesty fix).
- **Debugging:** Phase 11 subsystem (`server/debugging/`, 10 modules).
- **Deployment:** Phase 15 service with **six adapters** (Cloudflare
  Pages, Netlify, Vercel, Docker container, static host, webhook),
  pre-deployment validation, production builder, secret manager, and
  the Phase 33 fix that removed a client-side approval-gate bypass.
  **Implemented and test-proven; not live-proven** — no production URL,
  active deployment, or production database is verified (AGENTS.md says
  the same, and this redesign does not upgrade that claim).

### (d) Large-project support
Project memory persists across builds (facts/defects/ADRs); builds
checkpoint and recover (sandbox-integrity checkpoints in the task flow;
render-job and project journal recovery in the engines); version control
is real — GitHub lifecycle (`server/github/`: connect, branch, PR —
Phase 14) and the IDE's Git service (Phase 22: real git + npm
operations). Standing fragile areas remain as recorded in AGENTS.md:
long-running generation progress reporting, and `db.getFile` /
`db.getAllFiles` returning live objects that must be copied before
being held across an `await`.

### (e) Category coverage and the describe → package path
Engines exist for **every** owner target category except one:
games (`gameEngine` + `scene3d`, Phases 21/24), video editors
(`videoEditor`, Phases 20–31/34/35/37 + Video Editor Roadmap 1–4),
image editors (`imageEditor`, Phases 19/44–60, v1.0.0 release),
desktop + OS tools (`desktop`, `ide`, `release`, Phases 18/22/23/36),
Android/iOS (`android`, `ios`, Phases 17/25/34/35 — CI-proven genuine
builds on both platforms), web/SaaS/API (`application`, `architecture`,
and 11 generation profiles in `server/swarm/generationProfiles.ts`:
website/web app, SaaS, e-commerce, REST API, desktop, Android, CLI,
automation, data processing, game/creative, multimedia).
**The one true gap: photo editing (Lightroom-class)** — no dedicated
engine or workflow exists; the image engine's adjustments are a base,
not a photo workflow. The roadmap (F8) states this instead of papering
over it. **AI applications** have the provider layer but no dedicated
build workflow → F12.
The describe→plan→build→test→package path exists end-to-end per
category (prompt → planner → parallel workers → sandbox verification →
repair → integration → per-category packaging), but has never been run
as **one** unified pipeline across categories → F13.

## What changed in this task
1. **`UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`** (new) — vision and
   principles; the audit summary; disposition of prior roadmaps; and
   Factory Phases **F1–F14** in five arcs (orchestration core F1–F4,
   specialized AI teams F5, universal environment F6, category
   workflows F7–F12, describe-to-delivered + factory release F13–F14).
   Every phase carries objective, in/out scope, dependencies, and
   concrete acceptance criteria written in this repo's evidence style
   (named suites, real builds, artifact inspection, CI runs, recorded
   negative results where a proof is impossible).
2. **`AGENTS.md`** — product-goal section gained the "Universal AI
   Software Factory" direction in the owner's terms; the status table
   gained ONE row for this redesign; the "Later roadmap" section gained
   the tracking entry: *redesign complete 2026-11-27; no Factory phase
   started*. No existing row, phase record, or rule was edited or
   removed.
3. **`FACTORY_REDESIGN_REPORT.md`** (this file).
No code files were modified; no fix was necessary for a documentation
redesign, and none was smuggled in.

## What was preserved
Everything: SquadForge Phases 1–60 and their records stand; the
Graphics Editor Roadmap (44–60) is complete and untouched; the Video
Editor Roadmap's completed Phases 1–4 remain part of the platform's
video capability (its Phases 5–8 stay abandoned per the owner); all
engines, suites, and workflows are exactly as they were.

## Verification (this task)
Platform-relevant subset — 8 suites run locally
(`tests/orchestration.test.ts`, `tests/phase33_ai_reliability_security.test.ts`,
`tests/advanced_engineering_upgrade.test.ts`,
`tests/advanced_engineering_upgrade_v2.test.ts`,
`tests/fullstack_agent_and_concurrency.test.ts`,
`tests/fullstack_execution_and_reliability.test.ts`,
`tests/execution_adapter.test.ts`, `tests/phase1_task_concurrency.test.ts`):
**117 tests — 115 pass, 1 fail, 1 skipped.**
- The 1 failure is the **known pre-existing local-only failure**:
  `tests/orchestration.test.ts:334` "Valid files pass sandbox integrity
  check and create verified checkpoint" — proven identical on the
  pristine base and green in CI; not caused by (and not fixable within)
  a documentation task.
- The 1 skip is the gated live-provider test
  (`LIVE_PROVIDER_TEST=1` not set) — the F1 gap, visible in the run.
- `npm run lint` (tsc --noEmit): **clean**.
- `npm run build` (vite production build): **succeeds**.
The full suite (1,651 tests) was not run — it takes 30+ minutes on this
VM and this task changed no code; the subset above is the
platform-relevant surface.

## Limitations
- The audit is a code-and-docs inspection: maturity claims rest on the
  phases' own acceptance reports plus the suites re-run today. Engine
  internals were verified at the module/API level, not re-proven end
  to end — that is precisely what several Factory phases are for.
- Live-provider status could not be improved from this environment:
  no owner keys were exercised in this task, and prior evidence says
  egress to the Gemini endpoint failed even with a valid credential.
  F1 is written to accept a documented negative result for exactly
  this reason.
- The roadmap's Arc D ordering is a default, not a decision: the owner
  picks which category workflow runs first after F5/F6.
- This redesign is **not pushed** and no Factory phase is started;
  both await the owner's word.
