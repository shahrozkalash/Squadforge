# Phase 26: Professional Video Editing Engine — Progress

Extends the Phase 20 video editor (`server/videoEditor/`) in place — no duplicate system was created. Phase 20 projects load and export with unchanged behaviour (proven by test 5.2 and the untouched Phase 20 suite).

## Implemented

1. **Real overlay compositing incl. picture-in-picture** — every video track after the base track is composited with ffmpeg `overlay` filters in project (z) order, each clip windowed by `enable='between(t,…)'`, timestamp-shifted to its timeline position, with `eof_action=pass`. Proven at the pixel level (blue PiP over red base, window boundaries respected).
2. **Multiple layers** — unlimited video (base + overlays), audio, image and text layers. Still images are first-class media: `importMedia` detects image codecs (a probe bug that rejected images with no duration was found and fixed), and the exporter feeds them through dedicated `-loop 1` inputs so trim/speed semantics match video.
3. **Clip properties** — `ClipTransform` on every clip: position (x/y, may be negative), scale (0.05–4), rotation (−360..360°, exact bounding box computed in JS — ffmpeg's `hypot()` expression is unusable inside a filtergraph), opacity (0–1 via alpha), crop (per-edge pixels, validated against source dimensions). Speed (0.25–4×) via `setpts` + chained `atempo`. All validated; invalid values throw before any mutation.
4. **Accurate positioning and source-time controls** — timeline duration is now speed-aware (`clipDuration = source span / speed`); split maps timeline offsets to source offsets through the speed factor; trim's keep-end-fixed accounts for speed; source in/out points verified by a two-tone source test.
5. **Reusable, non-destructive editing tools** — `server/videoEditor/editingOps.ts`: `applyEditOperation` dispatcher (addClip, trim, split, move, remove, duplicate, setVolume, setTransform, setSpeed, addText, updateText, removeText, moveText), plus `cloneProject`. Operations mutate only the project model; a test hashes every source file before/after edits and exports and requires byte-identity.
6. **Text layers** — `project.texts`: positioned drawtext elements with font size, #RRGGBB colour, opacity, timing windows and layer ordering; rendered above overlays in export, and in the generated app when a font exists.
7. **Interface + generated app** — new authenticated route `POST /api/builds/:id/video-editor/operations` applies one validated operation to a submitted project and returns the updated project. The generated ClipForge desktop app gained the same model (transform properties, text list, overlay compositing + speed in `BuildExportArgs`, transform controls in the editor form) and was compile-verified genuinely (below).
8. **Canvas extension** — when overlays/texts extend past the base track, the canvas is padded with black (`tpad`) so late overlays remain visible; the exporter reports this and every other applied feature in `ExportResult.notes` instead of silently ignoring anything. Base-track spatial transforms are reported as overlay-only in the notes (crop and speed do apply on the base).

## Verification

- `tests/phase26_professional_video_editor.test.ts`: **12/12 pass** — PiP window/pixels, opacity blend (127,0,127), scale footprint, 180° rotation flip, crop removal, layer order via image track, speed duration + source-time mapping, split-under-speed, text pixels vs control export, non-destructive hashing, crash-journal recovery with new fields, Phase 20 file compatibility.
- Phase 20 suite re-run alongside: **15/15 pass** (27/27 combined).
- Generated ClipForge app compiled with the genuine Phase 18 pipeline: `ClipForge.exe` 152,064 bytes sha256 `a61d10662f4e4895a394b6bd64e1c5fec4354a27c36163cb0b4d43d505917f12`; `ClipForge.dll` 33,792 bytes sha256 `52be28c279d1a60fc58997a44162a4f4bc3ec273e942d2e5ca7b93361873196d`.
- Lint ✅, production build ✅, typecheck ✅.

## Limitations

- Spatial transforms (position/scale/rotation/opacity) apply to overlay-track clips; on the base track only crop and speed apply (reported in export notes).
- Rotation of media with unknown dimensions keeps the input frame size (corners crop) — dimensions are known for all probed media in practice.
- The generated app's GUI cannot be executed on this Linux host (standing limitation); its export graph mirrors the server exporter's structure but is verified by compilation, not by running it.
- No keyframe animation of transforms yet (Phase 28 scope); transforms are static per clip.
