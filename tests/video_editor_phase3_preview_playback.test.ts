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
  PreviewFrameCache,
  aspectRatioString,
  buildPreviewArgs,
  fitWithinBox,
  parseAspectRatio,
  playbackInfo,
  previewCacheKey,
  previewSizeFor,
  renderPreviewFrame
} from '../server/videoEditor/playback.js';
import { createProject as createImgProject, composite } from '../server/imageEditor/imageCore.js';
import { encodePng, decodePng } from '../server/imageEditor/imageCodec.js';

/**
 * Video Editor Roadmap Phase 3: Preview and Playback Engine.
 *
 * The audit (VIDEO_EDITOR_PHASE_3_PROGRESS.md) found playback, seeking,
 * frame navigation, the shared resolver, streaming decode and format
 * handling already real (SquadForge Phase 27) — those are pinned here
 * where Phase 3 relies on them. The genuine gaps filled by this phase
 * are aspect-ratio-aware preview sizing and the bounded preview-frame
 * cache; both are proven with real rendered frames below.
 */

const BASE = path.join(process.cwd(), '.tmp_vp3_tests');
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

function pipProject(): { project: VideoProject; pipClipId: string } {
  const project = createProject('vp3-pip', 320, 240, 30);
  addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
  const ovl = addTrack(project, 'video', 'PiP');
  const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
  pip.transform = { x: 16, y: 16, scale: 1, rotationDeg: 0, opacity: 1 };
  return { project, pipClipId: pip.id };
}

