# Phase 20 Progress — Video Editing Engine

Date: 2026-11-25
Baseline: `c45f4026` (main, after Phase 19)
Status: **Implemented and verified with genuine ffmpeg exports.** Acceptance is the owner's decision.

## What was built

`server/videoEditor/`:

- `types.ts` — `MediaAsset`, `TimelineClip` (trim points, volume, effect, title), `TimelineTrack` (video/audio), `Transition` (crossfade), `VideoProject`, `ExportSettings`, `ExportResult`.
- `timeline.ts` — the timeline model, all operations validated:
  - add/trim/split/move/remove clips with **overlap enforcement** on every track (the one exception: a base-track clip may overlap its predecessor by exactly the crossfade duration defined on it);
  - split keeps source offsets exact; trim supports keep-end-fixed; cross-track moves reject kind mismatches; volume is range-checked;
  - transitions validated (not after the last clip, shorter than both neighbours); `timelineDuration()` accounts for crossfade shortening;
  - project save/load (JSON, validated on load) plus a **recovery journal**: saves are atomic (tmp + rename), the journal records `saved` / `exporting` / `exported` / `export-failed`, and recovery always returns the last intact project.
- `mediaProbe.ts` — real ffprobe probing (duration, streams, dimensions, fps) with honest tool detection (env, PATH, standard locations; existence-verified).
- `videoExporter.ts` — compiles the timeline into a real ffmpeg filter graph: per-clip `trim`/`scale`/`pad`/`fps` normalization and effects (grayscale, blur, sharpen, invert), hard-cut groups joined by `concat`, groups joined by **xfade crossfades** at the defined durations, **drawtext titles** (system font, time-windowed), and audio from base clips + audio tracks (`atrim`, per-clip `volume`, `adelay` placement, `amix`). Output is **validated with ffprobe** (duration vs. expected within tolerance, dimensions, required streams) before success is reported. Missing ffmpeg, missing media, non-zero exit, or probe mismatch all return honest failures.
- `videoProjectGenerator.ts` — generates a C# WinForms video editor on the Phase 18 stack: multitrack document model with the same operations, an export that builds an ffmpeg graph and runs a real ffmpeg found on PATH (failing honestly when absent), JSON project save/load, and an editor shell with import, timeline, split/remove, and resolution/fps export settings.
- `videoEditorRoutes.ts` — `/api/builds/:id/video-editor` (generate, status, probe, export), mounted in `server.ts` with the standard auth + ownership dependencies; media paths are workspace-scoped via the shared path validators.

## Genuine evidence

- **Tests: 15/15 pass** (`tests/phase20_video_editing_engine.test.ts`), including three real exports from lavfi-generated media (testsrc/smptebars + sine tones):
  - two-clip hard-cut export → MP4 validated at ~4.0s, 320×240, with audio;
  - crossfade (0.5s) + title + grayscale export → validated at ~3.5s (the crossfade genuinely shortened the output);
  - missing-media export → honest failure, no file produced, journal left at `export-failed`, and the saved project recovered intact.
- **Generated app compiles** through the Phase 18 pipeline: `ClipForge.exe` (152,064 bytes, sha256 `a61d10662f4e4895a394b6bd64e1c5fec4354a27c36163cb0b4d43d505917f12`, PE-verified x64 Windows GUI) and `ClipForge.dll` (25,600 bytes, sha256 `37552d8108d2363e99593b8c108ca04b1a099cd16807ef1085ff1de9dc3dc57f`).
- Engine on this host: **ffmpeg 8.1.2** (xfade, drawtext, amix, concat filters present), DejaVu fonts for titles.
- Lint (`tsc --noEmit`) ✅ · production web build ✅.

Two real bugs were caught by the tests during development and fixed: the overlap check filtered the candidate clip out of its own comparison (same-id), which silently disabled overlap detection for move/trim; and early export failures (e.g. missing media) did not update the recovery journal. Both are covered by the suite now.

## Limitations

- Export compositing: the base video track is the visual sequence; additional video tracks are modeled and persisted but picture-in-picture overlay compositing is not yet in the exporter (their clips are not rendered). Audio from all tracks **is** mixed.
- Transitions are crossfades only; titles are drawtext overlays with a system font.
- The generated C# app's import uses a default 5-second trim (its model supports full trim/split/move; a frame-accurate preview UI is future work), and its preview is structural, not a playback engine.
- Export validation tolerance is ±max(1s, 5%) on duration, matching container/rounding behavior of the underlying codecs.
