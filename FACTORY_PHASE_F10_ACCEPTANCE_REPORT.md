# Factory Phase F10 — Mobile Workflow (Android / iOS): Acceptance Report

**Date:** 2026-11-28. **Verdict: F10 criteria met**, with the claim
split below recorded plainly — local verification vs CI build proof
are different claims and are never merged. Implemented and verified
locally; not pushed. F11 not started. Companion:
`FACTORY_PHASE_F10_PROGRESS.md` (audit map, workflow wiring, gate
evidence, integration findings).

## What was delivered

The mobile categories now work as a **workflow** on the factory
machinery, in the F7/F9 pattern:

```
description → MobileWorkflow.plan()               (F5 team by data)
            → SwarmOrchestrator build             (F2–F4 chain + gates)
            → MobileWorkflow.runEnvironmentCycle() (F6 contract, web)
            → mobile gate                         (structure/manifest/
                                                   Gradle/resources/
                                                   Kotlin compile/JVM
                                                   tests/CI proof)
            → verified delivery verdict
```

New code: `server/android/mobileWorkflow.ts` and
`server/android/mobileProjectGate.ts`, exported from the existing
`server/android/index.ts`. No existing code was modified; no
parallel mobile stack was created. New suite:
`tests/factory_phase_f10_mobile_workflow.test.ts` (**3/3**).

## Criterion-by-criterion verdict (roadmap F10 acceptance criteria)

### 1. Android: the workflow's app builds in CI to a signed-verifiable APK (apksigner pass, nonzero size, hash recorded — Phase 17/34 evidence style) — **MET, in the Phase 17/34 evidence style, via the CI-proven path**

