import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createProject, addTrack, addClip, addTransition } from '../server/videoEditor/timeline.js';
import { applyEditOperation } from '../server/videoEditor/editingOps.js';
import { importMedia } from '../server/videoEditor/mediaProbe.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';
import {
  PlaybackSession,
  TimelineView,
  buildPreviewArgs,
  renderPreviewFrame,
  resolveAtTime,
  playbackInfo
} from '../server/videoEditor/playback.js';
import { createProject as createImgProject, composite } from '../server/imageEditor/imageCore.js';
import { encodePng, decodePng } from '../server/imageEditor/imageCodec.js';

const BASE = path.join(process.cwd(), '.tmp_p27_tests');
const assets = new Map<string, MediaAsset>();
const byName = (name: string): MediaAsset => [...assets.values()].find((a) => a.path.endsWith(name))!;

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
}

function px(frame: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

function near(actual: [number, number, number], expected: [number, number, number], tol: number = 40): boolean {
  return Math.abs(actual[0] - expected[0]) <= tol && Math.abs(actual[1] - expected[1]) <= tol && Math.abs(actual[2] - expected[2]) <= tol;
}

function pipProject(): { project: VideoProject; overlayTrackId: string; pipClipId: string } {
  const project = createProject('p27', 320, 240, 30);
  addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
  const ovl = addTrack(project, 'video', 'PiP');
  const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
  pip.transform = { x: 16, y: 16, scale: 1, rotationDeg: 0, opacity: 1 };
  return { project, overlayTrackId: ovl.id, pipClipId: pip.id };
}

describe('SquadForge Phase 27: Real-Time Timeline and Playback Engine Test Suite', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(BASE, 'red.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'bluefull.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'blue.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=30', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'twotone.mp4')]);
    const img = createImgProject(120, 90, { r: 0, g: 200, b: 0, a: 255 });
    fs.writeFileSync(path.join(BASE, 'green.png'), encodePng(composite(img)));
    fs.writeFileSync(path.join(BASE, 'corrupt.mp4'), Buffer.from('this is not a video file at all, just text bytes'));
    for (const f of ['red.mp4', 'bluefull.mp4', 'blue.mp4', 'twotone.mp4', 'green.png']) {
      const a = await importMedia(path.join(BASE, f));
      assets.set(a.id, a);
    }
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Playback state machine (single clock)', () => {
    test('1.1 play/pause/stop/seek/speed with frame-accurate positions', () => {
      let nowMs = 0;
      const session = new PlaybackSession(() => nowMs);
      const { project } = pipProject();
      assert.equal(session.load(project, assets), true);
      assert.equal(session.state, 'idle');
      assert.equal(session.duration, 3);

      session.play();
      assert.equal(session.state, 'playing');
      nowMs += 1000;
      assert.equal(session.position(), 1);
      nowMs += 500;
      assert.equal(session.position(), 1.5);
      assert.equal(session.frameIndex(), 45);

      session.pause();
      assert.equal(session.state, 'paused');
      nowMs += 5000;
      assert.equal(session.position(), 1.5, 'paused position must not move');

      session.play();
      nowMs += 500;
      assert.equal(session.position(), 2);

      // Frame-accurate seek: 1.04s snaps to frame 31 (31/30)
      session.seekTo(1.04);
      assert.ok(Math.abs(session.position() - 31 / 30) < 1e-9, `seek snapped to ${session.position()}`);
      session.seekToFrame(45);
      assert.equal(session.position(), 1.5);
      session.seekByFrames(30);
      assert.equal(session.position(), 2.5);

      // Speed multiplies the same clock: 0.25s of wall time at 2x
      // advances the playhead 0.5s, landing exactly on the end.
      session.setSpeed(2);
      session.play();
      nowMs += 250;
      assert.equal(session.position(), 3);
      assert.equal(session.state, 'stopped');
    });

    test('1.2 End of timeline latches stopped; play restarts; invalid speed rejected', () => {
      let nowMs = 0;
      const session = new PlaybackSession(() => nowMs);
      const { project } = pipProject();
      session.load(project, assets);
      session.seekTo(2.5);
      session.setSpeed(1);
      session.play();
      nowMs += 1000; // past the 3s end
      assert.equal(session.position(), 3);
      assert.equal(session.state, 'stopped');
      session.play(); // restart from the end
      assert.equal(session.position(), 0);
      assert.equal(session.state, 'playing');
      session.stop();
      assert.equal(session.position(), 0);
      assert.equal(session.state, 'stopped');
      assert.throws(() => session.setSpeed(5), /speed/);
      assert.throws(() => session.setSpeed(0.1), /speed/);
    });

    test('1.3 Missing media at load is an explicit error state, never a silent play', () => {
      const session = new PlaybackSession(() => 0);
      const { project } = pipProject();
      const broken = new Map(assets);
      const ghost: MediaAsset = { id: 'ghost', path: path.join(BASE, 'does-not-exist.mp4'), durationSec: 3, hasVideo: true, hasAudio: false };
      broken.set('ghost', ghost);
      const badProject = createProject('bad', 320, 240, 30);
      addClip(badProject, broken, badProject.tracks[0].id, { mediaId: 'ghost', trackStart: 0, sourceIn: 0, sourceOut: 3 });
      assert.equal(session.load(badProject, broken), false);
      assert.equal(session.state, 'error');
      assert.match(session.error!, /missing/i);
      session.play();
      assert.equal(session.state, 'error', 'play must not start from an error state');
      void project;
    });
  });

  describe('2. Synchronization and resolution', () => {
    test('2.1 Audio position is the video position (zero drift) at every sampled instant', () => {
      let nowMs = 0;
      const session = new PlaybackSession(() => nowMs);
      const project = createProject('sync', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const audioTrack = project.tracks.find((t) => t.kind === 'audio')!;
      addClip(project, assets, audioTrack.id, { mediaId: byName('red.mp4').id, trackStart: 0.5, sourceIn: 0.5, sourceOut: 3 });
      session.load(project, assets);
      session.play();
      for (const step of [0, 250, 700, 1300, 2000]) {
        nowMs = step;
        assert.equal(session.syncDriftMs(), 0);
        assert.equal(session.audioPosition(), session.position());
      }
      const active = resolveAtTime(project, 1.5);
      const audio = active.find((a) => a.role === 'audio');
      assert.ok(audio, 'audio clip must be active at 1.5s');
      assert.ok(Math.abs(audio!.sourceTimeSec - 1.5) < 1e-9, `audio source time ${audio!.sourceTimeSec}`);
    });

    test('2.2 Resolution honours trims and speed exactly', () => {
      const project = createProject('res', 320, 240, 30);
      const clip = addClip(project, assets, project.tracks[0].id, { mediaId: byName('twotone.mp4').id, trackStart: 1, sourceIn: 0.5, sourceOut: 4 });
      applyEditOperation(project, assets, { type: 'setSpeed', clipId: clip.id, speed: 2 });
      const active = resolveAtTime(project, 1.5);
      assert.equal(active.length, 1);
      // (1.5 - 1) * 2 + 0.5 = 1.5 source seconds
      assert.ok(Math.abs(active[0].sourceTimeSec - 1.5) < 1e-9);
      assert.deepEqual(resolveAtTime(project, 0.5), [], 'nothing active before the clip starts');
    });

    test('2.3 Crossfade resolution: outgoing is base, incoming is transition-in with progress', () => {
      const project = createProject('fade', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('bluefull.mp4').id, trackStart: 3, sourceIn: 0, sourceOut: 3 });
      const red = project.tracks[0].clips[0];
      addTransition(project, red.id, 1);
      assert.equal(playbackInfo(project).durationSec, 5);
      const mid = resolveAtTime(project, 2.5).filter((a) => a.trackKind === 'video');
      assert.equal(mid.length, 2);
      const incoming = mid.find((a) => a.role === 'transition-in')!;
      assert.ok(incoming, 'incoming clip must be marked transition-in');
      assert.ok(Math.abs((incoming.transitionProgress ?? -1) - 0.5) < 1e-9);
      const before = resolveAtTime(project, 1).filter((a) => a.trackKind === 'video');
      assert.equal(before.length, 1);
      assert.equal(before[0].role, 'base');
    });
  });

  describe('3. Real preview frames', () => {
    test('3.1 Preview renders the real composited frame (PiP pixels match the export)', { timeout: 300_000 }, async () => {
      const { project } = pipProject();
      const out = path.join(BASE, 'prev_pip.png');
      const result = await renderPreviewFrame(project, assets, 1.0, out);
      assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
      if (result.status !== 'success') return;
      assert.equal(result.frameIndex, 30);
      assert.equal(result.activeClips.length, 2);
      const frame = decodePng(fs.readFileSync(out));
      assert.ok(near(px(frame, 24, 24), [0, 0, 255]), `pip pixel ${px(frame, 24, 24)}`);
      assert.ok(near(px(frame, 300, 220), [255, 0, 0]), 'base pixel outside pip');
    });

    test('3.2 Frame-accurate seeking lands in the correct source segment', { timeout: 300_000 }, async () => {
      const project = createProject('seek', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('twotone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 4 });
      const early = await renderPreviewFrame(project, assets, 0.5, path.join(BASE, 'prev_early.png'));
      const late = await renderPreviewFrame(project, assets, 2.5, path.join(BASE, 'prev_late.png'));
      assert.equal(early.status, 'success');
      assert.equal(late.status, 'success');
      assert.ok(near(px(decodePng(fs.readFileSync(path.join(BASE, 'prev_early.png'))), 160, 120), [255, 0, 0]), 't=0.5 must show the red segment');
      assert.ok(near(px(decodePng(fs.readFileSync(path.join(BASE, 'prev_late.png'))), 160, 120), [0, 0, 255]), 't=2.5 must show the blue segment');
    });

    test('3.3 Crossfade midpoint preview is a genuine blend', { timeout: 300_000 }, async () => {
      const project = createProject('fade-prev', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('bluefull.mp4').id, trackStart: 3, sourceIn: 0, sourceOut: 3 });
      addTransition(project, project.tracks[0].clips[0].id, 1);
      const out = path.join(BASE, 'prev_fade.png');
      const result = await renderPreviewFrame(project, assets, 2.5, out);
      assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
      const blended = px(decodePng(fs.readFileSync(out)), 160, 120);
      assert.ok(near(blended, [127, 0, 127], 48), `fade midpoint should blend red+blue, got ${blended}`);
    });

    test('3.4 Preview follows edits immediately (no stale frames) and honours hidden tracks', { timeout: 300_000 }, async () => {
      const { project, overlayTrackId, pipClipId } = pipProject();
      const out1 = path.join(BASE, 'prev_edit1.png');
      await renderPreviewFrame(project, assets, 1.0, out1);
      assert.ok(near(px(decodePng(fs.readFileSync(out1)), 24, 24), [0, 0, 255]));
      applyEditOperation(project, assets, { type: 'setTransform', clipId: pipClipId, transform: { x: 200, y: 140 } });
      const out2 = path.join(BASE, 'prev_edit2.png');
      await renderPreviewFrame(project, assets, 1.0, out2);
      const f2 = decodePng(fs.readFileSync(out2));
      assert.ok(near(px(f2, 24, 24), [255, 0, 0]), 'after the move, the old spot must show the base');
      assert.ok(near(px(f2, 210, 150), [0, 0, 255]), 'after the move, the new spot must show the PiP');
      const out3 = path.join(BASE, 'prev_hidden.png');
      const hidden = await renderPreviewFrame(project, assets, 1.0, out3, { hiddenTrackIds: new Set([overlayTrackId]) });
      assert.equal(hidden.status, 'success');
      assert.ok(near(px(decodePng(fs.readFileSync(out3)), 210, 150), [255, 0, 0]), 'hidden track must not render');
    });

    test('3.5 Missing, corrupted and out-of-range previews are explicit errors', { timeout: 300_000 }, async () => {
      const { project } = pipProject();
      const missing = await renderPreviewFrame(project, assets, 99, path.join(BASE, 'prev_none.png'));
      assert.equal(missing.status, 'error');
      assert.match((missing as any).error, /outside the timeline/);

      const corruptProject = createProject('corrupt', 320, 240, 30);
      const corruptAsset: MediaAsset = { id: 'corrupt-1', path: path.join(BASE, 'corrupt.mp4'), durationSec: 3, hasVideo: true, hasAudio: false, width: 320, height: 240 };
      const cmap = new Map<string, MediaAsset>([['corrupt-1', corruptAsset]]);
      addClip(corruptProject, cmap, corruptProject.tracks[0].id, { mediaId: 'corrupt-1', trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const corruptOut = path.join(BASE, 'prev_corrupt.png');
      const corrupt = await renderPreviewFrame(corruptProject, cmap, 1.0, corruptOut);
      assert.equal(corrupt.status, 'error');
      assert.equal(fs.existsSync(corruptOut), false, 'a failed preview must not leave a fake frame behind');

      const ghostProject = createProject('ghost', 320, 240, 30);
      const ghostAsset: MediaAsset = { id: 'ghost-1', path: path.join(BASE, 'gone.mp4'), durationSec: 3, hasVideo: true, hasAudio: false };
      const gmap = new Map<string, MediaAsset>([['ghost-1', ghostAsset]]);
      addClip(ghostProject, gmap, ghostProject.tracks[0].id, { mediaId: 'ghost-1', trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const ghost = await renderPreviewFrame(ghostProject, gmap, 1.0, path.join(BASE, 'prev_ghost.png'));
      assert.equal(ghost.status, 'error');
      assert.match((ghost as any).error, /missing/i);
    });

    test('3.6 Preview decoding is streaming: inputs are seeked with -ss before -i', () => {
      const { project } = pipProject();
      const { args } = buildPreviewArgs(project, assets, 1.0, path.join(BASE, 'x.png'));
      const ssIndex = args.indexOf('-ss');
      assert.ok(ssIndex !== -1, 'expected an input seek');
      assert.equal(args[ssIndex + 2], '-i', '-ss must directly precede its -i (input seeking, not output seeking)');
    });
  });

  describe('4. Timeline view state', () => {
    test('4.1 Zoom clamps, scroll clamps, x<->time round-trips, visibility toggles', () => {
      const view = new TimelineView(10);
      for (let i = 0; i < 30; i++) view.zoomIn();
      assert.ok(view.pxPerSecond <= 400);
      for (let i = 0; i < 40; i++) view.zoomOut();
      assert.ok(view.pxPerSecond >= 4);
      view.pxPerSecond = 100;
      view.setScroll(3);
      assert.equal(view.timeToX(3), 0);
      assert.equal(view.timeToX(4), 100);
      assert.ok(Math.abs(view.xToTime(view.timeToX(7.25)) - 7.25) < 1e-9);
      view.setScroll(999);
      assert.equal(view.scrollSec, 10);
      const range = view.visibleRange(500);
      assert.equal(range.endSec, 10);
      assert.equal(view.isTrackVisible('t1'), true);
      assert.equal(view.toggleTrack('t1'), false);
      assert.equal(view.isTrackVisible('t1'), false);
      assert.equal(view.toggleTrack('t1'), true);
    });
  });
});
