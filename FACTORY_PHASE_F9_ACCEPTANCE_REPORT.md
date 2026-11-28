# Factory Phase F9 — Web, SaaS, API, and Enterprise Workflow: Acceptance Report

**Date:** 2026-11-27. **Verdict: F9 criteria met**, with the claim
scoping below recorded plainly. Implemented and verified locally;
not pushed. F10 not started. Companion:
`FACTORY_PHASE_F9_PROGRESS.md` (audit map, workflow wiring,
integration findings).

## What was delivered

The web/SaaS/API categories now work as **workflows** on the factory
machinery, in the F7/F8 pattern:

```
description → WebWorkflow.plan()              (F5 team by data)
            → SwarmOrchestrator build         (F2–F4 chain + gates)
            → WebWorkflow.runEnvironmentCycle() (F6 contract, web)
            → runtime gate                    (real HTTP probes)
            → deployment gate                 (contract, approval-held)
            → verified delivery verdict
```

New code: `server/application/webWorkflow.ts` (the workflow) and
`server/application/webRuntimeProbe.ts` (the runtime gate), exported
from the existing `server/application/index.ts`. No existing code
was modified; no parallel web stack was created. The audit gap F9
closes: before this phase, runtime verification of a generated web
application was static (preview-HTML inspection) — nothing started
the delivered application and served its real HTTP responses in this
environment.

## Criterion-by-criterion verdict (roadmap F9 acceptance criteria)

### 1. One described SaaS-style app and one described REST API each build end-to-end; their generated test suites run green — **MET**

TaskBoard (SaaS) and Stockpile (REST API) each flow from description
to a completed swarm build: team resolved from F5 data (`saas` →
Web Development Team — SaaS Platform, profile `saas_platform`;
`api_service` → Backend Engineering Team — API Service, profile
`rest_api_backend`; verifier `claude` through the registry), the
platform analyzer classifies each build as described (`saas` /
`api_service`), the completion verifier approves, every sandbox
integrity check passes cleanly, and the delivered tree is
byte-identical to the fixture applications. Each app's own API
contract test suite (5 tests that start the real server and probe it
over HTTP) runs green through the platform test gate — inside the
swarm sandbox checks and again in the F6 contract test cycle
(`passed`, 0 failed, ≥ 5 passed for both apps). Label, per the
standing stub rule: the builds ran over the F2–F4 stub transport and
the applications are labelled test fixtures in the
ConnectedApplicationPlanner topology shape — the workflow machinery
is what is proven, not live model generation (F1 verdict).

### 2. The produced app serves real HTTP responses (status + body asserted, not just file existence) — **MET**

The runtime gate starts each delivered application from its built
tree on an ephemeral loopback port and probes its declared contract
over real HTTP. Asserted responses (status + JSON-subset/body):

**TaskBoard (9/9 probes):** `GET /api/health` → 200
`{"status":"ok","service":"taskboard",…}`; `GET /` → 200 dashboard
HTML containing "TaskBoard Dashboard"; `GET /api/plans` → 200 with
plan ids `[free, pro, team]`; `GET /api/workspaces` → 200 with the
seeded workspace; `GET /api/tasks` → 200 with both seeded tasks;
`POST /api/tasks` → 201 with the created task; `POST /api/tasks {}`
→ 400 `{"error":"title is required"}`; `POST /api/tasks` with a
malformed JSON body → 400 `{"error":"Invalid JSON body"}`;
`GET /api/does-not-exist` (undeclared) → 404
`{"error":"Not found"}`.

**Stockpile (8/8 probes):** `GET /api/health` → 200
`{"status":"ok","service":"stockpile"}`; `GET /api/items` → 200
with both seeded items and stock levels; `GET /api/items/item_1` →
200 with the Widget record; `GET /api/items/item_999` → 404
`{"error":"Item not found"}` (the app's declared error behaviour);
`POST /api/items` → 201 with the created item; `POST /api/items`
without a sku → 400 `{"error":"sku is required"}`;
malformed JSON → 400 `{"error":"Invalid JSON body"}`;
`GET /api/unknown` (undeclared) → 404 `{"error":"Not found"}`.

The contract build step also genuinely succeeded for both apps
(esbuild bundle validation over the `server.ts` entry — reported
`succeeded`, not skipped), and each export artifact is a
ProductionBuilder ZIP whose SHA-256 was re-verified against the
bytes on disk.

### 3. A deployment dry-run package is produced and passes the Phase 15 pre-deployment validator — **MET**

For the SaaS build, through the F6 contract: the export artifact
(the deployment package) is produced by ProductionBuilder, and
`validateDeployment` — `PreDeploymentValidator` plus the adapter
credential check — returns `valid: true` with readiness score ≥ 80
and no defects. The workflow then carries deployment to the
approval gate, honestly and no further: an unapproved production
request stays `pending_approval` (db record agrees) and produces
**no adapter side effect** (the deployment id is absent from the
static-host registry); an approved request reaches `active` with a
registry entry and target URL — exactly the state the static-host
adapter reaches in this environment.

### 4. Phase 13/15/16 suites pass; lint and build pass — **MET**

F7 + F8 + orchestration + Phase 13 + Phase 16 in one run: **53/53
pass**. Phase 15 deployment suites standalone: **33/33 pass**. F9
suite: **3/3 pass**. `npm run lint` clean; `npm run build` succeeds.
The F2-fixed tests (`orchestration.test.ts:334`, phase4 test 19
lineage) stay green — no regression.

## Task-brief items beyond the roadmap text

- **Broken app variant fails the runtime gate — MET.** Stockpile
  with an injected throw in its items-list handler: the server still
  starts (health probe passes — the gate discriminates per route),
  the list probe fails with the application's declared 500, the gate
  verdict is failed, and `WebWorkflow.verifyDelivery` refuses the
  delivery even with green tests and a real artifact. A missing
  entry point or a server that never becomes ready likewise fails
  by name in the report (readiness path), never as a fake success.
- **Deployment approval semantics — MET** (see criterion 3):
  unapproved = held + zero side effects; approved = the adapter's
  real terminal state here, claimed as nothing more.

## Claim table

| Claim | Verdict |
| :--- | :--- |
| Described SaaS app → running, contract-verified application through the workflow | **Proven** (stub transport; fixture app labelled) |
| Described REST API → running, contract-verified API through the workflow | **Proven** (stub transport; fixture app labelled) |
| Deployment dry-run passes the Phase 15 validator | **Proven** |
| Deployment approval gate holds unapproved requests with no side effects | **Proven** |
| Live external deployment (any of the 6 adapters) | **Not claimed** — approved requests reach the static host's in-platform registry state (`active`); the adapters remain test-proven, never live-proven |
| Preview as runtime evidence | **Not claimed** — the cycle records the PreviewGenerator mode; the runtime evidence is the gate's real HTTP probes |

## Limitations

Stub transport throughout (F1 verdict stands — no live generation
claimed). The runtime gate is a verification harness: it executes
the delivered application as a short-lived, loopback-only child
process with a scrubbed environment, in the F7 playability lineage;
production hosting remains the ExecutionBackend / preview-session
path (unavailable in this environment). The fixture applications
are deliberately small (in-memory data, no database, no auth, no
payment processing) — the proof is the pipeline and the HTTP
contract behaviour. Deployment is exercised on the static-host
adapter only. Two verifier-model interactions found during the
phase (planner-pre-created README collision; keyword-evidence
requirements) were resolved in the suite with truthful content and
wording, and are documented with their reasoning in the progress
doc — no platform code was changed for them.
