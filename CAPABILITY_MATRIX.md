# SquadForge Capability Matrix

Established by **Factory Phase F1** (2026-11-27, AI Models section)
and published in full by **Factory Phase F14** (2026-11-28). This is
the standing record of what the platform is *proven* to do — per
model, per category workflow, and for the factory machinery itself.
Every claim below carries its proof (suite name and headline
evidence, in this repo). A capability is `callable`/`proven` only
with a recorded run behind it; routing over transport stubs proves
the adapter and the machinery, never the model. Update this file
only with run evidence (suite name, date, verbatim result) — never
on the strength of a registry entry or a generator's existence.

**Reading rule for the whole matrix:** all Factory workflow proofs
(F2–F13) ran over the platform's stub transport, because no live
provider exists in this environment (F1, documented negative,
below). "Proven" therefore means: the machinery — classification,
team resolution, orchestration, gates, environment cycles, delivery
verdicts — did what the claim says, with the category's own
verification gate passing on real artifacts. It never means a live
model generated the content.

---

## 1. AI Models

Established by **Factory Phase F1** (2026-11-27). This is the standing
record of what the platform's model layer is *proven* to do, per model.
A model is `callable` only with a recorded successful live generation
behind it; routing over transport stubs proves the adapter, never the
model. Update this file only with run evidence (suite name, date,
verbatim result) — never on the strength of a registry entry.

### Environment of record for the F1 baseline

- Repo `.env`: **absent**. Process env: `GEMINI_API_KEY` **absent**,
  `OPENROUTER_API_KEY` **absent** (the only two provider keys the code
  reads — `server/gateway.ts`, `server/smartRouter.ts`). No `.env.local`
  or `server/.env` exists. Keys were inventoried by presence only.
- Local model server (Ollama, 127.0.0.1:11434): **not running** in this
  environment on 2026-11-27 (connection failed, HTTP 000).
- Genuine attempts on 2026-11-27 went through SquadForge's own
  `smartRouter.executeSmartRequest` (scratch driver, deleted after use).

### The matrix (verified 2026-11-27)

| Model (registry id) | Upstream id | Transport | Agent role | Routing-proven (stubs) | Live-proven | Classification |
|---|---|---|---|---|---|---|
| gpt-4o | openai/gpt-4o | OpenRouter | project_manager | yes (Phase 33) | no | registered-unproven |
| claude | anthropic/claude-3.5-sonnet | OpenRouter | software_architect | yes (Phase 33) | no | registered-unproven |
| llama | meta-llama/llama-3.3-70b-instruct | OpenRouter | frontend_developer | yes (Phase 33) | no | registered-unproven |
| mistral | mistralai/mistral-large-2407 | OpenRouter | backend_developer | yes (Phase 33) | no | registered-unproven |
| nemotron | nvidia/llama-3.1-nemotron-70b-instruct | OpenRouter | database_specialist | yes (Phase 33) | no | registered-unproven |
| gemini | google/gemini-3.8-flash | Gemini (native) | integration_specialist | yes (Phase 33) | no | registered-unproven |
| deepseek | deepseek/deepseek-chat | OpenRouter | qa_testing_specialist | yes (Phase 33) | no | registered-unproven |
| qwen | qwen/qwen-2.5-coder-32b-instruct | OpenRouter | debugging_specialist | yes (Phase 33) | no | registered-unproven |
| grok | x-ai/grok-2 | OpenRouter | security_specialist | yes (Phase 33) | no | registered-unproven |
| codex | openai/gpt-4o-mini | OpenRouter | devops_release_specialist | yes (Phase 33) | no | registered-unproven |
| gemini-fullstack | google/gemini-2.5-flash | Gemini (native) | fullstack_developer | yes (Phase 33) | no | **broken** (see note 1) |
| claude-uiux | anthropic/claude-3.5-sonnet | OpenRouter | ui_ux_designer | yes (Phase 33) | no | registered-unproven |
| deepseek-perf | deepseek/deepseek-chat | OpenRouter | performance_engineer | yes (Phase 33) | no | registered-unproven |
| mistral-docs | mistralai/mistral-large | OpenRouter | documentation_engineer | yes (Phase 33) | no | registered-unproven |
| local (dynamic, Ollama) | owner-configured | Local (Ollama) | — | yes (Phase 11) | **yes — Phase 11 record** | callable (historical; no server running in the F1 environment) |

