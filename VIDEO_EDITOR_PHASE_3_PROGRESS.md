# Video Editor Roadmap — Phase 3: Preview and Playback Engine — Progress

> **Naming note:** this is Phase 3 of the standalone *Professional Video
> Editor Roadmap*. Its phase numbers collide with SquadForge's own phase
> numbering (the video editor itself was built as SquadForge Phases
> 20, 26–31). To keep the two series unambiguous, these documents are
> named `VIDEO_EDITOR_PHASE_3_*` instead of `PHASE_3_*`.

Date: 2026-11-27. Status: **implemented and verified locally; not pushed**
(push is the owner's action, as with every phase).

## What the phase asked for

Build a real-time video preview with playback, pause, seeking, frame
navigation, aspect ratios, and synchronization between timeline and
preview. Handle common video formats and large files reliably.

## Audit first (spec item → existing implementation → gap)

The preview/playback core the brief describes was built by SquadForge
Phase 27 (`server/videoEditor/playback.ts`, 579 lines) and is in use by
the Phase 31 web editor. Building a second preview engine beside it
would violate the repo's own rules, so the phase began with a
file-verified audit. Every claim below is file-verified.

| Spec item | Already existed (evidence) | Genuine gap |
| :--- | :--- | :--- |
| Real-time preview frames | `renderPreviewFrame`/`buildPreviewArgs` (`playback.ts`): real composited frames — the timeline is resolved by the one shared `resolveAtTime`, each source is input-seeked, and frames are composited through the exporter's own `overlayTransformChain` plus the identical base scale/pad chain the exporter uses (`videoExporter.ts` segLabel); route `POST /preview/frame`; the web editor steps through these real frames and says so honestly (`editorWebApp.ts` header) | None (correctness) |
| Playback / pause | `PlaybackSession` (`playback.ts`): single-clock state machine — play/pause/stop, position derived from one monotonic anchor | None |
| Seeking | `seekTo` (frame-quantized, clamped), `seekToFrame` | None |
| Frame navigation | `seekByFrames(delta)` on the session (exercised by Phase 27 test 1.1); the web editor's ←/→ keys step one frame (Shift = 1 s) | None — pinned again by the new suite (test 2.1), including clamping at both ends |
| Aspect ratios | **Nothing.** Grep over `server/videoEditor/`: the only "aspect" in the subsystem is `force_original_aspect_ratio=decrease` inside the scale filters (source-media fit into the canvas). No aspect type, preset, or helper exists; the project is raw width/height; preview sizing is "project size or whatever width/height the caller passed". Nothing could answer "show this 16:9 project inside a 640×360 box undistorted", and nothing guarded the fitted size the yuv420p chain requires (even dimensions) | **Missing — gap 1** |
| Timeline ↔ preview synchronization | One resolver: `resolveAtTime` is used by `PlaybackSession.activeClips()`, by the preview renderer, and the audio position is the same clock (`audioPosition() === position()`, `syncDriftMs()` = 0 by construction). Phase 27 test 3.4 proves the preview follows edits immediately | None — the agreement is now pinned end-to-end (session state vs rendered frame) by the new suite (test 2.2) |
| Common formats | Generic ffprobe/ffmpeg path: `probeMedia`/`importMedia` (`mediaProbe.ts`) accept anything the tools can read, classify stills via `IMAGE_CODECS`, and fail with named errors ('ffprobe not found…', 'Media file not found…', 'Could not determine duration…'); the preview path has no format whitelist — a corrupted file produces an explicit preview error, never a placeholder (Phase 27 test 3.5). The `/media/import` route whitelists upload extensions | None — the new suite adds real-frame proof for WebM/VP9, MOV and MKV (test 5.1) |
| Large files | Input-seeked decoding: every video input is `-ss`-seeked before `-i`, so whole files are never loaded or decoded through (Phase 27 test 3.6 pins the argument order). **But:** no preview cache anywhere (grep-verified over `playback.ts` and `videoEditorRoutes.ts`) — every `/preview/frame` request re-ran ffmpeg, so scrubbing back over an already-shown frame re-decoded the same sources every time; and there was no preview-size scaling in use by the route, so every scrub step decoded at full project size | **Missing — gap 2 (cache)**; the size half is gap 1's fit |

One further divergence found by the audit, inside gap 1's territory:
in `buildPreviewArgs`, when the preview size differed from the project
size, overlay **positions** and text were scaled (sx/sy) but the
overlay **image** was not — it kept its natural pixel size. At any
non-project preview size the picture-in-picture was therefore
disproportionately large: the preview diverged from the export
geometry. Fixed as part of gap 1 (below).

## What was implemented (only the gaps, inside the existing architecture)

All changes are in `server/videoEditor/playback.ts` (already the
preview module; exported through the existing barrel) plus cache
wiring in the `/preview/frame` route. The single-resolver invariant is
untouched: `resolveAtTime`, the session, and the exporter's chains are
exactly as Phase 27 left them.

### Aspect-ratio awareness + aspect-preserving preview sizing

- `ASPECT_RATIOS` — the standard names (`16:9`, `9:16`, `1:1`, `4:3`,
  `3:4`, `21:9`) as numeric ratios.
- `aspectRatioString(width, height)` — the reduced "W:H" name of a
  size (gcd reduction; non-positive dimensions rejected by name).
  `playbackInfo()` now reports it as `aspectRatio` alongside the
  frame grid (additive field; the `/playback/info` route picks it up
  unchanged).
- `parseAspectRatio(input)` — a name, a "W:H" string, or a number →
  numeric ratio; garbage is rejected with a named error listing the
  known names.
- `fitWithinBox(srcW, srcH, maxW, maxH)` — the largest size with the
  source's aspect inside a box. Never upscales (a preview bigger than
  the project would invent pixels the export does not have).
  Dimensions are floored to even numbers, minimum 2, because the
  preview chain passes through yuv420p.
