import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createProject, addTrack, addClip, addTransition, validateProject } from '../server/videoEditor/timeline.js';
import { applyEditOperation } from '../server/videoEditor/editingOps.js';
import { effectChainFor, sampleKeyframes, buildTimeExpression } from '../server/videoEditor/effects.js';
import { exportVideo, defaultExportSettings } from '../server/videoEditor/videoExporter.js';
import { renderPreviewFrame } from '../server/videoEditor/playback.js';
import { importMedia } from '../server/videoEditor/mediaProbe.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';
import { decodePng } from '../server/imageEditor/imageCodec.js';

const BASE = path.join(process.cwd(), '.tmp_p28_tests');
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

function frameOf(video: string, t: number, tag: string): ReturnType<typeof decodePng> {
  const p = path.join(BASE, `frame_${tag}.png`);
  ff(['-ss', String(t), '-i', video, '-frames:v', '1', p]);
  return decodePng(fs.readFileSync(p));
}

async function exportOk(project: VideoProject, name: string): Promise<string> {
  const out = path.join(BASE, name);
  const result = await exportVideo(project, assets, defaultExportSettings(project), out);
  assert.equal(result.status, 'success', `${name}: ${result.error} | ${(result.ffmpegLogTail || '').slice(-300)}`);
  return out;
}

function singleClipProject(mediaName: string, seconds: number = 2): { project: VideoProject; clipId: string } {
  const project = createProject('p28', 320, 240, 30);
  const clip = addClip(project, assets, project.tracks[0].id, { mediaId: byName(mediaName).id, trackStart: 0, sourceIn: 0, sourceOut: seconds });
  return { project, clipId: clip.id };
}

