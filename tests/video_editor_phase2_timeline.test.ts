import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  addTrack,
  clipEnd,
  createProject,
  deserializeVideoProject,
  getClip,
  getTrack,
  moveClip,
  serializeVideoProject
} from '../server/videoEditor/timeline.js';
import {
  applyEditOperation,
  type EditOperation
} from '../server/videoEditor/editingOps.js';
import {
  DEFAULT_SNAP_THRESHOLD_SEC,
  collectSnapPoints,
  snapMoveStart,
  snapTime
} from '../server/videoEditor/snapping.js';
import { resolveAtTime } from '../server/videoEditor/playback.js';
import { EditHistory, applyEditOperationWithHistory } from '../server/videoEditor/history.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';

/**
 * Video Editor Roadmap Phase 2: professional editing timeline —
 * edit snapping and track lock, integrated into the existing
 * multitrack model and the Phase 26 operation dispatcher.
 *
 * Model-level suite in the Phase 1 style: operations consume
 * MediaAsset records and never read media files, so assets are
 * synthetic records with honest shapes.
 */

const videoAsset: MediaAsset = {
  id: 'asset-video',
  path: '/media/clip.mp4',
  durationSec: 20,
  hasVideo: true,
  hasAudio: true,
  width: 320,
  height: 240,
  fps: 30,
  kind: 'video'
};
const audioAsset: MediaAsset = {
  id: 'asset-audio',
  path: '/media/voice.mp3',
  durationSec: 20,
  hasVideo: false,
  hasAudio: true,
  kind: 'audio'
};
const assets = () => new Map<string, MediaAsset>([[videoAsset.id, videoAsset], [audioAsset.id, audioAsset]]);

const op = (project: VideoProject, operation: EditOperation) => applyEditOperation(project, assets(), operation);

function addClip(project: VideoProject, trackId: string, mediaId: string, trackStart: number, sourceOut: number, sourceIn = 0) {
  const { clip } = op(project, { type: 'addClip', trackId, clip: { mediaId, trackStart, sourceIn, sourceOut } });
  assert.ok(clip);
  return clip;
}

/**
 * Standard layout (all durations exact):
 *  base video: A 0–4, B 6–10
 *  audio:      C 2–5
 *  timeline duration 10; snap points (nothing excluded):
 *  [0, 2, 4, 5, 6, 10]
 */
function standardProject() {
  const project = createProject('Phase 2 Film', 320, 240, 30);
  const baseId = project.tracks[0].id;
  const audioId = project.tracks[1].id;
  const a = addClip(project, baseId, videoAsset.id, 0, 4);
  const b = addClip(project, baseId, videoAsset.id, 6, 4);
  const c = addClip(project, audioId, audioAsset.id, 2, 3);
  return { project, baseId, audioId, a, b, c };
}

describe('Video Editor Phase 2: multitrack model (audit evidence)', () => {
  test('a second video track is an overlay track: resolver roles base vs overlay', () => {
    const { project, baseId } = standardProject();
    const overlay = addTrack(project, 'video');
    const d = addClip(project, overlay.id, videoAsset.id, 1, 2);
    const atBase = resolveAtTime(project, 0.5);
    assert.equal(atBase.find((x) => x.clip.id === getClip(project, getTrack(project, baseId).clips[0].id).clip.id)?.role, 'base');
    const atOverlay = resolveAtTime(project, 2.5); // overlay clip (1–3) and audio clip (2–5) both active
    assert.equal(atOverlay.find((x) => x.clip.id === d.id)?.role, 'overlay');
    assert.equal(atOverlay.find((x) => x.trackKind === 'audio')?.role, 'audio');
  });
});

