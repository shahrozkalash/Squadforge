import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createProject, addClip } from '../server/videoEditor/timeline.js';
import {
  exportVideo,
  defaultExportSettings,
  validateExportSettings,
  EXPORT_AUDIO_SAMPLE_RATES
} from '../server/videoEditor/videoExporter.js';
import { importMedia, probeMedia } from '../server/videoEditor/mediaProbe.js';
import { settingsForPreset } from '../server/videoEditor/renderEngine.js';
import { RenderJobManager } from '../server/videoEditor/renderJobs.js';
import type { MediaAsset, VideoProject } from '../server/videoEditor/types.js';

/**
 * Video Editor Roadmap Phase 4: Rendering and Export Engine.
 *
 * The pipeline itself (export, presets, progress, cancellation, jobs,
 * recovery) is SquadForge Phase 30's, proven by its own suite. This
 * suite covers what the Phase 4 audit found genuinely missing:
 * export-settings validation with named errors, CRF constant-quality
 * mode, an audio sample-rate choice, output frame-rate verification,
 * a dimension-probed 1080p render, and the RenderJobManager persist
 * race (concurrent persists sharing one tmp filename — the failure
 * main CI run #173 hit) now hardened by serialization.
 */

const BASE = path.join(process.cwd(), '.tmp_vp4_tests');
const assets = new Map<string, MediaAsset>();
const byName = (name: string): MediaAsset => [...assets.values()].find((a) => a.path.endsWith(name))!;

function noisyProject(name: string, seconds = 3): VideoProject {
  const project = createProject(name, 320, 240, 30);
  addClip(project, assets, project.tracks[0].id, { mediaId: byName('noisy.mp4').id, trackStart: 0, sourceIn: 0, sourceOut: seconds });
  return project;
}

