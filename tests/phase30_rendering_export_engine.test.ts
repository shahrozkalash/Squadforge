import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createProject, addClip, serializeVideoProject } from '../server/videoEditor/timeline.js';
import { exportVideo, defaultExportSettings } from '../server/videoEditor/videoExporter.js';
import { importMedia, probeMedia } from '../server/videoEditor/mediaProbe.js';
import { detectEncoders, firstVerifiedHardwareEncoder } from '../server/videoEditor/hwAccel.js';
import { detectFfmpeg } from '../server/videoEditor/mediaProbe.js';
import { EXPORT_PRESETS, getPreset, settingsForPreset, renderCapabilities } from '../server/videoEditor/renderEngine.js';
import { RenderJobManager } from '../server/videoEditor/renderJobs.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';

const BASE = path.join(process.cwd(), '.tmp_p30_tests');
const assets = new Map<string, MediaAsset>();
const byName = (name: string): MediaAsset => [...assets.values()].find((a) => a.path.endsWith(name))!;

function simpleProject(name: string, fps = 30, seconds = 3): VideoProject {
  const project = createProject(name, 320, 240, fps);
  addClip(project, assets, project.tracks[0].id, { mediaId: byName('tone.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: seconds });
  return project;
}

describe('SquadForge Phase 30: Rendering and Export Engine Test Suite', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(BASE, 'tone.mp4')], { stdio: 'pipe' });
    const a = await importMedia(path.join(BASE, 'tone.mp4'));
    assets.set(a.id, a);
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Export presets', () => {
    test('1.1 Preset table and settings resolution are exact; overrides win', () => {
      assert.deepEqual(
        EXPORT_PRESETS.map((p) => [p.name, p.width, p.height]),
        [['source', 0, 0], ['480p', 854, 480], ['720p', 1280, 720], ['1080p', 1920, 1080], ['2160p', 3840, 2160]]
      );
      const project = simpleProject('preset-math');
      const s720 = settingsForPreset(project, '720p');
      assert.equal(s720.width, 1280);
      assert.equal(s720.height, 720);
      assert.equal(s720.videoBitrateKbps, 5000);
      assert.equal(s720.fps, 30, 'preset keeps the project frame rate');
      assert.equal(s720.preset, '720p');
      const overridden = settingsForPreset(project, '720p', { videoBitrateKbps: 777, fps: 24 });
      assert.equal(overridden.videoBitrateKbps, 777);
      assert.equal(overridden.fps, 24);
      const source = settingsForPreset(project, 'source');
      assert.equal(source.width, 320);
      assert.equal(source.height, 240);
      assert.throws(() => getPreset('8k'), /Unknown export preset/);
    });

    test('1.2 A 720p preset export really renders 1280x720 (upscale from a 320x240 project)', { timeout: 300_000 }, async () => {
      const project = simpleProject('preset-720');
      const out = path.join(BASE, 'p720.mp4');
      const result = await exportVideo(project, assets, settingsForPreset(project, '720p'), out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.width, 1280);
      assert.equal(probe.height, 720);
      assert.equal(result.encoderUsed, 'libx264');
    });

    test('1.3 A 4K preset export really renders 3840x2160', { timeout: 600_000 }, async () => {
      const project = simpleProject('preset-4k', 10, 1);
      const out = path.join(BASE, 'p4k.mp4');
      const result = await exportVideo(project, assets, settingsForPreset(project, '2160p'), out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.width, 3840);
      assert.equal(probe.height, 2160);
    });
  });

  describe('2. Hardware acceleration detection and fallback', () => {
    test('2.1 Detection is probe-based and honest on this host (no GPU)', { timeout: 120_000 }, async () => {
      const encoders = await detectEncoders(detectFfmpeg()!);
      const software = encoders.find((e) => e.encoder === 'libx264')!;
      assert.equal(software.verified, true, 'libx264 must pass its real encode probe');
      for (const hw of encoders.filter((e) => e.kind !== 'software')) {
        assert.equal(hw.verified, false, `${hw.encoder} must not verify without a GPU (detail: ${hw.detail})`);
      }
      assert.equal(await firstVerifiedHardwareEncoder(detectFfmpeg()!), null);
      const caps = await renderCapabilities();
      assert.equal(caps.autoEncoder, null);
      assert.ok(caps.notes.some((n) => /software libx264/.test(n)));
    });

    test('2.2 Requesting an unavailable hardware encoder falls back to software with a note', { timeout: 300_000 }, async () => {
      const project = simpleProject('fallback');
      const out = path.join(BASE, 'fallback.mp4');
      const result = await exportVideo(project, assets, { ...defaultExportSettings(project), encoderPreference: 'h264_nvenc' }, out);
      assert.equal(result.status, 'success', result.error);
      assert.equal(result.encoderUsed, 'libx264');
      assert.ok(result.notes!.some((n) => /h264_nvenc.*not available|fell back/.test(n)), `fallback must be noted: ${result.notes}`);
      const auto = await exportVideo(project, assets, { ...defaultExportSettings(project), encoderPreference: 'auto' }, path.join(BASE, 'auto.mp4'));
      assert.equal(auto.status, 'success', auto.error);
      assert.equal(auto.encoderUsed, 'libx264');
      assert.ok(auto.notes!.some((n) => /No verified hardware encoder/.test(n)));
    });
  });

  describe('3. Progress and cancellation', () => {
    test('3.1 Progress callbacks are real, monotonic and bounded', { timeout: 300_000 }, async () => {
      const project = simpleProject('progress');
      const fractions: number[] = [];
      // ffmpeg's -progress channel ticks every ~0.5s of wall-clock
      // encoding, so the render must take seconds: a 1080p upscale on
      // this host does. (A sub-second encode honestly emits ~1 tick.)
      const result = await exportVideo(project, assets, settingsForPreset(project, '1080p'), path.join(BASE, 'progress.mp4'), {
        onProgress: (f) => fractions.push(f)
      });
      assert.equal(result.status, 'success', result.error);
      assert.ok(fractions.length >= 2, `expected several progress updates, got ${fractions.length}: ${fractions}`);
      assert.ok(fractions.every((f) => f >= 0 && f <= 1), 'fractions stay within 0..1');
      for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1], 'progress never goes backwards');
    });

    test('3.2 Cancelling a render returns cancelled and removes the partial file', { timeout: 300_000 }, async () => {
      const project = simpleProject('cancel');
      const out = path.join(BASE, 'cancelled.mp4');
      const controller = new AbortController();
      const slowSettings = settingsForPreset(project, '1080p'); // upscale encode: seconds of work
      const pending = exportVideo(project, assets, slowSettings, out, { signal: controller.signal });
      setTimeout(() => controller.abort(), 400);
      const result = await pending;
      assert.equal(result.status, 'cancelled', `expected cancelled, got ${result.status}: ${result.error}`);
      assert.ok(!fs.existsSync(out), 'the partial output must be removed');
    });
  });

  describe('4. Background render jobs', () => {
    test('4.1 A submitted job renders, reports progress and lands in history', { timeout: 300_000 }, async () => {
      const dir = path.join(BASE, 'jobs1');
      const manager = new RenderJobManager(dir);
      const project = simpleProject('job-one');
      const out = path.join(BASE, 'job1.mp4');
      const job = await manager.submit({ buildId: 'b1', project, mediaAssets: assets, settings: defaultExportSettings(project), outputPath: out });
      assert.ok(job.status === 'queued' || job.status === 'running', `job accepted, got ${job.status}`);
      await manager.whenIdle();
      const done = manager.get(job.id)!;
      assert.equal(done.status, 'succeeded', done.error);
      assert.equal(done.progress, 1);
      assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0);
      assert.ok((done.outputBytes ?? 0) > 0);
      assert.equal(manager.history('b1').length, 1);
      // Persistence: a fresh manager over the same directory sees it.
      const reloaded = new RenderJobManager(dir);
      await reloaded.load();
      assert.equal(reloaded.get(job.id)?.status, 'succeeded');
    });

    test('4.2 An interrupted job is never trusted and can be retried to success', { timeout: 300_000 }, async () => {
      const dir = path.join(BASE, 'jobs2');
      fs.mkdirSync(dir, { recursive: true });
      const project = simpleProject('job-retry');
      const out = path.join(BASE, 'job2.mp4');
      const ghost = {
        id: 'ghost-job',
        buildId: 'b2',
        projectName: project.name,
        outputPath: out,
        settings: defaultExportSettings(project),
        status: 'running',
        progress: 0.4,
        createdAt: new Date().toISOString(),
        serializedProject: serializeVideoProject(project, assets)
      };
      fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [ghost] }, null, 2));
      const manager = new RenderJobManager(dir);
      await manager.load();
      const loaded = manager.get('ghost-job')!;
      assert.equal(loaded.status, 'interrupted');
      assert.match(loaded.error!, /not a valid export/);
      const retried = await manager.retry('ghost-job');
      assert.ok(retried.status === 'queued' || retried.status === 'running', `retry accepted, got ${retried.status}`);
      await manager.whenIdle();
      const done = manager.get('ghost-job')!;
      assert.equal(done.status, 'succeeded', done.error);
      assert.ok(fs.existsSync(out));
      const probe = await probeMedia(out);
      assert.equal(probe.width, 320);
    });

    test('4.3 A running job can be cancelled; a broken job fails honestly; outputs are manageable', { timeout: 300_000 }, async () => {
      const dir = path.join(BASE, 'jobs3');
      const manager = new RenderJobManager(dir);
      const slow = simpleProject('job-slow');
      const slowJob = await manager.submit({
        buildId: 'b3',
        project: slow,
        mediaAssets: assets,
        settings: settingsForPreset(slow, '1080p'),
        outputPath: path.join(BASE, 'job3-slow.mp4')
      });
      const deadline = Date.now() + 30_000;
      while (manager.get(slowJob.id)?.status !== 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(manager.get(slowJob.id)?.status, 'running');
      assert.equal(manager.cancel(slowJob.id), true);
      await manager.whenIdle();
      assert.equal(manager.get(slowJob.id)?.status, 'cancelled');

      const broken = simpleProject('job-broken');
      const ghostAssets = new Map(assets);
      const real = byName('tone.mp4');
      ghostAssets.set(real.id, { ...real, path: path.join(BASE, 'missing-file.mp4') });
      const brokenJob = await manager.submit({
        buildId: 'b3',
        project: broken,
        mediaAssets: ghostAssets,
        settings: defaultExportSettings(broken),
        outputPath: path.join(BASE, 'job3-broken.mp4')
      });
      await manager.whenIdle();
      const failed = manager.get(brokenJob.id)!;
      assert.equal(failed.status, 'failed');
      assert.match(failed.error!, /missing/);
      assert.ok(!fs.existsSync(path.join(BASE, 'job3-broken.mp4')));

      const quick = simpleProject('job-quick');
      const quickOut = path.join(BASE, 'job3-quick.mp4');
      const quickJob = await manager.submit({ buildId: 'b3', project: quick, mediaAssets: assets, settings: defaultExportSettings(quick), outputPath: quickOut });
      await manager.whenIdle();
      assert.equal(manager.get(quickJob.id)?.status, 'succeeded');
      const afterDelete = await manager.deleteOutput(quickJob.id);
      assert.equal(afterDelete.outputDeleted, true);
      assert.ok(!fs.existsSync(quickOut));
      assert.equal(manager.history('b3').length, 3, 'history keeps cancelled, failed and succeeded records');
    });
  });
});