describe('Video Editor Phase 2: snap points', () => {
  test('collectSnapPoints: origin, every clip edge on every track, timeline end — sorted, deduplicated', () => {
    const { project } = standardProject();
    assert.deepEqual(collectSnapPoints(project), [0, 2, 4, 5, 6, 10]);
  });

  test('collectSnapPoints: excludeClipId omits the edited clip, timeline end stays', () => {
    const { project, b } = standardProject();
    assert.deepEqual(collectSnapPoints(project, { excludeClipId: b.id }), [0, 2, 4, 5, 10]);
  });

  test('collectSnapPoints: playhead is a snap point when supplied; negative playhead rejected', () => {
    const { project } = standardProject();
    assert.deepEqual(collectSnapPoints(project, { playheadSec: 7.5 }), [0, 2, 4, 5, 6, 7.5, 10]);
    assert.throws(() => collectSnapPoints(project, { playheadSec: -1 }), /playheadSec cannot be negative/);
  });

  test('snapTime: nearest point within the threshold wins; the threshold is inclusive', () => {
    const points = [0, 2, 4, 5, 6, 10];
    assert.deepEqual(snapTime(4.1, points), { time: 4, snapped: true, target: 4 });
    assert.deepEqual(snapTime(4.6, [4.5, 4.75]), { time: 4.5, snapped: true, target: 4.5 }); // nearest of two in-range points
    assert.deepEqual(snapTime(4.25, points), { time: 4, snapped: true, target: 4 }); // exactly at the default threshold
    assert.equal(DEFAULT_SNAP_THRESHOLD_SEC, 0.25);
  });

  test('snapTime: outside the threshold the time is returned verbatim', () => {
    assert.deepEqual(snapTime(4.4, [0, 2, 4, 5, 6, 10]), { time: 4.4, snapped: false, target: null });
    assert.deepEqual(snapTime(4.1, [4], { thresholdSec: 0.05 }), { time: 4.1, snapped: false, target: null });
    assert.throws(() => snapTime(1, [0], { thresholdSec: -0.1 }), /thresholdSec cannot be negative/);
  });

  test('snapMoveStart: start edge, end edge, tie prefers start, no snap outside threshold', () => {
    const { b } = standardProject(); // duration 4
    const start = snapMoveStart(b, 3.8, [4]);
    assert.deepEqual(start, { time: 4, snapped: true, target: 4, edge: 'start' });
    const end = snapMoveStart(b, 3.8, [7.75]);
    assert.deepEqual(end, { time: 3.75, snapped: true, target: 7.75, edge: 'end' });
    const tie = snapMoveStart(b, 3.8, [4, 8]); // both edges 0.2 away
    assert.equal(tie.edge, 'start');
    assert.equal(tie.time, 4);
    const none = snapMoveStart(b, 3.8, [20]);
    assert.deepEqual(none, { time: 3.8, snapped: false, target: null, edge: null });
  });
});

