# Factory Phase F13 — Describe → Delivered Unified Pipeline: Acceptance Report

**Date:** 2026-11-28
**Verdict: COMPLETE (implemented and verified locally). Not yet pushed.**
Final acceptance remains the owner's.

Roadmap: `UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`, Factory Phase F13 —
one pipeline entry point takes a plain-language description and
delivers a verified artifact for every major category, each passing
its own category gate, with one uniform delivery record per build.

## What was delivered

**The facade** (`server/factory/unifiedPipeline.ts`, re-exported from
`server/factory/index.ts`; no existing module modified):
`deliverFromDescription(description, options)` runs the whole factory
chain — classification by the platform's existing analyzer
(`SoftwareRequirementsAnalyzer.detectCategory`) → routing to the Arc D
workflow for the detected category → team/profile/verifier resolved
from F5 data via the workflow's own `plan()` → a real swarm build
driven by the pipeline (approvals answered only through the caller's
responder; the pipeline never approves on its own) → the category
workflow's F6 environment cycle → the category's own verification
gate, composed check-by-check from the workflow's gate report (no
gate logic reimplemented) → one uniform `FactoryDeliveryRecord`,
persisted on the build as a `factory_delivery` event before it is
returned.

**The uniform record** carries the detected category, the workflow
route, the F5 team name / profile id / verifier model id, the build
id and status, the environment, the composed gate (name, passed, and
every check with its detail), the artifact reference (name, kind,
size, SHA-256, path), the workflow's own verified verdict, the
pipeline status (`delivered` | `failed`), named failure reasons,
evidence lines, honest labels, and timing. `delivered` requires the
workflow verdict **and** the gate; anything less is a persisted
`failed` record with the reasons named.

**Planning failures are named, before any build exists**
(`UnifiedPipelineError`): `UNSUPPORTED_CATEGORY` — an unclassifiable
description (the analyzer's `fullstack` fallback is named, never
guessed into a workflow) and a multimedia description naming none of
the three routable editor kinds; `MISSING_GATE_INPUT` — the web
route's `webContract`, the AI route's `aiContract`, and the photo
route's `photoSources` are required up front and named when absent.

## Per-category delivery evidence (the verified run)

Suite `tests/factory_phase_f13_unified_pipeline.test.ts`, **12/12
pass** in 118.6 s, run independently by the parent agent (Spark).
Every delivered record met the uniform contract asserted by the
suite: correct classification and team, the swarm build classified
identically, every gate check passed, a non-empty artifact carrying
its SHA-256, no failure reasons, the three honest base labels
(`stub-transport`, `fixture-content`, `no-live-model`) present, and
the record persisted on the build.

| Test | Description → category (team / profile) | Category gate | Route-specific evidence |
| :--- | :--- | :--- | :--- |
| F13.1 | 2D platformer → `game_application` (Game Development Team / `game_creative_application`) | Playability — headless execution of the delivered game | Label `platform-generator-content` |
| F13.2 | Video editor → `multimedia_application` (Creative Software Team — Multimedia / `multimedia_application`) | Video export verification — genuine ffmpeg render, ffprobe + decoded frames + audio RMS | Label `fixture-media` |
| F13.3 | Image editor → `multimedia_application` (same team / profile) | Image project verification — engine round trip + operation chain, pixel-exact | — |
| F13.4 | Photo editor → `multimedia_application` (same team / profile) | Photo delivery verification — originals by SHA-256, develop + batch export, originals untouched | Label `originals-supplied-out-of-band` |
| F13.5 | REST API → `api_service` (Backend Engineering Team — API Service / `rest_api_backend`) | Runtime contract probes — the delivered app, started and probed over real HTTP | All **8** declared contract probes ran and passed |
| F13.6 | Android app → `android_application` (Mobile Development Team — Android / `android_mobile_application`) | Android project gate — structure/manifest/Gradle/resources, Kotlin compile, JVM tests, CI build proof | Labels `no-local-apk`, `apk-is-ci-produced` |
| F13.7 | Desktop app → `desktop_application` (Desktop Software Team / `desktop_application`) | Desktop delivery gate — genuine build, persistent smoke runs, ELF artifact, Windows package + tamper check | Evidence includes the smoke-run `LaunchCount sequence 1 → 2`; label `gui-never-run`; the in-run build log shows a genuine dotnet build (ELF-verified apphost) |
| F13.8 | CLI tool → `cli_tool` (Developer Tools Team — CLI / `cli_tool_developer_utility`) | CLI execution gate — the delivered tool, genuinely executed | All **8** execution cases ran and passed |
| F13.9 | AI chat app → `ai_application` (AI Application Team / `ai_application`) | AI behaviour gate — surface probes, no-provider honesty, stub-provider round trips through the real gateway | Both configured models round-tripped (`gpt-4o`, `deepseek`); the stub transport's own log recorded exactly the upstream ids `openai/gpt-4o` and `deepseek/deepseek-chat` — the swap is configuration only; label `real-gateway-code` |

