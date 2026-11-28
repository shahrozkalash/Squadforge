# Video Editor Roadmap — Phase 2: Professional Editing Timeline — Progress

> **Naming note:** this is Phase 2 of the standalone *Professional Video Editor
> Roadmap*. Its phase numbers collide with SquadForge's own phase numbering
> (the video editor itself was built as SquadForge Phases 20, 26–31). To keep
> the two series unambiguous, these documents are named
> `VIDEO_EDITOR_PHASE_2_*` instead of `PHASE_2_*`.

Date: 2026-11-27. Status: **implemented and verified locally; not pushed**
(push is the owner's action, as with every phase).

## What the phase asked for

Implement a multi-track timeline with video, audio, and overlay tracks. Add
importing, trimming, splitting, moving, resizing, deleting, snapping,
zooming, and track controls. Add tests for editing operations.

## Audit first (spec item → existing implementation → gap)

As in Phase 1, the phase began with a file-verified audit — the timeline the
brief describes already exists and is in daily use by the exporter, the
preview resolver, and the web editor. Every claim below is file-verified.

| Spec item | Already existed (evidence) | Genuine gap |
| :--- | :--- | :--- |
| Multi-track model (video/audio/overlay) | `TimelineTrack` (`types.ts`): `kind: 'video' \| 'audio'`, unlimited tracks via `addTrack`. **Overlay is a role, not a kind:** the base track is the first video track (`baseVideoTrack`, `timeline.ts`); every later video track is an overlay track — the exporter composites them in order with per-clip transforms (`videoExporter.ts`: "overlay tracks (every video track after the base)") and `resolveAtTime` (`playback.ts`) reports roles `'base' \| 'overlay' \| 'audio'`. Text elements form a separate layer list (`project.texts`) | None |
| Importing | `importMedia`/`probeMedia` over real ffprobe (`mediaProbe.ts`); routes `/probe`, `/media/import`; validated `addClip` placement rules (audio-only media refused on video tracks, etc.) | None |
| Trimming | `trimClip` (`timeline.ts`) + dispatcher op `trim` — source in/out with optional `keepEndFixed` | None (snapping integration below) |
| Splitting | `splitClip` (speed-aware source offset) + op `split` | None |
| Moving | `moveClip` + op `move` — same-kind cross-track moves, overlap-validated | None (snapping integration below) |
| Resizing (edge trim) | Edge resizing *is* `trimClip`: changing `sourceOut` resizes the end edge; `keepEndFixed` resizes the start edge | None |
| Deleting | `removeClip` + op `remove` (also prunes transitions anchored on the clip) | None |
| Snapping | Only `frameSnap` (`playback.ts`) — quantizes a *seek position* to the project's frame grid. **No edit snapping anywhere**: grep over `server/videoEditor/` found no magnet-to-edge behaviour in the model, the dispatcher, or the web editor | **Missing entirely — gap 1** |
| Zooming | Model-level `TimelineView` (`playback.ts`): `pxPerSecond` 4–400, `zoomIn`/`zoomOut` ×1.5 steps, scroll + time↔pixel conversion; web editor zoom slider (`editorWebApp.ts`) drives the same quantity client-side | None |
| Track controls | Model: `muted` + `volume` (Phase 29, ops `setTrackMuted`/`setTrackVolume`); visibility: view-only (`TimelineView.hiddenTrackIds`, web-editor `state.hidden` → preview `hiddenTrackIds`). **Lock: nothing** — no `locked` field on `TimelineTrack`, no enforcement anywhere | **Lock missing — gap 2** |

## What was implemented (only the gaps, inside the existing architecture)

### Edit snapping — new module `server/videoEditor/snapping.ts`

Pure functions over the project model, in the subsystem's style:

- `collectSnapPoints(project, { excludeClipId?, playheadSec? })` — the snap
  targets: 0 (timeline origin), the timeline end (`timelineDuration`), and
  the start/end of every clip on every track — i.e. clip edges and track
  boundaries. The clip being edited is excluded so it can never capture
  itself; the playhead is a point when the caller supplies it. Sorted,
  deduplicated.
- `snapTime(timeSec, points, options?)` — nearest point within the
  threshold (inclusive), else the time verbatim. Default threshold
  `DEFAULT_SNAP_THRESHOLD_SEC = 0.25` s. Negative threshold/playhead are
  rejected by name.
- `snapMoveStart(clip, desiredStart, points, options?)` — both the moving
  clip's start and end edges are candidates; the smaller adjustment wins,
  ties prefer the start edge.

Integration is in the Phase 26 dispatcher (`editingOps.ts`), so every
mutation still flows through the single validated entry point and Phase 1
history keeps working unchanged:

- `move` and `trim` ops accept `snap?: boolean | SnapOptions`. Without it,
  behaviour is byte-for-byte the pre-Phase-2 behaviour (test-pinned).
- Move: the requested start is adjusted by `snapMoveStart` before
  `moveClip` validates and applies it.
- Trim: the *moving timeline edge* is snapped — the end edge for a plain
  trim, the start edge for `keepEndFixed` — and the snapped edge time is
  converted back to source values (source delta = timeline delta × speed)
  before `trimClip` validates. Snapping never bypasses validation: a
  snapped value that would extend past the media still throws the model's
  named error.

### Track lock — model field + enforcement in the validated op layer

- `TimelineTrack.locked?: boolean` (`types.ts`), optional like `muted`, so
  existing project files load unchanged; it round-trips through
  serialize/deserialize (test-pinned). Project format version stays 1.
- `assertTrackUnlocked(track)` (`timeline.ts`) throws
  `Track "<name>" is locked`. It is called by every validated clip edit:
  `addClip`, `trimClip`, `splitClip`, `moveClip` (source **and** target
  track), `removeClip`, `setClipVolume`, `addTransition`/`removeTransition`
  (base track) in `timeline.ts`; `setClipTransform`, `setClipSpeed`,
  `duplicateClip`, `addEffect`/`updateEffect`/`removeEffect`/`moveEffect`,
  `setClipKeyframes`, `setClipFades` in `editingOps.ts`. Because
  enforcement lives in the model/op layer — not in any UI — the routes,
  `EditorSession`, and direct model callers all respect the lock.
- New op `setTrackLocked` + `setTrackLocked()` beside `setTrackMuted`.
  Track controls are deliberately **not** blocked by the lock: volume,
  mute, and the lock flag itself stay operable on a locked track (a locked
  track must always be unlockable, and muting a locked track is a normal
  mix operation).
- Undo/redo restore state wholesale (`restoreProjectInto`) and never pass
  through the op layer, so history still works on projects containing
  locked tracks; a refused edit routed through
  `applyEditOperationWithHistory` leaves project **and** history untouched
  (test-pinned).

## Tests

New suite `tests/video_editor_phase2_timeline.test.ts` — **21/21 pass**:

- Audit evidence: a second video track resolves with role `'overlay'`
  against the base track's `'base'` and the audio track's `'audio'`.
- Snap points: exact point sets for a known layout, exclusion of the
  edited clip, playhead inclusion, negative-playhead rejection.
- `snapTime`/`snapMoveStart`: nearest-wins, inclusive threshold, verbatim
  return outside the threshold, start/end edge choice, tie → start edge.
- Dispatcher snapping: move start-edge and end-edge snaps to exact times,
  playhead capture, trim end-edge snap with exact source conversion,
  `keepEndFixed` start-edge snap with the end provably fixed — and the
  same operations **without** `snap` using requested values verbatim
  (pre-Phase-2 behaviour pinned).
- Phase 1 composition: a snapped move through
  `applyEditOperationWithHistory` undoes/redoes to the exact positions.
- Lock: flag round-trip through serialization; fourteen refused operations
  (dispatcher and a direct model call) each throwing
  `Track "Video 1" is locked` with the project provably untouched; move
  *into* a locked track refused; controls (mute/volume/unlock) operable
  while locked and edits restored after unlocking; a refused edit leaves
  the Phase 1 history holding only the lock operation; other tracks stay
  editable while one is locked.

Three test-side fixes during development, all in the new suite (engine
untouched): an end-edge expectation first written with a non-representable
decimal (7.9 − 4 = 3.9000000000000004 in IEEE-754) switched to exact binary
values; an overlay-role probe time before the audio clip's start; and a
"snap to nearest" case whose target was 0.4 s away — correctly outside the
0.25 s threshold — re-based to two in-range points.

Regression (same run of work): Phase 20 15/15, Phase 26 12/12, Phase 27
13/13, Phase 28 11/11, Phase 29 10/10, Phase 30 10/10, Phase 31 1/1, and
the Phase 1 architecture suite 20/20 — **92/92**. `npm run lint`
(tsc --noEmit) clean. `npm run build` (vite production build) succeeds.

## Limitations (honest)

- **Snapping is model/dispatcher-level.** The web editor's drag handlers
  do not pass `snap` yet and there is no snap toggle in the UI; the
  capability is live for route/session/model callers (the `/operations`
  route passes ops through, so a client can request it today) and the
  pure functions are exported for the view layer to adopt.
- **Lock is not surfaced in the web UI** — no lock button; the flag is
  settable through the `setTrackLocked` operation.
- **Text elements are not track-bound** (they live in `project.texts`),
  so the track lock does not cover text edits — consistent with how mute
  and visibility already treat them.
- The snap threshold is a duration (seconds), not a pixel distance —
  the right unit at the model layer; a UI adopting snapping would
  convert its pixel threshold through its current zoom.
