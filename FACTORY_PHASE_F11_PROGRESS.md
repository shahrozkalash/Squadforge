# Factory Phase F11 — Desktop & OS Tools Workflow: Progress

Date: 2026-11-28. Status: **implemented and verified locally; not
pushed.** Companion: `FACTORY_PHASE_F11_ACCEPTANCE_REPORT.md`.

## Audit map

### Desktop applications

| Piece | What exists | Source |
| :--- | :--- | :--- |
| Team / profile | `desktop_application` → Desktop Software Team, profile `desktop_application`, verifier `claude` via the registry | F5 `CategoryTeamRegistry` |
| Generator | `DesktopProjectGenerator`: Windows = WinForms (`getDefaultConfig`, 11 files), Linux = Avalonia (`getLinuxDefaultConfig`, 13 files), same app shape (entry point, state store, `--smoke` headless mode on Linux); macOS configs rejected by name in `validateConfig` | Phases 18/36 |
| Build pipeline | `DesktopBuildPipeline`: materializes the project into an isolated workspace, `dotnet restore` + `dotnet build`, harvests executables and format-verifies each (PE via `PeInspector`, ELF via `ElfInspector`) | Phases 18/36 |
| Environment | F6 desktop adapter: workspace store, build → pipeline, test cycle → compile + apphost `--smoke` (persisted `LaunchCount` read back), export → harvested exe re-hashed from disk, deploy → config + artifact dry-run; preview / requestDeployment are named unsupported errors | F6 |
| Release system | `ReleasePackager.publishProject` (genuine `dotnet publish -r win-x64`) + `packageRelease` (SHA-256 manifest, PE-verified exe entry, generated ICO, honest signing status) + `validatePackage` (7 steps incl. file-hashes tamper detection) | Phase 23 |
| Delivered artifact | Linux: ELF apphost + dependency files. Windows: versioned release ZIP + manifest via the release store format | |
| Execution proof | Linux: build verdict + `--smoke` runs (SMOKE_OK, LaunchCount persistence). Windows: publish + PE/package evidence only — a Windows GUI binary cannot execute on this host | Phases 36/57/60 record |

### OS / CLI tools

| Piece | What exists | Source |
| :--- | :--- | :--- |
| Team / profile | `cli_tool` → Developer Tools Team — CLI, profile `cli_tool_developer_utility`, verifier `claude` via the registry | F5 |
| Generation | **No deterministic generator module exists** (unlike desktop/Android/iOS). The category is served by the Phase 9 generation profile — file organization (`bin/cli.ts`, `src/cli/commandParser.ts`, `src/cli/commands/{run,init}.ts`, `src/cli/formatter.ts`, `src/types/cli.ts`), required contracts (`CliCommand`, `CliOption`, `CliExecutionResult`, `TerminalFormatOptions`), conventions (standard exit codes 0/1/2, `--help`/`--version`, clean missing-argument handling without stack traces) — and the swarm writes the files | Phase 9 profile |
| Environment | F6 web adapter (store-backed). A `bin/cli.ts` entry is not a bundle entry the web build recognises, so contract build reports `skipped` (surfaced as-is, the F7/F10 precedent); the project's own tests run through the platform test gate | F6 |
| Delivered artifact | The tool project tree + the environment's export ZIP | |
| Execution proof | The tool is materialized into a scratch directory and **executed** with the platform's own tsx runner (the F9 pattern): stdout, exit codes and file effects asserted against a fixture log with known level counts, plus the two clean-failure cases | F11 gate |

## Workflow wiring (new code)

- `server/desktop/desktopWorkflow.ts` — `DesktopWorkflow`:
  `plan()` (F5 data) → `runEnvironmentCycle()` reads the swarm
  build's delivered tree from the store, opens it through the F6
  **desktop** environment (seeded with the delivered files), then
  build → two `runTests` smoke runs → export → deployment dry-run,
  and finally the Windows package for the same app identity through
  the gate. `verifyDelivery()` is the factored verdict.
- `server/desktop/desktopProjectGate.ts` —
  `assessDesktopDelivery()` (checks: pipeline-build, smoke-runs,
  smoke-state-persistence — LaunchCounts strictly increasing across
  the two runs — artifact-elf, deployment-dry-run,
  windows-publish, windows-package-validation,
  windows-package-tamper-detection) and `verifyWindowsPackage()`
  (materialize the generator's Windows variant → publish → package
  → validate → tamper a packaged file's bytes → require the
  validator's file-hashes step to reject the copy).
- `server/ide/cliWorkflow.ts` — `CliToolWorkflow`: `plan()` →
  `runEnvironmentCycle()` through the F6 web contract (open, build,
  test, preview, export, files read back through the contract) →
  CLI gate → verdict.
- `server/ide/cliToolGate.ts` — `verifyCliTool()`: structure
  (package.json bin entry delivered), then eight execution cases
  against the gate's fixture log (INFO 3 / WARN 1 / ERROR 3 /
  DEBUG 1 / OTHER 1, total 9): `--help`, `--version`, summarize
  (exact counts on stdout), `--out report.json` (file appears,
  parses, counts match), `init` (creates a sample the tool itself
  then summarizes), missing argument (exit 1, message, no stack
  trace), missing input file (exit 1, names the file, no stack
  trace). Scratch is always removed; a stack trace is detected by
  pattern, `UnhandledPromiseRejection`, and `node:internal` markers.
- Both modules are exported from their package indexes
  (`server/desktop/index.ts`, `server/ide/index.ts`). No other
  existing code was modified except the two defect fixes below.