describe('Video Editor Phase 2: snapping in move/trim operations', () => {
  test('move with snap: start edge is pulled to the neighbouring clip edge', () => {
    const { project, b } = standardProject();
    op(project, { type: 'move', clipId: b.id, trackStart: 4.15, snap: true });
    assert.equal(getClip(project, b.id).clip.trackStart, 4); // A's end
    assert.equal(clipEnd(getClip(project, b.id).clip), 8);
  });

  test('move without snap: the requested position is used verbatim (pre-Phase-2 behaviour)', () => {
    const { project, b } = standardProject();
    op(project, { type: 'move', clipId: b.id, trackStart: 4.15 });
    assert.equal(getClip(project, b.id).clip.trackStart, 4.15);
  });

  test('move with snap: end edge wins when it is the closer one', () => {
    const { project, baseId } = standardProject();
    const overlay = addTrack(project, 'video');
    const d = addClip(project, overlay.id, videoAsset.id, 0, 2); // duration 2
    op(project, { type: 'move', clipId: d.id, trackStart: 7.9, snap: true });
    // start 7.9 is far from every point; end 9.9 snaps to the timeline end 10
    assert.equal(getClip(project, d.id).clip.trackStart, 8);
    assert.equal(clipEnd(getClip(project, d.id).clip), 10);
    assert.equal(getClip(project, d.id).track.id, overlay.id);
    assert.ok(baseId);
  });

  test('move with snap: the playhead captures the moving edge when supplied', () => {
    const { project } = standardProject();
    const overlay = addTrack(project, 'video');
    const d = addClip(project, overlay.id, videoAsset.id, 0, 2);
    op(project, { type: 'move', clipId: d.id, trackStart: 3.1, snap: { playheadSec: 3 } });
    assert.equal(getClip(project, d.id).clip.trackStart, 3);
  });

  test('trim with snap: the end edge is pulled to the timeline end, source values follow', () => {
    const { project, b } = standardProject();
    op(project, { type: 'trim', clipId: b.id, sourceIn: 0, sourceOut: 3.8, snap: true });
    const clip = getClip(project, b.id).clip;
    assert.equal(clip.sourceOut, 4); // 9.8 desired end snapped to 10 → sourceOut = (10 − 6) × speed 1
    assert.equal(clipEnd(clip), 10);
  });

  test('trim without snap: source values are used verbatim (pre-Phase-2 behaviour)', () => {
    const { project, b } = standardProject();
    op(project, { type: 'trim', clipId: b.id, sourceIn: 0, sourceOut: 3.8 });
    assert.equal(getClip(project, b.id).clip.sourceOut, 3.8);
  });

  test('trim with snap + keepEndFixed: the start edge snaps and the end stays fixed', () => {
    const project = createProject('Trim Snap', 320, 240, 30);
    const baseId = project.tracks[0].id;
    const b = addClip(project, baseId, videoAsset.id, 6, 4); // 6–10
    const overlay = addTrack(project, 'video');
    addClip(project, overlay.id, videoAsset.id, 6.25, 1); // snap point at 6.25
    op(project, { type: 'trim', clipId: b.id, sourceIn: 0.2, sourceOut: 4, keepEndFixed: true, snap: true });
    const clip = getClip(project, b.id).clip;
    assert.equal(clip.trackStart, 6.25);
    assert.equal(clip.sourceIn, 0.25); // 4 − (10 − 6.25) × speed 1
    assert.equal(clipEnd(clip), 10); // end fixed
  });

  test('snapped edits flow through Phase 1 history: undo restores the pre-snap position', () => {
    const { project, b } = standardProject();
    const history = new EditHistory();
    applyEditOperationWithHistory(project, assets(), { type: 'move', clipId: b.id, trackStart: 4.15, snap: true }, history);
    assert.equal(getClip(project, b.id).clip.trackStart, 4);
    assert.equal(history.undo(project), true);
    assert.equal(getClip(project, b.id).clip.trackStart, 6);
    assert.equal(history.redo(project), true);
    assert.equal(getClip(project, b.id).clip.trackStart, 4);
  });
});

