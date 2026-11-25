# Phase 30: Rendering and Export Engine — Progress

The Phase 20 ffmpeg exporter — already the single pipeline for video, overlays, effects, transitions, text and audio (Phases 26–29) — was upgraded in place. Nothing was re-implemented; presets, progress, cancellation, encoder selection and background jobs were layered onto the same `exportVideo` path, so a job render and a synchronous export can never diverge.

## Implemented

1. **Complete pipeline** — unchanged and re-verified: base + overlay compositing, effect stacks, xfade transitions, keyframed animation, text elements, caption burn-in, multitrack audio with fades/gain — all through the one graph builder, all validated by ffprobe before success is reported (duration, dimensions, stream presence).
2. **Export presets** (`renderEngine.ts`): `source`, `480p` (854×480, 2.5 Mbps), `720p` (1280×720, 5 Mbps), `1080p` (1920×1080, 9 Mbps), `2160p`/4K (3840×2160, 25 Mbps), each with an AAC bitrate; project frame rate is kept unless overridden, explicit overrides always win. Verified by real renders: a 320×240 project exported at the 720p preset probes at exactly 1280×720, and at the 4K preset at exactly 3840×2160 (an upscale of the small source, as the settings state).
3. **Formats** — MP4 with H.264/AAC remains the one genuinely supported combination; no other format is offered, because none is implemented or validated.
4. **Frame-rate and bitrate settings** — `fps`, `videoBitrateKbps`, and (new) `audioBitrateKbps` are honoured end-to-end and validated against the output probe.
5. **Progress, cancellation, error reporting** — progress comes from ffmpeg's documented `-progress pipe:1` channel (`out_time_us`), after it was measured that piped stderr suppresses the periodic stats lines entirely (only a final summary survives). Progress is monotonic, bounded 0..1 of the expected duration. Cancellation via `AbortSignal` kills the process, returns a distinct `cancelled` status, and **deletes the partial file** so it can never be mistaken for a finished export. Errors keep the existing contract: non-zero exit or failed ffprobe validation → `failed` with the ffmpeg log tail; success is impossible without a validated file.
6. **Background jobs with recovery** (`renderJobs.ts`): a per-build `RenderJobManager` runs jobs one at a time (bounded memory), persists every transition to `jobs.json` (atomic rename), and on load marks any job a dead process left `queued`/`running` as **`interrupted`** — its partial output is explicitly not a valid export — with the serialized project stored on the job so **retry re-renders it for real**, even after a server restart. Verified end-to-end: submit → succeeded with progress 1 and a probed output; a hand-planted "running" job loads as interrupted and retries to a validated success; a running job cancels; a job whose media vanished fails with the reason; history survives a fresh manager instance.
7. **Hardware acceleration, honestly** (`hwAccel.ts`): candidate encoders (nvenc, qsv, amf, videotoolbox, vaapi) are checked against `ffmpeg -encoders` AND a real 1-frame encode probe — a listed encoder that cannot encode is reported unavailable. `encoderPreference: 'auto'` picks the first probe-verified hardware encoder; a specific request verifies the same way; anything unavailable — or a hardware render that fails mid-graph — **falls back to software libx264 with a note in the result**, and `encoderUsed` always names the encoder that actually produced the file. On this host every hardware candidate fails verification (no GPU), detection says so, and `auto` renders in software with the note — verified by test.
8. **Memory control** — media is decoded by ffmpeg as a stream (never loaded whole); the captured ffmpeg log is tail-capped at 512 KB so a multi-hour render cannot grow memory; jobs run sequentially.
9. **History and output management** — routes (authenticated, ownership-checked): `GET /render/capabilities`, `POST /export` (now accepts `preset` + encoder/bitrate settings), `POST /export/jobs` (202), `GET /export/jobs`, `GET /export/jobs/:jobId`, `POST /export/jobs/:jobId/cancel`, `POST /export/jobs/:jobId/retry`, `DELETE /export/jobs/:jobId/output` (file removed, record kept), `GET /export/history`.

## Verification

- `tests/phase30_rendering_export_engine.test.ts`: **10/10 pass** — preset table/settings math, real 720p and real 4K renders probed, probe-based detection honesty on a GPU-less host, named-encoder and `auto` fallback with notes, real monotonic progress, cancellation removing the partial file, job lifecycle (submit/persist/history), interrupted-job recovery + retry, job cancellation, honest job failure, output deletion.
- Regression in the same run: Phases 20/26/27/28/29 — **71/71 combined**.
- Lint ✅, production build ✅, typecheck ✅ (0 errors).

## Actual hardware and limitations (this host)

- **No GPU exists on this host**, and no hardware encoder passes verification; all renders here are software libx264. Hardware paths are implemented and probe-gated, but a successful hardware render is **not** claimed — it has never run on hardware available to this project.
- Hardware encoding, where it exists, accelerates only the encode stage; the filter graph (compositing/effects) remains CPU work, and a hardware failure mid-render falls back to a full software re-render.
- Progress granularity is ffmpeg's ~0.5s progress tick: a sub-second render may report only its final tick. Progress is never synthesized between ticks.
- One render job runs at a time per build (deliberate, for memory); jobs for different builds share the host CPU.
- 4K renders of long timelines are slow in software (x264 at 3840×2160); the preset is offered because it genuinely works and validates, not because it is fast here.