describe('Video Editor Roadmap Phase 4: Rendering and Export Engine', () => {
  before(async () => {
    fs.mkdirSync(BASE, { recursive: true });
    // Detailed moving content (CRF levels must produce measurably
    // different file sizes) + a 44.1 kHz sine for the audio proofs.
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=3:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:d=3:sample_rate=44100',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        path.join(BASE, 'noisy.mp4')
      ],
      { stdio: 'pipe' }
    );
    const a = await importMedia(path.join(BASE, 'noisy.mp4'));
    assets.set(a.id, a);
  });
  after(() => fs.rmSync(BASE, { recursive: true, force: true }));

  describe('1. Export settings validation', () => {
    test('1.1 validateExportSettings accepts renderable settings and names every bad value', () => {
      const project = noisyProject('validate-math');
      const good = defaultExportSettings(project);
      assert.deepEqual(validateExportSettings(good), []);
      assert.deepEqual(validateExportSettings({ ...good, crf: 0 }), []);
      assert.deepEqual(validateExportSettings({ ...good, crf: 51, audioSampleRateHz: 48000 }), []);
      assert.ok(EXPORT_AUDIO_SAMPLE_RATES.includes(44100) && EXPORT_AUDIO_SAMPLE_RATES.includes(48000));

      const cases: [Partial<typeof good>, RegExp][] = [
        [{ width: 321 }, /width must be even/],
        [{ width: 0 }, /width must be a positive integer/],
        [{ height: -240 }, /height must be a positive integer/],
        [{ fps: 0 }, /fps must be a number/],
        [{ fps: 300 }, /fps must be a number/],
        [{ videoBitrateKbps: -1 }, /videoBitrateKbps must be a positive number/],
        [{ audioBitrateKbps: 0 }, /audioBitrateKbps must be a positive number/],
        [{ crf: -1 }, /crf must be an integer/],
        [{ crf: 52 }, /crf must be an integer/],
        [{ crf: 23.5 }, /crf must be an integer/],
        [{ audioSampleRateHz: 12345 }, /audioSampleRateHz must be one of/]
      ];
      for (const [patch, pattern] of cases) {
        const errors = validateExportSettings({ ...good, ...patch });
        assert.ok(errors.some((e) => pattern.test(e)), `${JSON.stringify(patch)} must be named: ${errors}`);
      }
    });

    test('1.2 settingsForPreset rejects unrenderable overrides at resolution time', () => {
      const project = noisyProject('preset-validation');
      assert.throws(() => settingsForPreset(project, '720p', { fps: 0 }), /Invalid export settings:.*fps/);
      assert.throws(() => settingsForPreset(project, '720p', { width: 321 }), /Invalid export settings:.*even/);
      assert.throws(() => settingsForPreset(project, '720p', { crf: 99 }), /Invalid export settings:.*crf/);
      const ok = settingsForPreset(project, '720p', { crf: 28, audioSampleRateHz: 48000, fps: 24 });
      assert.equal(ok.crf, 28);
      assert.equal(ok.audioSampleRateHz, 48000);
      assert.equal(ok.fps, 24);
    });

    test('1.3 exportVideo refuses invalid settings honestly, before any render', { timeout: 120_000 }, async () => {
      const project = noisyProject('export-validation');
      const out = path.join(BASE, 'never-rendered.mp4');
      const result = await exportVideo(project, assets, { ...defaultExportSettings(project), width: 321 }, out);
      assert.equal(result.status, 'failed');
      assert.match(result.error!, /Invalid export settings:.*width must be even/);
      assert.ok(!fs.existsSync(out), 'no output file may be produced for invalid settings');
    });
  });

  describe('2. Frame-rate settings, proven on real exports', () => {
    test('2.1 A 24 fps export of a 30 fps project really probes at 24 fps', { timeout: 300_000 }, async () => {
      const project = noisyProject('fps-24');
      const out = path.join(BASE, 'fps24.mp4');
      const result = await exportVideo(project, assets, { ...defaultExportSettings(project), fps: 24 }, out);
      assert.equal(result.status, 'success', result.error);
      assert.equal(result.probe?.fps, 24);
      const probe = await probeMedia(out);
      assert.equal(probe.fps, 24);
      assert.ok(Math.abs(probe.durationSec - 3) < 0.6, `duration stays the timeline duration, got ${probe.durationSec}`);
    });

    test('2.2 A 60 fps export really probes at 60 fps', { timeout: 300_000 }, async () => {
      const project = noisyProject('fps-60');
      const out = path.join(BASE, 'fps60.mp4');
      const result = await exportVideo(project, assets, settingsForPreset(project, 'source', { fps: 60 }), out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.fps, 60);
    });
  });

  describe('3. CRF constant-quality mode', () => {
    test('3.1 CRF drives real quality: CRF 40 output is far smaller than CRF 18 at identical geometry', { timeout: 300_000 }, async () => {
      const project = noisyProject('crf-levels');
      const hi = path.join(BASE, 'crf18.mp4');
      const lo = path.join(BASE, 'crf40.mp4');
      const hiResult = await exportVideo(project, assets, { ...defaultExportSettings(project), crf: 18 }, hi);
      const loResult = await exportVideo(project, assets, { ...defaultExportSettings(project), crf: 40 }, lo);
      assert.equal(hiResult.status, 'success', hiResult.error);
      assert.equal(loResult.status, 'success', loResult.error);
      assert.equal(hiResult.encoderUsed, 'libx264');
      const hiProbe = await probeMedia(hi);
      const loProbe = await probeMedia(lo);
      assert.equal(hiProbe.width, 320);
      assert.equal(loProbe.width, 320);
      assert.equal(hiProbe.height, loProbe.height);
      const hiBytes = fs.statSync(hi).size;
      const loBytes = fs.statSync(lo).size;
      assert.ok(loBytes < hiBytes * 0.75, `CRF 40 (${loBytes} B) must be far smaller than CRF 18 (${hiBytes} B)`);
    });

    test('3.2 CRF composes with presets: a 720p CRF 28 export probes at 1280x720', { timeout: 300_000 }, async () => {
      const project = noisyProject('crf-preset');
      const out = path.join(BASE, 'crf720.mp4');
      const result = await exportVideo(project, assets, settingsForPreset(project, '720p', { crf: 28 }), out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.width, 1280);
      assert.equal(probe.height, 720);
    });
  });

  describe('4. Audio encoding settings', () => {
    test('4.1 A requested 22050 Hz sample rate really lands in the exported AAC stream', { timeout: 300_000 }, async () => {
      const project = noisyProject('audio-rate');
      const out = path.join(BASE, 'rate22050.mp4');
      const result = await exportVideo(project, assets, { ...defaultExportSettings(project), audioSampleRateHz: 22050 }, out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.hasAudio, true);
      assert.equal(probe.audioCodec, 'aac');
      assert.equal(probe.audioSampleRateHz, 22050);
    });

    test('4.2 The default export keeps the source sample rate (44100 Hz)', { timeout: 300_000 }, async () => {
      const project = noisyProject('audio-default');
      const out = path.join(BASE, 'rate-default.mp4');
      const result = await exportVideo(project, assets, defaultExportSettings(project), out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.audioSampleRateHz, 44100);
    });
  });

  describe('5. Spec resolutions', () => {
    test('5.1 A 1080p preset export really renders 1920x1080 at the project frame rate', { timeout: 300_000 }, async () => {
      const project = noisyProject('spec-1080');
      const out = path.join(BASE, 'p1080.mp4');
      const result = await exportVideo(project, assets, settingsForPreset(project, '1080p'), out);
      assert.equal(result.status, 'success', result.error);
      const probe = await probeMedia(out);
      assert.equal(probe.width, 1920);
      assert.equal(probe.height, 1080);
      assert.equal(probe.fps, 30);
    });
  });

  describe('6. Render job persistence under concurrency (the CI #173 race)', () => {
    test('6.1 A burst of concurrent submits and cancels never breaks the job store', { timeout: 300_000 }, async () => {
      const dir = path.join(BASE, 'jobs-stress');
      const manager = new RenderJobManager(dir);
      const outcomes = await Promise.allSettled(
        Array.from({ length: 12 }, async (_, i) => {
          const project = noisyProject(`stress-${i}`, 2);
          const job = await manager.submit({
            buildId: 'stress',
            project,
            mediaAssets: assets,
            settings: defaultExportSettings(project),
            outputPath: path.join(BASE, `stress-${i}.mp4`)
          });
          // Even jobs are cancelled the moment they exist — this is
          // the fire-and-forget persist inside cancel() that used to
          // race the submit/run persists on the shared tmp filename.
          if (i % 2 === 0) manager.cancel(job.id);
          return job.id;
        })
      );
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      assert.equal(
        rejected.length,
        0,
        `no submit may reject (the old race surfaced as an ENOENT rename rejection): ${rejected.map((r) => String((r as PromiseRejectedResult).reason))}`
      );
      await manager.whenIdle(240_000);

      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'), 'utf8')) as { jobs: { id: string; status: string }[] };
      assert.equal(stored.jobs.length, 12, 'every job is in the persisted store');
      for (const [i, job] of stored.jobs.entries()) {
        assert.ok(['succeeded', 'cancelled'].includes(job.status), `job ${i} finished coherently, got ${job.status}`);
      }
      const succeeded = stored.jobs.filter((j) => j.status === 'succeeded').length;
      const cancelled = stored.jobs.filter((j) => j.status === 'cancelled').length;
      assert.equal(succeeded + cancelled, 12);
      assert.ok(cancelled >= 4, `the cancels really landed (got ${cancelled} cancelled)`);
      assert.ok(succeeded >= 4, `the uncancelled jobs really rendered (got ${succeeded} succeeded)`);
      assert.deepEqual(
        fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')),
        [],
        'no tmp litter may remain after concurrent persists'
      );

      // A fresh manager over the same directory reads the same truth.
      const reloaded = new RenderJobManager(dir);
      await reloaded.load();
      assert.equal(reloaded.list('stress').length, 12);
      assert.equal(reloaded.history('stress').length, 12);
    });
  });
});
