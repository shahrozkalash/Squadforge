# Factory Phase F10 — Mobile Workflow (Android / iOS): Progress

**Date:** 2026-11-28. Companion: `FACTORY_PHASE_F10_ACCEPTANCE_REPORT.md`.
Implemented and verified locally; not pushed. F11 not started.

## Audit map (the mobile path before F10)

**Android engine.** `server/android/` carries the Phase 17 base
(`androidProjectGenerator.ts` — project skeleton, Gradle wrapper
assets materialized from a bundled jar, `verifyWrapperAssets()`) and
the Phase 34/37 ClipForge video-editor generator
(`videoEditorGenerator.ts`, `getVideoEditorConfig()` →
`generateVideoEditorProject()` = 46 files: namespace/applicationId
`com.squadforge.clipforge`, compileSdk 35 — Media3 1.6.1's AAR
metadata demands it — targetSdk 34, minSdk 24, Media3 1.6.1 ×4,
`testImplementation` JUnit 4.13.2 + `org.json:json:20230618`).
`androidBuildPipeline.ts` performs genuine Gradle builds
(`assembleDebug` + `testDebugUnitTest`, `ApkInspector` apksigner
verification + SHA-256) — on hosts where a Gradle daemon can run.

**This host cannot run the Gradle daemon.** Java-initiated outbound
TCP is intercepted on this VM (recorded in the repo history), so
genuine Android builds are proven in GitHub Actions only: the Phase
34 workflow (`.github/workflows/phase34-android-video-editor.yml`)
runs `scripts/phase34-genuine-build.ts` and refuses to go green
unless the APK bytes are nonzero, `apksigner verification strictly
PASSED`, and exactly `UNIT_TESTS tests=19 failures=0 errors=0
skipped=0` — plus a broken-Kotlin negative step. The Phase 37
workflow extends the same project with the on-device EXPORT_VERIFY
gates (run #17: all 11 checks, APK 12,605,071 B, JVM 19/19).

**What local verification honestly existed before F10:** the Phase
34/37 suites pin the generator's file set and content statically;
Phase 37's local harness compiled generated sources with kotlinc for
its parity work. No single gate combined structure + manifest +
Gradle + resources + compilation + test execution over a delivered
project, and nothing connected the mobile engines to the F5 team /
F6 contract machinery as a workflow.

**iOS engine.** `server/ios/` (Phases 25/35):
`IosProjectGenerator.getDefaultConfig('FitTrack',
'com.squadforge.fittrack')` + `generateProjectFiles()` (13 files),
`IosProjectValidator.validateProjectFiles()` (structural: required
files, pbxproj isa objects, the `SDKROOT = iphoneos` guard, bundle
id, deployment target, Info.plist permission keys, AppIcon PNG
signature, `@main` App struct, NavigationStack, private-key scan),
and `IosBuildPipeline.detectEnvironment()` — on any non-macOS host
the build status is `environment-unavailable` with a reason naming
macOS and the Phase 25 workflow (`.github/workflows/
phase25-ios-verify.yml`, macos-15, `scripts/phase25-genuine-build.ts`;
CI run #5 evidence: FitTrack.app executable 72,232 B, Mach-O
universal x86_64+arm64, sha256 recorded).

**Teams (F5 data).** `CanonicalProjectType` (24 types) has exactly
two mobile entries — `android_application` and
`cross_platform_mobile` — both served by Mobile Development Teams
with profile `android_mobile_application`; every verifier resolves
through the registry to `claude`. **There is no iOS category, team,
or profile in the platform's category system**, and
`SoftwareRequirementsAnalyzer.detectCategory` checks multimedia
before mobile (a "video editor" description classifies
`multimedia_application`; `\b(ios app)\b` classifies
`cross_platform_mobile`). The F10 Android fixture description was
chosen to classify exactly `android_application` and to confirm
exactly one requirement ('Data export/import functionality', from
the import/export keywords) — verified by probe before the suite was
written.

## Workflow wiring (new code, F7/F9 pattern)

New: `server/android/mobileWorkflow.ts` (`MobileWorkflow`) and
`server/android/mobileProjectGate.ts` (the gate), both exported from
the existing `server/android/index.ts`. No existing code was
modified.

```
description → MobileWorkflow.plan()            (F5 team by data)
            → SwarmOrchestrator build          (F2–F4 chain + gates)
            → MobileWorkflow.runEnvironmentCycle() (F6 contract, web)
            → mobile gate                      (mobileProjectGate)
            → verified delivery verdict
```

- **Plan.** `CategoryTeamRegistry.selectForRequest` +
  `resolve` — the workflow stores no team data of its own.
- **Swarm build.** The platform's build entry point, driven by the
  caller. The F10 suite's fixture delivers the platform's own
  generated ClipForge project (44 text files; the binary wrapper jar
  and machine-specific `local.properties` are excluded because the
  build pipeline materializes/writes those itself — the exclusion is
  documented in the suite and the gate requires exactly the text
  set).
- **Environment cycle.** The built project is opened through the F6
  web environment and built / tested / previewed / exported through
  contract operations only. Outcomes are surfaced exactly as the
  adapter reports them: for a native Android tree the contract build
  reports `skipped` (no bundle entry point) and the contract test
  cycle reports `skipped` (no JS test discovery) — the project's
  real build and tests are the mobile gate's business, and the
  workflow says so in its documentation instead of borrowing the
  F7/F9 verdict shape unchanged.
- **Delivery verdict.** `verified` = mobile gate passed AND the
  contract export produced a non-empty artifact (SHA-256 re-verified
  against disk bytes in the suite).

## The mobile gate (`verifyAndroidProject` / `verifyIosProject`)

Android, over the delivered files:

1. **Structure** — the 16 required generated files are present.
2. **Manifest** — XML declaration, package present, INTERNET
   declared, the Phase 34 picker posture pinned (no
   READ/WRITE_EXTERNAL_STORAGE, no READ_MEDIA_* permissions),
   launcher activity with MAIN/LAUNCHER and `android:exported="true"`.
3. **Gradle** — namespace and applicationId equal the manifest
   package; compile/target/min SDK declared and ordered;
   testInstrumentationRunner present; the JUnit and org.json
   testImplementations the CI build resolves are declared;
   `settings.gradle.kts` includes `:app`; the wrapper properties
   name a Gradle distribution; `AndroidProjectGenerator
   .verifyWrapperAssets()` is valid.
4. **Resources** — every `@xml`/`@mipmap`/`@drawable`/`@string`/
   `@style` the manifest references resolves to a delivered
   resource file or values entry.
5. **Kotlin** — the JVM-pure subset is selected by an import
   fixpoint (JDK / Kotlin stdlib / org.json / JUnit imports, plus
   project-internal imports declared by already-selected files) and
   compiled with the real embeddable Kotlin compiler from the
   installed Gradle 8.7 distribution (a compiler process needs no
   daemon — the daemon is what this host cannot run), against the
   Android SDK platform jar. Runtime-bound sources (Compose UI,
   Media3, `android.*`, coroutines) are reported as **excluded**,
   never silently dropped: 8 compiled (ProjectItem, EditorModels,
   EditorOps, SquadForgeApi, ExportPlan + the 3 JVM test classes),
   14 excluded. The generated app's own JVM tests then execute under
   JUnitCore. Toolchain discovery is honest: every piece is located
   from real installations (JDK, Gradle distribution lib, Android
   SDK, an optional real org.json from Gradle caches) and a missing
   piece makes the gate **fail** with a named `toolchain-unavailable`
   reason — never a fake pass.
6. **CI build proof** — `androidCiBuildProof()` reads the Phase 34
   workflow + genuine-build script (and the Phase 37 workflow) from
   the repo and returns 8 named checks: both files exist, the
   workflow runs the script, and it still pins the 19-test line,
   the apksigner pass, the nonzero-APK grep, and the broken-Kotlin
   negative step. The report's `produces` field states what CI
   produces that this host cannot. The gate does not run CI and
   does not claim its outputs.

iOS, over a generated project: the platform's own
`IosProjectValidator` verdict, `IosBuildPipeline
.detectEnvironment()` recorded as the local build status
(`environment-unavailable` on this host, with the pipeline's own
reason), and `iosCiBuildProof()` — 5 named checks over the Phase 25
workflow (exists, macOS runner, runs the genuine-build script, the
script exists, the workflow verifies the harvested .app with `file`
+ `shasum -a 256`).

## Gate evidence (this run)

- Android gate over the generator output: **passed** — all
  structure/manifest/Gradle/resource error lists empty, wrapper
  assets valid, Kotlin compiled cleanly, **19 JVM tests executed:
  18 passed, 0 genuine failures, 1 environment-limited** (below),
  CI build proof complete (8/8 checks). Gate wall time ≈ 25 s
  (kotlinc dominates).
- The environment-limited test is
  `EditorOpsTest.jsonRoundTripPreservesTheProject`. It exercises
  org.json; the only org.json on this host is the Android SDK's stub
  android.jar, whose methods throw `RuntimeException("Stub!")` — the
  failure trace names both, and the gate classifies exactly that
  (test name + stub trace) as environment-limited. The generated
  project declares the real `org.json:json:20230618` artifact as a
  testImplementation, which Gradle resolves in CI, where the Phase
  34 workflow pins the full 19/19. A filesystem search confirmed no
  real org.json artifact exists on this VM. If one is ever
  discoverable (Gradle caches), the gate puts it ahead of
  android.jar and the suite asserts 19/19 instead — the branch is
  written into the test.
- iOS gate over the generated FitTrack project: **passed** —
  validator valid with zero errors/warnings, local build
  `environment-unavailable` (platform linux; reason names macOS +
  the Phase 25 workflow), CI build proof complete (5/5 checks).

## Integration findings

- The repo summary's harness description (from an earlier session)
  did not match the real swarm API; the suite was rebuilt on the
  actual F9/probe pattern (`db.saveBuild` + `startSwarm(buildId)`,
  files keyed by build id, `db.getEvents` sandbox/verifier records).
  No platform code was at fault.
- The probe's task partition omitted
  `gradle/wrapper/gradle-wrapper.properties`; the suite's task 1
  includes it, and the gate requires it.
- `SquadForgeApi.kt` joins the JVM-compilable set (its surface is
  org.json + java.net + same-package models only) — the fixpoint
  selection found it without hand-listing.
