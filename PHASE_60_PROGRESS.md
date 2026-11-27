# Phase 60 Progress — Desktop Release and Quality Assurance (Graphics Editor)

Date: 2026-11-27
Baseline: local snapshot on top of Phase 59 (staged locally, not yet pushed; the owner pushes in a batch)
Status: **Complete against the brief.** Versioned release packages for both desktop targets were produced by the project's own build pipeline, the Linux package was genuinely installed (extracted fresh) and run, the generated Windows app gained generator-emitted crash diagnostics whose writer is executed by the runtime harness, release notes ship in both packages and the repo, and the final graphics+desktop regression passes 480/480. **The WinForms GUI itself has still never been run** — it cannot start on this Linux VM (Phase 57 platform record) — so Windows first-run remains an owner-side verification, stated plainly in every document. This is the final phase of the Graphics Editor roadmap (Phases 56–60): there is no Phase 61.

## What was built

### 1. Crash diagnostics (generator-only change)

The generated PixelForge app had no unhandled-exception handling: `Program.Main` was a bare `Application.Run(new MainForm())`. The generator (`server/imageEditor/imageProjectGenerator.ts`) now emits:

- **`CrashDiagnostics.cs`** — a UI-independent static class (text formatting + file IO only; no `System.Windows.Forms`, no `System.Drawing.Common`, so it stays on the core side of the Phase 57 seam). `BuildReport` (pure) formats the report: app name + version stamped from the project config, UTC timestamp, context, OS/runtime/architecture from `RuntimeInformation`, and the exception chain (type, message, stack trace; inner exceptions bounded at 8). `WriteReport` writes `crash-<UTC timestamp>.log` into a caller-chosen directory (collision-safe suffixing); `TryWriteReport` writes to `DefaultReportDirectory` — a `crashes` folder next to the executable (`AppContext.BaseDirectory`) — and never throws.
- **Wired `Program.cs`** — `Application.SetUnhandledExceptionMode(CatchException)`; `Application.ThreadException` routes UI-thread errors through `TryWriteReport` and shows a `MessageBox` naming the report file (with a fallback message if the write failed); `AppDomain.CurrentDomain.UnhandledException` records background-thread (fatal) errors the same way.
- The generated README documents the crash reports.

