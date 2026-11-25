# Phase 20 Acceptance Report — Video Editing Engine

Date: 2026-11-25
Baseline: `c45f4026` (main)
Status: **Ready for owner acceptance.** Exports are real ffmpeg renders validated by ffprobe; failures are reported as failures.

## Requirement-by-requirement

| # | Requirement | Evidence |
| :--- | :--- | :--- |
| 1 | Video preview and media import | Media import is real ffprobe probing (duration/streams/dimensions/fps — test 1.1); the generated app provides the preview surface and import UI. Server-side "preview" is the probed metadata + validated export, not a fake player. |
| 2 | Multitrack timeline with video and audio tracks | Track model with kinds, per-track overlap enforcement, cross-kind move rejection (tests 2.1–2.5). |
| 3 | Trimming, splitting, moving, arranging | Exact source-offset math verified (tests 2.2–2.4): split at 1.25s yields 1.25/0.75 clips with correct sourceIn; keep-end-fixed trim moves trackStart correctly. |
| 4 | Basic transitions, titles, visual effects | Crossfade via xfade genuinely shortens output (4.0s → 3.5s measured, test 5.2); drawtext titles; per-clip effects (grayscale/blur/sharpen/invert). |
| 5 | Audio volume and timeline controls | Per-clip volume (validated 0–1) applied in the mix; audio clips placed by timeline position with adelay; amix across tracks (tests 2.4, 5.1). |
| 6 | Export settings for resolution, frame rate, format | `ExportSettings` (width/height/fps/MP4, H.264 + AAC, bitrate) drive the graph; output dimensions are probe-verified against the settings (test 5.1). |
| 7 | Real media processing through a local engine | ffmpeg 8.1.2 on this host; three genuine exports in the test suite, each ffprobe-validated. No simulated rendering anywhere: missing media or empty timelines fail (tests 5.3–5.4). |
| 8 | Project save/load and recovery | Atomic save + journal (`saved`/`exporting`/`exported`/`export-failed`); after a failed export the project recovers intact with the journal showing `export-failed` (tests 4.1–4.2, 5.3). |
| 9 | Preserve previous phases | New module + one router mount; Phases 17–19 suites still pass (see full-suite note in the progress doc history); the generated app compiles through the Phase 18 pipeline (`ClipForge.exe`, sha256 `a61d10662f4e4895a394b6bd64e1c5fec4354a27c36163cb0b4d43d505917f12`). |

## Test evidence

- Phase 20 suite: **15/15 pass**
- Lint ✅ · production web build ✅
- Genuine exports validated by ffprobe (durations ~4.0s and ~3.5s with crossfade, 320×240, audio present)

## Known limitations

Overlay (PiP) compositing of secondary video tracks is modeled but not yet rendered; crossfade-only transitions; generated app's import uses a default 5s trim and has no playback preview engine. Full detail in `PHASE_20_PROGRESS.md`.

## Acceptance

Pending the owner's review, per the repository's phase process.
