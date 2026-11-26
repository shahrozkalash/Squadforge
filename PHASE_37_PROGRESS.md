# Phase 37 Progress — Android Video Editor Export Parity

Date: 2026-11-26
Status: **Complete.** Run #17 of the Phase 37 genuine-export workflow (commit `3e409d0`) passed every check: all 11 `EXPORT_VERIFY` lines pass, `RESULT_JSON` `ok:true`, and the gate line "All Phase 37 checks passed." appeared. See `PHASE_37_ACCEPTANCE_REPORT.md` for the requirement-by-requirement evidence.

## What was built

The generated Android ClipForge editor (`server/android/videoEditorGenerator.ts`, Media3 1.6.1) was upgraded from a plain sequential export to a plan-driven export that mirrors the server engine's timeline semantics (`server/videoEditor/`):

- **Pure-Kotlin planner** (`ExportPlan.kt`): `ExportPlanner.plan(project, targetW, targetH)` computes sequences, compositor windows, and notes with zero Android imports, so it is JVM-testable. The generated app's JVM suite grew from 8 to **19 tests** (`ExportPlannerTest`, 11 tests) and the Phase 34 workflow gate was raised to match.
- **Plan-driven exporter** (`VideoExporter.kt`): base track segmented at text/transition boundaries; crossfade heads and overlay clips composited through a custom `VideoCompositorSettings`; speed via `SpeedChangeEffect` + pitch-corrected `SonicAudioProcessor`; clip gain and audio fades at sample level (`ClipAudioProcessor`, replacing the old `GainAudioProcessor`); text burned in via `TextOverlay`; Transformer build/start marshalled to the main looper (Media3 requirement).
- **Genuine verification harness** (`scripts/phase37-genuine-export.ts` + `.github/workflows/phase37-android-export-parity.yml`): generates the app, builds it, synthesizes five known media files with FFmpeg, runs the instrumented `ExportParityTest` on an emulator (real export of a synthetic project: crossfade, speed-2 clip, green PiP, yellow image, music with fades, burned-in text), pulls the MP4, and verifies it with FFprobe + pixel/RMS checks. The workflow gate requires the harness `RESULT_JSON` `ok:true`, `apkBytes > 0`, the exact unit-test line, `INSTRUMENTED status=pass`, and every `EXPORT_VERIFY` line passing.

## Parity semantics implemented

- Clip timeline duration = (sourceOut − sourceIn) / speed; clip fades are audio fades in clip time.
- Crossfade is xfade-style: the window is the last d seconds of a junction and the total duration shrinks by d per junction (d clamped to min(d, 0.5·durA, 0.5·durB), dropped to a cut below 0.05 s). Only `crossfade` of the 8 transition types renders for real; the other 7 render as cuts with an explicit plan note (also for transitions after non-base/last clips).
- Overlay placement: transform x/y is the top-left pixel position of the scaled clip on the canvas.
- Project time is converted to export time per clip (accumulated crossfade shrinkage), so overlays, audio, and text stay synchronized after junctions shrink the timeline.

## The road to green — 17 runs, each failure root-caused

| Run | Failure | Root cause / fix |
| :--- | :--- | :--- |
| #1 | Emulator never booted | KVM permissions on the runner + TCG flag (`44adbb1`) |
| #2 | Transformer accessed off the main thread | Build/start/cancel marshalled to the main looper (`27c41ac`) |
| #3–#4 | Generic asset-loader error; one environmental Gradle failure | Cause-chain diagnostics added (`62b9e6c`, `a5fbbde`); #4 was environmental (identical project built green in Phase 34) |
| #5 | `SingleInputVideoGraph does not use VideoCompositor` | A sequence starting with a gap never registers its video track → muted pre-roll fillers (`367f3f1`) |
| #6 | "Gaps in video sequences are not supported" | Gaps removed from all video sequences (`73a55ad`) |
| #7 | Sequence refused (items disagree about audio track) | Homogeneous per-clip/per-head sequences (`ff77326`); `experimentalSetForceAudioTrack` was tried first (#8) and died on a null audio consumer — removed |
| #9 | Bare message-less `IllegalStateException` in 0.14 s | Root stack-trace diagnostics (`f1bdf61`) |
| #10 | Same crash, pinpointed | `ImageAssetLoader` frame-rate check: image items need an explicit frame rate (`2a5789a`) |
| #11 | **Instrumented test passes for the first time**; harness pixel read broken | Harness crop-read bug fixed (`41adad8`); local frame scans then proved overlays genuinely never composited |
| #12 | androidTest compile failure | Missing `CompositorDiagnostics` import — Spark's error, owned; generated test sources are compiled locally ever since (`470847e`) |
| #13–#14 | 7/10 checks pass; overlays still invisible despite provably correct settings (diagnostics: alpha 1.0 throughout the PiP window) | Minimal-composition probe added (`929c167`); its centre pixel was pure red — secondaries never reached the output |
| #15 | Probe centre **pure green** — compositing fixed; export shrank to 512×288 HEVC and overlays drew at 32×32 | Root cause found in Media3 1.6.1 bytecode: `DefaultVideoCompositor` draws inputs in **reverse** registration order, so composition order must be top-layer-first, base last (`7ba2506`). Follow-ons: H.264 pinned (`setVideoMimeType`) and compositor scale recalibrated media-relative (`38360c5`) |
| #16 | 10/11 — PiP never leaves after its window | Media3 holds an ended sequence's last frame and consults the settings with that frame's in-window timestamp, so the alpha-0 outside the window never applies. Frame scans of the pulled MP4 proved green at t = 3.9…4.9 |
| #17 | **All 11 checks pass** | Composited sequences padded to the full composition duration with muted post-roll (`3e409d0`), so the current frame advances past the window |

Local verification at every step: generated Kotlin compiled locally (main **and** androidTest sources), planner JVM tests run locally (11/11), repo suites green, `npx tsc --noEmit` clean.

## Honest limitations

- Only `crossfade` renders as a real transition; the other seven types render as cuts with an explicit note in the export outcome.
- Base-track gaps/overlaps are closed up (base plays back-to-back), with a note when detected.
- Overlay rotation direction follows the Media3 compositor convention; it is not pixel-verified.
- Verification ran on an emulator (SwiftShader software rendering), not a physical device.
