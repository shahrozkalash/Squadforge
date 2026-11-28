# Factory Phase F13 — Describe → Delivered Unified Pipeline: Progress

**Status: COMPLETE (implemented and verified locally, 2026-11-28). Not yet pushed.**

Roadmap reference: `UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`, Factory Phase
F13. Objective: ONE pipeline entry point takes a plain-language
description and delivers a verified artifact for every major category —
classify → team (F5 data) → the category workflow (F7–F12) → that
category's verification gate → a single uniform delivery record.

## The gap (before F13)

The Arc D category workflows existed as six separate modules, each with
its own plan/build/cycle/gate surface: games (F7), the creative editors
— video, image, photo (F8), web/SaaS/API (F9), mobile (F10),
desktop/CLI (F11), and AI applications (F12). Classification existed
(`SoftwareRequirementsAnalyzer.detectCategory`), teams existed as data
(F5), and every category had an honest gate. What did not exist was a
single entry point that routes a description to the right workflow and
returns one uniform delivery record — a caller had to know which
workflow module to import, how to drive its swarm build, and how to
read its verdict shape. F13 builds exactly that facade and nothing
else: no category logic is reimplemented in the pipeline.

## Design — the facade (`server/factory/`)

- `server/factory/unifiedPipeline.ts` (new) — the whole phase:
  `deliverFromDescription(description, options)`, the
  `FactoryDeliveryRecord` shape, the `UnifiedPipelineError` type, and
  the per-route gate composition. `server/factory/index.ts` re-exports
  it. No existing module was modified.

The flow, step by step:

1. **Classify.** `SoftwareRequirementsAnalyzer.detectCategory` — the
   platform's existing analyzer, the same call the F5 team registry
   makes. The facade adds no classification of its own.
2. **Route.** The facade's only decision: which Arc D workflow serves
   the detected category (`routeForCategory`). A category with no
   workflow fails by name at planning (below) — it is never guessed
   into another category's workflow.
3. **Gate inputs are planning inputs.** Inputs a workflow cannot run
   its gate without — the web route's declared contract
   (`options.webContract`), the AI route's probe contract
   (`options.aiContract`), the photo route's originals supplied
   out-of-band (`options.photoSources`) — are required up front and
   fail by name at planning, not midway through a build.
4. **Plan.** The workflow's own `plan()` resolves the team, profile
   and verifier model from F5 data.
5. **Build.** The pipeline drives the real swarm chain: it creates
   the build, runs `SwarmOrchestrator.startSwarm`, and answers
   approval requests **only** through the caller's
   `approvalResponder` (invariant 1: approval must be real — the
   pipeline never approves on its own; without a responder, held
   tasks stay held and the build ends on its own terms).
6. **Cycle + gate.** The category workflow's F6 environment cycle
   runs, and the facade composes the route's gate from the workflow's
   own gate report — check by check, with no gate logic
   reimplemented. A build that did not complete, or a cycle that
   threw, composes a failed gate with the reason named.
7. **Record.** One uniform `FactoryDeliveryRecord` is persisted on
   the build as a `factory_delivery` event **before** it is returned
   (roadmap F13 criterion 3: a delivery without this record does not
   exist as far as the factory is concerned).

### Routing table

| Detected category | Route | Workflow (phase) |
| :--- | :--- | :--- |
| `game_application` | `game` | `GameWorkflow` (F7) |
| `multimedia_application` + "photo" in the description | `photo-editor` | `PhotoEditorWorkflow` (F8) |
| `multimedia_application` + "video" in the description | `video-editor` | `VideoEditorWorkflow` (F8) |
| `multimedia_application` + "image" in the description | `image-editor` | `ImageEditorWorkflow` (F8) |
| `saas`, `api_service`, `web_application` | `web` | `WebWorkflow` (F9) |
| `android_application`, `cross_platform_mobile` | `mobile` | `MobileWorkflow` (F10) |
| `desktop_application`, `cross_platform_desktop`, `windows_application` | `desktop` | `DesktopWorkflow` (F11) |
| `cli_tool` | `cli` | `CliToolWorkflow` (F11) |
| `ai_application` | `ai` | `AiWorkflow` (F12) |
| anything else | — | `UnifiedPipelineError` (`UNSUPPORTED_CATEGORY`), named at planning |

