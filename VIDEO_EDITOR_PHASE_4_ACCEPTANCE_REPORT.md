# Video Editor Roadmap — Phase 4: Rendering and Export Engine — Acceptance Report

> **Naming note:** Phase 4 of the standalone *Professional Video Editor
> Roadmap*. Its numbering collides with SquadForge's own phases (the
> video editor was built as SquadForge Phases 20/26–31); these reports
> are named `VIDEO_EDITOR_PHASE_4_*` to keep the series distinct.

Date: 2026-11-27. Prepared for owner acceptance — **final acceptance is
the owner's decision**. Nothing was pushed; no later roadmap phase was
started.

## Verdict

Phase 4 is complete against its brief. The audit found the rendering
pipeline the brief describes — genuine ffmpeg project-to-video export,
resolution presets, frame-rate plumbing, bitrate quality control, AAC
audio encoding, real progress from ffmpeg's own progress channel,
cancellation that removes partial output, and background jobs with
failed/interrupted recovery — already implemented for real by
SquadForge Phases 20 and 30. The genuine gaps were **settings
validation** (values flowed raw into ffmpeg and failed opaquely),
**CRF constant-quality mode** (bitrate was the only quality control),
**an audio sample-rate choice** (and a probe that could not see audio
properties at all), **output frame-rate verification** (a wrong-rate
render would have been reported as success), and a **concurrency race
in job persistence** (the one-off main CI #173 failure, root-caused
here to the shared tmp filename in `RenderJobManager.persist()`).
All five were implemented inside the existing modules. No duplicate
pipeline was built, and with no new options set the export argument
list is byte-identical to before — every pre-existing suite passes
unmodified.

## Requirement-by-requirement

| Brief requirement | Outcome | Evidence |
| :--- | :--- | :--- |
| Project-to-video export | Already existed; verified, unchanged. Timeline compiles to one ffmpeg graph; output ffprobe-validated before success | `exportVideo` (`videoExporter.ts`); Phase 20 suite; Phase 30 suite |
| Resolution settings | Already existed (presets source/480p/720p/1080p/2160p + overrides; dimensions probe-verified per export); **now validated** (positive even integers ≤ 16384, named errors) | `renderEngine.ts`, `validateExportSettings` (`videoExporter.ts`); new tests 1.1–1.3 |
| Frame rates | Setting already existed (presets keep project fps; overrides win); **now proven on real exports and verified per render**: a 30 fps project exported at 24 fps and at 60 fps probes at exactly those rates, and the exporter now fails a render whose probed rate differs from the request | `settings.fps` (`types.ts`); new tests 2.1, 2.2; exporter validation block |
| Quality settings | Bitrate already existed; **CRF mode implemented**: `crf` (integer 0..51) drives libx264 with `-crf` instead of `-b:v`; on a hardware encoder the bitrate drives and the result notes the substitution — never silent | `ExportSettings.crf`; new tests 3.1 (CRF 40 ≪ CRF 18 bytes, identical geometry), 3.2 (720p + CRF 28 → 1280×720) |
| Audio encoding | AAC + bitrate already existed; **sample-rate choice implemented** (`audioSampleRateHz`, standard rates only, `-ar`) and the probe now reports `audioCodec`/`audioSampleRateHz` so exports are verifiable | `mediaProbe.ts`, `videoExporter.ts`; new tests 4.1 (22050 Hz lands in the AAC stream), 4.2 (default keeps 44100 Hz) |
| Progress tracking | Already existed; verified, unchanged. ffmpeg `-progress` → monotonic 0..1 fractions on the job and the callback | `runFfmpeg`, `renderJobs.ts`; Phase 30 test 3.1 |
| Cancellation | Already existed; verified, unchanged. Abort → cancelled result/job, partial file removed | `videoExporter.ts`, `renderJobs.ts`; Phase 30 tests 3.2, 4.3 |
| Error recovery | Failed state + named errors, retry from the stored project, interrupted-on-load (output never trusted), hardware→software fallback retry — all already existed; **the job store's own race fixed**: persists serialized through a chain + unique tmp names, so concurrent submit/cancel/run persists can no longer interleave into the CI #173 `ENOENT … rename jobs.json.tmp` failure | `renderJobs.ts`; new test 6.1 (12-way concurrent burst, zero rejections, coherent store, no tmp litter) + counter-proof: the same test against the pre-fix `persist()` fails with eleven ENOENT rename rejections, the exact CI #173 signature |
| 720p and 1080p first | 720p already dimension-probed (Phase 30 test 1.2); **1080p now dimension-probed too**: preset render probes at 1920×1080, 30 fps | New test 5.1 |
| Prepare for 4K | Already real: the 2160p preset renders 3840×2160 and is dimension-probed; the new validation accepts it (even dims ≤ 16384) and CRF/sample-rate compose with it the same way | Phase 30 test 1.3; `EXPORT_PRESETS` |

