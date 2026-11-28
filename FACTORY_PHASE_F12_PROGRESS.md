# Factory Phase F12 — AI Applications Workflow: Progress

**Status: COMPLETE (implemented and verified locally, 2026-11-28). Not yet pushed.**

Roadmap reference: `UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`, Factory Phase
F12. Objective: an application that itself uses AI — a chat/Q&A app over
the platform's own gateway — works as a factory workflow, under the
defining honesty rule: when its model provider is unavailable, the
delivered app fails loudly with a named error and never emits fake
output.

## Audit (before any change)

**What an "AI app" means in this platform's terms.** The platform's
model layer is the unified gateway (`server/gateway.ts`,
`callUnifiedGateway`) over the smart router
(`server/swarm/smartRouter.ts` → `executeSmartRequest`): the caller
names a registry model id, the router resolves it through
`server/modelRegistry.ts` to a provider + upstream model id, enforces
the provider key gate, and calls the provider transport. Factory
Phase F1 pinned the gate's behaviour: with no key configured the
router refuses by name (`success=false`, `errorCode='NO_PROVIDER'`,
`error='Model "GPT-4o (Project Manager)" requires OPENROUTER_API_KEY.
Configure key or enable fallback.'`, `providerUsed='none'`) and never
fabricates a completion.

**How a delivered app can call the router at runtime.** The gateway is
an in-process API only — the platform exposes no HTTP completion
endpoint (the REST surface covers projects, builds, models and swarm
control; platform subsystems such as the debug team, the code
generation engine and the swarm itself import the gateway in-process).
Generated projects in this factory are platform-hosted TypeScript
projects executed by the repo's tsx (the F9 runtime-probe pattern), so
the smallest real runtime shape is: the delivered app imports the
platform gateway module in-process. The F12 fixture does exactly that
through an injected module path (`SQUADFORGE_GATEWAY_MODULE`), the
same way the F9 probe injects `PORT`. A standalone deployment of such
an app would need the platform beside it (or a future HTTP completion
endpoint); that is recorded as a limitation, not papered over.

**Templates/profiles.** None existed for AI applications: no chat,
Q&A/RAG, or summarizer profile or template anywhere in
`server/swarm/generationProfiles.ts`, the requirements analyzer, or
the swarm. The F8 photo engine closed category gap #1; this was gap
#2, confirmed by direct search.

**F5 category/team situation.** `ai_application` did **not** exist:
not in `CanonicalProjectType` (24 types), not in
`CANONICAL_PROJECT_TYPES`, not in `GenerationProfileType`, no team in
`server/swarm/categoryTeams.ts`, no `detectCategory` rule, no profile
matcher branch. Per the phase brief, adding the category + team as
F5-style **data** was in scope; it is documented as such below.

**The established transport seam.** Phase 33's suite established the
router's test seam: `OPENROUTER_BASE_URL` is read at call time
(`server/providerReliability.ts`), so a dummy `OPENROUTER_API_KEY`
plus a local stub HTTP server returning OpenRouter-shaped JSON drives
the real router end to end. F12 reuses that seam at the app boundary —
the delivered app's own code path (HTTP request → app handler →
gateway → router → transport) is exercised unmodified.

## Data added (F5-style, no engine changes)

- `server/types.ts`: `'ai_application'` added to the
  `CanonicalProjectType` union, to `CANONICAL_PROJECT_TYPES` (now 25),
  and to the `GenerationProfileType` union.
- `server/swarm/generationProfiles.ts`: the `ai_application`
  generation profile ("AI Applications", category `AI`): file
  organization (`server.ts`, `server/app.ts`, `server/platformAi.ts`,
  `public/index.html`, `tests/api.test.ts`), contracts
  (`AiAnswer`, `AiProviderError`, `ChatRequest`), conventions including
  "AI features call the platform AI gateway … never fabricates an
  answer", and a limitation notice citing `CAPABILITY_MATRIX.md`. The
  profile matcher gained a branch for chatbot / ai chat / ai assistant
  / ai application / conversational ai / llm app / ai-powered chat,
  placed **before** the Automation branch (whose bare `bot` substring
  would otherwise capture "chatbot").
- `server/architecture/requirementsAnalyzer.ts`: a `detectCategory`
  rule mapping chatbot/ai chat/ai assistant/ai application/ai app/ai
  companion/ai tutor/conversational ai/llm to `ai_application`,
  placed before the CLI/Automation rules for the same reason.
