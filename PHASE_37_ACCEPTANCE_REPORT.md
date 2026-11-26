# Phase 37 Acceptance Report — Android Video Editor Export Parity

Date: 2026-11-26
Status: **Ready for owner acceptance.** The generated Android ClipForge editor's Media3 export now renders the timeline's editing operations faithfully, proven by a genuine on-emulator export verified with FFprobe and pixel-level checks: Phase 37 workflow **run #17 (commit `3e409d0`) passed all 11 `EXPORT_VERIFY` checks** with the gate line "All Phase 37 checks passed."

## Requirement-by-requirement

| # | Requirement | Evidence |
| :--- | :--- | :--- |
| 1 | Genuine video overlay + image compositing | Green 160×120 PiP composited at its transform position and scale (media-relative compositor calibration, run #15–#16); yellow image clip composited at its window — `EXPORT_VERIFY pipGreen=pass`, `imageYellow=pass` in run #17 |
| 2 | Real transition rendering where supported | Crossfade renders as a true blend: the junction pixel at t=3.5 reads (127,0,124), a half red/half blue mix — `crossfadeBlend=pass`. The other 7 transition types render as cuts with an explicit note (documented limitation) |
| 3 | Clip speed + audio fade processing | Speed-2 clip B occupies half its source duration in the 5.00 s total; music fades verified by RMS (start 0.0272 < 0.55 × mid 0.1233; end 0.0417) — `audioFadeIn=pass`, `audioFadeOut=pass` |
| 4 | Text overlays burned in | White "HELLO" text rendered into the frame at its position/size/colour — `textWhitePixels=pass` (>30 white pixels in the text region at t=1.0) |
| 5 | Audio mixing, timeline timing, synchronization preserved | Project→export time conversion accounts for crossfade shrinkage; total duration 5.00 s exactly as planned (4 + 4/2 − 1 crossfade + music span); AAC stream present — `duration=pass`, `audioStream=pass` |
| 6 | Existing Media3 architecture, no duplicate engine | The export is the same generated app's `VideoExporter`, restructured around the pure-Kotlin `ExportPlanner`; no second engine was introduced |
| 7 | Genuine media-based export tests verified with FFprobe | The harness synthesizes known media, runs the real export on an emulator, pulls the MP4, and probes it: run #17's pulled file verified independently as **H.264 640×360, 5.000 s, AAC audio, 202,808 bytes** |
| 8 | Project compatibility preserved | The planner consumes the existing project model unchanged; Phase 34's generated-app behaviour (explicit target-size `Presentation`) is preserved; generated-app JVM tests grew 8 → 19 and the Phase 34 CI gate was updated to the exact new line |

## Final CI evidence (run #17, commit `3e409d0`)

- `UNIT_TESTS tests=19 failures=0 errors=0 skipped=0`
- `INSTRUMENTED status=pass` (real export on the emulator)
- `EXPORT_VERIFY`: duration, resolution, audioStream, pipGreen, baseRed, crossfadeBlend, imageYellow, pipGoneBlueBase, textWhitePixels, audioFadeIn, audioFadeOut — **11/11 pass**
- `RESULT_JSON` `ok:true`; gate line "All Phase 37 checks passed."
- Exported MP4 pulled and probed locally: H.264, 640×360, 5.000 s, AAC; frame scans at t=2.0 (PiP green over red base), t=3.5 (blend 127,0,124), t=4.6 (PiP gone — blue base, yellow image present) all correct.

## Root causes found on the way (17 runs)

The full run-by-run table is in `PHASE_37_PROGRESS.md`. The three decisive findings, all proven from Media3 1.6.1 behaviour/bytecode rather than guessed:

1. **Composition order is top-layer-first** — `DefaultVideoCompositor` draws inputs in reverse registration order, so the base sequence must be registered last (`7ba2506`).
2. **Compositor scale is media-relative** — `StaticOverlaySettings` scale applies on top of Media3's input-to-canvas aspect fit; canvas-relative scales shrink overlays a second time (`38360c5`, with the H.264 mime pin for the encoder fallback the reorder exposed).
3. **Ended sequences freeze their last frame** — the compositor consults the settings with the held frame's in-window timestamp, so sequences are padded to the full composition duration with muted post-roll (`3e409d0`).

Earlier structural rules were established the same way: no gaps anywhere in video sequences, homogeneous audio presence per sequence, explicit frame rate on image items, muted pre-roll instead of leading gaps.

## Known limitations

- Only `crossfade` of the eight transition types renders for real; the rest render as cuts with an explicit note in the export outcome.
- Base-track gaps/overlaps are closed up (the base plays back-to-back), with a note when detected.
- Overlay rotation direction follows the Media3 compositor convention and is not pixel-verified.
- All runtime evidence is from an emulator with software rendering (SwiftShader); no physical-device run has been performed.
- The diagnostics instrumentation (`CompositorDiagnostics`) remains in the generated export path; it records compositor calls for the parity test and is inert outside it.
