# Video Editor Roadmap — Phase 1: Video Editor Architecture — Progress

> **Naming note:** this is Phase 1 of the standalone *Professional Video Editor
> Roadmap*. Its phase numbers collide with SquadForge's own phase numbering
> (the video editor itself was built as SquadForge Phases 20, 26–31). To keep
> the two series unambiguous, these documents are named
> `VIDEO_EDITOR_PHASE_1_*` instead of `PHASE_1_*`.

Date: 2026-11-27. Status: **implemented and verified locally; not pushed**
(push is the owner's action, as with every phase).

## What the phase asked for

Inspect the repository, design a modular video-editor architecture, and
implement: project management, media assets, timeline data models, editor
state management, undo/redo, and autosave — with tests and documentation.
No later-phase work (no new editing operations, no preview/export changes).

## Audit first (requirement → existing implementation → gap)

The repository already contains a large, real video editor
(`server/videoEditor/`, 17 modules, ~4,900 lines) built by SquadForge
Phases 20/26–31. Building a second architecture beside it would violate the
repo's own rules, so the phase began with a requirement-by-requirement audit.
Every claim below is file-verified.

| Requirement | Already existed (evidence) | Genuine gap |
| :--- | :--- | :--- |
| Project management | `createProject` (`timeline.ts`); validated serialize/deserialize with format+version gate (`timeline.ts`, `types.ts` `SerializedVideoProject`); routes `POST /project/create`, `/project/save`, `/project/load` (`videoEditorRoutes.ts`) | None |
| Media assets | `MediaAsset` model (`types.ts`); `importMedia`/`probeMedia` over real ffprobe (`mediaProbe.ts`); routes `/probe`, `/media/import`; assets travel inside the serialized project | None |
| Timeline data models | `VideoProject`/`TimelineTrack`/`TimelineClip`/`Transition`/`TextElement`/`CaptionCue` (`types.ts`); validated model operations, overlap rules, `validateProject` (`timeline.ts`); the Phase 26 operation dispatcher `applyEditOperation` + `EditOperation` union (`editingOps.ts`) | None |
| Editor state management | Client-side `state` object in the web editor (`editorWebApp.ts`: playhead, selection, hidden tracks, zoom, save indicator); server-side `PlaybackSession` + `TimelineView` for playback (`playback.ts`); HTTP routes deliberately stateless — the client submits the whole project per call | **Partial:** no server-side object owns an *editing* session (project + media + history + persistence) |
| Undo/redo | **Nothing** in `server/videoEditor/` (grep-verified across all 17 modules). Undo exists only in the image editor (`HistoryStack`, `server/imageEditor/imageCore.ts`) | **Missing entirely — the phase's primary gap** |
| Autosave | Web editor: any change → "Unsaved changes" → 900 ms debounce → `POST /project/save` → "Autosaved …" indicator, plus Ctrl+S (`editorWebApp.ts`); server side: atomic tmp-write + rename and a recovery journal (`saveVideoProject`/`writeJournal`/`recoverVideoProject`, `timeline.ts`) | Client-side only; no server-side session autosave (follows from the session gap) |

## What was implemented (only the gaps, inside the existing architecture)

One new module, `server/videoEditor/history.ts`, exported from the existing
barrel (`index.ts`). Nothing else in the engine changed.

### `EditHistory` — bounded snapshot undo/redo

- Mirrors the image editor's proven `HistoryStack` pattern, adapted to this
  model: snapshots are deep clones of the `VideoProject` via the existing
  `cloneProject()` (`editingOps.ts`).
- `commit(project)` checkpoints the current state before an edit (the
  image-editor convention); `commitSnapshot()` accepts a pre-cloned snapshot.
- `undo(project)` / `redo(project)` restore **in place** (`restoreProjectInto`:
  the target's keys are replaced wholesale with a fresh clone). In-place
  restore is required by this codebase's style — every operation in
  `timeline.ts`/`editingOps.ts` mutates the project object it is handed, so
  holders of the reference must see restored state without re-binding.
- Bounded (default 50 checkpoints, validated ≥ 1); the oldest checkpoint is
  evicted past the limit. A new edit clears the redo stack.
- Snapshots are cloned on the way in and on restore, so live-project mutation
  can never corrupt stored history (test-proven).
- Memory honesty: a snapshot is project JSON only — media is referenced by
  id, never copied.

### `applyEditOperationWithHistory` — the integration point

The one wrapper between the Phase 26 dispatcher and history:

1. Clone the pre-edit state.
2. Run `applyEditOperation`. On success, the clone becomes the newest undo
   checkpoint and the operation's result is returned unchanged.
3. On failure, the project is restored from the clone and the error
   propagates — a rejected operation leaves the project **and** the history
   untouched (the dispatcher's validate-before-apply discipline is thus
   backed by a transactional guarantee at the history boundary).

### `EditorSession` — server-side editor state

The editing counterpart of `PlaybackSession`: one object owns a project's
editor state server-side.

- Holds `project`, `mediaAssets`, and an `EditHistory`; `registerMedia()`
  adds assets; `apply(op)` routes through `applyEditOperationWithHistory`;
  `undo()`/`redo()` delegate to the history. `dirty`, `canUndo`, `canRedo`
  are exposed as state.
- Autosave: `enableAutosave(dir, debounceMs = 900)` — the same 900 ms
  debounce the web editor uses — schedules `saveVideoProject` (the existing
  atomic save + journal) after any edit/undo/redo. `saveNow()` writes
  immediately; failures are captured in `lastSaveError`, never thrown into
  the edit path; the debounce timer is `unref`'d so a pending autosave never
  keeps a process alive.
- `EditorSession.load(dir)` recovers a session through the existing
  journal-aware `recoverVideoProject` and reports the journal state.

## Architecture (as designed/confirmed by this phase)

Module map — responsibilities and data flow:

```
types.ts            Data models only: VideoProject, tracks, clips, transitions,
                    texts, captions, MediaAsset, ExportSettings/Result.
timeline.ts         Model operations + validation (addClip/trim/split/move/…),
                    validateProject, serialization, disk persistence
                    (atomic save + recovery journal).
editingOps.ts       Non-destructive edit operations + the EditOperation union
                    and applyEditOperation — the single dispatcher every
                    caller goes through. cloneProject lives here.
history.ts  (NEW)   EditHistory (undo/redo), applyEditOperationWithHistory,
                    EditorSession (editor state + session autosave).
playback.ts         Playback state: PlaybackSession, TimelineView, preview
                    frame rendering (Phase 27).
mediaProbe.ts       ffprobe probing → MediaAsset records (import boundary).
videoExporter.ts    Project → ffmpeg filter graph → probed MP4 (export).
renderEngine.ts /   Presets, encoder detection; persisted background render
renderJobs.ts       jobs with progress/cancel/retry (Phase 30).
effects.ts /        Effect registry + keyframe math; caption cues, SRT/VTT,
captions.ts         caption provider adapters (Phases 28/29).
waveform.ts /       Audio peaks from real audio; scene/silence analysis →
aiEditing.ts        suggested cuts (Phase 29).
editorWebApp.ts     The Phase 31 web editor page: client editor state,
                    900 ms debounced autosave → /project/save.
videoEditorRoutes.ts HTTP surface (stateless per call): project create/save/
                    load, /operations, preview, export + jobs, media import.
videoProjectGenerator.ts  Generates the standalone ClipForge desktop app.
index.ts            Barrel export for the whole subsystem.
```

Data flow for an edit: caller → `applyEditOperation` (validate → mutate the
model) → optionally via `applyEditOperationWithHistory` for undoable edits →
persistence via `saveVideoProject` (directly, through `EditorSession`
autosave, or through the `/project/save` route from the web editor's
debounced autosave) → recovery via `recoverVideoProject` + journal.

Boundaries the design keeps: models never read media files (assets are
records); editing never touches source media (rendering is the exporter's
job, later); history depends on the dispatcher, never the reverse
(test-enforced).

## Tests

New suite `tests/video_editor_phase1_architecture.test.ts` — **20/20 pass**:

- Undo/redo semantics across representative existing operations: addClip,
  trim, split, move, setVolume, setSpeed, duplicate, remove (including the
  transition `removeClip` prunes), addText, addEffect — chains unwind in
  exact reverse and re-apply with identical ids.
- Redo-stack invalidation on a new edit; rejected operations (overlap, bad
  volume) leave project and history untouched; history bound eviction
  (limit 3 over 5 edits); empty-history no-ops; snapshot isolation;
  in-place identity; wholesale restore.
- `EditorSession`: dirty/history tracking, `registerMedia`, `saveNow`
  through the real journal path + `EditorSession.load` recovery, debounced
  autosave persisting an edit **and an undo**, honest error when saving
  without a directory.
- Architecture invariants: history builds on the dispatcher (not the
  reverse), the barrel exports the module, history defines no duplicate
  model types.

One test was fixed during development: the transition test initially moved
a clip into overlap *before* declaring the transition; the model correctly
rejected it (overlap is permitted only up to an existing transition's
length — the Phase 20 authoring flow, confirmed against
`tests/phase20_video_editing_engine.test.ts` test 3.1). The test now
follows the genuine flow. The engine was not changed.

Regression (same run of work): Phase 20 suite 15/15, Phase 26 12/12,
Phase 27 13/13, Phase 30 10/10, Phase 31 1/1 — **51/51**. `npm run lint`
(tsc --noEmit) clean. `npm run build` (vite production build) succeeds.

## Limitations (honest)

- **HTTP routes unchanged.** `/operations` remains stateless (Phase 31
  contract); there is no `/operations/undo` endpoint. Wiring route-level
  undo would need a per-build session registry and a decision about which
  side owns the project — deliberately not smuggled into an architecture
  phase.
- **The web editor has no undo/redo buttons yet.** Its client state calls
  `/operations`; surfacing the new history there is UI work for a later
  phase.
- **History is session state.** It is not written into the serialized
  project format (version stays 1, unchanged), so undo history does not
  survive a save/load cycle.
- **Snapshot cost** is one project-JSON clone per edit — right for an
  edit-decision-list model; it would not be the design for pixel data
  (and isn't used for any here).
- Autosave in `EditorSession` is single-writer per directory, same as the
  existing route save path it reuses.