- `server/swarm/categoryTeams.ts`: `ai_application` registered via
  the existing `connected(...)` helper as the "AI Application Team"
  on the `ai_application` profile — members and verifier resolve
  through the model registry at plan time, exactly like every other
  category. F5's invariant (exactly one team per canonical category)
  is preserved: 25 categories, 25 teams.

One existing test pin was migrated, with the justification written
into the test itself (the F58/Phase 50 precedent):
`tests/universal_architecture_engine.test.ts` test 1.1 asserted
exactly 24 canonical categories; it now asserts 25 and is renamed
"Recognizes all 25 canonical project categories". No other existing
test was touched.

`CAPABILITY_MATRIX.md` tracks per-model provider truth, not
categories — checked, left unchanged.

## Implementation

- `server/application/aiAppGate.ts` (new) — `probeAiAppBehaviour`:
  starts the delivered app through the F9 runtime probe and asserts
  the AI behaviour contract in up to three runs:
  1. **No provider configured** (the probe's environment scrub already
     removes every provider key): all declared surface probes must
     pass, and the chat probe must answer **503** with a JSON body
     carrying `errorCode: 'NO_PROVIDER'` and text naming the missing
     key (`OPENROUTER_API_KEY`). A non-empty `answer` field in that
     response is recorded as a **fabricated answer** and fails the
     run on its own.
  2+. **One stub run per configured model id**: the probe injects
  `OPENROUTER_API_KEY` (dummy), `OPENROUTER_BASE_URL` (the caller's
  stub transport) and `AI_MODEL_ID` (the configured model). The chat
  probe must answer 200 with a non-empty answer, and the model the
  app reports must equal the registry's upstream id for the
  configured model — proving the swap took effect through the real
  router, not through app code.
  The gate passes only when run 1 and every stub run pass.
- `server/application/aiWorkflow.ts` (new) — `AiWorkflow`, the
  F7/F9/F10/F11 shape: `plan()` (F5 team data + registry resolution),
  `verifyDelivery()` (verified = platform tests passed with zero
  failures **and** a non-empty exported artifact **and**
  `aiGate.passed`), and `runEnvironmentCycle()` (F6 web contract:
  open → build → test → preview → export, then read the delivered
  files back through the contract and apply the AI gate). Also
  exports `platformGatewayModulePath()`, which resolves the real
  `server/gateway.ts` the delivered app must call.
- `server/application/webRuntimeProbe.ts` (additive only) —
  `WebAppContract.extraEnv` (caller-supplied environment merged over
  the scrubbed child env; the allocated `PORT` always wins) and
  `WebRouteProbeResult.body` (response body, truncated to 2,000
  chars) so gates can assert on response content. The F9 suite passes
  unchanged (3/3).
- `server/application/index.ts` — exports for the two new modules.

## The fixture application (labelled)

"DocuChat" — a chat/Q&A application over a small document set, in the
`ai_application` profile's exact shape. `server/platformAi.ts` is the
bridge: it dynamically imports the platform gateway module named by
`SQUADFORGE_GATEWAY_MODULE` and calls `callUnifiedGateway` with the
model id from `AI_MODEL_ID` (default `gpt-4o`), `allowFallback:false`
(the configured model is the model that answers — a silent fallback
would make the swap assertion meaningless), `allowReportOnly:true`,
and the app's documents as prompt context. On gateway failure it
returns the router's error and error code unchanged; the app answers
**503** with `{ error, errorCode, model }`. On success it answers 200
with `{ answer, model, provider }` taken from the gateway result.
The non-AI surface: health, the chat page, and a documents JSON API
(list/get/add with validation and 404s). The application's own test
file includes a test that starts the server with no provider
configured and asserts the chat endpoint fails loudly and fabricates
nothing. In the swarm build, worker completions use stub transport
(the F1 situation); the application content is this labelled fixture.

## Verification (this session, printed summaries)

- New suite `tests/factory_phase_f12_ai_apps.test.ts`: **3/3**
  (data resolution; end-to-end workflow; fabricating-variant
  negative).
- Regression: F9 web workflow **3/3**; F1 capability **5/5**; F5
  category teams **8/8**; universal architecture engine **28/28**;
  orchestration **22/22** (the F2-fixed test at line 334 stays
  green); phase4-family glob (phase4 production reliability incl.
  test 19, phase44–49, video editor phase 4) **218/218**.
- `npm run lint` (tsc --noEmit): clean. `npm run build`: succeeds.

Full evidence is in `FACTORY_PHASE_F12_ACCEPTANCE_REPORT.md`.
