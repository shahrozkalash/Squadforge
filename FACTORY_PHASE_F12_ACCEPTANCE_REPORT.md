# Factory Phase F12 — AI Applications Workflow: Acceptance Report

**Date:** 2026-11-28
**Verdict: COMPLETE (implemented and verified locally). Not yet pushed.**
Final acceptance remains the owner's.

Roadmap: `UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`, Factory Phase F12 —
an application that itself uses AI works as a factory workflow, and
when its model provider is unavailable the delivered app fails loudly
with a named error, never fake output.

## What was delivered

**Category data (the audit gap, closed as F5-style data).** No AI-app
category existed anywhere in the platform. Added as data only:
`ai_application` in `CanonicalProjectType` / `CANONICAL_PROJECT_TYPES`
(24 → 25) / `GenerationProfileType` (`server/types.ts`); the
`ai_application` generation profile + profile-matcher branch
(`server/swarm/generationProfiles.ts`); a `detectCategory` rule
(`server/architecture/requirementsAnalyzer.ts`); and the "AI
Application Team" registered through the existing `connected(...)`
helper (`server/swarm/categoryTeams.ts`). F5's one-team-per-category
invariant holds at 25/25. One existing test pin migrated with its
justification written into the test (the F58 precedent):
`universal_architecture_engine.test.ts` 1.1, 24 → 25 canonical
categories. `CAPABILITY_MATRIX.md` tracks models, not categories —
checked, unchanged.

**Workflow** (`server/application/aiWorkflow.ts`, `AiWorkflow`):
plan from F5 team data → real swarm build → F6 web environment
contract cycle (open/build/test/preview/export) → AI gate → verified
delivery. `verifyDelivery` requires platform tests passed with zero
failures **and** a non-empty exported artifact **and** the AI gate.

**AI gate** (`server/application/aiAppGate.ts`,
`probeAiAppBehaviour`), reusing the F9 runtime probe (extended
additively with `extraEnv` and probe response `body`; F9 suite
unaffected at 3/3). The delivered app calls the platform's **real**
gateway code (`server/gateway.ts` → smart router → model registry);
no router is reimplemented anywhere in the fixture or the gate.

## Gate evidence (actual responses, this session)

The delivered fixture is "DocuChat", a chat/Q&A app over a document
set, in the `ai_application` profile's shape; its bridge
(`server/platformAi.ts`) imports the platform gateway module named by
`SQUADFORGE_GATEWAY_MODULE` and calls `callUnifiedGateway` with the
model id from `AI_MODEL_ID`, `allowFallback: false`.

**(a) Non-AI surface.** All 8 declared probes passed in every run:
health, chat page, document list, get one document, missing document
404, add a document 201, chat validation 400, undeclared route 404.
The application's own API contract tests (7, including a
no-provider chat test) passed through the platform test gate with 0
failures; the exported artifact's SHA-256 was re-verified against
the bytes on disk.

**(b) No provider configured — the honesty rule.** With the probe's
scrubbed environment (no provider keys anywhere), `POST /api/chat`
answered:

- Status: **503**
- `errorCode`: **`NO_PROVIDER`** (the router's own code, surfaced
  unchanged through the gateway and the app)
- `error`: `Model "GPT-4o (Project Manager)" requires
  OPENROUTER_API_KEY. Configure key or enable fallback.` — the
  router's verbatim named refusal (F1-pinned), naming both the
  configured model and the missing key
- Fabricated answer: **none** (no `answer` field in the response)

**(c) Stub-transport round trips — model swap with no code change.**
With the router's established test seam (`OPENROUTER_BASE_URL` →
local stub transport, dummy `OPENROUTER_API_KEY`), the same
delivered files were run once per configured model id, changing only
`AI_MODEL_ID`:

| Configured model | HTTP | Answer returned | Model reported by app | Provider |
| :--- | :--- | :--- | :--- | :--- |
| `gpt-4o` | 200 | the stub transport's answer, verbatim | `openai/gpt-4o` | `openrouter` |
| `deepseek` | 200 | the stub transport's answer, verbatim | `deepseek/deepseek-chat` | `openrouter` |

The stub transport's own request log confirms the swap happened
upstream, not in app code: it recorded exactly two calls, in order,
to `/v1/chat/completions` with upstream model ids
`openai/gpt-4o` then `deepseek/deepseek-chat`, each carrying the
injected key's Authorization header. These are **stub-transport**
results — they prove the app → gateway → router → transport path
and the registry-driven model swap; they are not live model output
(F1: no live provider path exists in this environment).