- `previewSizeFor(project, options)` — the one place preview size is
  decided. Precedence: explicit width/height (each defaulting to the
  project's — the pre-Phase-3 behaviour, verbatim, test-pinned) >
  aspect-preserving fit inside `maxWidth`/`maxHeight` > project size.
  `PreviewOptions` gains `maxWidth`/`maxHeight`; `renderPreviewFrame`
  resolves the size once and reports the resolved dimensions.
- **Overlay-image scaling fix** (`buildPreviewArgs`): at a non-project
  preview size the overlay chain now also scales the overlay image by
  the same (sx, sy) its position already used. At project size the
  chain is byte-for-byte the pre-Phase-3 chain (Phase 27 suite
  unchanged and green). A fitted preview is now the export geometry
  scaled — proven at the pixel level (test 3.1: the PiP occupies
  exactly the scaled rect; test 3.2: a portrait project's letterbox
  follows the project aspect).

### Bounded preview-frame cache

- `PreviewFrameCache` — an LRU-bounded (default 60 entries; the route
  uses 120 per build) directory of rendered frames. `get` refreshes
  recency and treats a vanished file as a miss; `put` copies the
  rendered frame in and evicts least-recently-used entries *with their
  files* past the bound.
- `previewCacheKey(project, mediaAssets, frameIndex, width, height,
  hiddenTrackIds)` — a SHA-256 fingerprint of everything a frame
  depends on: the full serialized project (so **any** edit
  invalidates), each media file's path + size + mtime (so replacing a
  file in place invalidates), the frame index, the resolved size, and
  the hidden-track set.
- `renderPreviewFrame` accepts `options.cache`. On a hit it still runs
  the full validation + resolution path and reports the same
  `activeClips`; only the ffmpeg decode is skipped, and the cached PNG
  is copied to the caller's output path. A cached frame therefore
  cannot diverge from what a fresh render would report.
