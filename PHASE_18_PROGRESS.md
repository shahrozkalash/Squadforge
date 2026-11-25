# Phase 18 Progress — Desktop Development Engine

Date: 2026-11-25
Baseline: `4e8a596` (main, after the Phase 17 CI workflow commit)
Status: **Implemented and verified, including a genuine local build of a generated Windows executable.** Acceptance is the owner's decision.

## What was built

`server/desktop/` — a new module mirroring the Phase 17 architecture:

- `types.ts` — `DesktopProjectConfig` (with a `platform` field: Windows first, Linux/macOS reserved), build options/results, diagnostics, PE report types.
- `desktopProjectGenerator.ts` — generates a real C# / .NET 8 / WinForms project: `.sln`, `.csproj` (`net8.0-windows`, `UseWindowsForms`, `RuntimeIdentifier win-x64`, `EnableWindowsTargeting`), `Program.cs` (STAThread entry), `MainForm.cs` + Designer (working form with JSON state persistence to %AppData%), `app.manifest`, `Directory.Build.props`, build scripts (`.ps1`/`.sh`), README, `.gitignore`. Config validation rejects invalid assembly names and — honestly — non-Windows platforms until their generators land. `detectDotnet()` / `listSdks()` perform real toolchain detection (DOTNET_ROOT, PATH, standard locations), never hardcoded success.
- `desktopBuildPipeline.ts` — isolated workspace under `.desktop_workspaces/<buildId>` using the shared `pathSecurity` validators; writes project files, runs `dotnet restore` (NuGet dependency management) and `dotnet build`, harvests `.exe`/`.dll` artifacts to `.desktop_artifacts/<buildId>`, and refuses success unless a PE-valid `.exe` exists.
- `peInspector.ts` — a genuine PE parser (DOS `MZ` header, `PE\0\0` signature, COFF header, optional-header subsystem). Rejects non-PE data.
- `desktopRoutes.ts` — `/api/builds/:id/desktop` router (generate, status, build, artifact download), mounted in `server.ts` with the same `requireAuth` + `verifyBuildOwnership` dependencies as the Android router. Artifact storage uses the shared scoped-path validators; downloads re-validate PE structure for `.exe` files.
- `server/types.ts` — `desktopConfig` / `desktopBuilds` fields on `Build`.

## Genuine build evidence (this host, 2026-11-25)

Toolchain provisioned for verification: .NET SDK **8.0.428** (Temurin-equivalent Microsoft distribution via the official install script). Unlike Java on this VM, .NET's networking is not restricted — a NuGet restore of Newtonsoft.Json 13.0.3 succeeded and a probe console app ran.

The pipeline compiled the generated `FitTrack` project end-to-end:

- `dotnet restore` exit 0; `dotnet build -c Debug` exit 0
- `FitTrack.exe` — **152,064 bytes**, sha256 `041526279323d91b2f6abfcd54b1968b781ec85921f1947125a80a937d99bf01` (identical across two independent builds — deterministic)
- PE inspection: **x64 (AMD64), Windows GUI subsystem, 6 sections**; `file` independently reports `PE32+ executable (GUI) x86-64, for MS Windows`
- `FitTrack.dll` — 8,704 bytes
- Broken-C# negative test: pipeline returns `failed` with real compiler output and zero artifacts.

One real bug was found and fixed during verification: the pipeline initially called `assertSafeWorkspacePath` with arguments in the wrong order (the shared validator takes root-then-relative-target); the first driver run failed honestly on it, the call was corrected to match the Phase 17 usage, and the build then succeeded. A second lesson is baked into the generator: without a pinned `win-x64` RID, a non-Windows host emits an extensionless apphost instead of the Windows `.exe` — the csproj template now pins the RID.

## Tests

- `tests/phase18_desktop_engine.test.ts` — **14/14 pass**: generation structure, real-app source checks, manifest levels, config validation, honest platform rejection, workspace isolation/traversal, PE parser positive/negative, toolchain honesty, genuine build (adaptive: honest failure when no SDK), broken-source failure.
- `npm run lint` (tsc) ✅ · `npm run build` (production web build) ✅

## Limitations

- Windows only: Linux/macOS configs are rejected with an explicit "not yet supported" error; the platform field and module layout are ready for their generators.
- The generated app is a foundation (one form, state persistence) — debugging integration is the standard .NET workflow (VS/VS Code F5, documented in the generated README); SquadForge does not yet attach its own debugger UI.
- The built `.exe` runs on Windows; this Linux host can compile and PE-verify it but cannot execute a WinForms GUI. Execution on the host is therefore not claimed.
- Release configuration uses the same pipeline path (`configuration: 'Release'`); only Debug was exercised in the verification run.
