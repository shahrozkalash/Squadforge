# Phase 35 Acceptance Report — Native iOS Video Editor

**Status:** Implemented and verified locally on 2026-11-25, and
**genuinely compile-verified in CI** on 2026-11-26: run
[45700928726](https://github.com/shahrozkalash/Squadforge/actions/runs/45700928726)
(macos-15, Xcode 16.4) returned `ok:true` — xcodebuild produced
the ClipForge .app (executable **72,232 bytes**, sha256
`2b83a46dbdfe9d4bd68f0bb0dab965b9dcc0833b83dcf30832d84d25c6f95759`,
**Mach-O universal x86_64 + arm64**, bundle id
`com.squadforge.clipforge`), and the swiftc ops checks passed.
Final acceptance remains the project owner's decision.
**Recommendation:** Accept. The generated app is compile-verified
end to end; the remaining limitations below are behavioural, not
build evidence.

## What this phase delivered

| # | Requirement | Result |
| :--- | :--- | :--- |
| 1 | Genuine Swift/SwiftUI editor (no WebView substitute) | **Done.** Full SwiftUI UI generated; a test scans every generated Swift file for WebView/WebKit usage. |
| 2 | Media import (iOS pickers) | **Done.** PhotosPicker (video/image) + document picker (audio); picked media copied into the app sandbox; metadata probed by AVFoundation. |
| 3 | Media library + asset management | **Done.** Assets listed with kind/duration and added to the matching track; assets live in the project model and persist with it. |
| 4 | Multitrack timeline; select/move clips | **Done.** Video + audio tracks, duration-sized clip blocks, tap-to-select, move by ±0.5 s commands with overlap validation. (Drag gestures are not implemented; move is button-driven and stated as such.) |
| 5 | Trim, split, arrange, delete | **Done** in `EditorOps` with the server engine's rules (trim clamped, split at playhead, overlap rejected). |
| 6 | Text/image overlays, basic transitions | **Text overlays done** (add/edit/remove, native preview rendering; not burned into the app export — stated). **Image clips** are editable in the timeline; preview/export skip them (stated). **Transitions** are modelled and validated; the app export renders them as cuts (stated), the server export renders them for real. |
| 7 | Audio tracks, volume, captions | **Done.** Track gain 0..2 + mute, clip volume (both as audio-mix steps in preview/export), caption cues at the playhead, SRT sidecar on export in the server's format. |
| 8 | Real-time preview with AVFoundation | **Done.** AVPlayer over an AVMutableComposition built from the timeline (clips at their positions with trims), first audio track mixed; native SwiftUI overlay/caption rendering. |
| 9 | Export settings, progress, cancellation, errors | **Done.** Source/480p/720p/1080p via AVAssetExportSession + a scaling video composition; progress from the session's own progress value; cancel deletes the partial file; failures surface as messages with the export notes (what was not composited and why). |
| 10 | Save, reopen, recover projects | **Done.** Atomic JSON writes after every edit; last project reopens on launch. |
| 11 | Project save/reopen integration with the existing engine | **Done.** Optional client for the Phase 31 `/project/load` + `/project/save` endpoints with the user's own session cookie, translating the SerializedVideoProject envelope both ways. |
| 12 | iOS permissions + sandboxed file access | **Done.** Only the photoLibrary usage description (picker-based import); all media copied into Documents; no security-scoped bookmarks needed; paths re-resolve by file name across container changes. |
| 13 | No whole-video memory loading | **Done and tested.** AVFoundation probing + composition pipelines stream from files; tests scan the import/preview/export sources for whole-file reads. |
| 14 | Genuine Xcode projects through Phase 25 | **Done and CI-proven.** `scripts/phase35-genuine-build.ts` drives the Phase 25 pipeline; the pbxproj patch passes the Phase 25 validator. Run 45700928726: .app executable 72,232 bytes, sha256 `2b83a46d…c95759`, Mach-O universal, bundle id `com.squadforge.clipforge`. |
| 15 | Tests: import, editing ops, persistence, export | **Done.** 14/14 repo tests (structure, wiring, interop, route, literal scanners, import guards) + a swiftc-compiled ops test main (the Android app's EditorOpsTest checks, transposed) that runs in CI and passed in run 45700928726 (`OPS_ALL_PASS`). |

## Check results

| Check | Result |
| :--- | :--- |
| Phase 35 tests | 14/14 pass |
| Phase 25 + 35 regression | 27/27 pass (2026-11-25); 58/58 for Phases 17 + 34 + 35 (2026-11-26) |
| Phase 20/26–31 + 34 regression | 85/85 pass |
| Genuine Xcode build (CI run 45700928726) | **Pass** — .app 72,232 B executable, Mach-O universal, ops checks pass |
| Lint / typecheck | Pass (`tsc --noEmit`) |
| Production build | Pass (`vite build`) |

## Not demonstrated / limitations

- **Genuine Xcode compilation and the .app** were proven only
  after four failing CI runs, each a distinct root cause in the
  generated Swift, fixed in the generator (never by weakening a
  check): #1 (45670074609) never acquired a runner (GitHub macOS
  capacity; cancelled in queue — no build attempted). #2
  (45678088776): `EditorViewModel.swift` used `Transferable`,
  `TransferRepresentation` and `PhotosPickerItem` without
  importing CoreTransferable/SwiftUI → imports added, test-
  guarded. #3 (45684915958): the `MovieFile` transfer used a
  combined trailing-closure shape the iOS 18 SDK rejects
  ("extra trailing closure passed in call") → rewritten. #4
  (45698798182): the rewrite still missed the initializer's real
  labels — "missing argument for parameter 'importing'" →
  `FileRepresentation`'s combined initializer takes its closures
  as `exporting:` / `importing:`; fixed and test-guarded. #5
  (45700928726): **full success** (above). The swiftc ops checks
  passed in every attempted run, including the failures. This
  host cannot build iOS apps at all — the standing Phase 25
  limitation — which is why every one of these needed a CI
  round-trip. The workflow file was created via the GitHub web
  UI; the GitHub App cannot push workflow files.
- **No IPA**: no signing team/certificates exist in CI; the Phase
  25 pipeline only attempts IPA export with a configured team and
  otherwise says so. Nothing about signing is fabricated.
- The generated app's GUI was not exercised on a device/simulator.
- Timeline clip movement is button-driven (±0.5 s), not drag.
- App export: overlay video tracks not composited, transitions as
  cuts, clip speed/fades not baked in, text overlays not burned
  in, image clips skipped — all stated in the app's export notes
  and README; the server engine covers those paths.


## Workflow reliability hardening (2026-11-26)

The verification workflow itself was hardened (workflow commit
`e00aab7`; guard tests in `tests/workflow_reliability.test.ts`,
commit `89c5d4d`). The build, ops and negative-test steps
previously piped through `tee` without `pipefail`; they now run
under `set -eo pipefail`, and a new **Validate genuine results**
step (`if: always()`) fails the workflow unless the build
RESULT_JSON is `ok:true` with non-zero `appBytes`, the ops and
negative-test results are `ok:true`, and a non-empty
`ClipForge.app` executable exists on disk.

- Run 45706734870 (first hardened run): **full success** —
  RESULT_JSON `ok:true`, app 72,232 bytes, sha256
  `2b83a46dbdfe9d4bd68f0bb0dab965b9dcc0833b83dcf30832d84d25c6f95759`
  (byte-identical to run #5), ops checks and the broken-Swift
  negative test passed, and the gate passed ("All Phase 35
  checks passed.").
