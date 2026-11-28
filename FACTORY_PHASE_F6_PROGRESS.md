# Factory Phase F6 — One Environment Contract: Progress

Status: **implemented and verified locally on 2026-11-27.** Not pushed.
Companion: `FACTORY_PHASE_F6_ACCEPTANCE_REPORT.md`.

## Objective (from UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md)

Consolidate the existing execution, preview, testing, debugging, and
deployment subsystems behind one environment contract every category
workflow uses, and close the environment-level open items recorded in
`AGENTS.md` (production worker decision, preview domain) as documented
decisions or proven runs. Proof: a two-category lifecycle (one web
project, one desktop project) through execute → preview → test →
deploy-dry-run, driven through the same environment API.

## Audit — the two surfaces as they actually were

The platform had two complete but unrelated environment surfaces,
built in different eras, with no shared API:

| Operation | Web surface (before F6) | Desktop surface (before F6) |
| :--- | :--- | :--- |
| Project store | `db` (`server/store.ts`): build records + files in SQLite, per-user | None at engine level. `DesktopProjectGenerator` produces a files map; routes mirror files into `db` for the UI, but the engine's working form is the materialized workspace |
| Open / files | `db.saveBuild` / `db.setFile` / `db.getFile` / `db.getAllFiles` | `DesktopBuildPipeline` writes the files map into `.desktop_workspaces/<buildId>` (path-security guarded) as a build side effect; no standalone file API |
| Build | `ExecutionAdapter.runProductionBuild` — esbuild bundle validation in a temp dir (passed/failed/skipped-no-entry) | `DesktopBuildPipeline.build` — real `dotnet restore` + `dotnet build`, parsed MSBuild diagnostics, artifacts harvested to `.desktop_artifacts/<buildId>` |
| Test cycle | `ExecutionAdapter.runIsolatedTests` — the platform test gate: verdict from a sandbox test run recorded by `ExecutionSessionManager` (`db.getSandboxTestRun`), or this repo's own trusted fixtures on host; honest skip otherwise. Generated tests never run on the host | No test-suite concept in generated projects. Verification = compile + the generated app's headless `--smoke` run (Phase 36: exercises the app state store, persists LaunchCount) |
| Preview | `PreviewGenerator.generateInteractivePreview` → self-labelled HTML (`real_application` / `static_html` / `fallback_preview`); plus sandbox preview sessions (`PreviewSessionService`) when a Docker worker exists | None. Native GUI (Avalonia/WinForms); no display on this host; the GUI has never been run headlessly (Phases 36/57 platform record) |
| Export artifact | `ProductionBuilder.buildProject` — production ZIP + SHA-256 (Phase 15) | The harvested build artifacts themselves (apphost + DLLs + manifests, SHA-256 from the pipeline) |
| Deploy | `DeploymentService` — 6 adapters, `PreDeploymentValidator`, production approval gate via `ApprovalGateService` (Phase 15/33) | Phase 23 `ReleasePackager` (`dotnet publish` → versioned ZIP + manifest) + `validatePackage` 7-step validation + `ReleaseStore` channels. **Windows-only: `publishProject` hardcodes `-r win-x64`** |
| Diagnose | `ExecutionAdapter.runTypeCheck` (real tsc diagnostics), `validateSyntax`, `auditSecurity` | The pipeline's parsed compiler diagnostics, returned per build call only |
| Status / events | Build record + `db.getEvents` (the swarm event log) | Nothing persisted — pipeline logs/diagnostics exist only in the build call's return value |

### Audit findings that shaped the contract

1. **The ExecutionBackend pattern is the house style** for exactly
   this problem (interface + result records + a DisabledBackend that
   refuses honestly). The contract mirrors it instead of inventing a
   foreign shape.
2. **Desktop deployment has a real gap, not a naming difference:**
   the Phase 23 packager publishes `win-x64` only, so a Linux-target
   desktop project has no server-side packaging adapter (Phase 60
   packaged the Linux app via `scripts/phase60-release.ts`, a repo
   script). F6 states this in the adapter's dry-run output rather
   than routing desktop projects through the web deployment service,
   whose `ProductionBuilder` would mangle C# sources into a "static
   site" — a fake capability.
3. **Desktop preview does not exist** and cannot be simulated
   honestly. The contract therefore needs a first-class refusal: a
   named, coded error, reported by `capabilities()` and thrown by the
   operation.
