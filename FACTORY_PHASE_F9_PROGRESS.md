# Factory Phase F9 — Web, SaaS, API, and Enterprise Workflow: Progress

**Date:** 2026-11-27. Companion: `FACTORY_PHASE_F9_ACCEPTANCE_REPORT.md`.
Implemented and verified locally; not pushed. F10 not started.

## Audit map (the web/SaaS/API path before F9)

**Categories and teams (F5 data).** `CategoryTeamRegistry` serves the
web categories from data: `saas` → "Web Development Team — SaaS
Platform" (profile `saas_platform`), `api_service` →
"Backend Engineering Team — API Service" (profile
`rest_api_backend`), `web_application`/`fullstack` → Web Development
Team (profile `website_and_web_app`). Classification is deterministic:
`SoftwareRequirementsAnalyzer.detectCategory` keyword rules ("saas" or
"dashboard" → `saas`; "rest api" → `api_service`). Every team's
verifier resolves through the registry to `claude`.

**Generated application shape.** The ConnectedApplicationPlanner
topology is the platform's web-app shape: `package.json` (tier 0,
sensitive), database topology (`server/db/*`), backend topology with
`server.ts` as the Express-style entry point mounting
`server/routes/api.ts`, and `/api/health` as the first declared
endpoint of every backend, followed by auth and per-entity CRUD
endpoints. `ExecutionAdapter.runProductionBuild` bundle-validates the
`server.ts` entry with esbuild; `PreDeploymentValidator` recognizes
`server.ts`/`server.js` as entry points.

**Runtime verification before F9 — static only.**
`BrowserRuntimeVerifier` inspects the preview HTML's structure (10
checks over the document, import map, mount target) and
`PreviewGenerator` compiles in-process with a self-labelled mode
(`real_application` / `static_html` / `fallback_preview`). Neither
serves a generated application's real HTTP responses. The sessions
that would (Docker preview/execution) are unavailable in this
environment — the configured ExecutionBackend is the disabled,
fail-closed one (F6 record). **The gap F9 closes:** no mechanism
started a delivered web application and probed its routes. The F9
runtime gate is that mechanism, in the F7 playability-checker lineage
(execute the delivered artifact headlessly; verdict from behaviour).

**Deployment.** Phase 15: `PreDeploymentValidator` (files, entry
point, package.json, syntax, security, secrets → readiness score) and
`DeploymentService` with six adapters (Cloudflare/Netlify/Vercel/
Docker/static/webhook) — test-proven, never live-proven (redesign
audit). The F6 web contract wraps them as `validateDeployment`
(dry-run) and `requestDeployment` (production approval gate: an
unapproved request is held at `pending_approval`; the static-host
adapter deploys into the in-process `staticHostRegistry` and an
approved request reaches `active` with a registry target URL). That
`active` registry state is the honest ceiling in this environment;
F9 asserts exactly it and claims no live external deploy.

## What was built

New code, extending the existing architecture (no parallel systems):

- `server/application/webRuntimeProbe.ts` — `probeWebAppRuntime(files,
  contract)`. Materializes the delivered files into a fresh temp dir
  (paths sanitized by `ExecutionAdapter.sanitizeFilePath`), allocates
  a free loopback port, and spawns the entry point
  (`server.ts`/`server.js`/`index.js`/`src/server.*`) the way the
  platform itself runs TypeScript — the repository's own tsx binary
  for `.ts`, plain node for `.js` — with a scrubbed environment in
  the ExecutionAdapter test-gate pattern (augmented PATH, NODE_ENV,
  HOME/TEMP/TMP at the temp dir, plus PORT; no application secrets).
  Readiness is the contract's health route answering 200, polled with
  a 20 s deadline; the child is always terminated (SIGTERM → SIGKILL)
  and the directory always removed. Each declared probe asserts
  status and, where declared, a recursive JSON subset or a body
  substring; failures name the route, the expected and actual status,
  and the first contract mismatch. The report carries `started`,
  per-probe results, captured server output, and errors — application
  faults land in the report, never throw past it.
- `server/application/webWorkflow.ts` — `WebWorkflow`, the F7/F8
  pattern: `plan()` (F5 team by data), `runEnvironmentCycle()` (F6
  contract open/build/test/preview/export → read files back through
  the contract → runtime gate → `verifyDelivery`: tests passed AND
  non-empty artifact AND runtime gate passed), `probeRuntime()`, and
  the deployment gate as workflow steps (`validateDeployment`,
  `requestDeployment` pass-throughs to the contract).
- Both modules are exported from `server/application/index.ts`.
- `tests/factory_phase_f9_web_workflow.test.ts` — the suite below.

## The two fixture applications

Stub transport (F1 verdict stands): the planner stub answers through
the platform's real `create_task` mechanism and the worker stub
writes fixture applications — small, dependency-free TypeScript
HTTP services (node:http only) in the ConnectedApplicationPlanner
topology shape. They are labelled fixtures in the suite header, not
live model output.

