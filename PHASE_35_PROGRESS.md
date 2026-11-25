# Phase 35 Progress — Native iOS Video Editor (ClipForge)

Status: implemented and verified locally on 2026-11-25. Genuine
Xcode compilation is **pending** — it runs in the Phase 35 CI
workflow on a macOS runner (native iOS builds are impossible on
this host; the Phase 25 pipeline reports environment-unavailable
here by design), and the workflow file reaches the repo through
the GitHub web UI because the GitHub App cannot push workflow
files. Final acceptance remains the project owner's decision.

## What was built

`server/ios/videoEditorGenerator.ts` generates a complete, genuine
Xcode project — "ClipForge" — on top of the Phase 25 engine
(`IosProjectGenerator` base project + editor sources + a pbxproj
patched to reference them), exposed at
`POST /api/builds/:id/ios/video-editor/generate` behind the
standard auth + ownership checks.

The one iOS-specific problem the Android generator never faces: an
Xcode project lists every source file explicitly in
project.pbxproj. The generator therefore patches the pbxproj using
Phase 25's own deterministic object-id scheme — the starter
Views/Components/Models/ViewModels groups are replaced by
Editor/Player/Export/UI groups and the file/build/sources entries
are rewritten — with every patch anchored on exact emitted text
and throwing on drift, so a changed base generator fails loudly
instead of emitting a corrupt project. The result passes the
Phase 25 structural validator with no errors.

### The generated app (Swift + SwiftUI, no WebView)
- **Media import:** the system PhotosPicker (video/image) and the
  document picker (audio). Picked media is copied into the app's
  Documents/media folder — the app works entirely inside its
  sandbox, never reads the photo library itself, and needs no
  security-scoped bookmarks. Metadata is probed with AVFoundation
  (`load(.duration)`, `loadTracks`), never by decoding media into
  memory. Project media paths are stored relative to Documents
  and re-resolved by file name if the container path changes.
- **Media library & multitrack timeline:** video and audio tracks,
  clip blocks sized by duration, selection, and the same project
  model as the server engine (Phases 20/26–31) with identical JSON
  field names, so projects move between app and server unchanged.
- **Editing operations** (`EditorOps`, pure Swift): add/remove
  tracks and clips, trim (clamped to media bounds), split at the
  playhead (`sourceIn + offset × speed`), move, volume (clip 0..1,
  track 0..2), mute, speed (0.25..4), text overlays, captions,
  transitions — the same operation set and validation rules
  (including per-track overlap rejection) as the server's
  `editingOps` dispatcher.
- **Preview:** AVPlayer plays an AVMutableComposition built from
  the timeline — the base video track's clips inserted at their
  timeline positions with their trims, the first audio track
  mixed in, per-clip volume steps in an AVMutableAudioMix. Text
  overlays and the active caption render natively in SwiftUI over
  the player.
- **Export:** AVAssetExportSession renders the base video track
  plus every unmuted audio track to a real MP4 at
  Source/480p/720p/1080p (an AVMutableVideoComposition scales to
  the target size), with progress from the session's own progress
  value (polled) and cancellation via `cancelExport()` (partial
  file deleted). Captions are written as a sidecar `.srt` in the
  same format the server engine produces.
- **Persistence & recovery:** the project JSON is written after
  every edit (temp file + atomic replace) to Documents and the
  last project reopens on launch.
- **Server connection:** an optional URLSession client for the
  Phase 31 API (`GET /project/load`, `POST /project/save`) using
  the user's own session cookie, stored only in the app's
  preferences. The client translates between the app's project
  JSON and the server's SerializedVideoProject envelope in both
  directions (load merges the envelope's media into the project;
  save splits it back out) — the wire shape was read from the
  actual routes, not assumed.

### Export limitations (stated in the app and its README, not hidden)
- Overlay (PiP) video tracks are preview-only in the app export —
  the export carries the base video track. The server export
  (Phase 26) remains the PiP path.
- Transitions render as cuts in the app export.
- Clip speed and audio fades are honoured in editing/preview math,
  not baked into the app export.
- Text overlays render in preview but are not burned into the app
  export (the Android app burns them via Media3; on iOS that would
  need a Core Animation video composition tool, deliberately not
  faked). The server export burns them in.
- Image clips are editable in the timeline; the app preview and
  export skip them (compositions are built from audio/video
  tracks). The server export loops stills.
- Preview mixes only the first audio track; export mixes every
  unmuted audio track.
- Projects loaded from the server reference server-side media
  paths; the media itself must be imported on the device before
  those clips can play or export.

### Frameworks and licenses
AVFoundation, AVKit, PhotosUI, SwiftUI, Foundation — all Apple
system frameworks. There are no third-party dependencies.

### Deliberate differences from the Phase 34 (Android) app
- The clip `effect` field is encoded in the server model's
  canonical string form ("none"); the decoder accepts both the
  string form and the object form the Android app writes.
- The API client translates the SerializedVideoProject envelope
  (see above); the Android client's load/save assumed the project
  object alone.
- No XCTest target is generated: the Phase 25 pbxproj has a single
  app target, so the editor's ops checks ship as a swiftc-compiled
  test main in the CI harness (`ops` mode) instead of an app test
  bundle.

## Verification

- `tests/phase35_ios_video_editor.test.ts`: **13/13 pass** —
  project completeness, Phase 25 validator-clean output, pbxproj
  group/file patching, photo-library permission wiring, no-WebView
  scan, picker/probe wiring, AVPlayer composition preview wiring,
  AVAssetExportSession progress/cancel wiring, atomic persistence,
  API endpoint + envelope parity, **server interop** (a fixture
  with the Swift model's exact field names parses through the
  server's own `deserializeVideoProject`, and the server serializer
  emits every field the Swift decoder reads), operation parity
  with the server dispatcher, and the generate route over real
  HTTP (owner succeeds, foreign user rejected).
- Phase 25 + Phase 35 suites together: **27/27 pass**.
- Phase 20/26/27/28/29/30/31 + Phase 34 regression: **85/85 pass**.
- Lint (`tsc --noEmit`) and production build (`vite build`) pass.
- `scripts/phase35-genuine-build.ts` on this host honestly reports
  `environment-unavailable` for every mode (exit 1) — no build is
  claimed here.

## Pending

- **Genuine Xcode compilation + the swiftc ops checks** run in
  `.github/workflows/phase35-ios-video-editor.yml` (macos-15) via
  `scripts/phase35-genuine-build.ts` (build + ops + a broken-Swift
  negative test). The workflow file is prepared in the repo
  working tree and will be created on GitHub through the web UI
  (the GitHub App cannot push workflow files — the same route
  Phases 25/34 use). Until that run lands, no claim is made that
  the generated Swift compiles; any errors it surfaces will be
  fixed in the generator and re-run.
- The generated app's GUI was not run on a device or simulator
  here.
