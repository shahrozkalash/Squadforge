# Factory Phase F1 — Acceptance Report

**Phase:** F1 — Live provider proof and model capability baseline
(Universal AI Software Factory roadmap).
**Date:** 2026-11-27.
**Verdict: COMPLETE — closed as a documented negative result**
(roadmap acceptance criterion 4). No successful live cloud generation
could be produced from this environment because no provider keys are
configured in it; every attempt outcome is recorded verbatim, and the
per-model capability baseline is established in `CAPABILITY_MATRIX.md`.
No claim in this report rests on a stub or a registry entry.

## Criterion-by-criterion

1. **At least one cloud path completes a real generation in a gated
   live run** — **NOT MET, and not claimable.** `GEMINI_API_KEY` and
   `OPENROUTER_API_KEY` are both absent (no repo `.env`, none in the
   process environment; inventoried by presence only). Genuine
   attempts through SquadForge's own `smartRouter.executeSmartRequest`
   were refused by name at the router's key gate:
   - Gemini (`gemini-fullstack`): `Model "Gemini 2.5 (Fullstack Dev)" requires GEMINI_API_KEY. Configure key or enable fallback.` (23 ms, `providerUsed="none"`)
   - OpenRouter (`gpt-4o`): `Model "GPT-4o (Project Manager)" requires OPENROUTER_API_KEY. Configure key or enable fallback.` (~0 ms, `providerUsed="none"`)
   The gated live test, run with `LIVE_PROVIDER_TEST=1`, skipped with
   its standing reason: "Set LIVE_PROVIDER_TEST=1 with a real
   GEMINI_API_KEY to run the genuine cloud check".
2. **Every registry entry classified with evidence** — **MET.**
   `CAPABILITY_MATRIX.md`: 13 × `registered-unproven` (routing proven
   over Phase 33 transport stubs; never live), 1 × `broken`
   (`gemini-fullstack` — Google's verbatim 404 for its upstream
   `gemini-2.5-flash`, "no longer available to new users", from Phase
   33's genuine attempts), local (Ollama) `callable` on the Phase 11
   record (no server running today — connection failed, HTTP 000).
3. **Phase 33 + orchestration suites, lint, build pass** — **MET with
   one named exception.** Phase 33: 14 pass / 0 fail / 1 gated skip.
   Orchestration + fullstack suites: 47 pass / 1 fail — the failure is
   exactly the known pre-existing local-only checkpoint test
   (`tests/orchestration.test.ts:334`, sandbox integrity; proven
   identical on the pristine base and green in CI), reported, not
   fixed, per standing instructions. Lint (tsc --noEmit): clean.
   Production build: succeeds.
4. **If no cloud path can succeed here, report exactly that with
   verbatim errors** — **MET.** This report + `FACTORY_PHASE_F1_PROGRESS.md`
   + the matrix's attempt log are that record. **F1 closes on this
   criterion.**

## What F1 additionally established

- A permanent registry baseline suite
  (`tests/factory_phase_f1_capability.test.ts`, 5/5): exact 10 base +
  4 variant ids, transport classification, upstream ids present,
  two-way role integrity, and the missing-key honesty contract pinned
  as regression tests.
- A documented registry inconsistency: three spec-only role aliases
  (`database_engineer`, `integration_engineer`, `qa_engineer`) that
  `getByRole()` cannot resolve — no production impact today, pinned
  by name so it cannot drift silently.
  **Addendum (Factory Phase F5, 2026-11-27): this inconsistency is
  resolved.** `AGENT_ROLE_ALIASES` declares the three aliases as data
  mapped to their canonical specialist roles and `getByRole()`
  canonicalizes through it — all 17 roles now resolve via
  `getByRole()` to exactly their `AGENT_SPECS`-assigned model, and
  three `assignedModelId` values that disagreed with the registry
  binding were aligned (`ui_ux_designer` → claude-uiux,
  `performance_engineer` → deepseek-perf, `documentation_engineer` →
  mistral-docs). The F1 suite was updated to pin the resolved state
  (alias set still pinned by name). See
  `FACTORY_PHASE_F5_ACCEPTANCE_REPORT.md`.
- The exact unblock for a future positive close: owner places a real
  key in the server environment → re-run the gated live test → update
  `CAPABILITY_MATRIX.md` with the raw result. The recommended
  `gemini-fullstack` providerModel fix (`google/gemini-3.8-flash`) is
  recorded in the matrix, deliberately unapplied until it can be
  verified live.

## Limitations

- The negative result is environmental (keys absent here; VM egress
  previously timed out on Google's API), not a provider verdict.
- `gemini-fullstack`'s `broken` rests on Phase 33's connector-helper
  evidence, the only genuine provider responses on record.
- The full 1,651-test suite was not re-run (no engine code changed;
  the suites above cover the model layer F1 touched).

**Recommendation:** accept F1 as closed-negative. The platform's live
proof remains an owner-key action, now reduced to a single documented
step whenever the owner chooses to take it.
