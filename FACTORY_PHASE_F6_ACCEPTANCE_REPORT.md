# Factory Phase F6 — One Environment Contract: Acceptance Report

Date: 2026-11-27. Status: **implemented and verified locally; not
pushed.** Companion: `FACTORY_PHASE_F6_PROGRESS.md` (full audit table
and design record).

## What was delivered

One environment contract — `FactoryEnvironment`
(`server/environment/environmentContract.ts`, 12 operations) — with
two adapters that wire the existing subsystems and reimplement
nothing:

- **Web** (`webEnvironment.ts`): store-backed. db project files,
  `ExecutionAdapter` build/test/typecheck, `PreviewGenerator`,
  `ProductionBuilder`, `PreDeploymentValidator` + `DeploymentService`.
- **Desktop** (`desktopEnvironment.ts`): workspace-backed. A
  per-project workspace store (the store the desktop engine never
  had), `DesktopBuildPipeline` builds, compile + `--smoke` test
  cycle, harvested-artifact export, config + artifact-format deploy
  dry-run.

Plus `createEnvironment()` factory (`server/environment/index.ts`)
and the suite `tests/factory_phase_f6_environment_contract.test.ts`
(**10/10**).

## Acceptance criteria (roadmap) — verdicts

1. **Lifecycle suite passes for both proof categories through the
   same environment API, no category-specific back doors.** ✅
   One driver function (`runLifecycle` in the suite) runs open →
   file round-trip → build → test → preview → export → deploy
   dry-run → unapproved deploy request → diagnose → status against
   both adapters, calling only contract operations. Shared
   assertions hold for both: byte-identical round-trip, missing file
   reads as `null`, build `succeeded`, test cycle `passed` with ≥1
   real check, export a non-empty artifact with a SHA-256, deploy
   dry-run `valid`, status consistent with the file listing.
   The web project is a real fixture app (esbuild-bundled build, its
   own node:test suite through the platform test gate, generator
   preview, ProductionBuilder ZIP). The desktop project is a genuine
   generated Avalonia app: real `dotnet build`, ELF-verified
   apphost, `--smoke` executed with SMOKE_OK + persisted LaunchCount
   read back.
2. **Deploy step is a validated dry-run against the existing
   adapters; the approval gate is enforced — a request without
   approval does not deploy, asserted.** ✅
   `validateDeployment` runs `PreDeploymentValidator` + adapter
   credential validation (web) / config + artifact re-verification
   (desktop) and creates nothing. The gate is asserted end-to-end:
   the lifecycle's unapproved production `requestDeployment` returns
   `pending_approval`; the test then proves
   `db.getDeployment(id).status === 'pending_approval'` **and**
   `staticHostRegistry.has(id) === false` (the hosting adapter was
   never reached), and that the same flow with `approved: true`
   reaches `active` with a target URL and a registry entry.
3. **Execution stays sandbox-only — a test asserts project code
   never runs on a plain host process.** ✅
   The suite asserts the configured backend here is the
   `DisabledBackend` (capabilities unavailable, `startProcess`
   refuses by name), and — with the trusted-fixture seam removed —
   that a fixture test whose only job is writing a marker file is
   reported as an honest sandbox **skip** and the marker never
   appears, including after a `build()` of the same project
   (bundling is compilation, not execution). The contract adds no
   host-execution path; the web test gate remains the platform's
   own (recorded sandbox runs, or this repo's trusted fixtures).
4. **Phase 10/15/32 suites pass; lint and build pass; AGENTS.md
   open items updated with the decision taken.** ✅ with one
   documented flake: the batch run (Phase 10 ×3, 15 ×2, 32,
   orchestration, Phase 4 — 194 tests) failed only two Phase 15
   tests on their fixed 400 ms pipeline wait under parallel load;
   the Phase 15 management suite passes standalone **24/24**, the
   known load-flake pattern, and F6 changed no existing code. Lint
   clean; vite build succeeds. The worker/preview-domain/guest
   decisions are recorded in `FACTORY_PHASE_F6_PROGRESS.md` and the
   AGENTS.md F6 row.

## Brief criteria — verdicts

- **Same cycle script, equivalent observable results, pass and fail
  cases.** ✅ Both adapters run the identical driver; a second
  uniform driver (`assertBreakAndRecover`) corrupts one project
  file per environment (a failing test file on web, broken C# on
  desktop), asserts the test cycle reports `failed`, restores the
  file through the contract, and asserts `passed` again.
- **Contract conformance by introspection.** ✅ The suite checks
  every name in `ENVIRONMENT_OPERATIONS` is a function on both
  adapter instances and that `capabilities()` covers exactly that
  set.
- **Named unsupported errors, never silent fake success.** ✅
  Desktop `preview` and `requestDeployment` throw
  `EnvironmentOperationUnsupportedError` (asserted: instance, name,
  `code`, environment, operation, non-empty reason), and
  `capabilities()` reports both as unsupported with the same
  reasons.

## Per-operation verdicts

| Operation | Web | Desktop |
| :--- | :--- | :--- |
| openProject | ✅ build record + seeded files | ✅ workspace + generated project seeded |
| writeFile / readFile / listFiles | ✅ db round-trip byte-identical | ✅ workspace round-trip byte-identical |
| build | ✅ esbuild bundle validation, succeeded | ✅ real dotnet build, ELF-verified apphost |
| runTests | ✅ project tests via platform gate (pass + fail proven) | ✅ compile + real `--smoke` execution (pass + fail proven) |
| preview | ✅ generator HTML, mode self-labelled | ❌ named unsupported (no display; GUI never run headlessly) |
| exportArtifact | ✅ ProductionBuilder ZIP + SHA-256 | ✅ harvested apphost, SHA-256 from disk bytes |
| validateDeployment | ✅ validator + credential dry-run | ✅ config + artifact re-verification dry-run; win-x64 packaging gap stated in the result |
| requestDeployment | ✅ gate held unapproved / executed approved | ❌ named unsupported (Phase 23 release system has no gated deployment request) |
| diagnose | ✅ real tsc diagnostics (0 on the clean fixture) | ✅ recorded MSBuild diagnostics from the last build |
| getStatus | ✅ build record + event log + last verdicts | ✅ workspace status record + event log |

## Limitations

- The desktop test cycle is compile + smoke by design: generated
  desktop projects ship no unit-test suite, and F6 does not invent
  one. The result's `mode` field (`compile_and_smoke`) states this
  wherever the verdict is consumed.
- Desktop deploy remains a dry-run story: the Phase 23 packager is
  win-x64-only, so Linux desktop targets have no server-side
  packaging adapter. F6 surfaces this in the dry-run result instead
  of fixing it — a Linux packaging adapter is new scope, not
  contract wiring.
- The web adapter's build is the platform's bundle *validation*
  (no persisted bundle artifact); the deployable web artifact comes
  from `exportArtifact`, as in the platform today.
- Web `lastBuildStatus`/`lastTestStatus` are adapter-instance
  records (the platform does not persist these reports); the build
  record and event log in `getStatus` are the platform's own.
- Sandbox preview sessions (`PreviewSessionService`) still require
  a Docker worker that does not exist here; the contract's web
  preview is the generator preview, the only one this host can
  produce — its mode label (`fallback_preview` included) is passed
  through unedited.
- No GUI claim is made anywhere: the desktop GUI remains
  compile-verified only (Phases 36/57 standing record).