### F1 attempt log (2026-11-27, verbatim)

Through `smartRouter.executeSmartRequest`, debugging-style prompt,
`bypassCache`:

- `gemini-fullstack` (Gemini native): `success=false`,
  `providerUsed="none"`, 23 ms —
  `Model "Gemini 2.5 (Fullstack Dev)" requires GEMINI_API_KEY. Configure key or enable fallback.`
- `gpt-4o` (OpenRouter): `success=false`, `providerUsed="none"`, ~0 ms —
  `Model "GPT-4o (Project Manager)" requires OPENROUTER_API_KEY. Configure key or enable fallback.`
- Gated suite (`LIVE_PROVIDER_TEST=1`, no key present):
  `live cloud provider: debugging-style Gemini call` **skipped** —
  "Set LIVE_PROVIDER_TEST=1 with a real GEMINI_API_KEY to run the genuine cloud check"
  (rest of the Phase 33 suite: 14 pass / 0 fail).

Both cloud transports refuse by name at the key gate before any HTTP
call is attempted — the router never fabricates a result. That honesty
contract is pinned by `tests/factory_phase_f1_capability.test.ts`.

### Notes

1. **gemini-fullstack is classified `broken`** on Phase 33's genuine
   evidence: through the owner's connected Google AI Studio credential,
   Google returned a real **404** for `gemini-2.5-flash` — the model
   "is no longer available to new users" — and recommended
   `models/gemini-3.8-flash`. The same attempts proved the API path and
   credential authenticate (a real **503 UNAVAILABLE** "high demand" on
   the default model) and that `gemini-3.8-flash` is a real current
   model; two attempts on it died on read timeouts through this VM's
   egress (~5.5 and ~7 minutes). Recommended fix (not applied in F1 —
   it cannot be verified without a key in this environment, and the
   owner's account may retain access): point `gemini-fullstack`'s
   `providerModel` at `google/gemini-3.8-flash` and re-run the gated
   live test.
2. **Role aliases:** AGENT_SPECS defines 17 roles; 14 match a registry
   entry's `agentRole`. Three are aliases — `database_engineer`,
   `integration_engineer`, `qa_engineer` — whose `assignedModelId`
   resolves (nemotron / gemini / deepseek). At F1 time
   `modelRegistry.getByRole()` could not resolve them. **Resolved in
   Factory Phase F5 (2026-11-27):** `AGENT_ROLE_ALIASES` now declares
   the mapping to the canonical specialist roles
   (`database_specialist`, `integration_specialist`,
   `qa_testing_specialist`) and `getByRole()` canonicalizes through
   it, so all 17 roles resolve; the alias set remains pinned by name
   in the F1 suite (updated) and the F5 suite. F5 also aligned three
   `AGENT_SPECS.assignedModelId` values that disagreed with the
   registry binding (`ui_ux_designer` → claude-uiux,
   `performance_engineer` → deepseek-perf, `documentation_engineer`
   → mistral-docs), so for every role `getByRole(role).id` equals the
   role's assigned model. See `FACTORY_PHASE_F5_ACCEPTANCE_REPORT.md`.
3. **What would make a model `callable`:** the owner's key present in
   the server environment, then the gated live test
   (`LIVE_PROVIDER_TEST=1`) passing for the Gemini path, or an
   equivalent gated run for OpenRouter, with the raw result recorded
   in the closing phase's acceptance report.

---

## 2. Category workflows (published by F14, 2026-11-28)

Every category below has its team defined as data (F5,
`server/swarm/categoryTeams.ts`; 25 categories after F12 added
`ai_application`) — one team per category, every member resolving to
a registered model, proven by
`tests/factory_phase_f5_category_teams.test.ts` (8/8, incl. a
full-swarm replaceability run: swapping `software_architect`
claude → gpt-4o in data only changed every verifier call, graph
unchanged). The categories in this table additionally have a
**workflow**: description → team → swarm build → environment cycle →
category verification gate → delivery verdict. All workflow proofs
ran over the stub transport (see the reading rule above); content
came from the platform's own generators/fixtures, labelled as such
in every suite and delivery record.

| Category | Workflow | Status | Proof (suite + headline evidence) | Explicitly NOT claimed |
|---|---|---|---|---|
| `game_application` (games) | F7 | **Proven** | `tests/factory_phase_f7_games_workflow.test.ts` (4/4): described 2D platformer delivered; shipped `game.js` executed headlessly in a `node:vm` context — 412 steps, 0 runtime errors, coin collected, deterministic replay; injected runtime error → delivery refused. 3D: project generation + OBJ/glTF exports structurally parsed (Phase 21 style). Multiplayer: two clients, shared-tick scoreboard deep-equal, teleport cheat rejected | 3D game *played* in the workflow; shared-world co-op (Phase 24 is instanced sessions + scoreboard); live model generation |
| `multimedia_application` — video editor | F8 | **Proven** | `tests/factory_phase_f8_creative_editors.test.ts` (4/4): delivered project rendered by the platform's genuine `exportVideo`; ffprobe h264 320×240, duration 3.5 s ±0.35, audio stream; decoded frames confirm clip colour, title pixels, real crossfade blend; audio RMS > −45 dB | The generated ClipForge GUI running; live model generation |
| `multimedia_application` — image editor | F8 | **Proven** | Same F8 suite: serialize → deserialize → composite round trip byte-identical; operation chain (brightness +20 → saturation 0.5) produces the hand-computed pixel (255, 108, 33); non-target layer untouched | A new genuine compile of the PixelForge app in F8 (compile evidence stands from Graphics Phases 56–60) |
| `multimedia_application` — photo editor (Lightroom-class base) | F8 | **Proven at base level** | Same F8 suite: catalog with SHA-256-pinned originals; non-destructive develop settings as data; +1 EV → mean luminance ×1.85; temperature +40 → R/B ratio ×1.27; saturation −100 → channel spread ≤ 1; settings round-trip byte-identical; originals hash-identical after delivery | Camera RAW (refused by name); local adjustments, lens correction, noise reduction; gamma-linear processing. Formats: PNG/JPEG/BMP/TIFF only |
| `saas` (web / SaaS) | F9 | **Proven** | `tests/factory_phase_f9_web_workflow.test.ts` (3/3): TaskBoard built end-to-end, started on a loopback port, **9/9 real HTTP contract probes** pass (health, dashboard, plans, workspaces, tasks, create 201, validation 400, malformed-JSON 400, undeclared 404); deployment dry-run passes the Phase 15 validator (readiness ≥ 80) | Live external deployment on any adapter (see §4); preview as runtime evidence |
| `api_service` (REST API) | F9 | **Proven** | Same F9 suite: Stockpile API, **8/8 real HTTP probes** pass incl. declared 404/400 error behaviour; a variant with a throwing route fails the runtime gate per-route and is refused delivery | Live external deployment; database/auth/payments in the fixture apps (deliberately small: in-memory data) |
| `android_application` (mobile) | F10 | **Proven locally; APK is CI-produced** | `tests/factory_phase_f10_mobile_workflow.test.ts` (3/3): delivered ClipForge project passes structure/manifest/Gradle/resource consistency; genuine Kotlin compile of the JVM-pure subset (8 sources); the app's own JVM tests executed — 19 run, 18 passed, 1 environment-limited (SDK-stub org.json, named, never counted as a pass). CI build-proof path emitted as 8 named checkable artifacts (Phase 34 workflow: nonzero `apkBytes`, apksigner pass, SHA-256 recorded; Phase 37 run #17: 11/11 EXPORT_VERIFY, APK 12,605,071 B) | An APK built on this host (the Gradle daemon cannot run here — Java outbound TCP is intercepted); Kotlin compile of Compose/Media3 sources (CI-proven only) |
| iOS (no category — see §4) | F10 (gate only) | **Partial — structural gate only** | Same F10 suite: generated FitTrack project passes the platform's structural validator (0 errors); local build honestly recorded `environment-unavailable`; CI proof path pinned as 5 named checks (Phase 25 run #5: 72,232 B Mach-O universal .app) | An iOS team/swarm build (no iOS category exists in F5 data); IPA; signing — never claimed |
| `desktop_application` (desktop + Windows package) | F11 | **Proven** | `tests/factory_phase_f11_desktop_tools.test.ts` (3/3): Linux Avalonia app genuinely built via `dotnet` (ELF-verified apphost, SHA-256 matches disk); two `--smoke` runs with persisted LaunchCount 1 → 2; Windows variant genuinely published, PE-verified, SHA-256-manifested, package validation passes incl. tamper rejection; signing `not-requested` | The generated GUI running/rendering (no display); the Windows exe executing (cannot run on this host); macOS delivery (generator rejects it by name); desktop signing/installers |
| `cli_tool` (OS / developer tools) | F11 | **Proven** | Same F11 suite: delivered `logsum` CLI genuinely executed in a scratch dir — 8/8 execution cases (exact level counts on fixture input, `--out` JSON report file created and count-matched, `init`, `--help`/`--version`); error cases exit 1 with readable messages, no stack traces | Platform-generated CLI content (no deterministic CLI generator exists — the tool is a labelled fixture in the Phase 9 profile's exact shape) |
| `ai_application` (AI apps) | F12 | **Proven (honesty rule incl.)** | `tests/factory_phase_f12_ai_apps.test.ts` (3/3): category/team/profile added as F5-style data (F5 invariant 25/25); DocuChat app calls the platform's **real** gateway; non-AI surface 8/8 HTTP probes; with no provider key, `POST /api/chat` → **503 `NO_PROVIDER`** with the router's verbatim key-naming error and **no answer field**; config-only model swap (gpt-4o → deepseek) round-trips through the stub transport, confirmed in the stub's own upstream request log; a fabricating variant is caught and refused | Live model answers; standalone (non-platform-hosted) deployment — the gateway is in-process only, no HTTP completion endpoint exists; embeddings/vector search ("RAG" is document context stuffing) |
| **Unified pipeline** (all routes above) | F13 | **Proven** | `tests/factory_phase_f13_unified_pipeline.test.ts` (12/12): one entry point, `deliverFromDescription`, delivers game, video/image/photo editors, REST API, Android, desktop, CLI and AI app from plain descriptions — each record asserted against the uniform contract (classification/team identical to the build's, every gate check passed, non-empty artifact with SHA-256, record persisted as a `factory_delivery` event). Negatives: unclassifiable/unroutable refused by name at planning (`UNSUPPORTED_CATEGORY`); missing gate inputs refused by name (`MISSING_GATE_INPUT`); a gate-failing delivery persisted as `failed`, never delivered | Routing for categories with teams but no workflow (refused by name — see below); a locally built APK; the desktop GUI running |

**Categories with F5 teams but no workflow** (teams resolve and are
proven as data by the F5 suite; the F13 pipeline refuses them by
name rather than approximating them with another category's
workflow): `landing_page`, `portfolio`, `blog`, `web_application`,
`fullstack`, `custom`, `ecommerce`, `backend_service`,
`windows_application`, `cross_platform_desktop`,
`cross_platform_mobile`, `developer_tool`, `automation_tool`,
`data_application`, `engineering_application`,
`creative_application`, `3d_application`. Stated plainly, as in F5:
member sets are identical for 23 of the original 24 categories —
that is what the platform assembles today; what differs per
category in the data is team identity and generation profile.

---

## 3. Factory machinery proofs

| Machinery | Proof | Scope of the proof |
|---|---|---|
| Delegation & parallel execution chain (F2) | `tests/factory_phase_f2_gauntlet.test.ts` (5/5): dependency ordering asserted from the task log over the seeded graph; parallelism proven deterministically (rendezvous barrier, ≥2 in-flight calls, ≥2 distinct models); cancellation aborts in-flight calls (build ends `stopped`, nothing completes after); a failing worker's task is released, retried and the build completes; final tree SHA-256 matches the expected merge | Mechanics over the stub transport and the application-plan seed graph; the fallback fan-out graph is covered per-module by existing suites |
| Shared context & memory: kill-and-resume (F3) | `tests/factory_phase_f3_memory_resume.test.ts` (5/5): a build hard-killed mid-run (≥2 tasks complete, checkpoint recorded, tasks in flight under live leases) resumes from persisted state alone via `resumeSwarm` and completes; final tree deep-equal (paths, contents, versions) to an uninterrupted control run; pre-kill facts/ADRs asserted present in post-resume worker context and prompts; 24 parallel writers, no lost or torn memory writes | Kill simulated in-process (caches discarded, store reloaded through the genuine `loadFromSqlite` path); one kill point proven — planner-phase and verification-phase kills not covered |
| Verification & repair: zero false completions (F4) | `tests/factory_phase_f4_verification_repair.test.ts` (11/11): 10 fault-injected builds + 1 engine probe against a deliberately lenient (approve-everything) verifier — syntax errors, TS type errors, secrets, `eval()`, failing tests, import crashes, broken import graphs all detected → repaired → re-verified → completed; malformed output and verifier-bait end `failed` with the defect named; retry bounds asserted exactly (9 calls = 3 attempts × 3 claims) | Exactly: the stub transport, the seeded application-plan graph, and the fault classes in the F4 table. Not a claim about live models, other project shapes, or defect classes the platform does not claim to detect (secret detection is pattern-based; a generic hardcoded password is outside the claimed class) |
| One environment contract (F6) | `tests/factory_phase_f6_environment_contract.test.ts` (10/10): one 12-operation `FactoryEnvironment` contract, two adapters (web/store-backed, desktop/workspace-backed); one lifecycle driver runs both — byte-identical file round-trips, real builds (esbuild validation; genuine `dotnet` build with ELF-verified apphost), pass **and** fail test cycles, exports with SHA-256, deployment dry-runs; approval gate asserted end-to-end (unapproved → `pending_approval`, zero adapter side effects); sandbox-only invariant asserted (DisabledBackend refuses by name; a side-effecting fixture test is an honest skip, marker never written); unsupported operations throw named `EnvironmentOperationUnsupportedError` | Desktop test cycle is compile + `--smoke` by design (generated projects ship no test suite; the `mode` field states it); desktop preview and desktop deployment requests are named-unsupported |

---

## 4. Known gaps (published, none hidden)

1. **No live cloud generation has ever been proven** (F1). No
   provider keys exist in this environment; both cloud transports
   refuse by name at the key gate. The single documented unblock:
   the owner places a real key in the server environment and the
   gated live test is re-run. Until then every workflow proof in
   this matrix is machinery-over-stub-transport, labelled as such.
2. **`gemini-fullstack` is broken** (F1 note 1): its upstream
   `gemini-2.5-flash` was retired by Google (verbatim 404 on
   record). The one-line fix (`providerModel` →
   `google/gemini-3.8-flash`) is recorded and deliberately unapplied
   until it can be verified live.
3. **No iOS category/team exists in F5 data** (F10 audit finding,
   pinned in the F10 suite). `CanonicalProjectType` has
   `android_application` and `cross_platform_mobile` (→ Android
   profile) only; the iOS path is a structural gate over generated
   projects, not a team build. Adding an iOS team is an F5-data
   change for a later phase or the owner's call.
4. **Linux desktop targets have no server-side packaging adapter**
   (F6): the Phase 23 release packager hardcodes `-r win-x64`. The
   F6 contract surfaces this in the deployment dry-run result
   instead of hiding it; a Linux packaging adapter is new scope.
5. **Live deployment has never been proven** (F9): the six
   deployment adapters are test-proven only. An approved request
   reaches the static-host adapter's in-platform registry state
   (`active` with a target URL) — claimed as exactly that, never as
   a live external deploy.
6. **Dependents of a permanently failed task stay `pending`** (F2,
   re-verified by F4): the task itself is flagged `failed`
   immediately with the defect named, but the build's terminal
   `failed` transition waits for the duration cap instead of
   failing fast. Build-level fail-fast is a scheduling-policy change,
   documented and deliberately not bundled into F2/F4.
7. **TS18003 is excluded from the sandbox type gate** (F4): "No
   inputs were found" is a tree-stage statement (the normal state
   before the first TS file lands), not a file defect; the honest
   verdict treats no-TypeScript as skipped, not failed. All other
   type diagnostics gate the build.
8. **`SandboxRunner` does not consume the adapter's `configErrors`**
   (F4 observation): package/tsconfig shape results remain advisory
   in the sandbox and are enforced in the honest verification
   report; the JSON-syntax subset is gated via `validateSyntax`. No
   false completion resulted in the F4 audit.
9. **Further standing limits, each recorded in its phase report:**
   automatic mid-build checkpoints follow a patch-count cadence, so
   create-only stretches get none (F3); failing-test repair
   attribution is first-test-file when a project has several test
   files and no `tests/engine.test.ts` (F4); two text classifiers
   (architecture analyzer vs Phase 9 keyword matcher) diverge on
   some edge phrasings — team selection follows the analyzer (F5);
   `3d_application`/`creative_application` map to the game profile
   and `engineering_application` to the data-processing profile —
   no dedicated profiles exist (F5); the F10 Android gate has one
   environment-limited JVM test on this host (SDK-stub org.json);
   the F12 gateway is in-process only — no HTTP completion endpoint
   exists for standalone AI apps.
