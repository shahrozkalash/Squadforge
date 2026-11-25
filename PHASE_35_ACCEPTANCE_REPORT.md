# Phase 35 Acceptance Report — Native iOS Video Editor

**Status:** Implemented and verified locally on 2026-11-25; genuine
Xcode compilation evidence is pending the CI workflow run (see
"Not demonstrated"). Final acceptance remains the project owner's
decision.
**Recommendation:** Safe to keep. Do not treat the generated app as
compile-verified until the Phase 35 CI run lands.

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
| 14 | Genuine Xcode projects through Phase 25 | **Generator + pipeline wired** (`scripts/phase35-genuine-build.ts` drives the Phase 25 pipeline; the pbxproj patch passes the Phase 25 validator). **.app evidence pending CI** — see below. |
| 15 | Tests: import, editing ops, persistence, export | **Done** at the level this host supports: 13/13 repo tests (structure, wiring, interop, route) + a swiftc-compiled ops test main (the Android app's EditorOpsTest checks, transposed) that runs in CI. |

## Check results

| Check | Result |
| :--- | :--- |
| Phase 35 tests | 13/13 pass |
| Phase 25 + 35 regression | 27/27 pass |
| Phase 20/26–31 + 34 regression | 85/85 pass |
| Lint / typecheck | Pass (`tsc --noEmit`) |
| Production build | Pass (`vite build`) |

## Not demonstrated / limitations

- **Genuine Xcode compilation and the .app** are pending the CI
  workflow run (the workflow file must be created via the GitHub
  web UI; the GitHub App cannot push workflow files). This host
  cannot build iOS apps at all — the standing Phase 25 limitation.
- **No IPA**: no signing team/certificates exist in CI; the Phase
  25 pipeline only attempts IPA export with a configured team and
  otherwise says so. Nothing about signing is fabricated.
- The generated app's GUI was not exercised on a device/simulator.
- Timeline clip movement is button-driven (±0.5 s), not drag.
- App export: overlay video tracks not composited, transitions as
  cuts, clip speed/fades not baked in, text overlays not burned
  in, image clips skipped — all stated in the app's export notes
  and README; the server engine covers those paths.
