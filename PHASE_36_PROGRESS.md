# Phase 36 Progress: Desktop Development Engine — Linux Target

**Started:** 2026-11-26 · **Status:** Implementation complete; verification in progress

## Why this phase

The repository was inspected end to end for the most important
unfinished user-facing feature: README promises, every phase's
acceptance report and limitations, the AGENTS.md open-work list, a
stub/TODO scan of server and frontend code, and a mechanical
cross-check of every `/api/...` call the UI makes against every
registered route (99 calls, 99 routes — all wired).

The gap that stood out is the Desktop Development Engine (Phase 18):
its config has carried a `platform` field since the start, its types
file says Linux/macOS generators "can be added later without
changing the pipeline or routes", and `validateConfig` rejected
every non-Windows config with "not yet supported". A user asking
SquadForge for a Linux desktop app got an error where Windows users
get a real, buildable application. Phase 36 closes that gap for
Linux. (Two other candidates were checked and rejected: AGENTS.md
open work #5, approval-request expiry, turned out to be already
implemented and wired on all three read paths in `server.ts`; the
remaining open items need a live provider key, production
infrastructure, or an owner decision.)

## What was built

- **Linux generator** (`server/desktop/desktopProjectGenerator.ts`):
  `getLinuxDefaultConfig()` (platform `linux`, framework `avalonia`,
  TFM `net8.0`) and a Linux branch of `generateProjectFiles` emitting
  a genuine Avalonia UI 11.2.8 application — `Program.cs` (Avalonia
  entry point + headless `--smoke` diagnostics mode), `App.axaml(.cs)`,
  `MainWindow.axaml(.cs)` (message editor, Save action, status line),
  `AppState.cs` (JSON state store under the per-user config
  directory, launch count + last message — the same behaviour the
  Windows app has), a freedesktop `.desktop` entry, `build.sh`, and a
  Linux README. The Windows file set is unchanged (the solution /
  .gitignore / Directory.Build.props literals moved verbatim into a
  shared helper both targets use).
- **Platform-branched validation**: Windows rules unchanged; Linux
  requires `net8.0` + `avalonia` and rejects `requireAdministrator`
  (no Linux equivalent — rejected, not faked); macOS is still
  rejected honestly as not yet supported.
- **ELF verification** (`server/desktop/elfInspector.ts`): a minimal
  honest ELF parser mirroring `PeInspector` — magic, class,
  endianness, `e_type` (must be EXEC or DYN), `e_machine`.
- **Pipeline generalization** (`server/desktop/desktopBuildPipeline.ts`):
  the output RID follows the platform (`linux-x64`); the harvest
  accepts the extensionless ELF apphost (ELF-verified, artifact kind
  `exe`), preserves the toolchain's file mode so the harvested
  apphost stays executable, and — for Linux — also harvests the
  apphost's `deps.json` / `runtimeconfig.json` manifests (kind
  `other`), because a framework-dependent apphost cannot start
  without them. The Windows harvest is byte-for-byte the old logic.
- **Routes** (`server/desktop/desktopRoutes.ts`): `/generate`
  accepts `platform` (plus `uiFramework` / `targetFramework`
  overrides) and starts from that platform's defaults; an
  unsupported platform value flows into validation and is rejected
  with its message. `/status` now reports
  `supportedPlatforms: ['windows', 'linux']`. The artifact download
  route ELF-verifies extensionless artifacts the way it PE-verifies
  `.exe` files.

## Found and fixed on this feature's path (latent bug)

`validateArtifactFilename`'s default extension list
(`apk|aab|zip|tar.gz|tgz|log|json|bin`) predates the desktop engine
and rejects `.exe`/`.dll` — so the desktop artifact store/download
layer rejected the very artifacts Phase 18 produces
(`storeDesktopArtifactBuffer` threw for `FitTrack.exe`;
`GET /artifacts/FitTrack.exe` returned 400). No test covered the
desktop routes, which is how it survived. The desktop module now
validates with its own `isValidDesktopArtifactFilename` — the same
traversal/charset discipline, applied to the shapes the engine
emits (`.exe`, `.dll`, the extensionless apphost, and its two
manifests; arbitrary `.json` names stay rejected).

## Verification so far

- Feasibility proven before building: a scratch Avalonia 11.2.8
  project restored from nuget.org on this VM (34 s) and compiled to
  a native ELF apphost.
- `npx tsc --noEmit` (also `npm run lint`): clean.
- Focused suites: `tests/phase36_desktop_linux.test.ts` (new,
  16 tests) + `tests/phase18_desktop_engine.test.ts` (test 2.3
  updated for the new platform scope) — **31/31 pass**, including a
  genuine `dotnet build` of the generated Linux project
  (ELF-verified apphost, 72,504 B) and two real `--smoke` runs of
  the harvested artifact proving the state store persists
  (LaunchCount 1 → 2 across runs).
- Production build (`npm run build`, vite): succeeds.

## Pending

- Full test suite result and the main CI run on the pushed commit
  (recorded in the acceptance report when they land).
- The generated app's GUI itself is not run here — this host has no
  display. The `--smoke` mode is the headless run verification;
  opening the window needs a Linux desktop.