**Negative — the fabricating variant is caught.** A copy of the
fixture whose chat handler skips the gateway and returns a hardcoded
answer was run through the same gate (with the genuine application
as a passing control in the same test): the variant answered **200**
in the no-provider run, the gate flagged the response as a
**fabricated answer**, the no-provider check failed (the named error
is absent), the gate failed overall, and `AiWorkflow.verifyDelivery`
refused the delivery even with green tests and a real artifact
supplied. The absence of the named error is itself the failure —
exactly the roadmap's honesty criterion.

## Test evidence (printed summaries, this session)

| Suite | Result |
| :--- | :--- |
| `tests/factory_phase_f12_ai_apps.test.ts` (new) | **3/3 pass** |
| `tests/factory_phase_f9_web_workflow.test.ts` | 3/3 pass |
| `tests/factory_phase_f1_capability.test.ts` | 5/5 pass |
| `tests/factory_phase_f5_category_teams.test.ts` | 8/8 pass |
| `tests/universal_architecture_engine.test.ts` | 28/28 pass |
| `tests/orchestration.test.ts` | 22/22 pass (F2-fixed test at line 334 green) |
| phase4-family glob (phase4 reliability incl. test 19, phase44–49, video-editor phase 4) | 218/218 pass |
| `npm run lint` (tsc --noEmit) | clean |
| `npm run build` | succeeds |

## Claim table

| Claim | Status |
| :--- | :--- |
| AI-app category/team/profile exist and resolve from data | **Proven** (data test; F5 invariant 25/25) |
| Described AI app builds through the real swarm chain and classifies as `ai_application` | **Proven** (verifier approved, sandbox checks clean, delivered files byte-identical to the fixture) |
| Delivered app's non-AI surface works over real HTTP | **Proven** (8/8 probes; app's own 7 tests green) |
| No provider → named failure, never a fabricated answer | **Proven** (503 + `NO_PROVIDER` + verbatim key-naming error; no `answer` field) |
| Configured model swap changes the provider-side model with no code change | **Proven at stub transport** (two runs, registry upstream ids asserted in app response and in the transport's own request log) |
| Fabricating variant fails the gate and the delivery verdict | **Proven** (negative test with passing control) |
| Live model answers | **Not claimed** — no provider keys exist here (F1 documented negative); Ollama is not running |
| Standalone (non-platform-hosted) AI app deployment | **Not claimed** — the gateway is in-process only; the platform exposes no HTTP completion endpoint (audit finding) |

## Limitations

- **Stub transport only.** Round trips exercise the real router,
  registry, key gate, request shaping and response parsing against a
  local OpenRouter-shaped stub — the Phase 33 seam. Answer *quality*
  of a real model is unproven and unclaimed.
- **Platform-hosted runtime.** The delivered app imports the platform
  gateway in-process via the injected `SQUADFORGE_GATEWAY_MODULE`
  path (the F9 probe's pattern for platform-hosted TypeScript
  projects). A deployment outside the platform would need the
  platform beside it or a future HTTP completion endpoint.
- **Swap scope.** Proven for two OpenRouter-routed registry models
  (`gpt-4o`, `deepseek`). Gemini-routed models need `GEMINI_API_KEY`
  (absent) and are not claimed.
- **"RAG" scope.** The app supplies its documents as prompt context
  (context stuffing over its own document store). No embeddings or
  vector search exist in the app or are claimed.
- **Fixture labelling.** DocuChat is a labelled fixture in the
  profile's exact shape; swarm worker completions used stub
  transport, as throughout the Factory phases (F1 verdict stands).

## Files changed

New: `server/application/aiAppGate.ts`,
`server/application/aiWorkflow.ts`,
`tests/factory_phase_f12_ai_apps.test.ts`,
`FACTORY_PHASE_F12_PROGRESS.md`, this report.
Modified: `server/types.ts`, `server/swarm/generationProfiles.ts`,
`server/swarm/categoryTeams.ts`,
`server/architecture/requirementsAnalyzer.ts`,
`server/application/webRuntimeProbe.ts` (additive: `extraEnv`,
probe `body`), `server/application/index.ts` (exports),
`tests/universal_architecture_engine.test.ts` (one justified pin
migration, 24 → 25), `AGENTS.md` (this phase's single status row).