4. **The desktop test cycle is compile + smoke**, and that is a
   genuine verdict (Phase 36 proved both halves, including the
   broken-C# failure). The contract's test result carries a `mode`
   field so the adapter states which verification actually ran.

## What was built

New module `server/environment/` (no existing code modified):

- `environmentContract.ts` — the `FactoryEnvironment` interface: 12
  operations (`openProject`, `writeFile`, `readFile`, `listFiles`,
  `build`, `runTests`, `preview`, `exportArtifact`,
  `validateDeployment`, `requestDeployment`, `diagnose`,
  `getStatus`), the `ENVIRONMENT_OPERATIONS` list, result records,
  `EnvironmentCapabilities`, and
  `EnvironmentOperationUnsupportedError` (name + `code` +
  environment/operation/reason as data).
- `webEnvironment.ts` — `WebEnvironmentAdapter` (store-backed).
  Delegates only: db for files/status/events,
  `ExecutionAdapter.runProductionBuild` / `runIsolatedTests` /
  `runTypeCheck`, `PreviewGenerator`, `ProductionBuilder`,
  `PreDeploymentValidator` + `DeploymentService`. Files read from the
  store are copied before use (the AGENTS.md live-object rule).
- `desktopEnvironment.ts` — `DesktopEnvironmentAdapter`
  (workspace-backed). Gives the desktop engine the project store it
  never had: one directory per project under `.desktop_projects/`
  (manifest + files + an adapter-kept status/event record), guarded
  by the same `pathSecurity` helpers the pipeline uses. Build
  delegates to `DesktopBuildPipeline`; the test cycle reuses the
  recorded build when the workspace file-hash is unchanged, then
  executes the harvested Linux apphost with `--smoke` for real
  (per-project `XDG_CONFIG_HOME`, state store read back); export
  re-hashes the artifact bytes on disk; the deploy dry-run runs
  generator config validation + ELF/PE re-verification of the
  harvested artifacts and states the win-x64 packaging limitation.
  `preview` and `requestDeployment` throw the named unsupported
  error with the recorded reasons.
- `index.ts` — `createEnvironment(kind, options)` factory +
  `listEnvironmentKinds()`, wired the way `server/execution/index.ts`
  wires its backend.

## Decisions closing the AGENTS.md environment open items

Recorded here and in the AGENTS.md F6 status row (Open work item 3):

1. **Production worker:** none is provisioned, and none is implied.
   Project execution stays opt-in: an operator points
   `EXECUTION_BACKEND=docker` at a TLS + gVisor worker they provision
   (the Phase 32 configuration, CI-proven in run 45669432584). The
   default remains the `DisabledBackend` — execution fails closed
   with an audited reason. F6's invariant test pins this on this
   host: backend name `disabled`, capabilities unavailable,
   `startProcess` refuses.
2. **Preview domain:** no production preview domain is set.
   `PREVIEW_BASE_DOMAIN` remains an operator setting; the preview
   listener only starts when a worker is configured, and preview
   links are the Phase 32 HMAC-signed, session/owner-bound tokens
   when it is. In development the existing default
   (`preview.localhost`) stands. No code change was needed — the
   decision is that this stays operator-owned, not platform-assumed.
3. **Guest execution:** no guest execution path is added. Execution
   remains behind the configured backend and the platform's
   authenticated flows; the contract changes neither.

## Verification (exact counts, printed summaries)

- `tests/factory_phase_f6_environment_contract.test.ts` — **10/10**
  (conformance 3, web lifecycle 3, desktop lifecycle 2, sandbox-only
  invariant 2). The desktop lifecycle performs 3 genuine dotnet
  builds (clean, broken, restored) plus real `--smoke` executions.
- Regression in one batch: Phase 36 + Phase 57 + F2 gauntlet —
  **32/32**.
- Roadmap-named suites in one batch (Phase 10 ×3, Phase 15 ×2,
  Phase 32, orchestration, Phase 4) — 194 tests; the only failures
  were two Phase 15 deployment-management tests
  (`releasing approved deployment…`, `Docker container adapter…`)
  failing on their fixed 400 ms pipeline wait under 8-file parallel
  load (status still `building`). **Both pass in isolation: the
  Phase 15 management suite standalone is 24/24.** This is the load
  flake pattern AGENTS.md already records for Phase 33; F6 modified
  no existing code, and the two tests F2 fixed
  (`orchestration.test.ts:334`, phase4 test 19) passed in every run.
- `npm run lint` (tsc --noEmit) — clean. `npm run build` (vite) —
  succeeds.