- The `/preview/frame` route now passes a per-build cache (the same
  per-build pattern as the Phase 30 render-job managers) and accepts
  `maxWidth`/`maxHeight` in the request body.

## Tests

New suite `tests/video_editor_phase3_preview_playback.test.ts` —
**17/17 pass**:

- Aspect math, exact values: ratio reduction (incl. portrait),
  parsing (names/strings/numbers, named rejections), `fitWithinBox`
  (landscape/portrait fits, height-constrained, no-upscale, even-floor
  66.67 → 66), `previewSizeFor` precedence, `playbackInfo().aspectRatio`.
- Frame navigation pinned: `seekByFrames(±1)` moves exactly one frame;
  stepping clamps at frame 0 and at the last frame; audio position
  stays on the same clock (drift 0).
- **Sync invariant, end-to-end:** at a crossfade midpoint, the
  session's `activeClips()` and the rendered preview's reported
  `activeClips` are deep-equal (clips, roles, source times), the
  preview's `frameIndex`/`timeSec` equal the session's, and the
  rendered pixels are the genuine blend.
- Fitted previews with real frames: half-size PiP geometry at exact
  scaled coordinates; portrait letterboxing by project aspect;
  explicit sizes verbatim (pre-Phase-3 behaviour pinned).
- Cache: an identical repeat request does not rewrite the cached file
  (mtime-pinned — ffmpeg did not run again) and serves byte-identical
  bytes; an edit invalidates (new entry, new pixels); replacing a
  media file in place invalidates (red → blue at the same path);
  bounded eviction removes the oldest entry and its file; key
  sensitivity to frame/size/hidden tracks.
- Formats & large files: WebM/VP9, MOV/H.264 and MKV/H.264 fixtures
  import as video and preview with their real colours; a 90-second
  file previews one second from its end via input seek (the `-ss`
  argument is the requested source time, directly before `-i`).

Regression (same run of work): Phase 20 15/15, Phase 26 12/12,
Phase 27 13/13, Phase 28 11/11, Phase 29 10/10, Phase 30 10/10,
Phase 31 1/1, Phase 1 architecture 20/20, Phase 2 timeline 21/21 —
**113/113**. `npm run lint` (tsc --noEmit) clean. `npm run build`
(vite production build) succeeds. No test needed fixing during
development; no engine behaviour outside the two gaps changed.

## Limitations (honest)

- **The web editor does not request fitted previews yet.** It calls
  `/preview/frame` at full project size, as before; the route now
  accepts `maxWidth`/`maxHeight` and caches per build, but the Phase 31
  page does not pass a fit box or a size. Adopting fit in the UI is
  interface work for a later phase.
- **Explicit mismatched width/height still produces a canvas of that
  aspect** — deliberately: it is the pre-existing contract (the export
  settings allow the same), and the caller owns it. The aspect-
  preserving path is the fit; nothing silently "corrects" an explicit
  size.
- **The cache is per-process and per-build**, stored as PNG files
  under `.video_previews/<buildId>/cache`. It is not shared across
  server processes and is not persisted as project state; its bound
  counts entries, not bytes (a 4K frame costs more disk than a 320×240
  one — 120 entries of large frames is real disk, accepted and
  documented rather than hidden).
- Cache invalidation trusts file size + mtime for media identity: a
  replacement engineered to keep both identical (same byte size, mtime
  reset) would serve the older frame. That is the standard
  size+mtime fingerprint trade-off, stated rather than hidden.
- "Real-time" keeps its Phase 27 meaning: preview frames are real
  decodes rendered on demand, so the achieved frame rate while
  scrubbing/playing depends on project size and host speed — the cache
  and fitted sizes reduce the cost of repeats and small previews, but
  no frame rate is guaranteed or faked.
- The generated ClipForge desktop app (`videoProjectGenerator.ts`) is
  untouched; its preview story is its own.
