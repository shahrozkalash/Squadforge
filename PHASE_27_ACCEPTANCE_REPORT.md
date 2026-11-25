# Phase 27: Real-Time Timeline and Playback Engine — Acceptance Report

| Requirement | Status | Evidence |
|---|---|---|
| Real-time playback: play, pause, stop | ✅ Verified | `PlaybackSession` state machine, deterministic-clock tests 1.1–1.2 (positions exact to the frame) |
| Timeline scrubbing + frame-accurate seeking | ✅ Verified | Seek snaps to the frame grid (1.04s → frame 31 at 30fps); seekToFrame/seekByFrames tested |
| Preview of multiple video/image layers | ✅ Verified | Pixel-proven composited frames: base + PiP (test 3.1); image layers resolve through the same path as Phase 26 exports |
| Audio/video synchronization | ✅ Verified | Single clock: drift 0ms at every sampled instant; per-clip source times exact under trims/speed (tests 2.1–2.2) |
| Playback speed controls | ✅ Verified | 0.25–4× re-anchored speed on the shared clock; out-of-range rejected (tests 1.1–1.2) |
| Timeline zoom, scrolling, track visibility | ✅ Verified | `TimelineView` clamps + x↔time round-trip (test 4.1); hidden tracks excluded from resolution and rendering (test 3.4) |
| Preview updates when clips are moved/trimmed/edited | ✅ Verified | Edit via the Phase 26 operations API changes the very next rendered frame (test 3.4) |
| Responsive controls, clear loading/error states | ✅ Verified | Session `error` state refuses play on missing media; structured preview errors (test 3.5) |
| Actual media decoding, not placeholder frames | ✅ Verified | Every preview is an ffmpeg decode of the real sources; corrupted media fails honestly and leaves no file (test 3.5) |
| Missing/unsupported/corrupted media handled safely | ✅ Verified | Load-time and render-time checks with explicit messages (tests 1.3, 3.5) |
| Playback time synchronized with the editing timeline | ✅ Verified | One resolver (`resolveAtTime`) shared by session, preview and sync reporting; crossfade progress exact (test 2.3) |
| Avoid loading entire large videos into memory | ✅ Verified | Input-side `-ss` before `-i` asserted in the built argument list (test 3.6); decoding is streaming |
| Tests: seeking, sync, playback state, timeline changes | ✅ 13/13 | `tests/phase27_playback_engine.test.ts`; Phase 20+26 regression 27/27 in the same run (40/40 total) |
| Lint, tests, production build | ✅ | Lint ✅, build ✅, typecheck ✅ |
| Progress + acceptance reports with verified evidence | ✅ | This file + PHASE_27_PROGRESS.md (limitations stated: server renders frames on demand; no frame cache; gap canvas labelled) |

Final acceptance of this phase remains Sheroz's decision.
