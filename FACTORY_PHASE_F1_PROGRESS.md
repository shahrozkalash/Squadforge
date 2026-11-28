# Factory Phase F1 — Progress

**Phase:** F1 — Live provider proof and model capability baseline
(Universal AI Software Factory roadmap; Factory numbering is distinct
from SquadForge's own Phases 1–60).
**Date:** 2026-11-27. **Status:** complete — closed as a **documented
negative result** under acceptance criterion 4 (no cloud path can
succeed from this environment: no provider keys are configured in it).
No code was changed; nothing was pushed; F2 was not started.

## Key inventory (presence only — values never read or recorded)

| Expected key (`.env.example`) | Repo `.env` | Process env | Verdict |
|---|---|---|---|
| `GEMINI_API_KEY` | no `.env` file exists | absent | **absent** |
| `OPENROUTER_API_KEY` | no `.env` file exists | absent | **absent** |

Also checked: no `.env.local`, no `server/.env`; the shell environment
carries no provider keys (only runtime socket variables). The code
reads exactly these two keys (`server/gateway.ts:24`,
`server/smartRouter.ts:475`). No credentials were invented, borrowed
from other stores, or extracted from the owner's connected AI Studio
connector — that connector's credential belongs to a different task
and is not this repo's configuration path.

## Genuine attempts (SquadForge's own router path only)

A scratch driver called `smartRouter.executeSmartRequest` once per
cloud transport with the gated test's own debugging-style prompt
(driver deleted after the run; the attempts are pinned permanently by
the honesty tests in the new F1 suite):

| Attempt | Result (verbatim) | Latency |
|---|---|---|
| `gemini-fullstack` → Gemini native | `success=false`, `providerUsed="none"` — `Model "Gemini 2.5 (Fullstack Dev)" requires GEMINI_API_KEY. Configure key or enable fallback.` | 23 ms |
| `gpt-4o` → OpenRouter | `success=false`, `providerUsed="none"` — `Model "GPT-4o (Project Manager)" requires OPENROUTER_API_KEY. Configure key or enable fallback.` | ~0 ms |
| Gated suite, `LIVE_PROVIDER_TEST=1` | live test **skipped**: "Set LIVE_PROVIDER_TEST=1 with a real GEMINI_API_KEY to run the genuine cloud check"; suite otherwise 14 pass / 0 fail | — |
| Local (Ollama, 127.0.0.1:11434) | connection failed (HTTP 000) — no local model server runs in this environment | — |

Both transports stop at the router's key gate before any HTTP call —
correct behaviour, and the reason a live success cannot be produced
here without the owner's keys in the server environment.

## Findings beyond the attempts

1. **`gemini-fullstack`'s upstream model is dead for new users.**
   Phase 33's genuine attempts (owner's AI Studio credential) got a
   real Google **404** for `gemini-2.5-flash` ("no longer available to
   new users"; Google recommends `gemini-3.8-flash`), a real **503**
   proving the API path authenticates, and egress read timeouts on
   `gemini-3.8-flash`. Classified **broken** in the matrix with the
   recommended one-line `providerModel` fix recorded — not applied,
   because it cannot be verified from this environment.
2. **Three spec-only role aliases.** AGENT_SPECS has 17 roles; 14
   match a registry `agentRole`. `database_engineer`,
   `integration_engineer`, `qa_engineer` resolve via `assignedModelId`
   but not via `getByRole()`. No production caller is affected (no
   server code calls `getByRole` outside the registry); pinned by name
   in the F1 suite so the set cannot drift silently.
   **Addendum (Factory Phase F5, 2026-11-27): RESOLVED.** The aliases
   are now declared data (`AGENT_ROLE_ALIASES` →
   `database_specialist` / `integration_specialist` /
   `qa_testing_specialist`) and `getByRole()` canonicalizes through
   them; all 17 roles resolve via `getByRole()` to exactly the model
   `AGENT_SPECS` assigns. Three `assignedModelId` values that
   disagreed with the registry binding were also aligned
   (`ui_ux_designer` → claude-uiux, `performance_engineer` →
   deepseek-perf, `documentation_engineer` → mistral-docs). The F1
   suite's alias pin was updated accordingly (the alias set is still
   pinned by name); see `FACTORY_PHASE_F5_ACCEPTANCE_REPORT.md`.
3. **Registry completeness was not previously pinned** — the
   orchestration suite asserted "≥10 models" and role specs, but not
   the exact id set, transports, or two-way role integrity. The new
   F1 suite pins all of it.

## Deliverables

- `CAPABILITY_MATRIX.md` (new) — the standing per-model record:
  transport, routing evidence, live evidence, classification
  (`callable` / `registered-unproven` / `broken`), attempt log, notes.
- `tests/factory_phase_f1_capability.test.ts` (new) — 5 tests:
  exact 10+4 registry, transport classification + upstream ids,
  two-way role integrity (aliases pinned), and the two missing-key
  honesty contracts.
- `FACTORY_PHASE_F1_ACCEPTANCE_REPORT.md` — criterion-by-criterion
  verdict.
- One AGENTS.md status row. No engine code changed.

## Verification (counts from printed summaries)

- F1 suite: **5/5 pass**.
- Phase 33 suite with `LIVE_PROVIDER_TEST=1`: **14 pass / 0 fail /
  1 skipped** (the gated live test — the F1 gap, visible by design).
- Orchestration + fullstack suites, lint, build: see the acceptance
  report (run at close).

## Limitations

- The negative result is a property of *this environment* (no keys
  configured, no local server, previously proven egress timeouts to
  Google). It says nothing about the providers themselves.
- The `broken` classification for gemini-fullstack rests on Phase 33's
  connector-helper attempts, not on a run through this repo's env-key
  path — no such run is possible without a key.
- Local `callable` status is historical (Phase 11); no Ollama server
  was available to re-verify it today.