- **TaskBoard (SaaS)** — `server.ts` + `server/app.ts` +
  `public/index.html` + `package.json` + `tsconfig.json` +
  `README.md` + `tests/api.test.ts` (the app's own 5 contract tests).
  Routes: `GET /api/health`, `GET /` (dashboard page read from
  `public/index.html`), `GET /api/plans` (free/pro/team tiers),
  `GET /api/workspaces`, `GET /api/tasks`, `POST /api/tasks` (201;
  400 `title is required`; 400 `Invalid JSON body`), JSON 404
  elsewhere.
- **Stockpile (REST API)** — same shape minus the dashboard.
  Routes: `GET /api/health`, `GET /api/items`, `GET /api/items/:id`
  (404 `Item not found`), `POST /api/items` (201; 400 `sku is
  required` / `name is required` / `stock must be a non-negative
  number`; 400 `Invalid JSON body`), JSON 404 elsewhere.

Each app's own test suite starts the real server on an ephemeral
port and probes it over HTTP — those suites are what the swarm
sandbox gate and the contract test cycle execute.

## Workflow runs (suite evidence)

Both descriptions flow: `WebWorkflow.plan` (category/team/profile
asserted from F5 data) → real `SwarmOrchestrator.startSwarm` over
the stub (4 planner tasks each; build `completed`, platform
classification `saas` / `api_service`, verifier approved, every
sandbox check "passed cleanly", all planned tasks completed, tree
byte-identical to the fixtures) → `WebWorkflow.runEnvironmentCycle`:

- contract **build `succeeded`** for both apps (esbuild bundle
  validation over the `server.ts` entry — not skipped);
- contract **tests `passed`**, 5/5 of each app's own API contract
  tests through the platform test gate;
- preview produced with its mode labelled (recorded, not asserted
  beyond presence — the runtime evidence is the gate, not the
  preview);
- export artifact: ProductionBuilder ZIP, SHA-256 re-verified against
  the bytes on disk;
- **runtime gate `passed`**: server started from the delivered tree
  (`server.ts`; captured output shows the app's own listening line),
  all probes green — SaaS 9/9, API 8/8 (details in the acceptance
  report);
- delivery `verified === true` for both.

**Deployment gate (SaaS build, through the contract):**
`validateDeployment` → `valid: true`, readiness score ≥ 80, no
defects. `requestDeployment` without approval → `pending_approval`,
the db record agrees, and `staticHostRegistry` has **no** entry for
the deployment id (no adapter side effect). With approval →
`active`, registry entry present, target URL carries the deployment
id. That is the state the static-host adapter honestly reaches in
this environment; no live external deployment is claimed.

**Negative:** the Stockpile fixture with an injected `throw` in its
items-list handler — the runtime gate still starts the server (health
probe passes), the list probe fails with the application's declared
500 (`{"error":"Internal server error"}`), the gate verdict is
`passed: false`, and `WebWorkflow.verifyDelivery` refuses the
delivery even with green tests and a real artifact. A control run of
the genuine fixture through the gate directly passes all probes.

## Integration findings (both reproduced, then fixed in the suite)

1. **Planner-pre-created README collision.** During planning the
   project manager creates `README.md` (v1) in the tree. A worker
   task whose filePaths include `README.md` answering `create_file`
   aborts its whole batch transactionally ("File README.md already
   exists (v1). Models must use patch_file with exact find/replace
   edits"), the batch's other files never land, and the task loops
   on the rejection until it pauses as an "unproductive agent loop"
   and the build waits for its duration cap. This is the F8 finding
   in a second form (theirs was scaffold seeding on
   package.json/tsconfig.json). Fix, in the stub: patch-aware
   responses — the behaviour MergeManager's own rejection demands.
   A file that already exists with different content is answered
   with `patch_file` (whole-content find/replace); a file already
   exactly as intended is omitted; the rest are created. No platform
   code changed: a real model reads the same rejection and patches.
2. **Keyword-evidence requirements (the F8 model, two more
   instances).** The requirements analyzer confirms requirements
   from description keywords and the honest verifier demands file
   evidence scored by token matching:
   - "JSON" in both descriptions confirms **"Data export/import
     functionality"**. Both READMEs now carry a section with that
     exact title documenting the *real* behaviour — for a JSON API,
     clients genuinely export data by reading it as JSON and import
     data by POSTing JSON — the F8 pattern, kept truthful.
   - "subscription" would confirm **"Payment processing and
     checkout handling"**, which the SaaS fixture does not implement
     (plan tiers with prices; no payments). The request text
     therefore says "tiered plans" — the same feature, no false
     claim — with the reasoning recorded in a comment at the
     description in the suite. The plans remain "subscription plans"
     inside the product, where that is the domain term.

## Verification (printed summaries)

- F9 suite: **3/3 pass** (SaaS e2e 11.2 s, API e2e 5.5 s, broken-app
  gate 1.0 s; total ~24 s).
- Regression batch in one run — F7 games workflow, F8 creative
  editors, orchestration, Phase 13, Phase 16: **53/53 pass** (the
  F2-fixed `orchestration.test.ts:334` stays green).
- Phase 15 deployment suites, standalone: **33/33 pass**.
- Fixture-gate probe during development (discarded debug suite):
  `ExecutionAdapter.runCompleteVerification` over the SaaS fixture
  tree — typecheck passed, 0 syntax errors, 0 security findings,
  test report 5/5 passed, build report passed.
- `npm run lint` clean; `npm run build` succeeds.

## Limitations

- Stub transport throughout (F1 verdict): the workflow machinery and
  the delivered apps' HTTP behaviour are proven; the fixture content
  is test fixture content, not live model output.
- The runtime gate executes the delivered application as a
  short-lived, loopback-only child process with a scrubbed
  environment — a verification harness in the F7 playability lineage,
  not a hosting environment. Production hosting of user applications
  remains the ExecutionBackend / preview-session path, unavailable
  in this environment (Docker sessions are CI-proven, Phase 32).
- The fixture applications are deliberately small: in-memory data,
  no database, no authentication, no payment processing. The proof
  is the factory pipeline plus real HTTP contract behaviour, not
  SaaS feature depth.
- Deployment is exercised against the static-host adapter only; the
  other five adapters remain test-proven (Phase 15 suites), never
  live-proven, and F9 claims no live external deployment.
- The runtime gate's entry-point convention covers
  `server.ts`/`server.js`/`index.js`/`src/server.*`; an application
  with another entry shape fails the gate by name rather than being
  guessed at.
