# Phase 27: Real-Time Timeline and Playback Engine — Progress

Built on the Phase 20/26 project and timeline data (`server/videoEditor/playback.ts`). No parallel timeline model was created; playback resolves against the same clips, transforms, transitions and speed settings the exporter renders.

## Implemented

1. **Playback state machine** — `PlaybackSession` with play / pause / stop, driven by ONE monotonic clock anchor. Position is frame-quantized to the project fps; reaching the end latches `stopped` at the exact duration; play from the end restarts. The clock is injectable, so behaviour is deterministically testable.
2. **Frame-accurate seeking** — `seekTo` snaps to the frame grid (seeking to 1.04s at 30fps lands on frame 31 = 1.0333s), plus `seekToFrame` / `seekByFrames` with clamping.
3. **A/V synchronization** — audio and video positions are the same number from the same clock (`syncDriftMs()` = 0 by construction), and `resolveAtTime()` returns the exact source time of every active audio and video clip, honouring trims, speed (source time = sourceIn + offset × speed) and crossfade output-time shifts on the base track.
4. **Multi-layer preview** — `renderPreviewFrame()` decodes ONE real composited frame at any timeline instant: input-side `-ss` seeking per source (streaming decode; whole files are never loaded into memory), the base clip normalized to the canvas, crossfade midpoints rendered as genuine blends (incoming clip at its fade progress), overlays through the exporter's own `overlayTransformChain` (extracted and shared in Phase 27 so preview and export cannot drift), clip titles and text layers drawn when active. Hidden tracks are excluded.
5. **Playback speed controls** — 0.25–4× on the session clock, re-anchoring without position jumps; out-of-range speeds throw.
6. **Timeline view state** — `TimelineView`: zoom (4–400 px/s, clamped), scroll (clamped to duration), x↔time conversion, visible-range computation, per-track visibility toggles that feed both resolution and preview rendering.
7. **Preview follows edits** — frames are rendered from the live project on every request (no cache): a test moves a PiP clip through the Phase 26 operations API and the next frame shows it in the new place.
8. **Loading/error states** — sessions load into an explicit `error` state for invalid projects or missing media (play is refused); preview returns structured errors for out-of-range times, missing media and corrupted media (ffmpeg failure), and a failed render never leaves a fake frame file behind.
9. **Routes** — authenticated, ownership-checked: `POST /playback/info` (duration/frame grid), `POST /preview/frame` (renders a frame, returns metadata + image URL), `GET /preview/image` (serves frames scoped to the build's own preview directory).

## Verification

- `tests/phase27_playback_engine.test.ts`: **13/13 pass** — state machine with a deterministic clock (play/pause/seek/speed/end/restart), zero-drift sync, trim/speed/crossfade resolution with exact source times and fade progress, pixel-proven preview frames (PiP, segment-accurate seeking on a two-tone source, crossfade blend (127,0,127)), edit-following previews, hidden-track previews, missing/corrupted/out-of-range error results, `-ss`-before-`-i` streaming assertion, view-state clamps and round-trips.
- Regression: Phase 20 (15/15) and Phase 26 (12/12) suites re-run — **40/40 combined**, including after the exporter refactor that extracted the shared transform chain.
- Lint ✅, production build ✅, typecheck ✅.

## Limitations

- Playback is a timeline-accurate engine and preview renderer, not a GPU video player: continuous motion playback in a UI is rendered by the client from these primitives (the Phase 31 web editor drives it); the server renders individual frames on demand, each a real decode.
- Preview of a base-track gap (no base clip at that instant) composites overlays over a generated black canvas, labelled as such by the absence of a base entry in `activeClips`.
- Each preview frame is a fresh ffmpeg invocation (~100–300 ms for short clips); there is no frame cache — correctness over speed, by design.
