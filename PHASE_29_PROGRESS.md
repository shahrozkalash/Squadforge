# Phase 29: Audio, Captions and AI Editing Engine — Progress

Integrated into the existing video editor (`server/videoEditor/`): the exporter's real amix path, the timeline model, the operations API, the preview renderer and the authenticated routes. The manual workflow (import → tracks → fades → captions → export) is complete without any AI provider.

## Implemented

1. **Multiple audio tracks with independent control** — already the Phase 20/26 model; Phase 29 adds per-track gain (`volume` 0..2) and `muted`, applied in the export mix on top of per-clip volume. Proven by PCM measurement: a muted second tone leaves the mix at single-track level, a half-gain track lands measurably between single and doubled.
2. **Audio fades, trimming, synchronization** — per-clip `fadeInSec`/`fadeOutSec` rendered with `afade` in the mix chain (validated to fit the clip's speed-adjusted duration); trimming and sync remain the Phase 26/27 source-time model, so fades ride the same timeline as the picture.
3. **Waveform from actual audio** — `waveform.ts` streams ffmpeg's PCM decode (mono, 8 kHz) and folds chunks into per-bucket peaks; long files never sit in memory. Verified against ground truth: ffmpeg's sine source peaks at exactly 0.125, a 1s-tone/1.5s-silence/1s-tone file peaks loud–silent–loud in the right buckets, and a video with no audio stream returns an explicit error.
4. **Voiceover / audio import** — audio files import through the existing probe path (`kind: 'audio'`), and a new authenticated route `POST /media/import` accepts a base64 audio upload (25 MB cap, extension allowlist, workspace-scoped write, then a real probe) — the endpoint a browser MediaRecorder voiceover flow posts to.
5. **Captions** — a caption track on the project (`captions: CaptionCue[]`) with validated add/update/remove operations; cues burn into exports via drawtext (disable with `burnInCaptions: false`) and appear in Phase 27 preview frames at the same position. **SRT and WebVTT import/export** are real parsers/formatters with lossless round-trips (including multi-line cues and hour-scale timestamps); malformed files throw instead of being silently mangled.
6. **Automatic captions via a provider adapter** — `captionProviders.ts`: config is server-side only (options or `SQUADFORGE_*` env). Default provider `none` reports `unavailable` and fabricates nothing. The one implemented provider, `whisper-cli`, shells out to a locally installed Whisper-compatible binary (offline, no paid APIs), requires a real SRT output file, and parses it with the real SRT parser; missing binary → `unavailable`, non-zero exit → `error`, exit 0 without output → `error`.
7. **AI-assisted suggestions from real signal analysis** — `aiEditing.ts` runs ffmpeg's scene-score filter and `silencedetect` and returns the measured scene timestamps, silent spans, and deterministic suggested cuts derived from them. Verified: the hard cut in a two-tone file is found at 2.0s ±0.35, and a constructed 1.5s silence is found at [1.0, 2.5] ±0.3. Missing/corrupt media returns an explicit error.
8. **Routes** — authenticated + ownership-checked: `/media/import`, `/waveform`, `/analyze`, `/captions/import`, `/captions/export`, `/captions/generate`, plus the new operations (`setFades`, `setTrackVolume`, `setTrackMuted`, `addCaption`, `updateCaption`, `removeCaption`) through the existing `/operations` endpoint.

## Verification

- `tests/phase29_audio_captions_ai.test.ts`: **10/10 pass** — fade envelope ratios measured on decoded PCM, gain/mute mix levels, waveform ground truth (0.125 sine peaks, silent gap ≈ 0), SRT/VTT round-trips and malformed-input failures, caption ops + burn-in pixels in export AND preview (with `burnInCaptions: false` control), scene/silence detection accuracy, provider unavailable/failure/success paths (the success path drives the adapter against a stand-in whisper binary honouring the real CLI contract; the adapter, process handling and parsing under test are the production code).
- Regression in the same run: Phases 20/26/27/28 — **61/61 combined**.
- Lint ✅, production build ✅, typecheck ✅.

## Limitations

- The whisper-cli provider is only as good as the locally installed binary; none is installed on this host, so live transcription quality is unverified here — the adapter contract, error handling and parsing are what this phase proves. No hosted/paid transcription is integrated, by requirement.
- Scene detection reports frame-difference scores above a threshold; it does not do semantic scene understanding, and the report says so.
- One caption track per project (cues may not need more for this editor's scope); styling per cue (fonts/colours per cue) is not modelled — burn-in uses the standard caption style.
- The generated ClipForge desktop app does not yet mirror captions/waveforms (server engine + routes are the integration surface this phase; the app catches up in Phase 31's integration pass if time allows — it is not claimed here).