The one sub-classification the facade performs is inside
`multimedia_application`: the analyzer returns one category for all
three editors (F8's recorded reality — one F5 team serves all three),
so the route is chosen by which editor kind the description names
(photo/video/image). A multimedia description naming none of them
fails by name rather than guessing an editor.

### The uniform delivery record

`FactoryDeliveryRecord` carries: `id` (`dlv_<buildId>`), the original
`description`, the detected `category`, the `workflow` route, the
`teamName` / `profileId` / `verifierModelId` from F5 data, the
`projectId` (the swarm build), the `buildStatus`, the `environment`
the cycle ran in, the composed `gate` (`name`, `passed`, and the
per-check `{ name, passed, detail }` list taken from the category's
own gate report), the `artifact` reference (`name`, `kind`,
`sizeBytes`, `sha256`, `path`), the workflow's own `verified`
verdict, the pipeline `status` (`delivered` | `failed`),
`failureReasons`, human-readable `evidence` lines, honest `labels`,
and timing (`startedAt` / `finishedAt` / `durationMs`).

Status composition is strict: `delivered` requires the workflow
verdict **and** the gate to have passed. If the gate passed but the
workflow verdict was not verified, a failure reason is recorded
saying so; a failed record always carries at least one named reason.

### Honest labels

Every record starts from three base labels — `stub-transport`,
`fixture-content`, `no-live-model` — stating the F1 situation plainly:
the model calls behind a build are served by whatever transport the
caller's environment provides (here, a stub; no live provider exists),
and delivered trees come from the category's established fixture seam.
Routes add their own labels from their gate reports, among them:
game `platform-generator-content`; video `fixture-media`; photo
`originals-supplied-out-of-band`; web `loopback-runtime-gate`; mobile
`no-local-apk` + `apk-is-ci-produced`; desktop `gui-never-run` +
`windows-package-verified-only`; AI `real-gateway-code` +
`stub-provider-round-trips`.

### Planning failures (named, before any build exists)

`UnifiedPipelineError` carries a `code` and, where relevant, the
detected `category`:

- `UNSUPPORTED_CATEGORY` — the analyzer's fallback (`fullstack` for
  gibberish) is named, never guessed into a workflow; likewise a
  multimedia description naming no routable editor kind.
- `MISSING_GATE_INPUT` — the missing option is named (`webContract`,
  `aiContract`, `photoSources`); the pipeline will not invent a
  contract or a set of originals.

Build and gate failures are **not** thrown: they return a record with
`status: 'failed'` and the reasons named — failed validation stays
visible (invariant 5), persisted on the build like any delivery.

## The fixture kit (tests)

`tests/factory_fixture_kit.ts` (new) extracts the established F7–F12
fixture seams — planner actions, per-file content functions, the
patch-aware stub transport installer, the declared contracts, and the
AI stub-provider factory — so the F13 suite drives the single entry
point with the same fixtures the category suites proved. (The phase
suites keep their own copies; the kit is the shared copy for the
pipeline suite.) Generated fixture files are the repository's own
trusted test content (`SQUADFORGE_TRUSTED_HOST_TESTS=1`, the standing
test-gate pattern).

## Verification

- New suite `tests/factory_phase_f13_unified_pipeline.test.ts`:
  **12/12 pass**, run independently by the parent agent (Spark) in
  118.6 s — the nine category deliveries (F13.1–F13.9), the
  planning-stage named failures (F13.10 unclassifiable/unroutable,
  F13.11 missing gate input), and the gate-failing delivery recorded
  as failed (F13.12). Per-category detail is in the acceptance report.
- Light regression at completion: F5 category teams **8/8 pass**.
- `npm run lint` (tsc --noEmit): clean. `npm run build`: succeeds.

Full evidence is in `FACTORY_PHASE_F13_ACCEPTANCE_REPORT.md`.
