# Factory Phase F14 — Progress Log

**Phase:** F14 — Factory Release & Capability Matrix Publication
(final phase of the Universal AI Software Factory roadmap).
**Date:** 2026-11-28.
**State at close of this log:** implemented and verified locally;
**not pushed**. The push is a separate step the owner performs with
Spark after F14; main CI therefore runs on the release commit only
after that push (roadmap F14 criterion 1 is owner/push-gated — see
the acceptance report). Final acceptance of the Factory roadmap
remains the owner's (roadmap criterion 3: no self-acceptance).

## What F14 did (and did not do)

F14 is a publication and verification phase. It changed **no
production code** and **no test code**. Its work:

1. Re-read every F1–F13 acceptance report on disk and verified each
   claim carried into the published matrix against its report. Any
   claim a report did not support was left out.
2. Republished `CAPABILITY_MATRIX.md`: the F1 model matrix kept
   verbatim (its verdicts stand unchanged), extended with §2
   category workflows, §3 factory machinery proofs, and §4 known
   gaps — every gap stated, none hidden.
3. Ran the final verification pass over the complete factory-era
   surface (all 13 factory suites + orchestration + Phase 4 +
   load-bearing category core suites), plus lint and build.
4. Wrote the consolidation (`FACTORY_PHASE_F14_ACCEPTANCE_REPORT.md`):
   what the factory is now, the F1–F14 verdict table, the defect
   ledger, the release recommendation.
5. Updated `AGENTS.md` (one F14 status row + the roadmap-tracking
   line), added the completion header to
   `UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`, and added a short
   "Universal AI Software Factory" section to `README.md` pointing
   at the roadmap, the matrix, and this release.

## Claim-verification method

The matrix was assembled report-first: each row's proof cell cites
the suite and the headline evidence exactly as the phase's
acceptance report records it (counts, hashes' existence, probe
numbers). Cross-checks performed while assembling:

- F5's "24 categories" vs F12's "24 → 25": the matrix states 25
  categories (post-F12) and attributes the 25th to F12.
- F9's deployment claim: the F9 report claims the approved request
  reaches the static-host registry state `active` and explicitly
  does **not** claim a live deploy — the matrix §4 gap 5 repeats
  exactly that boundary.
- F10's Android claim split (local vs CI-produced) is preserved
  verbatim in structure: no local APK is claimed anywhere.
- F13's routing scope: the F13 report lists nine routes; `saas` is
  proven via its F9 workflow but is **not** an F13 facade route —
  the matrix's unified-pipeline row lists the nine routes as the
  report does and does not add SaaS to them.
- F1's model verdicts are unchanged since 2026-11-27; the F14 pass
  re-ran the F1 capability suite (5/5) and the Phase 33 suite,
  whose only skip is the gated live test itself.

## Final verification pass — design

The full repo suite (~1,650 tests) was not re-run: on this
1.5-CPU VM it takes 30+ minutes and the factory-era surface is the
release's claim surface. Selection (stated, per the brief): all 13
factory suites (F1–F13), `orchestration` and
`phase4_production_reliability` (the chain's regression sentinels,
including both tests F2 fixed), and the load-bearing category core
suites the workflows stand on — Phase 21 (3D engine) + Phase 24
(game engine) for F7, Phase 33 (provider reliability) for F1,
`project_memory` ×2 for F3, Phase 34 + Phase 37 (Android generator
+ export parity) for F10, Phase 36 (desktop Linux) for F11.
Groups were run sequentially; counts below are from the printed
summaries of the F14 runs (2026-11-28), not copied from the phase
reports.

## Final verification pass — results

| Group | Suites | Result |
| :-- | :-- | :-- |
| A — core | F1 capability, F2 gauntlet, F3 memory/resume, F5 category teams, orchestration, Phase 4 reliability | **64/64 pass, 0 fail, 0 skipped** |
| B — verification gauntlet | F4 verification/repair | **11/11 pass** |
| C — contract + creative | F6 environment contract, F7 games, F8 creative editors | **18/18 pass** |
| D — web + AI | F9 web workflow, F12 AI apps | **6/6 pass** |
| E — mobile | F10 mobile workflow, Phase 34, Phase 37 | **26/26 pass** |
| F — desktop/CLI | F11 desktop tools, Phase 36 | **20/20 pass** |
| G — unified pipeline | F13 unified pipeline | **12/12 pass** (117 s) |
| H — category core | Phase 21, Phase 24, Phase 33, project_memory, project_memory authorization hardening | **66 pass, 0 fail, 1 skipped** of 67 — the skip is the Phase 33 gated live-provider test (`LIVE_PROVIDER_TEST=1` + a real `GEMINI_API_KEY`), the F1 gate itself, skipping with its standing reason |
| **Total** | **224 tests** | **223 pass, 0 fail, 1 gated skip** |
| Lint | `npm run lint` (`tsc --noEmit`) | exit 0, no diagnostics |
| Build | `npm run build` (`vite build`) | succeeds (standard chunk-size warning only) |

**No regression was found.** Every previously-green suite in the
selection is green in the F14 pass; the one skip is the designed
F1 gate. Consequently F14 made **no code changes** — there was no
genuine factory-era defect to fix, and none is claimed fixed.

## Gated suites — status stated honestly (roadmap F14 criterion 1)

- **Live provider gate** (`LIVE_PROVIDER_TEST=1`): remains gated
  and skipping — it needs the owner's real `GEMINI_API_KEY` in the
  server environment. This is the F1 documented negative; the gate
  stays because a live pass cannot be produced without the key,
  and an ungated version would fabricate exactly the claim F1
  refused to make.
- **Docker sandbox gate** (Phase 32, `DOCKER_INTEGRATION=1` /
  `SANDBOX_INTEGRATION=1`): remains gated — this VM has no Docker
  daemon. Its CI proof stands on the Phase 32 workflow record.
- **Local-model integration gate** (Phase 11,
  `LOCAL_MODEL_INTEGRATION=1`): remains gated — no Ollama server
  runs in this environment (F1 baseline).
- Main CI green on the release commit can only be asserted after
  the owner's push; the local pass above is the pre-push evidence,
  and the F14 acceptance report says so in those words.

## Files changed by F14

- `CAPABILITY_MATRIX.md` — republished (model section preserved;
  §2 workflows, §3 machinery, §4 gaps added).
- `FACTORY_PHASE_F14_PROGRESS.md` (new), `FACTORY_PHASE_F14_ACCEPTANCE_REPORT.md` (new).
- `AGENTS.md` — one "Factory Phase F14" status row after the F13
  row; the roadmap-tracking line updated to the final state.
- `UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md` — completion status
  header added; no phase text changed.
- `README.md` — one short "Universal AI Software Factory" section
  with pointers (roadmap, matrix, F14 report).

Nothing was pushed; `.github/workflows` untouched; no code changed.
