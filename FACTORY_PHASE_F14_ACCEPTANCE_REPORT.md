# Factory Phase F14 — Acceptance Report (Factory Release)

**Phase:** F14 — Factory Release & Capability Matrix Publication
(final phase, Universal AI Software Factory roadmap).
**Date:** 2026-11-28.
**Verdict: COMPLETE as a local release — implemented, verified,
and published locally; NOT pushed.** Two roadmap acceptance items
are owner-gated by their own text and are recorded as such, not
claimed: main CI green on the release commit (criterion 1) can
only exist after the owner's push, and final acceptance
(criterion 3) is the owner's — this report recommends; it does not
self-accept.

## What the factory is now

SquadForge is a describe-to-delivered software factory: one entry
point (`deliverFromDescription`) classifies a plain-language
description, resolves the responsible AI team from data (25
categories, every role bound to a registered model through one
registry), builds through a swarm chain whose delegation,
parallelism, cancellation, kill-and-resume recovery and
verification gates are all gauntlet-proven, runs the delivery
through a single environment contract shared by the web and
desktop surfaces, and returns a uniform, persisted delivery record
only when the category's own verification gate passes — games are
executed headlessly, web apps are probed over real HTTP, photos
are developed against hash-pinned originals, AI apps must refuse
by name when no provider exists. Its public claims are exactly its
proofs, published in `CAPABILITY_MATRIX.md`; its largest honest
limit stands unchanged since F1: no live cloud generation has ever
been proven in this environment, because no provider keys exist
here, and every workflow proof is machinery proven over the stub
transport, labelled as such in every suite and delivery record.

## Roadmap F14 criteria — verdicts