The workflow's app is the platform's generated ClipForge project —
the same project the Phase 34 CI workflow builds. The mobile gate
emits that build-proof path as a named, checkable artifact
(`androidCiBuildProof`, 8 checks, all present): the workflow and its
genuine-build script exist, the workflow runs the script, and it
still pins exactly the criterion's evidence — nonzero `apkBytes`,
`apksigner verification strictly PASSED`, the build pipeline's
SHA-256 recording, exactly 19 JVM tests green, and a broken-Kotlin
negative step — with the Phase 37 EXPORT_VERIFY workflow as
secondary evidence (run #17: all 11 checks, APK 12,605,071 B).
**No APK was built on this host and none is claimed**: the Gradle
daemon cannot run here (Java-initiated outbound TCP is
intercepted), and no new CI run was triggered in this phase — the
repo is unpushed by the owner's instruction, and CI runs on push.
What this phase adds locally is everything short of the daemon:
the delivered project passes structure, manifest, Gradle and
resource consistency, a genuine Kotlin compile of its JVM-pure
sources, and execution of the generated app's own JVM tests
(19 executed, 18 passed, 1 environment-limited — see Limitations).

### 2. iOS: the workflow's app builds on a macOS runner to a Mach-O universal executable (Phase 25 evidence style); IPA only with a signing team, never fabricated — **MET, in the Phase 25 evidence style**

The gate verifies the generated FitTrack project with the platform's
own structural validator (valid, zero errors) and records the Phase
25 build-proof path as 5 named checks (workflow exists, macOS
runner, runs the genuine-build script, script exists, harvested
.app verified with `file` + `shasum -a 256`) — the path whose CI run
#5 produced the 72,232 B Mach-O universal (x86_64+arm64) executable.
Locally the build status is recorded as exactly what it is:
`environment-unavailable` on this Linux host, with the pipeline's
own reason. **No IPA exists, no signing is claimed, nothing was
built for iOS on this host.**

### 3. A deliberately broken generated source file fails the workflow honestly (negative test, both platforms where the harness allows) — **MET**

Android, at the gate: (a) manifest package corrupted to
`com.example.broken` → gate fails, naming the namespace/package
mismatch; (b) a syntax error appended to `ExportPlan.kt` → gate
fails, compile errors naming the file. `verifyDelivery` refuses
both broken gates even with a real artifact. iOS: (a) `SDKROOT =
iphoneos` tampered to `macosx` in the pbxproj → validator error
naming SDKROOT, gate fails; (b) `ContentView.swift` removed → error
naming the missing file, gate fails.

### 4. Phase 17/25 suites pass; lint and build pass — **MET**

Regression batch in one run — F9 (3) + F7 (4) + Phase 37 + Phase 34
+ Phase 17 + Phase 25 + Phase 35 + orchestration: **109/109, 0
fail**. `npm run lint` (tsc --noEmit) clean; `npm run build`
succeeds. The two tests F2 fixed (`orchestration.test.ts:334`,
phase4 test 19) stay green inside the orchestration suite.

## Android claim table

| Claim | Status | Evidence |
| :--- | :--- | :--- |
| Described app → F5 mobile team by data | **Proven** | Suite test 1: category `android_application`, team "Mobile Development Team — Android", profile `android_mobile_application`, verifier `claude` via registry |
| Real swarm build completes through the F2–F4 gates | **Proven** (stub transport, F1 verdict stands) | Build `completed`, `verifier_approved` event, every `sandbox_check` "passed cleanly", delivered tree byte-identical to the generator output (44 text files) |
| F6 contract cycle over the delivered project | **Proven, with honest skips** | Build `skipped` (no web bundle entry), tests `skipped` (no JS discovery) — surfaced as-is; preview produced; artifact ZIP non-empty, SHA-256 re-verified against disk |
| Project structure/manifest/Gradle/resource consistency | **Proven locally** | Gate error lists all empty; wrapper assets valid |
| Kotlin compilation of the generated sources | **Proven locally for the JVM-pure subset** | 8 sources compiled with the real Kotlin compiler (embeddable 1.9.22 from the Gradle 8.7 distribution); 14 runtime-bound sources reported excluded by name category (Compose/Media3/android.*) |
| The generated app's JVM tests pass | **18/19 locally; 19/19 is the CI pin** | 19 executed, 0 genuine failures; 1 environment-limited (SDK stub org.json — named, with the trace evidence) |
| APK built, apksigner-verified, hash recorded | **CI-produced; not produced or claimed locally** | Phase 34 workflow + genuine-build script verified present with their gates pinned (8/8 checks); Phase 37 run #17 evidence stands |

## iOS claim table

| Claim | Status | Evidence |
| :--- | :--- | :--- |
| iOS team in the F5 registry | **Does not exist — audit finding, pinned in the suite** | `CanonicalProjectType` has no iOS entry; `cross_platform_mobile` maps to the Android mobile profile. The iOS path is a gate over generated projects, not a team build |
| Generated project structurally valid | **Proven locally** | `IosProjectValidator`: valid, zero errors/warnings over the 13 generated FitTrack files |
| iOS build on this host | **Not available — recorded, not fabricated** | `IosBuildPipeline.detectEnvironment()`: `environment-unavailable`, reason names macOS + the Phase 25 workflow |
| .app with Mach-O universal executable | **CI-produced (Phase 25 run #5); not produced locally** | Phase 25 workflow verified present with its checks pinned (5/5); run #5 evidence: 72,232 B, x86_64+arm64, sha256 recorded |
| IPA / signing | **Never claimed** | Requires a signing team; absent here and in CI evidence |

## Limitations

- **Stub transport.** Planner/worker/verifier model calls run over
  the F2 stub seam; the F1 verdict stands — no live model exists in
  this environment. The delivered content is the platform's own
  generator output, labelled as such.
- **No local APK.** The Gradle daemon cannot run on this VM; the
  Android build proof is the CI path, verified as an artifact, not
  re-run. A fresh CI run of the workflow's app happens when the
  owner pushes (the workflows already build this exact project).
- **One environment-limited JVM test locally** (`org.json` stub in
  the SDK android.jar). Classified by name + trace, never counted
  as a pass; the suite asserts 19/19 automatically on any host
  where a real org.json jar is discoverable.
- **Kotlin compile covers the JVM-pure subset only** (8 of 22
  Kotlin sources). Compose UI, Media3 exporter/player, and other
  `android.*`-bound sources are compile-proven only by the CI
  Gradle build; the gate lists them as excluded rather than
  implying coverage.
- **The contract cycle's build/test steps report `skipped`** for a
  native tree — true and surfaced; the mobile verdict therefore
  rests on the gate, by documented design.
- **iOS is gate-only in the workflow** (no team, no swarm build) —
  a platform reality recorded in the audit, not a gap this phase
  papers over. Wiring an iOS category/team would be an F5-data
  change for a later phase or the owner's call.
- Gate wall time is dominated by kotlinc (~25 s per full Android
  gate call on this VM); the suite's three gate calls are budgeted
  in its timeouts.

---

## Addendum (2026-11-28): CI #194 toolchain-discovery fix

**Failure.** In main CI run #194 (commit `daa7606`) the three
gate-dependent tests in this suite (and F13.6 in the unified-pipeline
suite) failed on the GitHub ubuntu runner with: *"Kotlin toolchain
unavailable on this host — missing: kotlin-compiler-embeddable jar
(Gradle distribution lib); kotlin-stdlib jar; junit jar;
hamcrest-core jar"* — while the same suites passed locally. The
sandbox-integration job was unaffected.

**Root cause.** `discoverKotlinToolchain` searched only three
places (an env override, `GRADLE_HOME`, SDKMAN `current`, and the
wrapper-dists trees) and, within each, required **all four jars in
one `lib` directory**. On the runner the installed Gradle keeps the
compiler/stdlib in `lib` but junit/hamcrest in `lib/plugins` (and
the distribution is reachable via SDKMAN's versioned candidates /
the `gradle` on PATH rather than the roots that were searched), so
every root was discarded as incomplete and all four pieces were
reported missing — including the two that were present.

**Fix** (`server/android/mobileProjectGate.ts`, discovery only —
the gate still refuses by name when no complete toolchain exists;
nothing is downloaded or faked):

- Distribution roots broadened: `GRADLE_HOME`; a `gradle`
  executable resolved from PATH via realpath (SDKMAN shims land
  inside the distribution); SDKMAN `current` **plus every versioned
  candidate**; `/opt/gradle` (+ versioned `/opt/gradle-*`),
  `/usr/local/gradle`, `/usr/share/gradle`; the wrapper-dists trees
  (unchanged); a `gradle` dir beside an Android SDK root.
- Each distribution is now searched across **both** `lib` and
  `lib/plugins`, and the four pieces are gathered across those two
  trees of the same distribution. Jar names are matched by version
  pattern (as before), with a unified-`hamcrest-<version>` fallback
  after `hamcrest-core`.
- New seam: `F10_GRADLE_SEARCH_ROOTS` (path-delimited distribution
  homes or lib dirs) **replaces** the search list when set, so a
  test can restrict discovery to one synthetic layout.
  `F10_GRADLE_LIB_DIR` keeps its meaning when the override is unset.

**Proof.** New test in this suite — *"Kotlin toolchain discovery
finds a CI-layout Gradle home and refuses a genuinely absent one"*:
it copies the host's real jars into a fake SDKMAN-style Gradle home
with junit/hamcrest **only** in `lib/plugins`, restricts discovery
to that home via `F10_GRADLE_SEARCH_ROOTS`, and asserts all four
pieces are found (junit/hamcrest paths under `lib/plugins`) and
that the gate then genuinely compiles the generated project and
runs its 19 JVM tests green. Restricted to an empty directory
instead, discovery names all four missing pieces and the gate
refuses (`toolchainAvailable: false`, `passed: false`, refusal
detail naming each piece). No existing assertion was changed.

**Local verification (2026-11-28).** This suite: **4/4 pass**
(was 3 tests; the discovery test is the 4th). F13 unified pipeline:
**12/12 pass**, F13.6 mobile included. Lint clean; build succeeds.
The CI-side confirmation is the next main CI run on the owner's
push — this addendum records the local evidence only.
