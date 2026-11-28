# Factory Phase F11 — Desktop & OS Tools Workflow: Acceptance Report

Date: 2026-11-28. Verdict: **the roadmap's F11 acceptance
criteria are met by genuine execution evidence on this machine,
with two scope limits carried honestly: the generated GUI is
never run (no display exists here; run evidence is the app's own
`--smoke` state exercise), and the Windows executable is publish-
and package-verified only — it cannot execute on this host.**
Companion: `FACTORY_PHASE_F11_PROGRESS.md` (audit map, wiring,
defect fixes). All counts below are from printed suite summaries.
Staged locally, **not pushed**.

## Roadmap criteria (UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md, F11)

| # | Criterion | Verdict | Evidence |
| :- | :--- | :--- | :--- |
| 1 | Windows package: genuine `dotnet publish` output, PE-verified exe, SHA-256 manifest, Phase 23 package/install validation passes incl. tamper detection | **PASS** | The gate publishes NoteKeeper's Windows variant with the platform's own `ReleasePackager`: exe PE-verified by `PeInspector`, manifest files all SHA-256 hashed, `validatePackage` returns valid, and a byte-tampered copy of the package is rejected by the validator's file-hashes step. Signing status reported as the packager reports it: `not-requested` |
| 2 | Linux package: ELF-verified apphost that actually launches (`--smoke` state persistence, Phase 36/60 style) | **PASS** | The swarm-delivered Avalonia tree builds through the desktop environment; two `--smoke` runs succeed with the persisted launch counter advancing **1 → 2** (read back from the app's own state file by the adapter); the exported apphost's ELF magic is asserted from its bytes and its SHA-256 matches the file on disk; the deployment dry-run is valid |
| 3 | An OS-tool variant (CLI utility) built with real output on fixture input asserted | **PASS** | The delivered `logsum` CLI is materialized into a scratch dir and executed with the platform's tsx: exact level counts on the gate's fixture log (INFO 3 / WARN 1 / ERROR 3 / DEBUG 1 / OTHER 1, total 9) asserted on stdout, the `--out` JSON report file created and count-matched, `init` creating a summarizable sample, `--help`/`--version` correct |
| 4 | Phase 18/22/23/36 suites pass; lint and build pass | **PASS** | Phase 18 **14/14**, Phase 22 **14/14**, Phase 23 **7/7**, Phase 36 **17/17**; `npm run lint` clean; `npm run build` succeeds |

## Brief criteria

| Criterion | Verdict | Evidence |
| :--- | :--- | :--- |
| (a) Desktop end-to-end green | **PASS** | Suite test 1: F5 team data (Desktop Software Team, `desktop_application` profile, verifier `claude`) → swarm build classified `desktop_application`, verifier-approved, sandbox-clean, tree byte-identical to the generator's output → desktop-environment cycle (build + two smoke runs + export + dry-run) → gate 8/8 checks → `verified` |
| (b) CLI end-to-end green incl. execution evidence | **PASS** | Suite test 2: F5 team data (Developer Tools Team — CLI, `cli_tool_developer_utility`, verifier `claude`) → swarm build classified `cli_tool` → web contract cycle (build honestly `skipped` for a bin entry; the tool's own 5 tests pass through the platform gate; artifact hash matches disk) → execution gate 8/8 cases → `verified` |
| (c) Broken variants refused | **PASS** | Suite test 3: uncompilable desktop source → contract build/test cycle failed with real diagnostics, gate refuses (pipeline-build false) even alongside genuine Windows evidence; uncaught-throw CLI entry → execution gate fails its help/summarize cases, `verifyDelivery` refuses |
| CLI error case is a declared failure, not a crash dump | **PASS** | Missing argument and missing input file both exit **1** with a readable stderr message (the missing-file case names the file) and no stack trace, `UnhandledPromiseRejection`, or `node:internal` marker — asserted by pattern |

## Claim table

| Claim | Status | Basis |
| :--- | :--- | :--- |
| A desktop description flows F5 team → swarm → desktop contract → gate to a verified delivery | **PROVEN** | Suite test 1, all assertions green |
| The delivered Linux desktop app genuinely builds (real dotnet) and its apphost launches headlessly with persistent state | **PROVEN** | Pipeline build verdict + two `--smoke` runs, LaunchCount [1, 2] |
| The exported desktop artifact is the harvested binary, hash-pinned | **PROVEN** | ELF magic from bytes; SHA-256 equals the on-disk file's hash |
| The Windows package for the same app is genuinely published, PE-verified, hash-manifested, validation-clean, and tamper-evident | **PROVEN** | Phase 23 packager + validator + the gate's tamper copy, all in suite test 1 |
| A CLI description flows F5 team → swarm → contract → execution gate to a verified delivery | **PROVEN** | Suite test 2, all assertions green |
| The delivered CLI genuinely executes its declared behaviour, incl. file effects and clean failures | **PROVEN** | 8 gate cases executed against the delivered files in a scratch dir |
| Broken desktop and CLI variants fail their gates | **PROVEN** | Suite test 3 |
| The generated desktop GUI runs / renders | **NOT CLAIMED** | No display exists here; `--smoke` exercises the app's state store headlessly, as Phases 36/60 established |
| The Windows executable runs | **NOT CLAIMED** | A WinForms exe cannot execute on this Linux host; publish/package evidence only (the Phase 23/57 standing limit) |
| macOS desktop delivery | **NOT CLAIMED** | The generator honestly rejects macOS configs; nothing in F11 changes that |
| CLI content is platform-generated | **LABELLED FIXTURE** | No deterministic CLI generator exists; the tool follows the Phase 9 profile's file organization and contracts exactly and is labelled a fixture, the F9 precedent |
| Desktop signing / installers | **NOT CLAIMED** | Phase 23's standing record: signing `not-requested`/unavailable here, installer scripts are generated data |

## Defects found and fixed (detail in the progress doc)

1. `DesktopBuildPipeline` ignored the F6 adapter's `artifactsRoot`
   (harvest hardcoded to `<cwd>/.desktop_artifacts`), so any
   non-default adapter root produced artifact paths pointing at
   files never written there. `DesktopBuildOptions.artifactsRoot`
   added (default unchanged); the adapter passes its root through.
2. `IntegrationAgent`'s browser-dependency scan exempted only
   Node entry files themselves, so a Node CLI's local command
   modules were flagged for importing `fs`/`path` and the build
   failed on phantom broken contracts. The exemption now covers
   the Node roots' transitive relative-import closure; unreachable
   files are scanned exactly as before (F4 gauntlet 11/11).

## Exact counts (printed summaries, this machine)

| Suite | Result |
| :--- | :--- |
| `tests/factory_phase_f11_desktop_tools.test.ts` | **3/3** |
| F6 environment contract | 10/10 |
| Phase 36 desktop Linux | 17/17 |
| Phase 18 desktop engine | 14/14 |
| Phase 23 release distribution | 7/7 |
| Phase 22 desktop IDE | 14/14 |
| F2 delegation gauntlet | 5/5 |
| F4 verification/repair gauntlet | 11/11 |
| Orchestration (incl. the F2-fixed :334) | 22/22 |
| F10 mobile workflow | 3/3 |
| `npm run lint` (tsc --noEmit) | clean |
| `npm run build` | succeeds |

## Limitations (standing, honest)

- Stub transport throughout (F1): no live model exists in this
  environment; desktop content is the platform's own generator
  output, the CLI tool a labelled profile-shaped fixture.
- GUI never run; Windows exe never executed; macOS rejected —
  see the claim table.
- The Windows variant is packaged from the generator's output for
  the same app identity (Phase 23's designed input), not from a
  second swarm build; the swarm-delivered Linux tree is what the
  desktop environment builds and launches.
- The CLI gate's execution cases follow the generation profile's
  declared surface; a project that does not follow the profile
  fails the gate's structure case loudly rather than being probed
  by guesswork.
