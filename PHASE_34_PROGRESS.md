# Phase 34 Progress — Native Android Video Editor (ClipForge)

Status: implemented and verified locally on 2026-11-25. Genuine
Gradle compilation is **pending** — it runs in the Phase 34 CI
workflow on a GitHub-hosted runner (this host cannot run the Gradle
daemon; see "Verification"), and the workflow file reaches the repo
through the GitHub web UI because the GitHub App cannot push
workflow files. Final acceptance remains the project owner's
decision.

## What was built

`server/android/videoEditorGenerator.ts` generates a complete,
genuine Android Studio project — "ClipForge" — on top of the
Phase 17 engine (`AndroidProjectGenerator` base project + Media3
dependencies + editor sources), exposed at
`POST /api/builds/:id/android/video-editor/generate` behind the
standard auth + ownership checks.

### The generated app (Kotlin + Jetpack Compose, no WebView)
- **Media import:** Android photo picker (`PickMultipleVisualMedia`,
  video/image) and document picker (`OpenMultipleDocuments`, audio).
  The manifest requests **no storage permission** — the pickers
  grant access to the picked items only, grants are persisted with
  `takePersistableUriPermission`, and metadata is probed by
  streaming (`MediaMetadataRetriever`). Whole media files are never
  loaded or decoded into memory by the app.
- **Media library & multitrack timeline:** video and audio tracks,
  clip blocks sized by duration, selection, and the same project
  model as the server engine (Phases 20/26–31) with identical JSON
  field names, so projects move between app and server unchanged.
- **Editing operations** (`EditorOps`, pure Kotlin): add/remove
  tracks and clips, trim (clamped to media bounds), split at the
  playhead, move, volume (clip 0..1, track 0..2), mute, speed
  (0.25..4), text overlays, captions, transitions — the same
  operation set and validation rules (including per-track overlap
  rejection) as the server's `editingOps` dispatcher. The generated
  project ships JVM unit tests for these (`EditorOpsTest`).
- **Preview:** ExoPlayer plays the base track as a concatenated
  playlist of clipped items (play/pause/seek operate on the edited
  timeline); the first audio track plays in sync through a second
  player; text overlays and the active caption render natively in
  Compose over the player.
- **Export:** Media3 Transformer renders the base video track
  (per-clip gain via a real PCM gain audio processor, text overlays
  via `OverlayEffect`, optional 480p/720p/1080p presentation) plus
  every unmuted audio track to a real MP4, with progress from
  Transformer's own progress channel and cancellation via
  `Transformer.cancel()` (partial file deleted). Captions are
  written as a sidecar `.srt` in the same format the server engine
  produces.
- **Persistence & recovery:** the project JSON is written after
  every edit (temp file + rename) to app-private storage and the
  last project reopens on launch.
- **Server connection:** an optional HttpURLConnection client for
  the Phase 31 API (`GET /project/load`, `POST /project/save`) using
  the user's own session cookie, stored only in app-private
  preferences.

### Export limitations (stated in the app and its README, not hidden)
- Overlay (PiP) video tracks are preview-only in the app export —
  Transformer output carries one video track. The server export
  (Phase 26) remains the PiP path.
- Transitions render as cuts in the app export.
- Clip speed and audio fades are honoured in editing/preview, not
  baked into the app export.

### Libraries and licenses
AndroidX Media3 1.6.1 (exoplayer, transformer, effect, ui —
Apache-2.0), Jetpack Compose / Material 3 (Apache-2.0), Kotlin
coroutines (Apache-2.0), JUnit 4 (EPL-1.0, tests only), org.json
(BSD-style license, JVM tests only; the runtime copy is part of the
Android platform). The Media3 Transformer API surface used here
(`start(Composition, String)`, `cancel()`, `getProgress`) was
checked against the official AndroidX API reference.

## Verification

- `tests/phase34_android_video_editor.test.ts`: **13/13 pass** —
  project completeness, Media3 dependencies, permission-free
  manifest, no-WebView scan, picker/probe wiring, ExoPlayer preview
  wiring, Transformer progress/cancel wiring, atomic persistence,
  API endpoint parity, **server interop** (a fixture with the Kotlin
  model's exact field names parses through the server's own
  `deserializeVideoProject`, and the server serializer emits every
  field the Kotlin `fromJson` reads), operation parity with the
  server dispatcher, and the generate route over real HTTP
  (owner succeeds, foreign user rejected).
- Phase 17 + Phase 34 suites together: **42/42 pass**.
- Lint (`tsc --noEmit`) and production build pass.

## Pending

- **Genuine Gradle compilation + the app's JVM unit tests** run in
  `.github/workflows/phase34-android-video-editor.yml` via
  `scripts/phase34-genuine-build.ts` (assembleDebug +
  testDebugUnitTest + a broken-Kotlin negative test). The workflow
  file is prepared in the repo working tree and will be created on
  GitHub through the web UI (the GitHub App cannot push workflow
  files — the same route Phase 25 uses). Until that run lands, no
  claim is made that the generated Kotlin compiles; any errors it
  surfaces will be fixed in the generator and re-run.
- The generated app's GUI was not run on a device or emulator here.