## Defects found by the F11 suite and fixed

1. **The desktop pipeline ignored any artifacts root but its own,
   so the F6 adapter's `artifactsRoot` option produced false
   paths.** `DesktopBuildPipeline` hardcoded harvesting to
   `<cwd>/.desktop_artifacts/<buildId>` while
   `DesktopEnvironmentAdapter` reported artifact paths under its
   configured root — with a non-default root, `exportArtifact`
   threw "build reported success but no artifact file exists on
   disk" (the F11 suite's first run, custom scratch roots; F6 used
   the default roots, where the two coincide). Fix:
   `DesktopBuildOptions.artifactsRoot` (optional; default
   unchanged), the pipeline harvests under it, and the adapter
   passes its own root through. F6's suite (default roots) still
   passes 10/10; Phases 18/36 pipelines callers are untouched
   (routes pass no root).
2. **The IntegrationAgent judged a Node project's local modules as
   browser files.** Its browser-dependency scan exempted only
   recognized Node roots (server/test files and package.json script
   entries) — a CLI tool's command modules, imported only by the
   entry point, were scanned as browser code and their `fs`/`path`
   imports flagged as broken contracts; the completion chain then
   spawned `[Integration Fix] Resolve broken contract: fs/path`
   tasks and the build failed. Fix (in
   `server/swarm/integrationAgent.ts`): the exemption now covers
   the transitive closure of relative imports from the Node roots
   — a Node entry's local modules are server code wherever they
   live, per `nodeEntryFiles`' own stated intent. Files unreachable
   from any Node root are scanned exactly as before; the F4
   gauntlet (broken import graph, integration probe) still passes
   11/11. Fixture-side, the tool's package.json declares a natural
   `"start": "tsx bin/cli.ts"` script, which is what makes
   `bin/cli.ts` a recognized Node entry in the first place.

## Test evidence

Suite: `tests/factory_phase_f11_desktop_tools.test.ts` (**3/3**).

- **Desktop end-to-end:** plan asserts the Desktop Software Team /
  `desktop_application` profile / verifier `claude`; the swarm
  build completes classified `desktop_application`, verifier
  approved, all sandbox checks clean, the delivered tree
  byte-identical to the generator's Avalonia output for
  NoteKeeper. Contract cycle: build `succeeded`; two smoke runs
  `passed` (`compile_and_smoke`, SMOKE_OK in both details) with
  persisted **LaunchCount [1, 2]**; exported artifact is an ELF
  executable (magic bytes asserted) whose SHA-256 matches the
  bytes on disk; deployment dry-run `valid`. Gate: all 8 checks
  green, incl. the Windows half — publish produced a PE-verified
  `NoteKeeper.exe`, manifest files all SHA-256 hashed,
  `validatePackage` valid, signing status `not-requested`, and a
  byte-tampered package copy rejected at the file-hashes step.
  `verified === true`.
- **CLI end-to-end:** plan asserts the Developer Tools Team — CLI /
  `cli_tool_developer_utility` profile / verifier `claude`; the
  swarm build completes classified `cli_tool` with the fixture
  tree byte-identical. Contract cycle: build `skipped` (bin entry,
  reported as-is), the tool's own 5-test suite `passed` through
  the platform test gate, artifact ZIP hash matches disk bytes.
  Execution gate: all 8 cases green — the delivered logsum ran
  under the platform tsx and produced the exact fixture counts,
  the JSON report file with matching counts, a working `init`,
  and both clean failures at exit 1 with no stack traces.
  `verified === true`.
- **Broken variants:** uncompilable C# appended to `Program.cs` →
  desktop contract build `failed` with diagnostics, test cycle
  `failed` ("Compilation failed"), dry-run invalid, and
  `assessDesktopDelivery` refuses the delivery (pipeline-build
  check false) even with the genuine Windows report from the
  happy path in evidence. A CLI entry that throws uncaught →
  execution gate fails (help and summarize cases false) and
  `verifyDelivery` refuses.

## Verification (printed summaries)

- F11 suite **3/3** · F6 contract **10/10** · Phase 36 **17/17** ·
  Phase 18 **14/14** · Phase 23 **7/7** · Phase 22 **14/14** ·
  F2 gauntlet **5/5** · F4 gauntlet **11/11** · orchestration
  **22/22** (the F2-fixed :334 stays green) · F10 **3/3**.
- `npm run lint` (tsc --noEmit) clean; `npm run build` succeeds.

## Limitations

- Stub transport throughout (F1 verdict stands — no live model
  here). The desktop content is the platform's own generator
  output, labelled as such; the CLI tool is a labelled fixture in
  the generation profile's shape (no deterministic CLI generator
  exists to draw from).
- The generated desktop GUI has never been run — no display
  exists here. Linux run evidence is the generated app's own
  `--smoke` state-store exercise; the Windows exe is publish- and
  package-verified only and cannot execute on this host. macOS
  remains honestly rejected by the generator.
- The Windows variant is packaged from the generator's output for
  the same app identity (the release system's designed input —
  Phase 23's own evidence style), not from a second swarm build;
  the swarm-delivered tree is the Linux variant that the desktop
  environment builds and launches.
- The CLI gate's cases are shaped to the generation profile's
  declared surface (bin entry, summarize-style command set); the
  structure case fails loudly on a project that does not follow
  the profile rather than guessing another interface.
- Desktop packaging beyond the Phase 23 ZIP (installers, signing)
  keeps Phase 23's standing record: installer scripts are
  generated data, signing is honestly `not-requested` /
  unavailable on this host, never fabricated.