describe('Video Editor Roadmap Phase 3: Preview and Playback Engine', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(BASE, 'red.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'bluefull.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'blue.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=30', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'twotone.mp4')]);
    // Common container/codec variety for the format tests.
    ff(['-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=2:r=30', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-pix_fmt', 'yuv420p', path.join(BASE, 'green.webm')]);
    ff(['-f', 'lavfi', '-i', 'color=c=purple:s=320x240:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'purple.mov')]);
    ff(['-f', 'lavfi', '-i', 'color=c=yellow:s=320x240:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'yellow.mkv')]);
    // A long file for the large-file seek test (small frame, low rate: fast to make, genuinely 90 s long).
    ff(['-f', 'lavfi', '-i', 'color=c=0x008080:s=160x120:d=90:r=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', path.join(BASE, 'long.mp4')]);
    // Dedicated mutable file for the cache-invalidation-by-replacement test.
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'mutable.mp4')]);
    const img = createImgProject(120, 90, { r: 0, g: 200, b: 0, a: 255 });
    fs.writeFileSync(path.join(BASE, 'green.png'), encodePng(composite(img)));
    for (const f of ['red.mp4', 'bluefull.mp4', 'blue.mp4', 'twotone.mp4', 'green.webm', 'purple.mov', 'yellow.mkv', 'long.mp4', 'mutable.mp4', 'green.png']) {
      const a = await importMedia(path.join(BASE, f));
      assets.set(a.id, a);
    }
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Aspect ratio and preview sizing (the Phase 3 gap, pure geometry)', () => {
    test('1.1 aspectRatioString reduces sizes to their W:H name', () => {
      assert.equal(aspectRatioString(1920, 1080), '16:9');
      assert.equal(aspectRatioString(1080, 1920), '9:16');
      assert.equal(aspectRatioString(1000, 1000), '1:1');
      assert.equal(aspectRatioString(320, 240), '4:3');
      assert.equal(aspectRatioString(240, 320), '3:4');
      assert.throws(() => aspectRatioString(0, 100), /positive/);
    });

    test('1.2 parseAspectRatio accepts names, W:H strings and numbers; rejects garbage by name', () => {
      assert.ok(Math.abs(parseAspectRatio('16:9') - 16 / 9) < 1e-12);
      assert.ok(Math.abs(parseAspectRatio('9:16') - 9 / 16) < 1e-12);
      assert.equal(parseAspectRatio(1.5), 1.5);
      assert.throws(() => parseAspectRatio('wide'), /unrecognized aspect ratio/);
      assert.throws(() => parseAspectRatio('16:0'), /unrecognized aspect ratio/);
      assert.throws(() => parseAspectRatio(-2), /positive/);
    });

    test('1.3 fitWithinBox preserves aspect, never upscales, and returns even dimensions', () => {
      assert.deepEqual(fitWithinBox(320, 240, 160, 160), { width: 160, height: 120 });
      assert.deepEqual(fitWithinBox(240, 320, 160, 160), { width: 120, height: 160 });
      assert.deepEqual(fitWithinBox(320, 240, 9999, 9999), { width: 320, height: 240 }, 'no upscale beyond the source');
      assert.deepEqual(fitWithinBox(320, 240, 1000, 60), { width: 80, height: 60 }, 'height-constrained fit');
      assert.deepEqual(fitWithinBox(300, 200, 100, 100), { width: 100, height: 66 }, 'even floor for yuv420p (66.67 -> 66)');
      assert.throws(() => fitWithinBox(320, 240, 0, 100), /positive/);
    });

    test('1.4 previewSizeFor precedence: explicit size verbatim > aspect fit > project size', () => {
      const { project } = pipProject();
      assert.deepEqual(previewSizeFor(project), { width: 320, height: 240 });
      assert.deepEqual(previewSizeFor(project, { maxWidth: 160 }), { width: 160, height: 120 });
      assert.deepEqual(previewSizeFor(project, { maxWidth: 160, maxHeight: 90 }), { width: 120, height: 90 });
      assert.deepEqual(previewSizeFor(project, { width: 200, maxWidth: 100 }), { width: 200, height: 240 }, 'explicit width wins; height keeps the pre-Phase-3 default (project height)');
    });

    test('1.5 playbackInfo reports the project aspect ratio alongside the frame grid', () => {
      const { project } = pipProject();
      const info = playbackInfo(project);
      assert.equal(info.aspectRatio, '4:3');
      assert.equal(info.fps, 30);
      assert.equal(info.frameCount, 90);
      const portrait = createProject('vp3-portrait-info', 240, 320, 30);
      assert.equal(playbackInfo(portrait).aspectRatio, '3:4');
    });
  });

  describe('2. Frame navigation and timeline<->preview synchronization', () => {
    test('2.1 Frame stepping moves exactly one frame and clamps at both ends', () => {
      const session = new PlaybackSession(() => 0);
      const { project } = pipProject();
      assert.equal(session.load(project, assets), true);
      session.seekToFrame(45);
      assert.equal(session.position(), 1.5);
      session.seekByFrames(1);
      assert.equal(session.frameIndex(), 46);
      assert.ok(Math.abs(session.position() - 46 / 30) < 1e-9);
      session.seekByFrames(-2);
      assert.equal(session.frameIndex(), 44);
      session.seekByFrames(-1000);
      assert.equal(session.frameIndex(), 0, 'stepping before the start clamps to frame 0');
      session.seekByFrames(10000);
      assert.equal(session.frameIndex(), 89, 'stepping past the end clamps to the last frame');
      assert.equal(session.audioPosition(), session.position(), 'audio stays on the same clock while stepping');
      assert.equal(session.syncDriftMs(), 0);
    });

    test('2.2 Session state and the rendered preview agree at the same instant (one resolver)', { timeout: 300_000 }, async () => {
      const project = createProject('vp3-sync', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('bluefull.mp4').id, trackStart: 3, sourceIn: 0, sourceOut: 3 });
      addTransition(project, project.tracks[0].clips[0].id, 1);

      const session = new PlaybackSession(() => 0);
      assert.equal(session.load(project, assets), true);
      session.seekTo(2.5);
      const fromSession = session.activeClips().map((a) => ({
        clipId: a.clip.id,
        role: a.role,
        sourceTimeSec: Number(a.sourceTimeSec.toFixed(3))
      }));

      const out = path.join(BASE, 'sync_frame.png');
      const rendered = await renderPreviewFrame(project, assets, 2.5, out);
      assert.equal(rendered.status, 'success', rendered.status === 'error' ? rendered.error : '');
      if (rendered.status !== 'success') return;
      assert.equal(rendered.frameIndex, session.frameIndex(), 'preview lands on the session frame');
      assert.equal(rendered.timeSec, session.position(), 'preview time is the session position');
      const fromPreview = rendered.activeClips.map((a) => ({ clipId: a.clipId, role: a.role, sourceTimeSec: a.sourceTimeSec }));
      assert.deepEqual(fromPreview, fromSession, 'preview and session resolve the same clips, roles and source times');
      const blended = px(decodePng(fs.readFileSync(out)), 160, 120);
      assert.ok(near(blended, [127, 0, 127], 48), `the agreed crossfade midpoint renders as a blend, got ${blended}`);
    });
  });

  describe('3. Aspect-preserving fitted previews (real frames)', () => {
    test('3.1 A fitted preview keeps the project aspect and scales overlay geometry with it', { timeout: 300_000 }, async () => {
      const { project } = pipProject();
      const out = path.join(BASE, 'fit_pip.png');
      const result = await renderPreviewFrame(project, assets, 1.0, out, { maxWidth: 160, maxHeight: 160 });
      assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
      if (result.status !== 'success') return;
      assert.equal(result.width, 160);
      assert.equal(result.height, 120);
      const frame = decodePng(fs.readFileSync(out));
      assert.equal(frame.width, 160);
      assert.equal(frame.height, 120);
      // The PiP (project rect 16,16 + 160x120) scales to (8,8) + 80x60 at half size.
      assert.ok(near(px(frame, 12, 12), [0, 0, 255]), `scaled pip interior ${px(frame, 12, 12)}`);
      assert.ok(near(px(frame, 84, 64), [0, 0, 255]), 'scaled pip far corner');
      assert.ok(near(px(frame, 4, 4), [255, 0, 0]), 'before the scaled pip, the base shows');
      assert.ok(near(px(frame, 100, 100), [255, 0, 0]), 'outside the scaled pip, the base shows');
    });

    test('3.2 A portrait project fitted into a square box letterboxes by project aspect, not source aspect', { timeout: 300_000 }, async () => {
      const project = createProject('vp3-portrait', 240, 320, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const out = path.join(BASE, 'fit_portrait.png');
      const result = await renderPreviewFrame(project, assets, 1.0, out, { maxWidth: 160, maxHeight: 160 });
      assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
      if (result.status !== 'success') return;
      assert.deepEqual({ width: result.width, height: result.height }, { width: 120, height: 160 });
      const frame = decodePng(fs.readFileSync(out));
      assert.equal(frame.width, 120);
      assert.equal(frame.height, 160);
      // The 320x240 source fits the 120-wide canvas at 120x90, centred: pad rows 0..34 and 125..159.
      assert.ok(near(px(frame, 60, 80), [255, 0, 0]), 'centre shows the source');
      assert.ok(near(px(frame, 60, 5), [0, 0, 0]), 'top pad is black');
      assert.ok(near(px(frame, 60, 155), [0, 0, 0]), 'bottom pad is black');
    });

    test('3.3 Explicit width/height are still used verbatim (pre-Phase-3 behaviour pinned)', { timeout: 300_000 }, async () => {
      const { project } = pipProject();
      const out = path.join(BASE, 'explicit_size.png');
      const result = await renderPreviewFrame(project, assets, 1.0, out, { width: 100, height: 100 });
      assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
      if (result.status !== 'success') return;
      assert.equal(result.width, 100);
      assert.equal(result.height, 100);
      const frame = decodePng(fs.readFileSync(out));
      assert.equal(frame.width, 100);
      assert.equal(frame.height, 100);
    });
  });

  describe('4. Preview frame cache (the second Phase 3 gap)', () => {
    test('4.1 An identical repeat request is served from the cache without re-rendering', { timeout: 300_000 }, async () => {
      const cache = new PreviewFrameCache(path.join(BASE, 'cache1'), 10);
      const { project } = pipProject();
      const out1 = path.join(BASE, 'cache_a.png');
      const first = await renderPreviewFrame(project, assets, 1.0, out1, { cache });
      assert.equal(first.status, 'success', first.status === 'error' ? first.error : '');
      assert.equal(cache.size, 1);
      const key = previewCacheKey(project, assets, 30, 320, 240);
      const cachedPath = cache.get(key);
      assert.ok(cachedPath && fs.existsSync(cachedPath), 'the rendered frame is in the cache');
      const cachedMtime = fs.statSync(cachedPath!).mtimeMs;
      const firstBytes = fs.readFileSync(out1);

      await new Promise((r) => setTimeout(r, 30));
      const out2 = path.join(BASE, 'cache_b.png');
      const second = await renderPreviewFrame(project, assets, 1.0, out2, { cache });
      assert.equal(second.status, 'success');
      assert.equal(cache.size, 1, 'no new entry for an identical request');
      assert.equal(fs.statSync(cachedPath!).mtimeMs, cachedMtime, 'the cached file was not rewritten — ffmpeg did not run again');
      assert.ok(fs.readFileSync(out2).equals(firstBytes), 'the served frame is byte-identical');
    });

    test('4.2 An edit invalidates the cached frame (preview still follows edits)', { timeout: 300_000 }, async () => {
      const cache = new PreviewFrameCache(path.join(BASE, 'cache2'), 10);
      const { project, pipClipId } = pipProject();
      const out1 = path.join(BASE, 'cache_edit1.png');
      await renderPreviewFrame(project, assets, 1.0, out1, { cache });
      assert.ok(near(px(decodePng(fs.readFileSync(out1)), 24, 24), [0, 0, 255]));
      applyEditOperation(project, assets, { type: 'setTransform', clipId: pipClipId, transform: { x: 200, y: 140 } });
      const out2 = path.join(BASE, 'cache_edit2.png');
      const second = await renderPreviewFrame(project, assets, 1.0, out2, { cache });
      assert.equal(second.status, 'success');
      assert.equal(cache.size, 2, 'the edited project is a different cache entry');
      const frame = decodePng(fs.readFileSync(out2));
      assert.ok(near(px(frame, 24, 24), [255, 0, 0]), 'the old spot shows the base after the move');
      assert.ok(near(px(frame, 210, 150), [0, 0, 255]), 'the new spot shows the PiP after the move');
    });

    test('4.3 Replacing a media file in place invalidates its cached frames', { timeout: 300_000 }, async () => {
      const cache = new PreviewFrameCache(path.join(BASE, 'cache3'), 10);
      const mutable = byName('mutable.mp4');
      const project = createProject('vp3-mutable', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: mutable.id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const out1 = path.join(BASE, 'cache_mut1.png');
      await renderPreviewFrame(project, assets, 1.0, out1, { cache });
      assert.ok(near(px(decodePng(fs.readFileSync(out1)), 160, 120), [255, 0, 0]), 'first render shows the red file');

      ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'mutable.mp4')]);
      const out2 = path.join(BASE, 'cache_mut2.png');
      const second = await renderPreviewFrame(project, assets, 1.0, out2, { cache });
      assert.equal(second.status, 'success');
      assert.ok(near(px(decodePng(fs.readFileSync(out2)), 160, 120), [0, 0, 255]), 'after replacement the preview shows the new file, not the cached red frame');
    });

    test('4.4 The cache is bounded: oldest entries are evicted with their files', { timeout: 300_000 }, async () => {
      const cache = new PreviewFrameCache(path.join(BASE, 'cache4'), 2);
      const project = createProject('vp3-bounded', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('twotone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 4 });
      for (const t of [0.5, 1.0, 1.5]) {
        const r = await renderPreviewFrame(project, assets, t, path.join(BASE, `bounded_${t}.png`), { cache });
        assert.equal(r.status, 'success', r.status === 'error' ? r.error : '');
      }
      assert.equal(cache.size, 2);
      const keyOf = (frameIndex: number) => previewCacheKey(project, assets, frameIndex, 320, 240);
      assert.equal(cache.get(keyOf(15)), null, 'the oldest frame (t=0.5) was evicted');
      assert.ok(cache.get(keyOf(45)), 'the newest frame (t=1.5) is still cached');
    });

    test('4.5 Cache keys are sensitive to frame, size, hidden tracks and project state', () => {
      const { project } = pipProject();
      const base = previewCacheKey(project, assets, 30, 320, 240);
      assert.equal(previewCacheKey(project, assets, 30, 320, 240), base, 'same inputs, same key');
      assert.notEqual(previewCacheKey(project, assets, 31, 320, 240), base, 'frame changes the key');
      assert.notEqual(previewCacheKey(project, assets, 30, 160, 120), base, 'size changes the key');
      assert.notEqual(previewCacheKey(project, assets, 30, 320, 240, new Set(['t1'])), base, 'hidden tracks change the key');
    });
  });

  describe('5. Common formats and large files', () => {
    test('5.1 WebM/VP9, MOV and MKV media import and preview with real frames', { timeout: 300_000 }, async () => {
      const cases: { file: string; color: [number, number, number] }[] = [
        { file: 'green.webm', color: [0, 128, 0] },
        { file: 'purple.mov', color: [128, 0, 128] },
        { file: 'yellow.mkv', color: [255, 255, 0] }
      ];
      for (const c of cases) {
        const asset = byName(c.file);
        assert.equal(asset.kind, 'video', `${c.file} imports as video`);
        const project = createProject(`vp3-${c.file}`, 320, 240, 30);
        addClip(project, assets, project.tracks[0].id, { mediaId: asset.id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
        const out = path.join(BASE, `fmt_${c.file}.png`);
        const result = await renderPreviewFrame(project, assets, 1.0, out);
        assert.equal(result.status, 'success', `${c.file}: ${result.status === 'error' ? result.error : ''}`);
        assert.ok(near(px(decodePng(fs.readFileSync(out)), 160, 120), c.color), `${c.file} frame shows its real content`);
      }
    });

    test('5.2 A 90-second file previews near its end by input seek, not by decoding through', { timeout: 300_000 }, async () => {
      const longAsset = byName('long.mp4');
      const dur = Math.floor(longAsset.durationSec);
      assert.ok(dur >= 85, `the long fixture is genuinely long (probed ${longAsset.durationSec}s)`);
      const project = createProject('vp3-long', 160, 120, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: longAsset.id, trackStart: 0, sourceIn: 0, sourceOut: dur });
      const t = dur - 1;
      const { args } = buildPreviewArgs(project, assets, t, path.join(BASE, 'x.png'));
      const ssIndex = args.indexOf('-ss');
      assert.ok(ssIndex !== -1 && args[ssIndex + 2] === '-i', 'the late frame is reached by input seek');
      assert.ok(Math.abs(Number(args[ssIndex + 1]) - t) < 0.01, `seek target is the requested source time (${args[ssIndex + 1]})`);
      const out = path.join(BASE, 'long_end.png');
      const result = await renderPreviewFrame(project, assets, t, out);
      assert.equal(result.status, 'success', result.status === 'error' ? result.error : '');
      assert.ok(near(px(decodePng(fs.readFileSync(out)), 80, 60), [0, 128, 128]), 'the frame near the end shows the real content');
    });
  });
});
