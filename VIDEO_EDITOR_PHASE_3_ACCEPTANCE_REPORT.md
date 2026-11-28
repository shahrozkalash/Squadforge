# Video Editor Roadmap — Phase 3: Preview and Playback Engine — Acceptance Report

> **Naming note:** Phase 3 of the standalone *Professional Video Editor
> Roadmap*. Its numbering collides with SquadForge's own phases (the
> video editor was built as SquadForge Phases 20/26–31); these reports
> are named `VIDEO_EDITOR_PHASE_3_*` to keep the series distinct.

Date: 2026-11-27. Prepared for owner acceptance — **final acceptance is
the owner's decision**. Nothing was pushed; no later roadmap phase was
started.

## Verdict

Phase 3 is complete against its brief. The audit found the preview and
playback engine the brief describes — real composited preview frames,
a single-clock playback session, frame-accurate seeking and stepping,
one timeline resolver shared by session and preview (zero A/V drift by
construction), generic ffprobe/ffmpeg format handling with named
errors, and streaming input-seek decoding for large files — already
implemented for real by SquadForge Phase 27. The genuine gaps were
**aspect-ratio awareness** (nothing in the subsystem could size a
preview by aspect, and overlay images did not scale with non-project
preview sizes, so fitted previews would have diverged from the export
geometry) and a **preview-frame cache** (every request re-decoded).
Both were implemented inside the existing preview module and route.
No duplicate preview engine was built, the single-resolver invariant
is untouched, and default behaviour is unchanged: explicit preview
sizes are used verbatim exactly as before, and the cache only skips a
decode when every input to the frame is fingerprint-identical.

## Requirement-by-requirement

| Brief requirement | Outcome | Evidence |
| :--- | :--- | :--- |
| Real-time video preview | Already existed; verified, unchanged. Real composited frames via input-seeked decode through the exporter's transform chain | `renderPreviewFrame`/`buildPreviewArgs` (`playback.ts`); Phase 27 tests 3.1–3.6; new tests 2.2, 3.1–3.3, 5.1 |
| Playback, pause | Already existed; verified, unchanged. Single-clock `PlaybackSession` (play/pause/stop) | `playback.ts`; Phase 27 tests 1.1–1.3 |
| Seeking | Already existed; verified, unchanged. Frame-quantized `seekTo`/`seekToFrame` | `playback.ts`; Phase 27 test 1.1 |
| Frame navigation | Already existed (`seekByFrames`); **pinned by the new suite**: ±1 frame exactness, clamping at frame 0 and the last frame, audio on the same clock | `playback.ts`; new test 2.1 |
| Aspect ratios | **Was missing; implemented**: `ASPECT_RATIOS`, `aspectRatioString`, `parseAspectRatio`, `fitWithinBox` (aspect-preserving, never upscales, even dimensions for yuv420p), `previewSizeFor` precedence (explicit > fit > project), `playbackInfo().aspectRatio`; overlay images now scale with non-project preview sizes so a fitted preview is the export geometry scaled | `playback.ts`; new tests 1.1–1.5, 3.1–3.3 (pixel-level) |
| Synchronization between timeline and preview | Already existed by construction (one resolver); **now pinned end-to-end**: session `activeClips()` deep-equals the rendered preview's reported clips/roles/source times at a crossfade midpoint, frame index and time agree, pixels blend | `resolveAtTime` (`playback.ts`); new test 2.2 |
| Common video formats | Already existed (generic ffprobe/ffmpeg, named errors, no whitelist in the preview path); **proof added** for WebM/VP9, MOV/H.264, MKV/H.264 with real frames | `mediaProbe.ts`, `playback.ts`; new test 5.1; Phase 27 test 3.5 (corrupt/missing) |
| Large files reliably | Streaming input-seek decode already existed; **proof added**: a 90 s file previews 1 s from its end via `-ss` input seek. **Cache implemented** so repeat requests over the same frames no longer re-decode: `PreviewFrameCache` (LRU-bounded, files evicted with entries) + `previewCacheKey` fingerprint (serialized project + per-file size/mtime + frame + size + hidden tracks); wired per-build into `/preview/frame` | `playback.ts`, `videoEditorRoutes.ts`; new tests 4.1–4.5, 5.2 |

## Verification (all run locally, 2026-11-27)

| Check | Result |
| :--- | :--- |
| `tests/video_editor_phase3_preview_playback.test.ts` (new) | **17/17 pass, 0 fail** |
| `tests/phase20_video_editing_engine.test.ts` | 15/15 pass |
| `tests/phase26_professional_video_editor.test.ts` | 12/12 pass |
| `tests/phase27_playback_engine.test.ts` | 13/13 pass |
| `tests/phase28_effects_transitions_animation.test.ts` | 11/11 pass |
| `tests/phase29_audio_captions_ai.test.ts` | 10/10 pass |
| `tests/phase30_rendering_export_engine.test.ts` | 10/10 pass |
| `tests/phase31_integrated_editor.test.ts` | 1/1 pass |
| `tests/video_editor_phase1_architecture.test.ts` | 20/20 pass |
| `tests/video_editor_phase2_timeline.test.ts` | 21/21 pass |
| `npm run lint` (`tsc --noEmit`) | Clean |
| `npm run build` (vite production build) | Succeeds |

Counts are read from the suites' printed summaries. The full repo
suite was not run (30+ min on this VM); the run covered the new suite
plus every pre-existing video-editor suite and both earlier roadmap
suites. The two known pre-existing local-only failures
(`tests/orchestration.test.ts` sandbox-integrity,
`tests/phase4_production_reliability.test.ts` test 19) are outside this
set, exist on the pristine base, and pass in CI.

## Limitations (honest)

- The web editor does not yet request fitted (maxWidth/maxHeight)
  previews — it renders at full project size as before; the capability
  is live at the module and route layer.
- Explicit width/height that mismatch the project aspect still render
  at that aspect (the pre-existing caller-owns-it contract, same as
  export settings); the aspect-preserving path is the fit.
- The preview cache is per-process/per-build, entry-count-bounded
  (not byte-bounded), and its media fingerprint is size + mtime — a
  replacement preserving both would serve the older frame.
- Preview remains on-demand real decoding: no frame rate is
  guaranteed; the cache removes repeat cost, not first-render cost.
- The generated ClipForge desktop app is untouched by this phase.

## Recommendation

Accept Phase 3: the brief's engine was verified present and real, its
two genuine gaps (aspect-ratio-aware sizing with export-consistent
geometry, and a bounded fingerprint-invalidated preview cache) are
implemented in place and proven with real frames, and the regression
surface is fully green.
