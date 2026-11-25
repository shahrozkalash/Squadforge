# Phase 25 Progress — Native iOS Development Engine

Status: **complete and verified on 2026-11-25**, including genuine
compilation on a real macOS/Xcode CI runner. Final acceptance
remains the project owner's decision.

## What was built

`server/ios/` generates genuine Xcode projects (Swift + SwiftUI)
and builds them with the real `xcodebuild` on macOS:

- **Project generator** (`iosProjectGenerator.ts`): a complete
  `.xcodeproj` (deterministic object IDs, objectVersion 56), a
  SwiftUI app (entry point, NavigationStack UI, MVVM view model),
  Info.plist, asset catalog with a genuine generated 1024×1024
  AppIcon PNG, shared scheme, and optional Swift Package Manager
  dependencies (`XCRemoteSwiftPackageReference`). Routes at
  `/api/builds/:id/ios` behind auth + ownership.
- **Validator** (`iosProjectValidator.ts`): structural checks only —
  required files, balanced pbxproj, bundle id / deployment target /
  SDKROOT present, Swift files referenced both ways, SPM references
  match the configuration, no real private-key material.
- **Build pipeline** (`iosBuildPipeline.ts`): on non-macOS hosts it
  reports `environment-unavailable` honestly; on macOS it runs
  `xcodebuild -list` then an unsigned simulator build
  (`CODE_SIGNING_ALLOWED=NO`), parses diagnostics, harvests the
  genuine `.app` from DerivedData, and attempts IPA export **only**
  when a development team is configured — otherwise it says why not.
  On failure it now also returns the tail of the raw xcodebuild
  output, so CI failures are diagnosable instead of silent.

## The road to green (all evidence from real CI runs)

1. The workflow file could not be pushed by the GitHub App (403 on
   workflow files), so it was created through the GitHub web UI
   (commit `e14ee11`).
2. Run #1 was cancelled before starting: GitHub no longer supports
   the `macos-14` runner configuration for this repo. The workflow
   moved to `macos-15` (commit `f3980a6`).
3. Run #2 executed on a real macOS runner (Xcode 16.4) but the build
   failed in ~8.5 s with **zero parseable diagnostics** — the raw
   output died with the ephemeral workspace. The pipeline was fixed
   to surface an `outputTail` (commit `d20166a`).
4. Run #3 stalled in GitHub's queue for 1 h 45 m (GitHub's own
   annotation: "The job was not acquired by Runner of type hosted
   even after multiple attempts" + an internal server error). It
   was cancelled and re-dispatched.
5. Run #4 gave the diagnosis verbatim: *xcodebuild: error: Unable
   to find a destination matching { platform:iOS Simulator } —
   available destinations are macOS only (My Mac)*. The generated
   pbxproj never set `SDKROOT`, so Xcode defaulted the project to
   the host platform. Fixed in the generator (project + target
   settings), guarded in the validator, and asserted by a test
   (commit `eaaf983`).
6. **Run #5 — SUCCESS** (see below).

## Genuine verification (run #5, 2026-11-25)

- Run: https://github.com/shahrozkalash/Squadforge/actions/runs/45642533792
  (commit `eaaf983`, macos-15, Xcode 16.4, job 2 m 42 s, every step
  passed)
- Plain build: `FitTrack.app`, main executable **72,232 bytes**,
  sha256 `52f2c466cacb2d04ad0587995a55c565a52bd346a1184e22874c810860a9537c`,
  verified independently in the workflow as a **Mach-O universal
  binary (x86_64 + arm64)**; bundle identifier
  `com.squadforge.fittrack`.
- SPM build (swift-algorithms dependency): success (separate build,
  sha256 `35bdfbcd…c081b`).
- Negative test (broken Swift): failed honestly — 9 diagnostics,
  0 artifacts.
- Local suite: `tests/phase25_ios_engine.test.ts` 14/14.

## Limitations

- The verified build is an **unsigned simulator .app**. No IPA was
  produced: CI has no development team, certificate or provisioning
  profile, and the pipeline never fabricates one.
- The generated app's GUI was not launched in a simulator here.
- The SPM proof covers one package (swift-algorithms).
