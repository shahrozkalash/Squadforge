# Phase 30: Rendering and Export Engine — Acceptance Report

| Requirement | Status | Evidence |
|---|---|---|
| Complete pipeline (video, overlays, effects, transitions, text, audio) | ✅ Verified | The single Phase 20–29 graph builder; regression 71/71 across all six video suites |
| Presets 480p / 720p / 1080p / 4K where supported | ✅ Verified | Preset table asserted exactly; real renders probed at 1280×720 and 3840×2160 (tests 1.1–1.3) |
| MP4 H.264/AAC; other formats only when genuine | ✅ Honoured | MP4/H.264/AAC is the only offered format; nothing unimplemented is presented |
| Frame-rate and bitrate settings | ✅ Verified | fps + video/audio bitrate flow into settings and the encoder args; overrides beat presets (test 1.1) |
| Export progress, cancellation, error reporting | ✅ Verified | Real `-progress` channel ticks, monotonic and bounded (test 3.1); cancel returns `cancelled` and deletes the partial file (test 3.2); failures carry the ffmpeg log tail |
| Background jobs with safe recovery after interruption | ✅ Verified | Persisted job store; a planted `running` job loads as `interrupted` (output explicitly untrusted) and retries to a validated success (test 4.2) |
| Hardware acceleration detection + optional GPU rendering | ✅ Verified (detection) | Encoders are listed AND probe-verified before use; `auto`/named selection wired into the render (tests 2.1–2.2). No GPU exists on this host, so no hardware render is claimed |
| Automatic fallback to software rendering | ✅ Verified | Unavailable named encoder and `auto` both render via libx264 with an explanatory note and `encoderUsed: 'libx264'` (test 2.2); mid-render hardware failure also retries in software |
| Output validation using FFprobe | ✅ Verified | Pre-existing gate kept: duration/dimensions/stream checks must pass before `success`; job outputs probed in tests |
| Export history and output-file management | ✅ Verified | History persists across manager instances; output deletion removes the file and keeps the record (tests 4.1, 4.3) |
| Never report success without a validated existing file | ✅ Honoured | Success requires exit 0 + file exists + ffprobe validation; cancelled renders delete partials; interrupted jobs are never marked succeeded |
| Do not pretend GPU acceleration is available | ✅ Honoured | On this host detection reports every hardware encoder unverified and renders in software, saying so in notes and capabilities |
| Memory controlled for long videos | ✅ By construction + cap | Stream decoding, sequential jobs, 512 KB log tail cap |
| Existing project compatibility preserved | ✅ Verified | All Phase 20–29 suites pass unchanged (71/71) |
| Tests with genuine media + FFmpeg | ✅ 10/10 | `tests/phase30_rendering_export_engine.test.ts` |
| Lint, tests, production build | ✅ | Lint ✅, build ✅, typecheck ✅ |
| Hardware/rendering limitations recorded | ✅ | PHASE_30_PROGRESS.md (no GPU on this host; encode-stage-only acceleration; 0.5s progress ticks; sequential jobs; slow software 4K) |

Final acceptance of this phase remains Sheroz's decision.
