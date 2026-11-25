import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  createProject,
  addTrack,
  addClip,
  trimClip,
  splitClip,
  moveClip,
  removeClip,
  setClipVolume,
  addTransition,
  timelineDuration,
  validateProject,
  serializeVideoProject,
  deserializeVideoProject,
  saveVideoProject,
  recoverVideoProject,
  writeJournal,
  clipDuration
} from '../server/videoEditor/timeline.js';
import { importMedia, probeMedia, detectFfmpeg } from '../server/videoEditor/mediaProbe.js';
import { exportVideo, defaultExportSettings } from '../server/videoEditor/videoExporter.js';
import { VideoProjectGenerator } from '../server/videoEditor/videoProjectGenerator.js';
import type { MediaAsset } from '../server/videoEditor/types.js';

const TMP_ROOT = path.join(process.cwd(), '..', '..', 'tmp');
let workDir = '';
let clipA = '';
let clipB = '';
let mediaA: MediaAsset;
let mediaB: MediaAsset;
const assets = () => new Map([[mediaA.id, mediaA], [mediaB.id, mediaB]]);

function makeMedia(): { project: ReturnType<typeof createProject>; baseId: string } {
  const project = createProject('Test Film', 320, 240, 30);
  return { project, baseId: project.tracks[0].id };
}

