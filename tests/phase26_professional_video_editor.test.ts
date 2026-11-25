import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  createProject,
  addTrack,
  addClip,
  timelineDuration,
  saveVideoProject,
  recoverVideoProject,
  writeJournal,
  deserializeVideoProject,
  serializeVideoProject
} from '../server/videoEditor/timeline.js';
import { applyEditOperation, setClipTransform, setClipSpeed, cloneProject } from '../server/videoEditor/editingOps.js';
import { exportVideo, defaultExportSettings } from '../server/videoEditor/videoExporter.js';
import { importMedia } from '../server/videoEditor/mediaProbe.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';
import { createProject as createImgProject, composite } from '../server/imageEditor/imageCore.js';
import { encodePng, decodePng } from '../server/imageEditor/imageCodec.js';

const BASE = path.join(process.cwd(), '.tmp_p26_tests');
const assets = new Map<string, MediaAsset>();
const byName = (name: string): MediaAsset => [...assets.values()].find((a) => a.path.endsWith(name))!;

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
}

function frameAt(videoPath: string, t: number): ReturnType<typeof decodePng> {
  const png = path.join(BASE, `frame_${t}_${Math.random().toString(36).slice(2, 8)}.png`);
  ff(['-ss', String(t), '-i', videoPath, '-frames:v', '1', png]);
  return decodePng(fs.readFileSync(png));
}