describe('SquadForge Phase 28: Effects, Transitions and Animation Engine Test Suite', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'red.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'bluefull.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=100x80:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'blue.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x404040:s=320x240:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'gray.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=320x240:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'midgray.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x240:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=white:s=160x240:d=2:r=30', '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'edge.mp4')]);
    for (const f of ['red.mp4', 'bluefull.mp4', 'blue.mp4', 'gray.mp4', 'midgray.mp4', 'edge.mp4']) {
      const a = await importMedia(path.join(BASE, f));
      assets.set(a.id, a);
    }
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Modular effects — real rendering', () => {
    test('1.1 Brightness, saturation and temperature change the rendered pixels as specified', { timeout: 300_000 }, async () => {
      const control = singleClipProject('gray.mp4');
      const controlOut = await exportOk(control.project, 'ctl.mp4');
      const controlPx = px(frameOf(controlOut, 1, 'ctl'), 160, 120);
      assert.ok(near(controlPx, [64, 64, 64], 24), `control gray ${controlPx}`);

      const bright = singleClipProject('gray.mp4');
      applyEditOperation(bright.project, assets, { type: 'addEffect', clipId: bright.clipId, effectType: 'brightness', value: 0.4 });
      const brightPx = px(frameOf(await exportOk(bright.project, 'bright.mp4'), 1, 'bright'), 160, 120);
      assert.ok(brightPx[0] > controlPx[0] + 60, `brightness +0.4 must lift the pixel (${controlPx[0]} -> ${brightPx[0]})`);

      const desat = singleClipProject('red.mp4');
      applyEditOperation(desat.project, assets, { type: 'addEffect', clipId: desat.clipId, effectType: 'saturation', value: 0 });
      const desatPx = px(frameOf(await exportOk(desat.project, 'desat.mp4'), 1, 'desat'), 160, 120);
      assert.ok(Math.abs(desatPx[0] - desatPx[1]) <= 24 && Math.abs(desatPx[1] - desatPx[2]) <= 24, `saturation 0 must gray the red, got ${desatPx}`);

      const warm = singleClipProject('midgray.mp4');
      applyEditOperation(warm.project, assets, { type: 'addEffect', clipId: warm.clipId, effectType: 'temperature', value: 1 });
      const warmPx = px(frameOf(await exportOk(warm.project, 'warm.mp4'), 1, 'warm'), 160, 120);
      assert.ok(warmPx[0] - warmPx[2] > 20, `warm temperature must push R above B, got ${warmPx}`);
      const cool = singleClipProject('midgray.mp4');
      applyEditOperation(cool.project, assets, { type: 'addEffect', clipId: cool.clipId, effectType: 'temperature', value: -1 });
      const coolPx = px(frameOf(await exportOk(cool.project, 'cool.mp4'), 1, 'cool'), 160, 120);
      assert.ok(coolPx[2] - coolPx[0] > 20, `cool temperature must push B above R, got ${coolPx}`);
    });

    test('1.2 Blur softens a hard edge; effect ORDER changes the result; removal restores the original', { timeout: 300_000 }, async () => {
      const blurred = singleClipProject('edge.mp4');
      applyEditOperation(blurred.project, assets, { type: 'addEffect', clipId: blurred.clipId, effectType: 'blur', value: 8 });
      const blurredPx = px(frameOf(await exportOk(blurred.project, 'blur.mp4'), 1, 'blur'), 156, 120);
      assert.ok(blurredPx[0] > 55, `blur must lift the black side near the edge, got ${blurredPx[0]}`);

      // Ordering proof needs a NON-linear pair (pure convolutions like
      // blur/sharpen mathematically commute): brightness clips at 255,
      // so brighten-then-blur differs from blur-then-brighten.
      const orderA = singleClipProject('edge.mp4'); // brightness THEN blur
      applyEditOperation(orderA.project, assets, { type: 'addEffect', clipId: orderA.clipId, effectType: 'brightness', value: 0.5 });
      applyEditOperation(orderA.project, assets, { type: 'addEffect', clipId: orderA.clipId, effectType: 'blur', value: 8 });
      const frameA = frameOf(await exportOk(orderA.project, 'orderA.mp4'), 1, 'oa');
      const orderB = singleClipProject('edge.mp4'); // blur THEN brightness
      applyEditOperation(orderB.project, assets, { type: 'addEffect', clipId: orderB.clipId, effectType: 'blur', value: 8 });
      applyEditOperation(orderB.project, assets, { type: 'addEffect', clipId: orderB.clipId, effectType: 'brightness', value: 0.5 });
      const frameB = frameOf(await exportOk(orderB.project, 'orderB.mp4'), 1, 'ob');
      let maxDiff = 0;
      for (let x = 130; x < 190; x++) {
        maxDiff = Math.max(maxDiff, Math.abs(px(frameA, x, 120)[0] - px(frameB, x, 120)[0]));
      }
      assert.ok(maxDiff > 15, `effect order must change the rendered edge (max strip diff ${maxDiff})`);

      const removed = singleClipProject('edge.mp4');
      const inst = applyEditOperation(removed.project, assets, { type: 'addEffect', clipId: removed.clipId, effectType: 'blur', value: 8 }).clip!.effects![0];
      applyEditOperation(removed.project, assets, { type: 'removeEffect', clipId: removed.clipId, effectId: inst.id });
      const removedPx = px(frameOf(await exportOk(removed.project, 'removed.mp4'), 1, 'rem'), 156, 120);
      assert.ok(removedPx[0] < 40, `after removal the edge must be sharp again, got ${removedPx[0]}`);
    });

    test('1.3 Chain building: legacy preset first, stack in order, neutrals omitted, ranges validated', () => {
      const { project, clipId } = singleClipProject('red.mp4');
      const clip = project.tracks[0].clips[0];
      clip.effect = 'invert';
      applyEditOperation(project, assets, { type: 'addEffect', clipId, effectType: 'contrast', value: 1 }); // neutral -> omitted
      applyEditOperation(project, assets, { type: 'addEffect', clipId, effectType: 'brightness', value: 0.25 });
      applyEditOperation(project, assets, { type: 'addEffect', clipId, effectType: 'saturation', value: 2 });
      assert.deepEqual(effectChainFor(clip), ['negate', 'eq=brightness=0.25', 'eq=saturation=2']);
      assert.throws(() => applyEditOperation(project, assets, { type: 'addEffect', clipId, effectType: 'brightness', value: 7 }), /outside/);
      assert.throws(() => applyEditOperation(project, assets, { type: 'addEffect', clipId, effectType: 'blur', value: -1 }), /outside/);
      const bad = { ...clip, effects: [{ id: 'x', type: 'contrast', value: 99 }] } as any;
      assert.ok(validateProject({ ...project, tracks: project.tracks.map((t) => ({ ...t, clips: [bad] })) }, assets).length > 0);
    });
  });

  describe('2. Transitions', () => {
    function twoClipProject(): VideoProject {
      const project = createProject('tr', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('bluefull.mp4').id, trackStart: 3, sourceIn: 0, sourceOut: 3 });
      return project;
    }

    test('2.1 Wipe-left reveals the incoming clip from the right at the midpoint', { timeout: 300_000 }, async () => {
      const project = twoClipProject();
      addTransition(project, project.tracks[0].clips[0].id, 1, 'wipe-left');
      const out = await exportOk(project, 'wipe.mp4');
      const mid = frameOf(out, 2.5, 'wipe');
      assert.ok(near(px(mid, 280, 120), [0, 0, 255]), `right side must already be the incoming blue, got ${px(mid, 280, 120)}`);
      assert.ok(near(px(mid, 40, 120), [255, 0, 0]), `left side must still be the outgoing red, got ${px(mid, 40, 120)}`);
    });

    test('2.2 Fade-black darkens the whole frame at the midpoint', { timeout: 300_000 }, async () => {
      const project = twoClipProject();
      addTransition(project, project.tracks[0].clips[0].id, 1, 'fade-black');
      const out = await exportOk(project, 'fadeblack.mp4');
      const mid = px(frameOf(out, 2.5, 'fb'), 160, 120);
      assert.ok(mid[0] < 110 && mid[1] < 110 && mid[2] < 110, `fade-black midpoint must be dark, got ${mid}`);
    });

    test('2.3 Unknown transition types are rejected everywhere', () => {
      const project = twoClipProject();
      assert.throws(() => addTransition(project, project.tracks[0].clips[0].id, 1, 'spin' as any), /Unknown transition/);
      project.transitions.push({ afterClipId: project.tracks[0].clips[0].id, type: 'spin' as any, durationSec: 1 });
      assert.ok(validateProject(project, assets).some((e) => /Unknown transition/.test(e)));
    });
  });

  describe('3. Keyframe animation', () => {
    test('3.1 Sampler: linear, smooth, holds, per-property independence', () => {
      const base = { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 };
      const kfs = [
        { id: 'a', timeSec: 0, x: 0 },
        { id: 'b', timeSec: 2, x: 100 },
        { id: 'c', timeSec: 1, opacity: 0.5 }
      ];
      assert.equal(sampleKeyframes(kfs, base, 1).x, 50);
      assert.equal(sampleKeyframes(kfs, base, -5).x, 0, 'holds the first value before the track');
      assert.equal(sampleKeyframes(kfs, base, 99).x, 100, 'holds the last value after the track');
      assert.equal(sampleKeyframes(kfs, base, 1).opacity, 0.5);
      assert.equal(sampleKeyframes(kfs, base, 0).opacity, 0.5, 'single-point property holds everywhere');
      assert.equal(sampleKeyframes(kfs, base, 1).scale, 1, 'unkeyframed properties keep the base value');
      const smooth = [
        { id: 'a', timeSec: 0, x: 0, easing: 'smooth' as const },
        { id: 'b', timeSec: 2, x: 100 }
      ];
      const quarter = sampleKeyframes(smooth, base, 0.5).x;
      assert.ok(quarter < 25 && quarter > 0, `smooth easing starts slower than linear (25), got ${quarter}`);
      assert.equal(sampleKeyframes(smooth, base, 1).x, 50, 'smooth passes through the midpoint');
      assert.deepEqual(sampleKeyframes(undefined, base, 1), base);
      assert.match(buildTimeExpression(kfs as any, 'x', 0), /if\(lt\(t,/);
    });

    test('3.2 Keyframed export moves and fades the overlay; preview matches the export pixel-for-pixel', { timeout: 300_000 }, async () => {
      const project = createProject('kf', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const ovl = addTrack(project, 'video', 'PiP');
      const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      pip.transform = { x: 0, y: 20, scale: 1, rotationDeg: 0, opacity: 1 };
      applyEditOperation(project, assets, {
        type: 'setKeyframes',
        clipId: pip.id,
        keyframes: [
          { id: 'k1', timeSec: 0, x: 0, opacity: 1 },
          { id: 'k2', timeSec: 3, x: 200, opacity: 0.2 }
        ]
      });
      const out = await exportOk(project, 'kf.mp4');
      const early = frameOf(out, 0.3, 'kfe');
      assert.ok(near(px(early, 30, 30), [0, 0, 255], 70), `early: pip near x=20 mostly opaque blue, got ${px(early, 30, 30)}`);
      const late = frameOf(out, 2.7, 'kfl');
      const latePx = px(late, 215, 30);
      // opacity at 2.7s = 1 + (0.2-1)*(2.7/3) = 0.28 -> 0.72*red + 0.28*blue
      assert.ok(Math.abs(latePx[0] - 184) <= 34 && Math.abs(latePx[2] - 71) <= 34, `late blend should be ~(184,0,71), got ${latePx}`);
      assert.ok(near(px(late, 10, 30), [255, 0, 0]), 'the pip has moved away from the left edge');
      const prev = await renderPreviewFrame(project, assets, 2.7, path.join(BASE, 'kf_prev.png'));
      assert.equal(prev.status, 'success');
      const prevPx = px(decodePng(fs.readFileSync(path.join(BASE, 'kf_prev.png'))), 215, 30);
      assert.ok(Math.abs(prevPx[0] - latePx[0]) <= 14 && Math.abs(prevPx[2] - latePx[2]) <= 14, `preview ${prevPx} must match export ${latePx}`);
    });

    test('3.3 Animated scale grows the overlay footprint over time', { timeout: 300_000 }, async () => {
      const project = createProject('kfs', 320, 240, 30);
      addClip(project, assets, project.tracks[0].id, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const ovl = addTrack(project, 'video', 'PiP');
      const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      pip.transform = { x: 100, y: 80, scale: 0.5, rotationDeg: 0, opacity: 1 };
      applyEditOperation(project, assets, {
        type: 'setKeyframes',
        clipId: pip.id,
        keyframes: [
          { id: 'k1', timeSec: 0, scale: 0.5 },
          { id: 'k2', timeSec: 3, scale: 2 }
        ]
      });
      const out = await exportOk(project, 'kfscale.mp4');
      // At t=0.15 scale ~0.575: pip is 100x80*0.575 = 58x46 at (100,80) -> (190,100) is outside (red)
      assert.ok(near(px(frameOf(out, 0.15, 'ks1'), 190, 100), [255, 0, 0]), 'small early footprint');
      // At t=2.85 scale ~1.93: pip is ~193x154 -> (190,100) is inside (blue)
      assert.ok(near(px(frameOf(out, 2.85, 'ks2'), 190, 100), [0, 0, 255]), 'grown late footprint');
    });

    test('3.4 Animated text moves across the frame in the export', { timeout: 300_000 }, async () => {
      const { project } = singleClipProject('red.mp4', 3);
      const el = applyEditOperation(project, assets, {
        type: 'addText',
        text: { text: 'MOVE', trackStart: 0, durationSec: 3, x: 10, y: 20, fontSize: 40, color: '#FFFFFF' }
      }).text!;
      applyEditOperation(project, assets, {
        type: 'setTextKeyframes',
        textId: el.id,
        keyframes: [
          { id: 't1', timeSec: 0, x: 10 },
          { id: 't2', timeSec: 3, x: 210 }
        ]
      });
      const out = await exportOk(project, 'textmove.mp4');
      const brightIn = (frame: ReturnType<typeof decodePng>, x0: number, x1: number): boolean => {
        for (let y = 14; y < 90; y++) for (let x = x0; x < x1; x++) {
          const [r, g, b] = px(frame, x, y);
          if (r > 190 && g > 190 && b > 190) return true;
        }
        return false;
      };
      const early = frameOf(out, 0.2, 'tm1');
      assert.ok(brightIn(early, 0, 150), 'early: text on the left');
      assert.ok(!brightIn(early, 200, 320), 'early: no text on the right');
      const late = frameOf(out, 2.8, 'tm2');
      assert.ok(brightIn(late, 190, 320), 'late: text on the right');
      assert.ok(!brightIn(late, 0, 120), 'late: text has left the left side');
    });

    test('3.5 Keyframe validation: out-of-range times, duplicates, forbidden text properties', () => {
      const { project, clipId } = singleClipProject('red.mp4', 2);
      assert.throws(
        () => applyEditOperation(project, assets, { type: 'setKeyframes', clipId, keyframes: [{ id: 'k', timeSec: 5, x: 0 }] }),
        /outside 0\.\.2/
      );
      assert.throws(
        () =>
          applyEditOperation(project, assets, {
            type: 'setKeyframes',
            clipId,
            keyframes: [
              { id: 'k1', timeSec: 1, x: 0 },
              { id: 'k2', timeSec: 1, x: 5 }
            ]
          }),
        /duplicate/
      );
      assert.throws(
        () => applyEditOperation(project, assets, { type: 'setKeyframes', clipId, keyframes: [{ id: 'k', timeSec: 1, opacity: 2 }] }),
        /outside 0\.\.1/
      );
      const el = applyEditOperation(project, assets, {
        type: 'addText',
        text: { text: 'T', trackStart: 0, durationSec: 2, x: 0, y: 0, fontSize: 30, color: '#FFFFFF' }
      }).text!;
      assert.throws(
        () => applyEditOperation(project, assets, { type: 'setTextKeyframes', textId: el.id, keyframes: [{ id: 'k', timeSec: 1, opacity: 0.5 }] }),
        /cannot be keyframed/
      );
    });
  });
});