describe('SquadForge Phase 20: Video Editing Engine Test Suite', () => {
  before(() => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    workDir = fs.mkdtempSync(path.join(TMP_ROOT, 'phase20-'));
    clipA = path.join(workDir, 'clipA.mp4');
    clipB = path.join(workDir, 'clipB.mp4');
    const ffmpeg = detectFfmpeg();
    assert.ok(ffmpeg, 'ffmpeg is required for the Phase 20 integration tests');
    execFileSync(ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipA
    ], { stdio: 'pipe' });
    execFileSync(ffmpeg!, [
      '-y', '-f', 'lavfi', '-i', 'smptebars=duration=2:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipB
    ], { stdio: 'pipe' });
  });

  after(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('1. Media probing (real ffprobe)', () => {
    test('1.1 importMedia probes real files honestly', async () => {
      mediaA = await importMedia(clipA);
      mediaB = await importMedia(clipB);
      assert.ok(Math.abs(mediaA.durationSec - 2) < 0.2, `duration ${mediaA.durationSec}`);
      assert.equal(mediaA.hasVideo, true);
      assert.equal(mediaA.hasAudio, true);
      assert.equal(mediaA.width, 320);
      assert.equal(mediaA.height, 240);
    });

    test('1.2 Probing a missing file fails with a clear error', async () => {
      await assert.rejects(() => probeMedia(path.join(workDir, 'nope.mp4')), /not found/);
    });
  });

  describe('2. Timeline operations', () => {
    test('2.1 Add clips back-to-back; overlaps are rejected', () => {
      const { project, baseId } = makeMedia();
      addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      addClip(project, assets(), baseId, { mediaId: mediaB.id, trackStart: 2, sourceIn: 0, sourceOut: 2 });
      assert.equal(timelineDuration(project), 4);
      assert.throws(
        () => addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 1, sourceIn: 0, sourceOut: 1 }),
        /overlaps/
      );
      assert.throws(
        () => addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 4, sourceIn: 0, sourceOut: 3 }),
        /past media duration/
      );
    });

    test('2.2 Split divides source offsets exactly; invalid splits rejected', () => {
      const { project, baseId } = makeMedia();
      const clip = addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const right = splitClip(project, clip.id, 1.25);
      assert.equal(clipDuration(clip), 1.25);
      assert.equal(right.sourceIn, 1.25);
      assert.equal(clipDuration(right), 0.75);
      assert.equal(right.trackStart, 1.25);
      assert.throws(() => splitClip(project, clip.id, 99), /outside clip span/);
    });

    test('2.3 Trim adjusts source bounds; keepEndFixed moves the start', () => {
      const { project, baseId } = makeMedia();
      const clip = addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 1, sourceIn: 0, sourceOut: 2 });
      trimClip(project, assets(), clip.id, 0.5, 2, true);
      assert.equal(clip.trackStart, 1.5); // end stays at 3.0
      assert.equal(clipDuration(clip), 1.5);
      assert.throws(() => trimClip(project, assets(), clip.id, 1.8, 1.2), /sourceOut must be after sourceIn/);
    });

    test('2.4 Move respects overlaps and track kinds; volume is validated', () => {
      const { project, baseId } = makeMedia();
      const a = addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 1 });
      addClip(project, assets(), baseId, { mediaId: mediaB.id, trackStart: 1, sourceIn: 0, sourceOut: 1 });
      assert.throws(() => moveClip(project, a.id, 0.5), /overlaps/);
      moveClip(project, a.id, 2);
      assert.equal(a.trackStart, 2);
      const audioTrack = addTrack(project, 'audio');
      assert.throws(() => moveClip(project, a.id, 0, audioTrack.id), /between video and audio/);
      setClipVolume(project, a.id, 0.5);
      assert.equal(a.volume, 0.5);
      assert.throws(() => setClipVolume(project, a.id, 2), /between 0 and 1/);
      removeClip(project, a.id);
      assert.equal(project.tracks[0].clips.length, 1);
    });

    test('2.5 Audio-only placement rules are enforced', () => {
      const { project } = makeMedia();
      const audioTrack = project.tracks.find((t) => t.kind === 'audio')!;
      const placed = addClip(project, assets(), audioTrack.id, { mediaId: mediaB.id, trackStart: 0, sourceIn: 0, sourceOut: 1 });
      assert.ok(placed.id);
      assert.deepEqual(validateProject(project, assets()), []);
    });
  });

  describe('3. Transitions', () => {
    test('3.1 Crossfade shortens the timeline and permits exact overlap', () => {
      const { project, baseId } = makeMedia();
      const a = addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      addClip(project, assets(), baseId, { mediaId: mediaB.id, trackStart: 2, sourceIn: 0, sourceOut: 2 });
      addTransition(project, a.id, 0.5);
      assert.equal(timelineDuration(project), 3.5);
      // Moving B into the crossfade window is allowed up to the transition length
      const b = project.tracks[0].clips[1];
      moveClip(project, b.id, 1.5);
      assert.throws(() => moveClip(project, b.id, 1.4), /overlaps/);
      assert.throws(() => addTransition(project, b.id, 0.5), /last clip/);
    });
  });

  describe('4. Project persistence & recovery', () => {
    test('4.1 Save/load round-trips through disk with journal', async () => {
      const { project, baseId } = makeMedia();
      addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const dir = path.join(workDir, 'proj1');
      await saveVideoProject(dir, project, assets());
      const recovered = await recoverVideoProject(dir);
      assert.equal(recovered.journalState, 'saved');
      assert.equal(recovered.project.tracks[0].clips.length, 1);
      assert.equal(recovered.mediaAssets.get(mediaA.id)?.path, clipA);
    });

    test('4.2 Serialize/deserialize validates structure', () => {
      const { project, baseId } = makeMedia();
      addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 1 });
      const round = deserializeVideoProject(JSON.parse(JSON.stringify(serializeVideoProject(project, assets()))));
      assert.equal(round.project.name, 'Test Film');
      assert.throws(() => deserializeVideoProject({ format: 'nope' } as any), /format\/version/);
    });
  });

  describe('5. Genuine export through ffmpeg', () => {
    test('5.1 Two-clip export produces a validated MP4', { timeout: 300_000 }, async () => {
      const { project, baseId } = makeMedia();
      addClip(project, assets(), baseId, { mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      addClip(project, assets(), baseId, { mediaId: mediaB.id, trackStart: 2, sourceIn: 0, sourceOut: 2 });
      const out = path.join(workDir, 'export-basic.mp4');
      const result = await exportVideo(project, assets(), defaultExportSettings(project), out);
      assert.equal(result.status, 'success', result.error || result.ffmpegLogTail);
      assert.ok(result.outputBytes! > 10_000);
      assert.ok(Math.abs(result.probe!.durationSec - 4) < 1.0, `duration ${result.probe!.durationSec}`);
      assert.equal(result.probe!.width, 320);
      assert.equal(result.probe!.height, 240);
      assert.equal(result.probe!.hasAudio, true);
    });

    test('5.2 Crossfade + title + effect export validates at the shortened duration', { timeout: 300_000 }, async () => {
      const { project, baseId } = makeMedia();
      const a = addClip(project, assets(), baseId, {
        mediaId: mediaA.id, trackStart: 0, sourceIn: 0, sourceOut: 2, effect: 'grayscale', title: 'Opening'
      } as any);
      addClip(project, assets(), baseId, { mediaId: mediaB.id, trackStart: 2, sourceIn: 0, sourceOut: 2 });
      addTransition(project, a.id, 0.5);
      const out = path.join(workDir, 'export-xfade.mp4');
      const result = await exportVideo(project, assets(), defaultExportSettings(project), out);
      assert.equal(result.status, 'success', result.error || result.ffmpegLogTail);
      assert.ok(Math.abs(result.probe!.durationSec - 3.5) < 1.0, `duration ${result.probe!.durationSec}`);
    });

    test('5.3 Missing media at export time fails honestly and recovery keeps the project', { timeout: 120_000 }, async () => {
      const { project, baseId } = makeMedia();
      const ghost: MediaAsset = { id: 'ghost', path: path.join(workDir, 'ghost.mp4'), durationSec: 2, hasVideo: true, hasAudio: false, width: 320, height: 240 };
      const withGhost = new Map(assets());
      withGhost.set(ghost.id, ghost);
      addClip(project, withGhost, baseId, { mediaId: ghost.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const dir = path.join(workDir, 'proj-ghost');
      await saveVideoProject(dir, project, withGhost);
      await writeJournal(dir, 'exporting', 'simulated interrupted export');
      const out = path.join(workDir, 'export-ghost.mp4');
      const result = await exportVideo(project, withGhost, defaultExportSettings(project), out, { journalDir: dir });
      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /missing at export time/);
      assert.equal(fs.existsSync(out), false);
      const recovered = await recoverVideoProject(dir);
      assert.equal(recovered.project.tracks[0].clips.length, 1); // project intact
      assert.equal(recovered.journalState, 'export-failed');
    });

    test('5.4 Empty timeline export is refused, not faked', { timeout: 60_000 }, async () => {
      const { project } = makeMedia();
      const result = await exportVideo(project, assets(), defaultExportSettings(project), path.join(workDir, 'empty.mp4'));
      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /empty/);
    });
  });

  describe('6. Generated Application Source', () => {
    test('6.1 Generator emits a complete video-editor app on the desktop stack', () => {
      const config = VideoProjectGenerator.getDefaultConfig('ClipForge');
      const files = VideoProjectGenerator.generateProjectFiles(config);
      for (const expected of [
        'ClipForge.sln',
        'src/ClipForge/ClipForge.csproj',
        'src/ClipForge/Program.cs',
        'src/ClipForge/MainForm.cs',
        'src/ClipForge/VideoDocument.cs'
      ]) {
        assert.ok(files[expected], `missing ${expected}`);
      }
      const doc = files['src/ClipForge/VideoDocument.cs'];
      assert.match(doc, /public VideoClip Split\(/);
      assert.match(doc, /BuildExportArgs/);
      assert.match(doc, /FindFfmpeg/);
      assert.match(doc, /never simulated/);
      const form = files['src/ClipForge/MainForm.cs'];
      assert.match(form, /Export MP4/);
      assert.match(form, /_fpsBox/);
    });
  });
});