describe('Video Editor Phase 2: track lock', () => {
  test('setTrackLocked sets the flag; it survives serialize/deserialize; tracks default unlocked', () => {
    const { project, baseId } = standardProject();
    assert.equal(getTrack(project, baseId).locked, undefined);
    op(project, { type: 'setTrackLocked', trackId: baseId, locked: true });
    assert.equal(getTrack(project, baseId).locked, true);
    const { project: loaded } = deserializeVideoProject(serializeVideoProject(project, assets()));
    assert.equal(getTrack(loaded, baseId).locked, true);
  });

  test('a locked track refuses clip edits by name — dispatcher and direct model calls alike', () => {
    const { project, baseId, a, b } = standardProject();
    op(project, { type: 'setTrackLocked', trackId: baseId, locked: true });
    const locked = /Track "Video 1" is locked/;
    assert.throws(() => op(project, { type: 'addClip', trackId: baseId, clip: { mediaId: videoAsset.id, trackStart: 12, sourceIn: 0, sourceOut: 2 } }), locked);
    assert.throws(() => op(project, { type: 'trim', clipId: a.id, sourceIn: 0, sourceOut: 3 }), locked);
    assert.throws(() => op(project, { type: 'split', clipId: a.id, atTimelineSec: 2 }), locked);
    assert.throws(() => op(project, { type: 'move', clipId: a.id, trackStart: 1 }), locked);
    assert.throws(() => moveClip(project, a.id, 1), locked); // direct model entry point
    assert.throws(() => op(project, { type: 'remove', clipId: a.id }), locked);
    assert.throws(() => op(project, { type: 'duplicate', clipId: a.id }), locked);
    assert.throws(() => op(project, { type: 'setVolume', clipId: a.id, volume: 0.5 }), locked);
    assert.throws(() => op(project, { type: 'setSpeed', clipId: a.id, speed: 2 }), locked);
    assert.throws(() => op(project, { type: 'setTransform', clipId: a.id, transform: { x: 5 } }), locked);
    assert.throws(() => op(project, { type: 'setFades', clipId: a.id, fadeInSec: 0.5, fadeOutSec: 0 }), locked);
    assert.throws(() => op(project, { type: 'addEffect', clipId: a.id, effectType: 'brightness', value: 0.2 }), locked);
    assert.throws(() => op(project, { type: 'setKeyframes', clipId: a.id, keyframes: [] }), locked);
    assert.throws(() => op(project, { type: 'addTransition', afterClipId: a.id, durationSec: 1 }), locked);
    // Nothing moved: the refused edits left the project untouched.
    assert.equal(getTrack(project, baseId).clips.length, 2);
    assert.equal(getClip(project, a.id).clip.trackStart, 0);
    assert.equal(getClip(project, b.id).clip.trackStart, 6);
    assert.equal(project.transitions.length, 0);
  });

  test('moving a clip into a locked track is refused; the source track stays untouched', () => {
    const { project, baseId } = standardProject();
    const overlay = addTrack(project, 'video');
    const d = addClip(project, overlay.id, videoAsset.id, 0, 2);
    op(project, { type: 'setTrackLocked', trackId: baseId, locked: true });
    assert.throws(
      () => op(project, { type: 'move', clipId: d.id, trackStart: 12, targetTrackId: baseId }),
      /Track "Video 1" is locked/
    );
    assert.equal(getClip(project, d.id).track.id, overlay.id);
  });

  test('track controls stay operable on a locked track, and unlocking restores edits', () => {
    const { project, baseId, a } = standardProject();
    op(project, { type: 'setTrackLocked', trackId: baseId, locked: true });
    op(project, { type: 'setTrackMuted', trackId: baseId, muted: true });
    op(project, { type: 'setTrackVolume', trackId: baseId, volume: 0.5 });
    assert.equal(getTrack(project, baseId).muted, true);
    assert.equal(getTrack(project, baseId).volume, 0.5);
    op(project, { type: 'setTrackLocked', trackId: baseId, locked: false });
    op(project, { type: 'move', clipId: a.id, trackStart: 1 });
    assert.equal(getClip(project, a.id).clip.trackStart, 1);
  });

  test('a refused edit on a locked track leaves Phase 1 history untouched', () => {
    const { project, baseId, a } = standardProject();
    const history = new EditHistory();
    applyEditOperationWithHistory(project, assets(), { type: 'setTrackLocked', trackId: baseId, locked: true }, history);
    assert.equal(history.canUndo, true);
    assert.throws(
      () => applyEditOperationWithHistory(project, assets(), { type: 'move', clipId: a.id, trackStart: 1 }, history),
      /is locked/
    );
    // Only the lock operation is on the undo stack — undoing reverts the lock itself.
    assert.equal(history.undo(project), true);
    assert.equal(getTrack(project, baseId).locked, undefined);
    assert.equal(history.canUndo, false);
  });

  test('other tracks stay editable while one track is locked', () => {
    const { project, baseId, audioId, c } = standardProject();
    op(project, { type: 'setTrackLocked', trackId: baseId, locked: true });
    op(project, { type: 'move', clipId: c.id, trackStart: 3 });
    assert.equal(getClip(project, c.id).clip.trackStart, 3);
    assert.ok(audioId);
  });
});