## Negative results

- **F13.10 — unclassifiable and unroutable requests fail by name at
  planning.** A gibberish description is refused with
  `UNSUPPORTED_CATEGORY` naming the analyzer's `fullstack` fallback —
  never guessed into a workflow. A multimedia description naming no
  editor kind ("an audio editor…") is refused with
  `UNSUPPORTED_CATEGORY` for `multimedia_application`, the message
  stating that the description names none of the three routable
  kinds. No build exists in either case.
- **F13.11 — a missing gate input fails by name at planning.** The
  API description without `webContract`, and the photo description
  without `photoSources`, are each refused with
  `MISSING_GATE_INPUT` naming the missing option — the pipeline will
  not invent a contract or a set of originals.
- **F13.12 — a gate-failing delivery is recorded as failed, not
  delivered.** Using the photo gate's designed refusal (F8): the
  build completes and the catalog is genuine, but one supplied
  "original" does not match the SHA-256 the catalog records for it.
  The returned record has `buildStatus: 'completed'`,
  `status: 'failed'`, `verified: false`, `gate.passed: false`; the
  refusing check ("original verified by SHA-256") is named in the
  record, the failure reasons name the photo gate, the artifact
  exists with its SHA-256 (it is the gate, not the export, that
  refused delivery), and the failed record is persisted on the build
  — failed validation stays visible.

## Test evidence (printed summaries)

| Suite | Result |
| :--- | :--- |
| `tests/factory_phase_f13_unified_pipeline.test.ts` (new) | **12/12 pass** (118.6 s; independent run by the parent agent, Spark) |
| `tests/factory_phase_f5_category_teams.test.ts` (light regression) | 8/8 pass |
| `npm run lint` (tsc --noEmit) | clean |
| `npm run build` | succeeds |

## Claim table

| Claim | Status |
| :--- | :--- |
| One entry point delivers every major category from a plain description | **Proven** (F13.1–F13.9: game, video/image/photo editors, web/API, mobile, desktop, CLI, AI app — each through the single pipeline) |
| Each delivery passes its own category gate, composed from the workflow's gate report | **Proven** (every gate check asserted passed per record; gate logic not reimplemented in the facade) |
| Team/profile/verifier come from F5 data for every route | **Proven** (asserted per record; verifier `claude` via the registry) |
| One uniform delivery record per build, persisted before return | **Proven** (the suite reads the `factory_delivery` event back from the build and matches id, status and artifact hash) |
| Unclassifiable/unroutable input fails by name at planning, no build created | **Proven** (F13.10) |
| Missing gate inputs fail by name at planning | **Proven** (F13.11) |
| A gate-failing delivery is recorded as failed, never delivered | **Proven** (F13.12, persisted failed record) |
| Live model generation behind the builds | **Not claimed** — stub transport; no live provider exists in this environment (F1 verdict stands) |
| A locally built mobile APK | **Not claimed** — the APK remains CI-produced (F10 claim split; the record carries `no-local-apk` / `apk-is-ci-produced`) |
| The generated desktop GUI runs | **Not claimed** — genuine build + headless `--smoke` state exercise only (F11; the record carries `gui-never-run`) |

## Limitations

- **Stub transport.** Planner/worker model calls behind every build
  use the established stub seam, and delivered trees come from the
  categories' established fixtures (shared via
  `tests/factory_fixture_kit.ts`). The records say so in their
  labels; no live generation is claimed (F1).
- **Inherited per-category limits stand.** The mobile APK is
  CI-produced, not built on this host (F10); the desktop GUI has
  never run and the Windows package is verified, not executed (F11);
  the AI route's honesty rule is inherited from F12 — with no
  provider key the delivered app answers with the router's named
  refusal, and its round trips are stub-provider results through the
  real gateway code, not live answers.
- **Routing scope.** Only the nine routes above exist. Other
  canonical categories (e.g. `ecommerce`, `data_application`,
  `engineering_application`) have F5 teams but no Arc D workflow, and
  the pipeline refuses them by name rather than approximating them
  with another category's workflow.
- **Approvals are the caller's.** The pipeline answers the swarm's
  approval gate only through the caller-supplied responder; a
  production caller must wire a real approval path, exactly as the
  F7–F12 suites' pumps stood in for the owner in tests.
- **Fixture seam.** The suite's builds run on the repository's
  trusted-fixture test gate; the pipeline itself contains no test
  seams — classification, routing, building, cycling and gating are
  the production modules' own code paths.

## Files changed

New: `server/factory/unifiedPipeline.ts`, `server/factory/index.ts`,
`tests/factory_fixture_kit.ts`,
`tests/factory_phase_f13_unified_pipeline.test.ts`,
`FACTORY_PHASE_F13_PROGRESS.md`, this report.
Modified: `AGENTS.md` (this phase's single status row). No existing
code module was modified.
