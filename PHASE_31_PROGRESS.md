# Phase 31: Cross-Platform Professional Video Editor — Progress

Phases 20 and 26–30 built the engine; Phase 31 integrates it into one usable application: a web-based editor served by SquadForge itself, the generated Windows desktop editor (ClipForge) kept in step, project autosave/recovery over HTTP, and an end-to-end HTTP-level workflow test that drives the whole stack the way the UI does.

## Implemented

1. **Web-based editor** (`server/videoEditor/editorWebApp.ts`, served per build at `GET /api/builds/:id/video-editor/app`): a single self-contained page with a media library, preview player, multitrack timeline, properties panel and export screen. **Every control calls the real API** — there are no decorative controls:
   - Media library: file upload (`/media/import`, now accepting video/image/audio with the same size/extension/workspace rules) and probe-by-name (`/probe`); per-asset Add-clip, Waveform (canvas drawn from the real peaks) and Analyze (real scene/silence results).
   - Preview player: frames are **server-rendered real frames** (Phase 27 endpoint, the exporter's own compositing chain); transport play/pause/stop, frame stepping, playback-speed selection (stepping rate), timeline zoom, per-track visibility sent as `hiddenTrackIds`. Playback steps through frames the server actually renders — the achievable rate depends on project size, and the page says so instead of faking motion.
   - Timeline: tracks and clips rendered from the project JSON at the chosen zoom, ruler seek, click-to-select, playhead.
   - Properties: timeline start (move), position/scale/rotation/opacity, speed, volume, fades — applied through the validated operations endpoint; effect add/remove; transition add; split/duplicate/delete; track add (new `addTrack` operation), per-track volume/mute; text overlays; captions add/remove plus SRT import/export.
   - Export screen: preset list and encoder notes come from `/render/capabilities` (so the page shows "no verified hardware encoder — software libx264" on this host rather than pretending); synchronous export and background render jobs with a progress bar driven by the job's real progress, cancel, history with retry and delete-output.
   - Errors and loading states: a server error anywhere appears verbatim in the error bar; the preview shows a "Rendering frame…" state while a frame is in flight; export buttons disable during a synchronous export.
2. **Project autosave and recovery over HTTP**: `POST /project/create`, `POST /project/save` (atomic write + journal via the Phase 20 store), `GET /project/load` returning the project and its journal state. The web editor autosaves (debounced) after every applied operation and, on boot, recovers the saved project and says so, including the journal state.
3. **Keyboard shortcuts**: Space play/pause, ←/→ frame step (Shift = 1s), Home stop, S split at playhead, Delete remove clip, Ctrl+S save — all wired to the same operations as the buttons.
4. **Responsive layout**: the three-panel grid collapses to a single column under 980px; the preview scales with the viewport.
5. **Desktop application (ClipForge)**: the generated Windows editor gained the Phase 29 caption model — `VideoCaption` cues saved/loaded with the project and burned into its ffmpeg exports with the same style as the server (bottom-centre, fontsize 28, boxed, timed enable). It compiles genuinely with the Phase 18 pipeline: build succeeded, PE verified; `ClipForge.dll` 39,424 bytes, sha256 `4f56ea5b773676a6be893a17081cf7a008d20044501207568fbdeda51999afbf`.
6. **Platform readiness**: Android/iOS integration is architectural only — the editor is an HTTP API plus a web client, and Phases 17/25 generate native projects — but **no Android or iOS editor is claimed**: nothing mobile was built or verified in this phase.

## Verification

- `tests/phase31_integrated_editor.test.ts`: **1/1 — the complete workflow over real HTTP** against the actual router (stub auth/ownership, real everything else): the served page references the real endpoints → project create → media probe/import → operations (base clip, new overlay track, PiP clip, transform, effect, fades, caption, text) → playback info ≈ 3s → preview frame pixels (blue PiP centre, red base corner) → waveform + analysis → save → reopen with captions/tracks/journal intact → SRT export → background render job at the 720p preset polled to `succeeded` with progress 1 → output file ffprobe-validated (1280×720, audio present, ~3s) → present in export history → a foreign build id gets 404.
- The editor page's JavaScript passes `node --check`, and every element id the script references exists in the served HTML (both asserted during development).
- Regression in the same run: Phases 20/26/27/28/29/30 — **72/72 combined**.
- Lint ✅, production build ✅, typecheck ✅.

## Limitations

- The web editor's playback is frame-stepping over server-rendered frames (real decoding, honest rates), not a GPU-composited live video element; large projects step slowly. This is the Phase 27 architecture surfaced faithfully, not a placeholder.
- The web UI was verified at the HTTP/API level and by static checks (syntax, element ids, endpoint references), not by an automated browser clicking through it; the generated Windows app's GUI likewise cannot run on this Linux host (standing limitation) — its compilation and export-argument generation are what is verified.
- ClipForge mirrors transforms, effects, speed, text and now captions; keyframe animation, transitions and render jobs remain server-engine features the desktop app does not yet mirror.
- This is a working professional-style editor built on a real engine; it is **not** claimed to be CapCut-level or production-ready — see the acceptance report for the exact evidence boundary.