| # | Criterion | Verdict |
| :-- | :-- | :-- |
| 1 | Main CI is green on the release commit (exact counts), gated suites' status stated honestly | **Owner/push-gated — pre-push evidence complete.** F14's local final pass: **224 tests, 223 pass, 0 fail, 1 gated skip** (groups in `FACTORY_PHASE_F14_PROGRESS.md`), lint exit 0, build succeeds. The one skip is the designed live-provider gate (`LIVE_PROVIDER_TEST=1` + owner's `GEMINI_API_KEY`); the Docker sandbox gate and the local-model gate likewise remain gated, each for a stated environmental reason (no Docker daemon / no Ollama server on this VM). CI itself runs when the owner pushes; no CI result is claimed here. |
| 2 | The capability matrix contains no claim without a linked run, suite, or artifact hash in this repo | **MET.** Every row of the republished `CAPABILITY_MATRIX.md` cites its suite and headline evidence, verified against the F1–F13 acceptance reports on disk during F14; claims no report supported were left out, and §4 publishes the known gaps. |
| 3 | `AGENTS.md` and the roadmap are updated to the final state; the owner accepts or the phase stays open — no self-acceptance | **Updated; acceptance pending the owner.** AGENTS.md gained the F14 row and the final roadmap-tracking line; the roadmap carries the completion header. This report's recommendation (below) is the input to the owner's decision, not the decision. |

## Phase-by-phase verdict table (F1–F14)

| Phase | Verdict | Evidence pointer |
| :-- | :-- | :-- |
| F1 — Live provider proof + capability matrix | **Complete — documented negative** (roadmap criterion 4): no keys exist in this environment; both cloud transports refuse by name; per-model baseline published | `FACTORY_PHASE_F1_ACCEPTANCE_REPORT.md`; `CAPABILITY_MATRIX.md` §1; suite 5/5 |
| F2 — Delegation & parallel execution gauntlet | **Complete**: whole swarm chain proven end-to-end (ordering, deterministic parallelism, cancellation, failure recovery, hash-matched merge); 1 chain-breaking defect fixed | `FACTORY_PHASE_F2_ACCEPTANCE_REPORT.md`; suite 5/5 |
| F3 — Shared context & memory hardening | **Complete**: kill-and-resume proven (final tree deep-equal to an uninterrupted run); 3 memory defects fixed | `FACTORY_PHASE_F3_ACCEPTANCE_REPORT.md`; suite 5/5 |
| F4 — Verification & repair gauntlet | **Complete**: zero false completions across 10 fault-injected builds + 1 engine probe vs an approve-everything verifier; 2 genuine defects fixed (+1 regression caught and fixed in-phase, +1 dedupe fix) | `FACTORY_PHASE_F4_ACCEPTANCE_REPORT.md`; suite 11/11 |
| F5 — Category AI teams as data | **Complete**: 24 category teams as data; category→profile mapping created; replaceability proven in a full swarm run; F1's alias finding closed; 3 binding divergences aligned | `FACTORY_PHASE_F5_ACCEPTANCE_REPORT.md`; suite 8/8 |
| F6 — One environment contract | **Complete**: 12-operation contract, web + desktop adapters, lifecycle proven on both; approval gate and sandbox-only invariant asserted; unsupported operations refuse by name | `FACTORY_PHASE_F6_ACCEPTANCE_REPORT.md`; suite 10/10 |
| F7 — Games workflow | **Complete**: described 2D game delivered and executed headlessly (412 steps, 0 errors); 3D export + multiplayer foundation proven at their stated scopes | `FACTORY_PHASE_F7_ACCEPTANCE_REPORT.md`; suite 4/4 |
| F8 — Creative editors workflow | **Complete**: video (genuine ffmpeg export verified by ffprobe/frames/RMS), image (pixel-exact), photo base built (develop-as-data, hash-pinned originals) | `FACTORY_PHASE_F8_ACCEPTANCE_REPORT.md`; suite 4/4 |
| F9 — Web / SaaS / API workflow | **Complete**: two described apps run and pass 9/9 + 8/8 real HTTP contract probes; deployment held at the approval gate, no further claimed | `FACTORY_PHASE_F9_ACCEPTANCE_REPORT.md`; suite 3/3 |
| F10 — Mobile workflow | **Complete**: Android project gate green locally (consistency, Kotlin compile of the JVM-pure subset, 18/19 JVM tests + 1 named environment-limited); APK proof is the pinned CI path; iOS structural gate only, no team exists | `FACTORY_PHASE_F10_ACCEPTANCE_REPORT.md`; suite 3/3 |
| F11 — Desktop & OS tools workflow | **Complete**: genuine dotnet build + smoke persistence (LaunchCount 1 → 2), Windows package tamper-evident, CLI genuinely executed 8/8; 2 genuine defects fixed | `FACTORY_PHASE_F11_ACCEPTANCE_REPORT.md`; suite 3/3 |
| F12 — AI applications workflow | **Complete**: `ai_application` category added as data (25/25 invariant); no-provider honesty proven (503 `NO_PROVIDER`, no fabricated answer); config-only model swap proven at stub transport; fabricating variant refused | `FACTORY_PHASE_F12_ACCEPTANCE_REPORT.md`; suite 3/3 |
| F13 — Describe→delivered unified pipeline | **Complete**: one entry point delivers all nine routed categories, each through its own gate, with uniform persisted records; planning failures and gate failures are named, never faked | `FACTORY_PHASE_F13_ACCEPTANCE_REPORT.md`; suite 12/12 |
| F14 — Factory release + matrix publication | **Complete locally** (this report): matrix republished with proofs + gaps; final pass 223 pass / 0 fail / 1 gated skip; docs and tracking updated | `FACTORY_PHASE_F14_PROGRESS.md`; `CAPABILITY_MATRIX.md` |

## Defect ledger — every genuine defect found and fixed, F2–F13

Each entry was probe-verified before fixing and is regression-pinned
by the phase's suite (all re-run green in the F14 pass).

| # | Defect | Found | Fixed in |
| :-- | :-- | :-- | :-- |
| 1 | `ExecutionAdapter.parseTestOutput` understood only TAP output; on spec-reporter Node versions a fully passing run read as 100% failed, the sandbox spawned unbounded fix tasks, and **no build containing tests could complete**. Also the root cause of the two long-standing local-only failures (`orchestration.test.ts:334`, Phase 4 test 19) | F2 | `server/swarm/executionAdapter.ts` (spec-line parsing; summary-based fallback) |
| 2 | `ProjectMemory.recordFact`: fact contradictions were silent — assumption-vs-confirmed refused with no build-record trace; confirmed-vs-confirmed stored undetected alongside its opposite | F3 | `server/swarm/projectMemory.ts` (contradiction check + `fact_conflict` event; `server/types.ts` EventType) |
| 3 | `retrieveTaskContext` assembled confirmed facts fifth of six sections, so the budget packer dropped pinned facts on large projects at every probed budget | F3 | `projectMemory.ts` (facts packed immediately after the header) |
| 4 | `recordRevision` pruning used a plain slice that dropped the oldest facts — including the initial user-derived confirmed facts | F3 | `projectMemory.ts` (shared `pruneFacts`; confirmed facts never dropped) |
| 5 | Sandbox gate never consumed the TypeScript compiler report: a build with a real TS2322 was marked `completed` while the honest verdict on the same tree was `failed` — a **false completion** | F4 | `server/swarm/sandboxRunner.ts` (type diagnostics gate the sandbox; fix task names the diagnostic; TS18003 excluded — see gap 7 in the matrix) |
| 6 | Failing-test repair tasks were addressed to a hardcoded `tests/engine.test.ts` — a phantom file in most projects, so the repair loop could never repair a failing test and builds hung | F4 | `sandboxRunner.ts` (attribution resolves to a test file actually in the tree) |
| 7 | Duplicate fix tasks for one error (a crashed test file reported in-line and in the recap) raced to patch one file | F4 | `sandboxRunner.ts` (fix-task spawning dedupes identical (file, message) errors) |
| 8 | `DesktopBuildPipeline` ignored the environment adapter's configured `artifactsRoot` (harvest hardcoded to `<cwd>/.desktop_artifacts`), so exports threw with any non-default root | F11 | `server/desktop/desktopBuildPipeline.ts` + `server/desktop/types.ts` + `server/environment/desktopEnvironment.ts` (`artifactsRoot` option, adapter passes its root) |
| 9 | `IntegrationAgent`'s browser-dependency scan exempted only Node entry files themselves, flagging a CLI's local command modules for importing `fs`/`path` — phantom broken-contract fix tasks failed real builds | F11 | `server/swarm/integrationAgent.ts` (exemption covers the Node roots' transitive relative-import closure; unreachable files scanned as before) |
| 10 | Registry divergence: three `AGENT_SPECS.assignedModelId` values disagreed with the operational registry binding (ui_ux, performance, documentation roles), and three role aliases (`database_engineer`, `integration_engineer`, `qa_engineer`) were unresolvable via `getByRole()` | F1 (found) / F5 (fixed) | `server/modelRegistry.ts` (bindings aligned; `AGENT_ROLE_ALIASES` + canonicalizing `getByRole`) — behaviour-preserving; agreement pinned for all 17 roles |

Documented but deliberately **not** fixed (each with its reason in
its phase report and in `CAPABILITY_MATRIX.md` §4): the
dependents-of-a-failed-task liveness wart (F2/F4 — scheduling-policy
change); TS18003 exclusion and unconsumed `configErrors` (F4 —
rationale recorded); the checkpoint patch-count cadence (F3 —
product decision); the missing Linux desktop packaging adapter and
the missing iOS team (F6/F10 — new scope, surfaced not hidden); the
`gemini-fullstack` providerModel fix (F1 — recorded, unapplied until
verifiable live).

## Final verification (F14 pass, 2026-11-28)

224 tests across 8 groups (composition and per-group counts in
`FACTORY_PHASE_F14_PROGRESS.md`): **223 pass, 0 fail, 1 skipped** —
the skip is the Phase 33 gated live-provider test, skipping by
design with its standing reason. `npm run lint` exit 0;
`npm run build` succeeds. No previously-green suite regressed; F14
changed no code.

## Limitations of this release

- **Everything is local and unpushed.** The release commit, its CI
  run, and any CI-produced artifacts (notably the F10 Android APK
  on a fresh run) exist only after the owner's push.
- **No live model claim exists anywhere in the release.** F1's
  negative close is the release's foundation fact: with the
  owner's key, the gated live test is a single documented step;
  without it, all generation claims remain machinery claims.
- Category coverage is the nine F13 routes plus the F9 SaaS
  workflow; the other 16 F5 categories have teams as data and no
  workflow, and the pipeline refuses them by name.
- Per-phase limitations stand as recorded in each acceptance
  report (stub transport throughout; generated GUIs never run;
  Windows exe never executed on this host; photo base is
  global-adjustments-only; multiplayer is a foundation, not
  shared-world co-op).

## Release recommendation

**Recommend owner acceptance of the Factory roadmap as complete,
and release by push.** The roadmap's own bar — a platform whose
public claims match its proofs — is met by construction: the
published matrix contains no claim without a suite or artifact
behind it, the gaps are published in the same document, and the
one foundational unknown (live generation) is a single owner-key
step away from being testable, with the gate already built and
waiting. The push itself, the CI run it triggers, and the owner's
acceptance are the remaining acts — all three belong to the owner,
per the roadmap.