function px(frame: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

function near(actual: [number, number, number], expected: [number, number, number], tol: number = 36): boolean {
  return Math.abs(actual[0] - expected[0]) <= tol && Math.abs(actual[1] - expected[1]) <= tol && Math.abs(actual[2] - expected[2]) <= tol;
}

async function exportOk(project: VideoProject, name: string): Promise<string> {
  const out = path.join(BASE, name);
  const result = await exportVideo(project, assets, defaultExportSettings(project), out);
  assert.equal(result.status, 'success', `${name}: ${result.error} | ${(result.ffmpegLogTail || '').slice(-400)}`);
  return out;
}

function baseProject(): { project: VideoProject; baseId: string } {
  const project = createProject('p26', 320, 240, 30);
  return { project, baseId: project.tracks[0].id };
}

describe('SquadForge Phase 26: Professional Video Editing Engine Test Suite', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(BASE, 'red.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'blue.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=80x120:d=3:r=30', '-f', 'lavfi', '-i', 'color=c=black:s=80x120:d=3:r=30', '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'half.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=yellow:s=80x120:d=3:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=80x120:d=3:r=30', '-filter_complex', '[0:v][1:v]hstack=inputs=2[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'stripe.mp4')]);
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=2:r=30', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(BASE, 'twotone.mp4')]);
    const img = createImgProject(120, 90, { r: 0, g: 200, b: 0, a: 255 });
    fs.writeFileSync(path.join(BASE, 'green.png'), encodePng(composite(img)));
    for (const f of ['red.mp4', 'blue.mp4', 'half.mp4', 'stripe.mp4', 'twotone.mp4', 'green.png']) {
      const a = await importMedia(path.join(BASE, f));
      assets.set(a.id, a);
    }
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Overlay compositing (picture-in-picture)', () => {
    test('1.1 PiP renders inside its window only; image layer and z-order are real', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      addClip(project, assets, baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      const ovl = addTrack(project, 'video', 'PiP');
      const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0.5, sourceIn: 0, sourceOut: 2 });
      pip.transform = { x: 16, y: 16, scale: 1, rotationDeg: 0, opacity: 1 };
      const imgT = addTrack(project, 'video', 'Image');
      const img = addClip(project, assets, imgT.id, { mediaId: byName('green.png').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      img.transform = { x: 180, y: 130, scale: 1, rotationDeg: 0, opacity: 1 };
      const out = await exportOk(project, 'pip.mp4');
      const f1 = frameAt(out, 1.0);
      assert.ok(near(px(f1, 24, 24), [0, 0, 255]), `pip pixel ${px(f1, 24, 24)}`);
      assert.ok(near(px(f1, 300, 220), [255, 0, 0]), `bg pixel ${px(f1, 300, 220)}`);
      assert.ok(near(px(f1, 190, 140), [0, 200, 0], 48), `image pixel ${px(f1, 190, 140)}`);
      const f0 = frameAt(out, 0.25);
      assert.ok(near(px(f0, 24, 24), [255, 0, 0]), 'pip must not show before its window');
    });

    test('1.2 Opacity blends the overlay with the base', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      addClip(project, assets, baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const ovl = addTrack(project, 'video', 'PiP');
      const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      pip.transform = { x: 16, y: 16, scale: 1, rotationDeg: 0, opacity: 0.5 };
      const out = await exportOk(project, 'opacity.mp4');
      const blended = px(frameAt(out, 1.0), 24, 24);
      assert.ok(near(blended, [127, 0, 127], 42), `expected purple blend, got ${blended}`);
    });

    test('1.3 Scale shrinks the overlay footprint; position is exact', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      addClip(project, assets, baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const ovl = addTrack(project, 'video', 'PiP');
      const pip = addClip(project, assets, ovl.id, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      pip.transform = { x: 200, y: 150, scale: 0.5, rotationDeg: 0, opacity: 1 }; // 160x120 -> 80x60 at (200,150)
      const out = await exportOk(project, 'scale.mp4');
      const f = frameAt(out, 1.0);
      assert.ok(near(px(f, 210, 160), [0, 0, 255]), 'inside scaled overlay');
      assert.ok(near(px(f, 290, 160), [255, 0, 0]), 'outside scaled width (unscaled would reach 360)');
      assert.ok(near(px(f, 210, 220), [255, 0, 0]), 'outside scaled height');
    });

    test('1.4 Rotation 180 flips the overlay content', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      addClip(project, assets, baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const ovl = addTrack(project, 'video', 'PiP');
      const clip = addClip(project, assets, ovl.id, { mediaId: byName('half.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      clip.transform = { x: 16, y: 16, scale: 1, rotationDeg: 180, opacity: 1 };
      const out = await exportOk(project, 'rotate.mp4');
      const f = frameAt(out, 1.0);
      // 180 degrees: bounding box stays 160x120; content is flipped in place.
      const left = px(f, 24, 60);   // flipped: original RIGHT (black)
      const right = px(f, 168, 60); // flipped: original LEFT (white)
      assert.ok(left[0] < 70 && left[1] < 70 && left[2] < 70, `left should be black after 180 flip, got ${left}`);
      assert.ok(right[0] > 185 && right[1] > 185 && right[2] > 185, `right should be white after 180 flip, got ${right}`);
    });

    test('1.5 Crop removes the cropped source region before compositing', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      addClip(project, assets, baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const ovl = addTrack(project, 'video', 'PiP');
      const clip = addClip(project, assets, ovl.id, { mediaId: byName('stripe.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      clip.transform = { x: 16, y: 16, scale: 1, rotationDeg: 0, opacity: 1, crop: { left: 80, top: 0, right: 0, bottom: 0 } };
      const out = await exportOk(project, 'crop.mp4');
      const f = frameAt(out, 1.0);
      assert.ok(near(px(f, 24, 24), [0, 0, 255]), `cropped overlay should be all blue, got ${px(f, 24, 24)}`);
      assert.ok(near(px(f, 120, 24), [255, 0, 0]), 'cropped overlay is only 80 wide; x=120 is base');
    });
  });

  describe('2. Speed and source-time accuracy', () => {
    test('2.1 Speed 2 halves the timeline span and advances source time', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      const clip = addClip(project, assets, baseId, { mediaId: byName('twotone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 4 });
      setClipSpeed(project, assets, clip.id, 2);
      assert.equal(timelineDuration(project), 2);
      const out = await exportOk(project, 'speed.mp4');
      // At t=1.5 the source time is 3.0s -> second half (blue)
      assert.ok(near(px(frameAt(out, 1.5), 160, 120), [0, 0, 255]));
      assert.ok(near(px(frameAt(out, 0.5), 160, 120), [255, 0, 0]));
    });

    test('2.2 Source in-point selects the exact source segment', { timeout: 300_000 }, async () => {
      const { project, baseId } = baseProject();
      addClip(project, assets, baseId, { mediaId: byName('twotone.mp4').id, trackStart: 0, sourceIn: 2, sourceOut: 4 });
      const out = await exportOk(project, 'sourcein.mp4');
      assert.ok(near(px(frameAt(out, 0.3), 160, 120), [0, 0, 255]), 'clip starting at source 2s must show the blue segment immediately');
    });

    test('2.3 Splitting a sped-up clip maps timeline offsets to source offsets', () => {
      const { project, baseId } = baseProject();
      const clip = addClip(project, assets, baseId, { mediaId: byName('twotone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 4 });
      setClipSpeed(project, assets, clip.id, 2);
      const right = applyEditOperation(project, assets, { type: 'split', clipId: clip.id, atTimelineSec: 0.5 }).clip!;
      assert.equal(clip.sourceOut, 1); // 0.5s timeline * speed 2 = 1s source
      assert.equal(right.sourceIn, 1);
      assert.equal(right.trackStart, 0.5);
    });
  });

  describe('3. Text layers', () => {
    test('3.1 A text element renders real pixels over the video', { timeout: 300_000 }, async () => {
      const withText = baseProject();
      addClip(withText.project, assets, withText.baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      applyEditOperation(withText.project, assets, {
        type: 'addText',
        text: { text: 'HELLO', trackStart: 0, durationSec: 2, x: 20, y: 20, fontSize: 44, color: '#FFFFFF' }
      });
      const outText = await exportOk(withText.project, 'text.mp4');
      const plain = baseProject();
      addClip(plain.project, assets, plain.baseId, { mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      const outPlain = await exportOk(plain.project, 'notext.mp4');
      const regionMax = (frame: ReturnType<typeof decodePng>): number => {
        let max = 0;
        for (let y = 14; y < 84; y++) for (let x = 14; x < 190; x++) {
          const [r, g, b] = px(frame, x, y);
          max = Math.max(max, Math.min(r, g, b));
        }
        return max;
      };
      assert.ok(regionMax(frameAt(outText, 1.0)) > 180, 'white text pixels must appear in the text region');
      assert.ok(regionMax(frameAt(outPlain, 1.0)) < 60, 'control export must have no bright text pixels');
    });
  });

  describe('4. Non-destructive operations', () => {
    test('4.1 Operations never modify source media; invalid ops leave the project untouched', async () => {
      const hashOf = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      const before = new Map([...assets.values()].map((a) => [a.id, hashOf(a.path)]));
      const { project, baseId } = baseProject();
      const clip = addClip(project, assets, baseId, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2 });
      setClipTransform(project, assets, clip.id, { x: 40, y: 30, opacity: 0.8 });
      const snapshot = cloneProject(project);
      assert.throws(() => setClipTransform(project, assets, clip.id, { opacity: 1.5 }), /opacity/);
      assert.throws(() => setClipSpeed(project, assets, clip.id, 8), /speed/);
      assert.throws(() => setClipTransform(project, assets, clip.id, { crop: { left: 150, top: 0, right: 150, bottom: 0 } }), /crop/);
      assert.deepEqual(JSON.parse(JSON.stringify(project)), JSON.parse(JSON.stringify(snapshot)), 'failed ops must not mutate the project');
      const dup = applyEditOperation(project, assets, { type: 'duplicate', clipId: clip.id }).clip!;
      assert.equal(dup.trackStart, 2);
      assert.equal(dup.transform?.x, 40);
      for (const [id, h] of before) assert.equal(hashOf(assets.get(id)!.path), h, 'source media must be byte-identical after edits');
    });
  });

  describe('5. Recovery and Phase 20 compatibility', () => {
    test('5.1 Save + crash-journal recovery preserves transforms, speed and texts', async () => {
      const dir = path.join(BASE, 'proj');
      const { project, baseId } = baseProject();
      const clip = addClip(project, assets, baseId, { mediaId: byName('blue.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 3 });
      setClipTransform(project, assets, clip.id, { x: 24, y: 24, scale: 0.75, rotationDeg: 15, opacity: 0.9 });
      setClipSpeed(project, assets, clip.id, 1.5);
      applyEditOperation(project, assets, { type: 'addText', text: { text: 'Title', trackStart: 0, durationSec: 2, x: 8, y: 8, fontSize: 30, color: '#FFEE00' } });
      await saveVideoProject(dir, project, assets);
      await writeJournal(dir, 'exporting', 'simulated crash mid-export');
      const recovered = await recoverVideoProject(dir);
      assert.equal(recovered.journalState, 'exporting');
      const rc = recovered.project.tracks[0].clips[0];
      assert.equal(rc.transform?.scale, 0.75);
      assert.equal(rc.transform?.rotationDeg, 15);
      assert.equal(rc.speed, 1.5);
      assert.equal(recovered.project.texts?.length, 1);
      assert.equal(recovered.project.texts?.[0].text, 'Title');
    });

    test('5.2 A Phase 20 project file (no new fields) loads and exports unchanged in behaviour', { timeout: 300_000 }, async () => {
      const legacy = {
        format: 'squadforge-video-project' as const,
        version: 1 as const,
        project: {
          id: 'legacy-1',
          name: 'legacy',
          width: 320,
          height: 240,
          fps: 30,
          tracks: [
            {
              id: 't-video',
              kind: 'video' as const,
              name: 'Video 1',
              clips: [
                { id: 'c1', mediaId: byName('red.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: 2, volume: 1, effect: 'none' as const }
              ]
            },
            { id: 't-audio', kind: 'audio' as const, name: 'Audio 1', clips: [] }
          ],
          transitions: []
        },
        media: [...assets.values()]
      };
      const { project, mediaAssets } = deserializeVideoProject(legacy as any);
      assert.deepEqual(project.texts, []);
      const out = path.join(BASE, 'legacy.mp4');
      const result = await exportVideo(project, mediaAssets, defaultExportSettings(project), out);
      assert.equal(result.status, 'success', result.error);
      assert.ok(near(px(frameAt(out, 1.0), 160, 120), [255, 0, 0]));
      const roundTrip = deserializeVideoProject(serializeVideoProject(project, mediaAssets));
      assert.equal(roundTrip.project.id, 'legacy-1');
    });
  });
});
