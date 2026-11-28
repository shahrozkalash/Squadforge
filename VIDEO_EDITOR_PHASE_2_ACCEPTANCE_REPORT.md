# Video Editor Roadmap — Phase 2: Professional Editing Timeline — Acceptance Report

> **Naming note:** Phase 2 of the standalone *Professional Video Editor
> Roadmap*. Its numbering collides with SquadForge's own phases (the video
> editor was built as SquadForge Phases 20/26–31); these reports are named
> `VIDEO_EDITOR_PHASE_2_*` to keep the series distinct.

Date: 2026-11-27. Prepared for owner acceptance — **final acceptance is the
owner's decision**. Nothing was pushed; no later roadmap phase was started.

## Verdict

Phase 2 is complete against its brief. The audit found the professional
timeline the brief describes — multitrack model with overlay tracks,
importing, trim/split/move/edge-resize/delete, zoom, and mute/volume/hide
track controls — already implemented for real by earlier SquadForge
phases. The two genuine gaps, **edit snapping** and **track lock**, were
implemented inside the existing architecture: snapping as a new pure
module wired into the existing operation dispatcher, and lock as a model
field enforced by the validated operation layer. No duplicate timeline
was built, no existing operation changed behaviour (snapping is opt-in
per operation; lock defaults off), and the serialized project format is
untouched (version 1).

## Requirement-by-requirement

| Brief requirement | Outcome | Evidence |
| :--- | :--- | :--- |
| Multi-track timeline: video, audio, overlay tracks | Already existed; verified, unchanged. Overlay is a role: every video track after the base is composited as an overlay (exporter) and resolves with role `'overlay'` (playback) | `types.ts`, `timeline.ts` (`baseVideoTrack`), `videoExporter.ts`, `playback.ts` (`resolveAtTime`); role test in the new suite |
| Importing | Already existed; verified, unchanged | ffprobe `importMedia` (`mediaProbe.ts`), `/media/import` route, validated `addClip` |
| Trimming | Already existed; gained optional snapping | `trimClip` + `trim` op (`timeline.ts`, `editingOps.ts`) |
| Splitting | Already existed; verified, unchanged | `splitClip` + `split` op |
| Moving | Already existed; gained optional snapping | `moveClip` + `move` op |
| Resizing | Already existed — edge resize is `trimClip` (end edge; start edge with `keepEndFixed`) | `timeline.ts` |
| Deleting | Already existed; verified, unchanged | `removeClip` + `remove` op (prunes transitions) |
| Snapping | **Was missing (only playback frame-grid snapping existed); implemented**: `collectSnapPoints`/`snapTime`/`snapMoveStart` (origin, clip edges, track boundaries, timeline end, playhead; 0.25 s default threshold) + opt-in `snap` on the dispatcher's `move`/`trim` ops, both edges, exact source-time conversion for trims | `server/videoEditor/snapping.ts`, `editingOps.ts`; 13 snapping tests incl. verbatim-behaviour pins without `snap` |
| Zooming | Already existed; verified, unchanged | `TimelineView` pxPerSecond 4–400 zoomIn/zoomOut (`playback.ts`); web-editor zoom slider |
| Track controls | Mute/volume (model) and hide (view) already existed; **lock was missing; implemented**: `TimelineTrack.locked`, enforced by `assertTrackUnlocked` in every validated clip edit incl. transitions, new `setTrackLocked` op; controls stay operable while locked | `types.ts`, `timeline.ts`, `editingOps.ts`; 7 lock tests incl. refusals by named error and history integrity |
| Tests for editing operations | New focused suite + full video regression | Below |

## Verification (all run locally, 2026-11-27)

| Check | Result |
| :--- | :--- |
| `tests/video_editor_phase2_timeline.test.ts` (new) | **21/21 pass, 0 fail** |
| `tests/phase20_video_editing_engine.test.ts` | 15/15 pass |
| `tests/phase26_professional_video_editor.test.ts` | 12/12 pass |
| `tests/phase27_playback_engine.test.ts` | 13/13 pass |
| `tests/phase28_effects_transitions_animation.test.ts` | 11/11 pass |
| `tests/phase29_audio_captions_ai.test.ts` | 10/10 pass |
| `tests/phase30_rendering_export_engine.test.ts` | 10/10 pass |
| `tests/phase31_integrated_editor.test.ts` | 1/1 pass |
| `tests/video_editor_phase1_architecture.test.ts` | 20/20 pass |
| `npm run lint` (`tsc --noEmit`) | Clean |
| `npm run build` (vite production build) | Succeeds |

Counts are read from the suites' printed summaries. The full repo suite
was not run (30+ min on this VM); the run covered the new suite plus
every pre-existing video-editor suite. The two known pre-existing
local-only failures (`tests/orchestration.test.ts`,
`tests/phase4_production_reliability.test.ts` test 19 — both green in CI)
are outside this subsystem and untouched.

## Files changed

- `server/videoEditor/snapping.ts` — **new**: `collectSnapPoints`,
  `snapTime`, `snapMoveStart`, `SnapOptions`, `DEFAULT_SNAP_THRESHOLD_SEC`.
- `server/videoEditor/types.ts` — `TimelineTrack.locked?: boolean` added.
- `server/videoEditor/timeline.ts` — `assertTrackUnlocked` added and
  called by `addClip`, `trimClip`, `splitClip`, `moveClip` (source and
  target), `removeClip`, `setClipVolume`, `addTransition`,
  `removeTransition`.
- `server/videoEditor/editingOps.ts` — lock checks in `setClipTransform`,
  `setClipSpeed`, `duplicateClip`, the effect ops, `setClipKeyframes`,
  `setClipFades`; new `setTrackLocked` + `setTrackLocked` op; opt-in
  `snap` on the `move`/`trim` ops applied in the dispatcher.
- `server/videoEditor/index.ts` — one line: barrel-export `snapping.js`.
- `tests/video_editor_phase2_timeline.test.ts` — **new** suite (21 tests).
- `VIDEO_EDITOR_PHASE_2_PROGRESS.md`, `VIDEO_EDITOR_PHASE_2_ACCEPTANCE_REPORT.md` — **new**.
- `AGENTS.md` — one status row ("Video Editor Roadmap Phase 2").

No workflow file was touched; nothing was pushed; Phase 3 was not started.

## Remaining limitations (owner-visible)

1. **Snapping and lock are not surfaced in the web editor UI yet** — no
   snap toggle, no lock button, and the editor's drag handlers do not
   pass `snap`. Both capabilities are live at the model/dispatcher layer
   (and reachable through the `/operations` route) and fully test-proven
   there; UI surfacing is later-phase work.
2. **The track lock does not cover text elements** — texts are not
   track-bound in this model (they live in `project.texts`), the same
   boundary mute/visibility already have.
3. **The snap threshold is time-based** (default 0.25 s), not
   zoom-dependent pixels — correct at the model layer; a UI adopting it
   converts through its zoom.
4. Lock state is a project property, so it persists with the project
   file (by design, like mute); undo history remains session state, as
   established in Phase 1.

## Recommendation

Accept Phase 2. The timeline brief is met by the existing engine plus
two real, integrated additions: snapping that composes with the Phase 1
history and never bypasses validation, and a lock that holds at every
entry point because it is enforced where edits are validated — with all
92 pre-existing video-editor tests passing unchanged.
