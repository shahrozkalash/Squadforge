# Phase 31: Cross-Platform Professional Video Editor — Acceptance Report

| Requirement | Status | Evidence |
|---|---|---|
| Complete editor interface (media library, preview player, multitrack timeline, properties panel, export screen) | ✅ Verified | Web editor served per build; every panel wired to the real API (E2E test asserts the page references the real endpoints and drives them) |
| Import and organize videos, images, audio and subtitles | ✅ Verified | Upload + probe import for video/image/audio; subtitle import/export (SRT/VTT from Phase 29) in the UI and over HTTP |
| Every editing control connected to the real engine | ✅ Verified | All controls call the validated operations/jobs endpoints; the E2E workflow exercises add/track/transform/effect/fades/caption/text through HTTP |
| Playback, editing, effects, transitions, captions and export work together | ✅ Verified | One HTTP workflow: PiP + effect + fades + caption + text → preview pixels correct → export job output ffprobe-validated |
| Project autosave, recovery, clear error handling | ✅ Verified | Debounced autosave after every op; save/load over HTTP with journal state; server errors surfaced verbatim in the UI; recovery proven in the E2E test (save → reopen intact) |
| Keyboard shortcuts and useful workflows | ✅ Implemented | Space/arrows/Home/S/Delete/Ctrl+S wired to the same operations (page code verified statically; shortcuts act on the same endpoints the E2E test drives) |
| Responsive interface | ✅ Implemented | CSS grid collapses under 980px; preview scales (CSS-level, stated as such) |
| Integration with project generation and desktop pipeline | ✅ Verified | ClipForge generator gained captions and recompiled genuinely through the Phase 18 pipeline (PE verified; dll sha256 in the progress report) |
| Usable Windows desktop application and web-based editor | ✅ Verified (with stated limits) | Web editor fully functional over the real API; ClipForge compiles and its export path is real ffmpeg — its GUI cannot be executed on this Linux host, so interactive desktop use is not claimed as tested |
| Architecture ready for Android/iOS without claiming them | ✅ Honoured | HTTP API + web client + native project generators (Phases 17/25); no mobile editor claimed |
| No decorative controls / no fake previews / no fake progress | ✅ Honoured | Preview frames are server-rendered decodes; job progress is ffmpeg's real channel; every button performs its named operation or shows the server's error |
| Complete workflow test (create → import → edit → effects+audio → preview → save → reopen → export, FFprobe-verified) | ✅ 1/1 | `tests/phase31_integrated_editor.test.ts` |
| All regression tests, lint, typecheck, production build | ✅ | 72/72 across Phases 20/26–31 suites; lint ✅, build ✅, typecheck ✅ |
| Platform-specific limitations documented | ✅ | PHASE_31_PROGRESS.md (frame-stepping playback rates, no browser-click automation, desktop GUI not executable here, ClipForge mirror scope) |
| No CapCut-level parity or production-readiness claim | ✅ Honoured | Not claimed anywhere; the evidence boundary is stated in both documents |

Final acceptance of this phase remains Sheroz's decision.

---

## Addendum (2026-11-28): CI #194 PiP colour regression — root cause and fix

**Failure.** In main CI run #194 (commit `daa7606`) this suite's
workflow test failed at the preview-frame step: *"PiP centre must
be blue, got (0, 0, 114)"*. The suite had been green in CI #193.
It reproduced locally with the same value, so it was not an
ffmpeg-version difference (local ffmpeg 8.1.2 vs the runner's apt
ffmpeg): the pushed code itself changed the rendered pixel.

**Root cause (frame-dump evidence).** The PiP/overlay rendering is
correct: rendering the exact preview filter graph gives the PiP
centre (240, 180) as **(0, 0, 254)**. The darkening comes from the
**caption drawtext box**. The preview draws the active caption
("HELLO E2E", fontsize 28, text top at y = h−52 = 188) with a
semi-transparent black box; measured on the rendered frame the box
spans rows **180–215**, cols **68–251** — its top padding strip
lands exactly on row 180, and x=240 is inside its right edge, so
the sampled PiP-centre point sits under the box's top border. The
arithmetic matches the failure exactly: 254 × (1 − 0.55) ≈ **114**.

The regression delta was in the pushed `server/videoEditor/playback.ts`:
the preview's caption box had been changed from the historical
`black@0.4 / boxborderw=6` to `black@0.55 / boxborderw=8` (matching
the exporter's constants). At border 6 the box top is row 182 —
below the sample point; at border 8 it is row 180 — on it. (The
Phase 3 overlay-scaling and Phase 4 export changes in the same push
were inspected and are not involved: with the caption box not
covering the point, the overlay renders pure blue on the same
code.)

**Fix.** One shared source of truth for the caption box, used by
both renderers so they cannot drift apart on it again:
`CAPTION_BOX_ALPHA = 0.55` and `CAPTION_BOX_BORDER = 6` are now
exported from `server/videoEditor/videoExporter.ts`; the exporter's
caption burn-in builds its drawtext from them and the preview in
`server/videoEditor/playback.ts` imports them. The border returns
to 6 in **both** renderers (alpha stays 0.55): the box top sits at
h−58 (row 182 at this frame size), clear of the PiP centre, and
preview ≡ export is preserved — the fix moves both together
rather than re-diverging the preview. The test's colour assertion
was not touched.

**Local verification (2026-11-28).** This suite: **1/1 pass**.
Regression: Video Editor Phase 3 + Phase 4 suites **28/28**;
Phases 20/26/27/29 suites **35/35** (Phase 29 covers caption
burn-in and preview captions against the changed constants).
Lint clean; build succeeds.
