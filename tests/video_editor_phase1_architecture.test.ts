import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  createProject,
  getClip,
  recoverVideoProject,
  timelineDuration
} from '../server/videoEditor/timeline.js';
import { cloneProject } from '../server/videoEditor/editingOps.js';
import {
  EditHistory,
  EditorSession,
  applyEditOperationWithHistory,
  restoreProjectInto
} from '../server/videoEditor/history.js';
import type { EditOperation } from '../server/videoEditor/editingOps.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';

/**
 * Video Editor Roadmap Phase 1: architecture — undo/redo, editor
 * session state, and session autosave.
 *
 * Model-level suite: the editing operations consume MediaAsset
 * records (they never read the media files), so assets here are
 * synthetic records with honest shapes. Persistence tests use the
 * real saveVideoProject/recoverVideoProject disk path.
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

function freshProject(): { project: VideoProject; baseId: string; audioId: string } {
  const project = createProject('Phase 1 Film', 320, 240, 30);
  return { project, baseId: project.tracks[0].id, audioId: project.tracks[1].id };
}

const addClipOp = (trackId: string, trackStart: number, sourceOut = 4): EditOperation => ({
  type: 'addClip',
  trackId,
  clip: { mediaId: videoAsset.id, trackStart, sourceIn: 0, sourceOut }
});

const eq = (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

describe('Video Editor Phase 1: undo/redo across edit operations', () => {
  test('addClip: undo removes the clip, redo restores it with the same id', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const { clip } = applyEditOperationWithHistory(project, assets(), addClipOp(baseId, 0), history);
    assert.ok(clip);
    assert.equal(project.tracks[0].clips.length, 1);
    assert.equal(history.canUndo, true);
    assert.equal(history.canRedo, false);

    assert.equal(history.undo(project), true);
    assert.equal(project.tracks[0].clips.length, 0);
    assert.equal(history.canRedo, true);

    assert.equal(history.redo(project), true);
    assert.equal(project.tracks[0].clips.length, 1);
    assert.equal(project.tracks[0].clips[0].id, clip!.id);
  });

  test('trim and split: undo restores the exact pre-edit model, step by step', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    const { clip } = applyEditOperationWithHistory(project, media, addClipOp(baseId, 0, 8), history);
    const original = cloneProject(project);

    applyEditOperationWithHistory(project, media, { type: 'trim', clipId: clip!.id, sourceIn: 1, sourceOut: 7 }, history);
    assert.equal(getClip(project, clip!.id).clip.sourceIn, 1);

    const { clip: right } = applyEditOperationWithHistory(project, media, { type: 'split', clipId: clip!.id, atTimelineSec: 3 }, history);
    assert.equal(project.tracks[0].clips.length, 2);

    assert.equal(history.undo(project), true); // un-split
    assert.equal(project.tracks[0].clips.length, 1);
    assert.equal(getClip(project, clip!.id).clip.sourceOut, 7);

    assert.equal(history.undo(project), true); // un-trim
    eq(project, original);

    assert.equal(history.redo(project), true); // re-trim
    assert.equal(getClip(project, clip!.id).clip.sourceIn, 1);
    assert.equal(history.redo(project), true); // re-split, same right-hand id
    assert.equal(project.tracks[0].clips.length, 2);
    assert.equal(getClip(project, right!.id).clip.id, right!.id);
  });

  test('move, setVolume, setSpeed, duplicate, remove: a five-edit chain unwinds in reverse', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    const { clip } = applyEditOperationWithHistory(project, media, addClipOp(baseId, 0, 6), history);
    const afterAdd = cloneProject(project);

    applyEditOperationWithHistory(project, media, { type: 'move', clipId: clip!.id, trackStart: 2 }, history);
    applyEditOperationWithHistory(project, media, { type: 'setVolume', clipId: clip!.id, volume: 0.4 }, history);
    applyEditOperationWithHistory(project, media, { type: 'setSpeed', clipId: clip!.id, speed: 2 }, history);
    const { clip: copy } = applyEditOperationWithHistory(project, media, { type: 'duplicate', clipId: clip!.id }, history);
    applyEditOperationWithHistory(project, media, { type: 'remove', clipId: copy!.id }, history);
    assert.equal(project.tracks[0].clips.length, 1);

    for (let i = 0; i < 5; i++) assert.equal(history.undo(project), true, `undo ${i + 1}`);
    eq(project, afterAdd);
    assert.equal(history.undoDepth, 1); // only the addClip checkpoint remains
  });

  test('removeClip also restores the transition it carried away', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    const { clip: a } = applyEditOperationWithHistory(project, media, addClipOp(baseId, 0, 4), history);
    applyEditOperationWithHistory(project, media, addClipOp(baseId, 4, 4), history);
    // The Phase 20 authoring flow: the transition is declared first, and
    // only then may the next clip move into the crossfade window.
    applyEditOperationWithHistory(project, media, { type: 'addTransition', afterClipId: a!.id, durationSec: 1 }, history);
    const second = project.tracks[0].clips[1];
    applyEditOperationWithHistory(project, media, { type: 'move', clipId: second.id, trackStart: 3 }, history);
    assert.equal(project.transitions.length, 1);

    applyEditOperationWithHistory(project, media, { type: 'remove', clipId: a!.id }, history);
    assert.equal(project.transitions.length, 0); // removeClip prunes transitions

    assert.equal(history.undo(project), true);
    assert.equal(project.transitions.length, 1);
    assert.equal(project.tracks[0].clips.length, 2);
  });

  test('text and effect operations are undoable', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    const { clip } = applyEditOperationWithHistory(project, media, addClipOp(baseId, 0), history);
    const { text } = applyEditOperationWithHistory(project, media, {
      type: 'addText',
      text: { text: 'Title', trackStart: 0, durationSec: 2, x: 10, y: 10, fontSize: 24, color: '#FFFFFF' }
    }, history);
    applyEditOperationWithHistory(project, media, { type: 'addEffect', clipId: clip!.id, effectType: 'brightness', value: 0.2 }, history);
    assert.equal((project.texts ?? []).length, 1);
    assert.equal(getClip(project, clip!.id).clip.effects?.length, 1);

    assert.equal(history.undo(project), true); // un-effect
    assert.equal(getClip(project, clip!.id).clip.effects?.length ?? 0, 0);
    assert.equal(history.undo(project), true); // un-text
    assert.equal((project.texts ?? []).length, 0);
    assert.equal(history.redo(project), true);
    assert.equal((project.texts ?? [])[0].id, text!.id);
  });

  test('a new edit after undo invalidates the redo stack', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    applyEditOperationWithHistory(project, media, addClipOp(baseId, 0), history);
    applyEditOperationWithHistory(project, media, addClipOp(baseId, 4), history);
    assert.equal(history.undo(project), true);
    assert.equal(history.canRedo, true);

    applyEditOperationWithHistory(project, media, addClipOp(baseId, 4, 2), history);
    assert.equal(history.canRedo, false);
    assert.equal(history.redo(project), false);
    assert.equal(project.tracks[0].clips.length, 2);
  });

  test('a rejected operation leaves the project and the history untouched', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    applyEditOperationWithHistory(project, media, addClipOp(baseId, 0, 6), history);
    const before = cloneProject(project);
    const depthBefore = history.undoDepth;

    // Overlapping addClip must throw (model rule) and roll back fully.
    assert.throws(() => applyEditOperationWithHistory(project, media, addClipOp(baseId, 2, 4), history), /overlaps/);
    eq(project, before);
    assert.equal(history.undoDepth, depthBefore);

    // Invalid volume likewise.
    const clipId = project.tracks[0].clips[0].id;
    assert.throws(() => applyEditOperationWithHistory(project, media, { type: 'setVolume', clipId, volume: 2 }, history), /volume/);
    eq(project, before);
    assert.equal(history.undoDepth, depthBefore);
  });

  test('history is bounded: the oldest checkpoints are evicted past the limit', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory(3);
    const media = assets();
    for (let i = 0; i < 5; i++) {
      applyEditOperationWithHistory(project, media, addClipOp(baseId, i * 4, 2), history);
    }
    assert.equal(history.undoDepth, 3);
    assert.equal(project.tracks[0].clips.length, 5);
    // Only the three newest edits can be undone: 5 clips -> 2 clips, then no more.
    assert.equal(history.undo(project), true);
    assert.equal(history.undo(project), true);
    assert.equal(history.undo(project), true);
    assert.equal(project.tracks[0].clips.length, 2);
    assert.equal(history.undo(project), false);
  });

  test('undo/redo on an empty history are honest no-ops', () => {
    const { project } = freshProject();
    const history = new EditHistory();
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, false);
    assert.equal(history.undo(project), false);
    assert.equal(history.redo(project), false);
    assert.throws(() => new EditHistory(0), /positive integer/);
  });

  test('snapshots are isolated: later mutation of the live project cannot corrupt history', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const media = assets();
    const { clip } = applyEditOperationWithHistory(project, media, addClipOp(baseId, 0), history);
    // Mutate the live clip directly, outside any recorded operation.
    getClip(project, clip!.id).clip.volume = 0.1;
    assert.equal(history.undo(project), true);
    assert.equal(project.tracks[0].clips.length, 0);
    assert.equal(history.redo(project), true);
    // Redo restores the state as it was when undo ran (volume 0.1), proving
    // the redo snapshot was cloned at undo time, not aliased.
    assert.equal(getClip(project, clip!.id).clip.volume, 0.1);
  });

  test('restore is in place: the project object identity survives undo/redo', () => {
    const { project, baseId } = freshProject();
    const history = new EditHistory();
    const ref = project;
    applyEditOperationWithHistory(project, assets(), addClipOp(baseId, 0), history);
    history.undo(project);
    assert.equal(project, ref);
    history.redo(project);
    assert.equal(project, ref);
    assert.equal(ref.tracks[0].clips.length, 1);
  });

  test('restoreProjectInto replaces contents wholesale (stale keys do not survive)', () => {
    const { project, baseId } = freshProject();
    const media = assets();
    applyEditOperationWithHistory(project, media, addClipOp(baseId, 0), new EditHistory());
    const target = createProject('Other', 640, 360, 24);
    target.texts = [{ id: 'stale', text: 'x', trackStart: 0, durationSec: 1, x: 0, y: 0, fontSize: 12, color: '#000000' }];
    restoreProjectInto(target, project);
    assert.equal(target.name, 'Phase 1 Film');
    assert.equal(target.tracks[0].clips.length, 1);
    assert.equal((target.texts ?? []).length, 0);
  });
});

describe('Video Editor Phase 1: EditorSession state + autosave', () => {
  const TMP_ROOT = path.join(process.cwd(), '..', '..', 'tmp');
  let workDir = '';

  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    workDir = fs.mkdtempSync(path.join(TMP_ROOT, 've-phase1-'));
  });

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  test('session apply/undo/redo track dirty state and history', () => {
    const { project, baseId } = freshProject();
    const session = new EditorSession(project, assets());
    assert.equal(session.dirty, false);
    assert.equal(session.canUndo, false);

    session.apply(addClipOp(baseId, 0));
    assert.equal(session.dirty, true);
    assert.equal(session.canUndo, true);
    assert.equal(timelineDuration(project), 4);

    assert.equal(session.undo(), true);
    assert.equal(project.tracks[0].clips.length, 0);
    assert.equal(session.canRedo, true);

    assert.equal(session.redo(), true);
    assert.equal(project.tracks[0].clips.length, 1);
    session.close();
  });

  test('registerMedia makes an asset placeable through the session', () => {
    const { project, audioId } = freshProject();
    const session = new EditorSession(project, new Map());
    assert.throws(() => session.apply({ type: 'addClip', trackId: audioId, clip: { mediaId: audioAsset.id, trackStart: 0, sourceIn: 0, sourceOut: 3 } }), /Media asset not found/);
    session.registerMedia(audioAsset);
    session.apply({ type: 'addClip', trackId: audioId, clip: { mediaId: audioAsset.id, trackStart: 0, sourceIn: 0, sourceOut: 3 } });
    assert.equal(project.tracks[1].clips.length, 1);
    session.close();
  });

  test('saveNow persists through the journal path and load() recovers the session', async () => {
    const dir = path.join(workDir, 'saved');
    const { project, baseId } = freshProject();
    const session = new EditorSession(project, assets());
    session.enableAutosave(dir, 10_000); // long debounce: saveNow drives this test
    session.apply(addClipOp(baseId, 0));
    await session.saveNow();
    assert.equal(session.dirty, false);
    assert.ok(session.lastSavedAt);
    assert.equal(session.lastSaveError, undefined);
    assert.ok(fs.existsSync(path.join(dir, 'project.json')));
    assert.ok(fs.existsSync(path.join(dir, 'journal.json')));

    const { session: recovered, journalState } = await EditorSession.load(dir);
    assert.equal(journalState, 'saved');
    assert.equal(recovered.project.tracks[0].clips.length, 1);
    assert.equal(recovered.mediaAssets.get(videoAsset.id)?.durationSec, 20);
    // A recovered session starts with a clean history (history is session state, not persisted).
    assert.equal(recovered.canUndo, false);
    session.close();
    recovered.close();
  });

  test('debounced autosave writes edits — and an undo — without an explicit save', async () => {
    const dir = path.join(workDir, 'autosaved');
    const { project, baseId } = freshProject();
    const session = new EditorSession(project, assets());
    session.enableAutosave(dir, 25);
    session.apply(addClipOp(baseId, 0));
    await new Promise((r) => setTimeout(r, 200));
    let recovered = await recoverVideoProject(dir);
    assert.equal(recovered.project.tracks[0].clips.length, 1);
    assert.equal(session.dirty, false);

    assert.equal(session.undo(), true);
    await new Promise((r) => setTimeout(r, 200));
    recovered = await recoverVideoProject(dir);
    assert.equal(recovered.project.tracks[0].clips.length, 0);
    assert.equal(session.lastSaveError, undefined);
    session.close();
  });

  test('saveNow without an enabled autosave directory is an honest error', async () => {
    const { project } = freshProject();
    const session = new EditorSession(project, assets());
    await assert.rejects(() => session.saveNow(), /Autosave is not enabled/);
    session.close();
  });
});

describe('Video Editor Phase 1: architecture invariants', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

  test('history builds ON the operation dispatcher — the dispatcher does not depend on history', () => {
    const historySrc = read('server/videoEditor/history.ts');
    const opsSrc = read('server/videoEditor/editingOps.ts');
    assert.match(historySrc, /from '\.\/editingOps\.js'/);
    assert.doesNotMatch(opsSrc, /history\.js/);
    assert.doesNotMatch(opsSrc, /EditHistory/);
  });

  test('the module is exported from the videoEditor barrel', () => {
    const indexSrc = read('server/videoEditor/index.ts');
    assert.match(indexSrc, /export \* from '\.\/history\.js';/);
  });

  test('no duplicate timeline model: history.ts defines no project/track/clip types of its own', () => {
    const historySrc = read('server/videoEditor/history.ts');
    assert.doesNotMatch(historySrc, /interface (VideoProject|TimelineTrack|TimelineClip|MediaAsset)\b/);
    assert.match(historySrc, /from '\.\/types\.js'/);
  });
});