## Verification (all run locally, 2026-11-27)

| Check | Result |
| :--- | :--- |
| `tests/video_editor_phase4_render_export.test.ts` (new) | **11/11 pass, 0 fail** |
| `tests/phase20_video_editing_engine.test.ts` | 15/15 pass |
| `tests/phase26_professional_video_editor.test.ts` | 12/12 pass |
| `tests/phase27_playback_engine.test.ts` | 13/13 pass |
| `tests/phase28_effects_transitions_animation.test.ts` | 11/11 pass |
| `tests/phase29_audio_captions_ai.test.ts` | 10/10 pass |
| `tests/phase30_rendering_export_engine.test.ts` | 10/10 pass |
| `tests/phase31_integrated_editor.test.ts` | 1/1 pass |
| `tests/video_editor_phase1_architecture.test.ts` | 20/20 pass |
| `tests/video_editor_phase2_timeline.test.ts` | 21/21 pass |
| `tests/video_editor_phase3_preview_playback.test.ts` | 17/17 pass |
| **Total (one run)** | **141/141 pass, 0 fail, 0 skipped** |
| `npm run lint` (`tsc --noEmit`) | Clean |
| `npm run build` (vite production build) | Succeeds |
| Race counter-proof (pre-fix `persist()` vs new test 6.1) | Fails with 11 × `ENOENT … rename '…/jobs.json.tmp'` — the CI #173 signature; fixed code restored and re-verified green |

## Limitations (honest)

- CRF applies to libx264 only — an encoder fact. Hardware encoders
  are bitrate-driven with an explicit note when a CRF was requested;
  per-encoder quality knobs (NVENC CQ etc.) are not mapped, and no
  hardware encoder verifies on this host in any case.
- The audio codec remains AAC only (the MP4 pipeline's codec);
  sample rate and bitrate are the audio encoding choices.
- Validation caps (dimensions ≤ 16384, fps ≤ 240, standard sample
  rates) are stated policy in `validateExportSettings`, not ffmpeg
  limits.
- Frame-rate verification tolerance is max(1 fps, 5%) because
  ffprobe's `avg_frame_rate` is rounded to two decimals; it catches
  wrong-rate renders (24 vs 30 vs 60), not 29.97-vs-30 substitutions.
- Job persistence is serialized per process; two server processes
  over one jobs directory remain last-writer-wins (writes stay
  atomic via unique tmp names, but there is no cross-process lock).
  The server runs one manager per build in one process.
- The web editor's export UI does not surface CRF or sample-rate
  controls yet; both are accepted through the existing route
  `settings` body today.

## Recommendation

**Accept.** Every brief requirement is either proven pre-existing
functionality or a gap closed in this phase with real-export evidence
(probed dimensions, frame rates, sample rates, and file-size quality
differentials — nothing asserted from settings math alone), and the
one known CI flake in this subsystem (run #173) is root-caused,
fixed, and covered by a test demonstrated to catch the original code.
