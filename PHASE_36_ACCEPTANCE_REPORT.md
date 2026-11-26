# Phase 36 Acceptance Report: Desktop Development Engine — Linux Target

**Date:** 2026-11-26 · **Verdict: PASS** (with the limitations below)
**Implementation commit:** `77e74b2` on `main`
**CI:** Main CI run [#163](https://github.com/shahrozkalash/Squadforge/actions/runs/45773463796) — **Success**

## Assignment

"Next Development Phase": inspect the repository and completed
phases, identify the most important unfinished user-facing feature,
implement it fully in the existing architecture (no duplicates, no
placeholders, no mocks), add focused tests, run lint / typecheck /
tests / production build, fix regressions, and update the phase
documentation with actual results. Do not start another phase
automatically.

## How the feature was chosen

The inspection covered the README feature list, every phase
acceptance report's limitations, the AGENTS.md open-work list, a
stub/TODO scan of `server/` and `src/`, and a mechanical cross-check
of all 99 `/api/...` calls the UI makes against all 99 registered
routes (all wired — no dead UI surface). The Desktop Development
Engine (Phase 18) was the standout gap: its config carried a
`platform` field from the start, its types file promised Linux/macOS
generators could be added "without changing the pipeline or routes",
and every non-Windows request was rejected with "not yet supported"
— an error where Windows users get a real application. AGENTS.md
open work #5 (approval expiry) was checked first and found already
implemented and wired on all three read paths in `server.ts`, so it
was not re-done. The remaining open items require a live provider
key, production infrastructure, or an owner decision.

## What was delivered

| # | Requirement | Result |
| :--- | :--- | :--- |
| 1 | Linux desktop generation | `DesktopProjectGenerator.getLinuxDefaultConfig()` + Linux branch of `generateProjectFiles`: a genuine Avalonia UI 11.2.8 app (pinned packages) — `Program.cs`, `App.axaml(.cs)`, `MainWindow.axaml(.cs)`, `AppState.cs` state store, freedesktop `.desktop` entry, `build.sh`, README. Same behaviour contract as the Windows app: message editor, Save action, launch count + last message persisted as JSON |
| 2 | Headless run verification | The generated app ships a `--smoke` diagnostics mode that exercises the real state store without opening a window and prints `SMOKE_OK` |
| 3 | Honest validation | Linux requires `net8.0` + `avalonia`; `requireAdministrator` is rejected (no Linux equivalent — not faked); macOS still rejected as not yet supported; a Windows config with the platform tag flipped to `linux` is rejected |
| 4 | Genuine build + format verification | Pipeline RID follows the platform (`linux-x64`); the extensionless apphost is verified by a new `ElfInspector` (ELF magic, class, endianness, EXEC/DYN type, machine) mirroring `PeInspector`; the harvest preserves the executable bit and includes the apphost's `deps.json`/`runtimeconfig.json` manifests, without which the framework-dependent binary cannot start |
| 5 | Routes | `/generate` accepts `platform` (+ framework/TFM overrides) and starts from that platform's defaults; unsupported platform values are rejected by validation with their message; `/status` reports `supportedPlatforms: ['windows', 'linux']`; the artifact download route ELF-verifies extensionless artifacts |
| 6 | Windows preserved | The Windows file set, validation rules, pipeline harvest and PE verification are unchanged in behaviour (shared literals moved verbatim into a helper both targets use; Phase 18 suite green locally and in CI) |

## Found and fixed on this feature's path (latent bug)

`validateArtifactFilename`'s default extension list predates the
desktop engine and rejects `.exe`/`.dll`, so the desktop artifact
store/download layer rejected the very artifacts Phase 18 produces
(`storeDesktopArtifactBuffer` threw for `FitTrack.exe`; the download
route returned 400). No test covered the desktop routes, which is
how it survived. The desktop module now validates with its own
`isValidDesktopArtifactFilename` — same traversal/charset
discipline, desktop shapes (`.exe`, `.dll`, extensionless apphost,
its two manifests; arbitrary `.json` names stay rejected) — with
round-trip tests.

## Verification (actual results)

- **Feasibility first:** a scratch Avalonia 11.2.8 project restored
  from nuget.org on this VM and compiled to a native ELF apphost
  before any generator code was written.
- **Lint / typecheck:** `npm run lint` (`tsc --noEmit`) clean.
- **Focused suites (local):** Phase 36 (17 tests) + Phase 18
  (14 tests) — **31/31 pass**, including a genuine `dotnet build`
  of the generated Linux project (ELF-verified apphost, 72,504 B)
  and two real `--smoke` runs of the harvested artifact proving
  state persistence (LaunchCount 1 → 2).
- **Full suite (local):** 1,216 tests — 1,213 pass, 2 fail,
  0 cancelled, 1 skipped. The 2 failures are the documented
  pre-existing local-only failures (orchestration sandbox-integrity
  checkpoint; Phase 4 test 19), proven identical on the pristine
  base and green in CI.
- **Production build:** `npm run build` (vite) succeeds.
- **CI:** run [#163](https://github.com/shahrozkalash/Squadforge/actions/runs/45773463796)
  on `77e74b2` — **Success** (both jobs; 5m 3s). Log counts:
  `# tests 1216 / # pass 1215 / # fail 0 / # cancelled 0 / # skipped 1`
  (the skip is the `DOCKER_INTEGRATION`-gated Phase 32 suite, which
  runs in its own workflow). Phase 36 suite green by name
  (`ok 111`), with the runner's own build evidence:
  `FitTrackLinux: genuine ELF (64-bit, little-endian, x86-64, DYN)`,
  and the `--smoke` run test passing on the runner. Phase 18 suite
  green by name (`ok 63`) with its genuine PE build.

## Known limitations

- The generated app's **GUI is not run** on this host or in CI —
  neither has a display. The `--smoke` mode is the headless run
  verification (real process, real state store, real persistence);
  opening the window requires a Linux desktop.
- The Linux target is **linux-x64 only** (no ARM64 RID yet), and the
  app is framework-dependent (a .NET 8 runtime must be installed;
  the manifests are harvested so the artifact folder runs as-is).
- The Windows artifact bundle has the parallel property Phase 18
  shipped with — its `.exe` is harvested without its manifests.
  Recorded here rather than silently changed under Phase 18's
  accepted behaviour.
- **macOS desktop generation remains unimplemented** and is still
  rejected honestly.
- Final acceptance of this phase rests with the project owner.
