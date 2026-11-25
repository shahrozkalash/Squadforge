# Phase 18 Acceptance Report — Desktop Development Engine

Date: 2026-11-25
Baseline: `4e8a596` (main)
Status: **Ready for owner acceptance.** All requirements verified with genuine evidence; nothing simulated.

## Requirement-by-requirement

| # | Requirement | Evidence |
| :--- | :--- | :--- |
| 1 | Windows desktop projects first; architecture ready for Linux/macOS | `DesktopProjectConfig.platform` on every config; Windows generator implemented; Linux/macOS rejected honestly ("not yet supported") rather than faked. |
| 2 | Desktop project generator, application structure, build configuration, development workflow | Generator emits `.sln`, `.csproj` (net8.0-windows, WinForms, win-x64 RID), `Directory.Build.props`, build scripts, README with the VS/VS Code debug workflow. |
| 3 | Real source-code generation | Generated C# is a working WinForms app (STAThread entry, form + designer, JSON state persistence to %AppData%) — compiled unchanged by the pipeline. |
| 4 | Dependency management | `dotnet restore` (NuGet) is a distinct pipeline step; restore failure fails the build honestly. Verified live (Newtonsoft.Json restore + the generated project's own restore). |
| 5 | Execution & debugging | Debugging = standard .NET tooling against the generated solution (documented in the generated README). Host execution of the Windows GUI is **not** claimed on this Linux host — see Limitations in PHASE_18_PROGRESS.md. |
| 6 | Project previews | The generated app's structure/config are inspectable through the build's file store; no fake preview rendering is presented. |
| 7 | Secure workspace for desktop projects and generated files | Workspaces under `.desktop_workspaces/<buildId>` and artifacts under `.desktop_artifacts/<buildId>`, all paths through the shared `pathSecurity` validators; traversal rejected (tests 3.1–3.2). |
| 8 | Integration with existing agents and project lifecycle | Router mounted at `/api/builds/:id/desktop` with the same auth + ownership dependencies as Phase 17; config persists on the `Build` record (`desktopConfig`); generated files live in the build's normal file store. |
| 9 | No fake executables or simulated build results | The pipeline reports success only when `dotnet build` exits 0 **and** a harvested `.exe` parses as a genuine PE. Evidence: `FitTrack.exe`, 152,064 bytes, sha256 `041526279323d91b2f6abfcd54b1968b781ec85921f1947125a80a937d99bf01`, x64 Windows GUI, 6 sections (also confirmed by the `file` utility). Broken source fails with real compiler diagnostics and no artifacts. |

## Test evidence

- Phase 18 suite: **14/14 pass** (`tests/phase18_desktop_engine.test.ts`)
- Lint (`tsc --noEmit`): ✅
- Production web build: ✅
- Genuine build: SDK 8.0.428, restore + build exit 0, PE-verified `.exe` (above)

## Known limitations

Windows-first only; no SquadForge-hosted debugger UI; the Windows GUI cannot be executed on this Linux verification host; Release configuration path implemented but only Debug exercised. Full detail in `PHASE_18_PROGRESS.md`.

## Acceptance

Pending the owner's review, per the repository's phase process.