No engine code changed (the TS engine and the C# engine core are untouched), so the Phase 59 fixture-hash gate is unaffected — and the Phase 59 suite, which pins those hashes, passes in the regression below.

### 2. Runtime harness: scenario S15

`scripts/phase57-runtime-harness.ts` now also copies the generated `CrashDiagnostics.cs` (as `PHASE60_EXTRA_CORE_SOURCES`, listed separately so the Phase 57 core-source pin stays exact), and `scripts/phase57-runtime-harness/Program.cs` gained **S15**: a real thrown exception (with an inner exception) is written to a report file and the file's contents are verified field by field (header, app name/version stamp — pinned to the release version `1.0.0`, context, timestamp, OS/runtime lines, exception type/message, inner exception, stack-trace section), a second report does not overwrite the first, `BuildReport` is deterministic for a fixed timestamp, and `TryWriteReport` writes into the default crashes folder and returns its path. Harness result: **16 scenarios (14 executed, 2 skipped-documented), 171 assertions, 0 failures, exit 0** (Phase 59 state was 15 scenarios / 153 assertions).

### 3. Release builds + packaging (`scripts/phase60-release.ts`)

One explicit release version, **`1.0.0`**, applied consistently: it is the project configs' own `version` field (the generator already stamps `<Version>` into both .csproj files from it), the `CrashDiagnostics.AppVersion` constant, the package folder/archive names, and the release notes. A Phase 60 test proves the knob is the config (a `2.3.4` config flows into both the .csproj and the crash-report stamp).

The driver builds through `DesktopBuildPipeline` in **Release** configuration and packages the builds' real output directories (never hand-assembled copies):

- **Windows** — PixelForge generated fresh, Release build (restore + build exit 0; pipeline PE-verified). Package folder `PixelForge-1.0.0-win-x64/` = the win-x64 output (`PixelForge.exe`, `PixelForge.dll`, `PixelForge.deps.json`, `PixelForge.runtimeconfig.json`; `.pdb` symbols are the only exclusion) + package `README.txt` (.NET 8 Desktop Runtime requirement) + `GRAPHICS_EDITOR_RELEASE_NOTES.md` + `SHA256SUMS` over the folder's contents. Every packaged payload file is hash-checked against the build output during packaging (manifest diff enforced, not sampled). Zipped: `PixelForge-1.0.0-win-x64.zip`.
- **Linux** — the Phase 36 Avalonia app (`SquadForgeApp`, the Desktop Development Engine's Linux target) generated from the default Linux config, Release build (pipeline ELF-verified). Package folder `SquadForgeApp-1.0.0-linux-x64/` = the linux-x64 output (apphost + 30 further files: app dll, deps/runtimeconfig, the Avalonia/Skia dependency set) + `README.txt` + release notes + `SHA256SUMS`; apphost executable bit preserved and re-verified. Archived: `SquadForgeApp-1.0.0-linux-x64.tar.gz`.

Packages live in `~/workspace/squadforge-audit/release/phase60/` (outside the repo snapshot's pushed paths).

### 4. Installation + startup verification

- **Linux — genuinely executed.** The driver extracts the finished `.tar.gz` into a fresh empty directory and runs the extracted apphost twice with `--smoke` against a fresh config home: run 1 printed `SMOKE_OK SquadForgeApp launches=1`, run 2 `SMOKE_OK SquadForgeApp launches=2`, and the persisted `state.json` was read back with `LaunchCount == 2`. Installation and startup of the shipped artifact — not just the build output — are therefore proven on this platform.
- **Windows — package completeness only.** The package's payload was hash-diffed against the build output during packaging, both binaries PE-verified in the package, and the Phase 60 suite re-verifies `SHA256SUMS` against the files on disk and lists the zip's contents. First run on a real Windows machine remains owner-side; nothing here claims otherwise.

### 5. Release documentation

`GRAPHICS_EDITOR_RELEASE_NOTES.md` (repo root; a copy ships in both packages): what each package is — including the plain statement that the Linux package is **not** the image editor — the PixelForge feature list tied to Phases 19 + 44–59, system requirements, the format support table with the Phase 58 named refusals, how crash reports are produced, and the known limitations (GUI never run on Windows by us, no GPU acceleration, parallel CPU opt-in, desktop-app scope limits). No claims beyond the evidence.

## Driver defects found and fixed during this phase (both in the new release driver, not the product)

1. **Tar extraction failed on ownership restore.** The sandbox's build files are root-owned; `tar -xzf` tried to chown extracted files and exited with failure. Extraction now uses `--no-same-owner` (what a normal user's extraction effectively does). The failure was in my driver's verification step; the tarball itself was always valid (manual extraction with the flag succeeds).
2. **Smoke state landed CWD-relative.** .NET's `Environment.GetFolderPath(ApplicationData)` returns an empty path when the `XDG_CONFIG_HOME` directory does not exist, so the app fell back to a relative state path. The driver now creates the config home first — matching any real user machine, where `~/.config` exists. (Observed edge, recorded honestly: the Phase 36 app's state store inherits this .NET behavior when the config home is entirely absent; on Windows `ApplicationData` always exists. Not changed in this phase — it is the scaffold's documented platform behavior, and the release's install path always has a config home.)

An earlier foreground regression run was interrupted by a service restart before producing results; the regression was re-run detached to a log file and completed in full (below). Nothing was inferred from the interrupted run.

## Verification

- Phase 60 suite (`tests/phase60_release_qa.test.ts`): **11/11** — version consistency (incl. the custom-version flow), CrashDiagnostics emission + seam pins, Program.Main wiring, harness S15 wiring, release-notes content, and both packages (required files, SHA256SUMS verified against disk, PE/ELF re-inspection, archive listings).
- Runtime harness: **16 scenarios, 171 assertions, 0 failures**, exit 0 — against a fresh generation of the current generator.
- Final regression, one run: Phase 19 + Phases 44–60 graphics suites + Phase 18 + Phase 36 desktop suites — **480 tests, 480 pass, 0 fail, 0 skipped**.
- `npx tsc --noEmit`: clean.
- Phase 59 benchmark re-run: **skipped by design** — this phase changed no engine code (only the generated app's entry point, one new generated diagnostics file, the harness, the release driver and docs), so there is no performance surface to re-measure; the Phase 59 suite's pinned fixture hashes pass in the regression, proving byte-identical engine behavior.
- Not run locally: the full repo suite (1,500+ tests) — the local regression covers the graphics + desktop surface this phase touches; full-suite confirmation comes with the owner's push to CI, as with every phase in this roadmap.
