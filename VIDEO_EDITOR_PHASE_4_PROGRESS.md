# Video Editor Roadmap — Phase 4: Rendering and Export Engine — Progress

> **Naming note:** this is Phase 4 of the standalone *Professional Video
> Editor Roadmap*. Its phase numbers collide with SquadForge's own phase
> numbering (the video editor itself was built as SquadForge Phases
> 20, 26–31). To keep the two series unambiguous, these documents are
> named `VIDEO_EDITOR_PHASE_4_*` instead of `PHASE_4_*`.

Date: 2026-11-27. Status: **implemented and verified locally; not pushed**
(push is the owner's action, as with every phase).

## What the phase asked for

Implement a reliable rendering pipeline with project-to-video export,
resolution settings, frame rates, quality settings, audio encoding,
progress tracking, cancellation, and error recovery. Support 720p and
1080p first, then prepare for 4K.

## Audit first (spec item → existing implementation → gap)

The pipeline the brief describes was built by SquadForge Phase 20
(`server/videoEditor/videoExporter.ts`) and Phase 30
(`renderEngine.ts` + `renderJobs.ts` + `hwAccel.ts`) and is in use by
the routes and the web editor. Building a second render pipeline
beside it would violate the repo's own rules, so the phase began with
a file-verified audit. Every claim below is file-verified.

| Spec item | Already existed (evidence) | Genuine gap |
| :--- | :--- | :--- |
| Project-to-video export | `exportVideo` (`videoExporter.ts`): the timeline compiles to one ffmpeg filter graph (trim/scale/pad/fps per clip, concat groups, xfade junctions, overlays, titles, texts, captions, per-clip audio mixed with amix); the output is ffprobe-validated (duration, dimensions, audio presence) before success is reported | None |
| Resolution settings | `EXPORT_PRESETS` (`renderEngine.ts`): source/480p/720p/1080p/2160p + explicit width/height overrides; output dimensions probe-verified on every export | Values never validated (see settings validation row) |
| Frame-rate settings | `settings.fps` is a real setting: presets keep the project rate, overrides replace it (`settingsForPreset`), and the exporter normalizes every segment with `fps=` and sets `-r`. Phase 30 test 1.1 pins the settings math for a 24 fps override | **Output fps was never verified** — the probe captured `fps` into the result but nothing compared it to the request, and no test had ever rendered at a non-project rate. A wrong-rate file would have been reported as success |
| Quality settings | Bitrate mode only: `videoBitrateKbps` (preset envelope or override) → `-b:v` | **No constant-quality (CRF) mode** — the standard way to ask libx264 for "this quality, whatever bitrate it takes" did not exist |
| Audio encoding | AAC (`audioCodec: 'aac'`, the only codec the MP4 pipeline offers) + `audioBitrateKbps` → `-b:a` | **No sample-rate choice**, and `probeMedia` reported nothing about the audio stream (no codec, no sample rate), so audio properties of an export could not be verified at all |
| Progress tracking | Real: ffmpeg's `-progress pipe:1` channel → elapsed seconds → monotonic 0..1 fraction (`runFfmpeg`, `RenderJobManager.runJob`); Phase 30 test 3.1 | None |
| Cancellation | `AbortSignal` → SIGTERM/SIGKILL, result `cancelled`, partial output deleted (exporter + job manager); Phase 30 tests 3.2, 4.3 | None |
| Error recovery | Failed jobs keep a named error and the stored serialized project; `retry` re-runs them; jobs a dead process left `queued`/`running` load as `interrupted` and their output is never trusted; a verified hardware encoder that fails a real render falls back to libx264 once, with a note; Phase 30 tests 4.2, 4.3, 2.2 | The job store itself had a concurrency hole (next row) |
| Settings validation | **Nothing.** `ExportSettings` values flowed raw into the filter graph and encoder args; `settingsForPreset` spread overrides unchecked | **Missing** — odd dimensions (unencodable by the yuv420p chain), fps ≤ 0, negative bitrates failed opaquely inside ffmpeg, if they failed at all |
| Job persistence reliability | Atomic write-tmp-then-rename in `RenderJobManager.persist()` — but **every caller shared one tmp filename** (`jobs.json.tmp`) | **Race, code-proven**: concurrent persists (a submit's awaited persist, a running job's start/finish persists, a cancel's fire-and-forget persist) interleave write/rename; the first rename moves the tmp away and the second rename throws `ENOENT ... rename '.../jobs.json.tmp'`. This is the exact failure main CI run #173 recorded once in Phase 30 test 4.3 (`jobs3` dir); it never recurred only because the interleaving is timing-dependent |
| 720p / 1080p support | 720p: real render dimension-probed (Phase 30 test 1.2). 1080p: rendered in Phase 30 tests 3.1/3.2 (progress/cancel) but its dimensions were never probed | 1080p dimension proof (small; closed by new test 5.1) |
| 4K readiness | Real: the 2160p preset renders and is dimension-probed (Phase 30 test 1.3, 3840×2160) | None |

## What was implemented (only the gaps, inside the existing architecture)

### 1. Settings validation with named errors (`videoExporter.ts`, `renderEngine.ts`, `types.ts`)

- `validateExportSettings(settings): string[]` — width/height must be
  positive **even** integers ≤ 16384 (the export chain is yuv420p;
  odd dimensions cannot be encoded), fps must be in (0, 240],
  bitrates must be positive, `crf` (when set) an integer in [0, 51],
  and `audioSampleRateHz` (when set) one of `EXPORT_AUDIO_SAMPLE_RATES`
  (the standard rates, 8000–192000). Every error names the field, the
  rule, and the offending value.
- `exportVideo` runs it beside project validation and returns the
  honest `failed` result (`Invalid export settings: …`) **before**
  ffmpeg is invoked; no output file is produced.
- `settingsForPreset` runs it on the merged settings and throws the
  same named error, so a bad route override fails at resolution time
  (the same posture as `getPreset`'s existing throw for unknown
  presets).
- With no new options set, the ffmpeg argument list is byte-identical
  to the pre-Phase-4 list — validation only rejects, it never rewrites.

### 2. CRF constant-quality mode (`types.ts`, `videoExporter.ts`)

- `ExportSettings.crf?: number`. In `buildArgs`, libx264 renders with
  `-crf N` instead of `-b:v`. Hardware encoders have no CRF: they are
  driven by the bitrate setting, and if the standing render used one
  while a CRF was requested, the result carries a note saying exactly
  that — a requested quality mode is never silently dropped. If a
  hardware attempt fails and the software retry renders, the CRF
  applies there as requested.
- Proven on real exports (new tests 3.1, 3.2): CRF 18 vs CRF 40 of the
  same detailed 3 s clip produce identical geometry with the CRF 40
  file far smaller (< 75% of the CRF 18 size, in practice much less),
  and CRF composes with presets (720p + CRF 28 probes at 1280×720).

### 3. Audio sample-rate choice + a probe that can see audio (`types.ts`, `mediaProbe.ts`, `videoExporter.ts`)

- `ExportSettings.audioSampleRateHz?: number` → `-ar` on the audio
  encode. Unset keeps the mix's native rate (the source rate in
  practice).
- `probeMedia` now also reports `audioCodec` and `audioSampleRateHz`
  (additive `ProbeResult` fields, in the pattern of Phase 26's
  `videoCodec` addition).
- Proven on real exports (new tests 4.1, 4.2): a 44.1 kHz project
  exported with `audioSampleRateHz: 22050` probes as AAC at exactly
  22050 Hz; the default export probes at 44100 Hz.

### 4. Output frame-rate (and sample-rate) verification (`videoExporter.ts`)

- The post-render ffprobe validation — which already compared
  duration, dimensions, and audio presence — now also compares the
  output frame rate against `settings.fps` (tolerance: max(1 fps,
  5%)) and, when a sample rate was requested, the output sample rate
  against it. A render that comes out at the wrong rate is a failed
  render with a named error, not a success.
- Proven positively by the new fps exports (tests 2.1, 2.2: 30 fps
  project rendered at exactly 24 fps and exactly 60 fps, duration
  preserved) and by every pre-existing suite passing with the check
  active (141/141, below).

### 5. Render-job persistence hardened (`renderJobs.ts`)

- Persists are **serialized** through a promise chain
  (`persistChain`): only one store write is ever in flight, and the
  snapshot is taken when the write runs, so a queued persist always
  stores the latest state. The chain itself never rejects (one failed
  write cannot wedge later persists); each caller still receives its
  own write's outcome.
- Each write uses a **unique** tmp name (`jobs.json.<uuid>.tmp`) and
  cleans it up on failure — the shared-name interleaving is gone even
  across processes pointing at the same directory.
- Proof (new test 6.1): a burst of 12 concurrent submits with
  immediate cancels interleaved (the exact call pattern of CI #173)
  completes with zero rejections, a parseable store holding all 12
  jobs in coherent final states, no `.tmp` litter, and a fresh
  manager reading the same truth. **Counter-proof:** with `persist()`
  temporarily reverted to the pre-fix form, the same test fails
  immediately with eleven `ENOENT … rename '…/jobs.json.tmp'`
  rejections — byte-for-byte the CI #173 signature — confirming both
  the root cause and that the test catches it. (The revert was a
  local experiment; the fixed code was restored and re-verified.)

## Tests

New suite `tests/video_editor_phase4_render_export.test.ts` —
**11/11 pass**:

- Validation, exact: valid/default/CRF/sample-rate settings accepted;
  eleven bad values each named (odd width, zero/negative height,
  fps 0 and 300, negative video bitrate, zero audio bitrate,
  CRF −1/52/23.5, non-standard sample rate); `settingsForPreset`
  throws the named error for bad overrides and passes good ones
  through exactly; `exportVideo` refuses invalid settings with the
  named error and produces no file.
- Frame rates on real exports: 24 fps and 60 fps renders of a 30 fps
  project probe at exactly the requested rate; duration preserved.
- CRF on real exports: CRF 40 ≪ CRF 18 bytes at identical geometry;
  720p + CRF 28 probes at 1280×720.
- Audio on real exports: requested 22050 Hz lands in the AAC stream;
  default export keeps 44100 Hz.
- 1080p: preset render probes at 1920×1080, 30 fps.
- Persistence stress: 12 concurrent submit/cancel operations, zero
  rejections, coherent persisted store, no tmp litter, reload agrees.

Regression (same run of work): Phase 20 15/15, Phase 26 12/12,
Phase 27 13/13, Phase 28 11/11, Phase 29 10/10, Phase 30 10/10,
Phase 31 1/1, Roadmap Phase 1 20/20, Phase 2 21/21, Phase 3 17/17 —
with the new suite, **141/141**. `npm run lint` (tsc --noEmit) clean.
`npm run build` (vite production build) succeeds. No existing test
needed modification; no engine behaviour outside the four gaps
changed (the default export argument list is unchanged, and Phase
30's suite passes unmodified against the hardened job manager).

## Limitations (honest)

- **CRF is a libx264 mode.** That is an encoder fact, not an
  implementation shortcut: hardware encoders expose their own quality
  knobs (NVENC CQ, QSV global quality, AMF QP), which this phase does
  not map — on this host no hardware encoder verifies anyway, so the
  path is note-and-bitrate by design. Per-encoder quality mapping is
  future work if a host with a GPU ever runs this pipeline.
- **The audio codec remains AAC only.** `audioCodec` stays typed
  `'aac'`: it is the codec the MP4 output, the probe validation, and
  every existing caller assume. Sample rate and bitrate are the audio
  encoding choices; a second codec would be a format decision, not an
  export-setting tweak.
- **Validation caps are policy, stated in the open:** dimensions
  ≤ 16384 and fps ≤ 240 are sanity bounds chosen for this pipeline,
  not ffmpeg limits. A legitimate need beyond them is a one-line
  change to `validateExportSettings`.
- **The fps verification tolerance** (max(1 fps, 5%)) exists because
  ffprobe reports `avg_frame_rate` rounded to two decimals; it will
  catch a wrong-rate render (24 vs 30 vs 60) but not a 29.97-vs-30
  substitution. That trade-off is deliberate and documented here.
- **The persist chain is per-process.** Two `RenderJobManager`
  instances in *different processes* over one directory are still
  last-writer-wins (the unique tmp names keep each write atomic, but
  there is no cross-process lock). The server runs one manager per
  build in one process — the Phase 30 pattern — so this matches the
  deployment shape; it is stated rather than hidden.
- The web editor's export UI is unchanged: it does not surface CRF or
  sample-rate controls yet. The routes already accept both through
  the existing `settings` body (they flow through
  `settingsForPreset`/`exportVideo` validation unchanged).
