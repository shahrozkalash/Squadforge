import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';
import type { Server } from 'http';
import { createVideoEditorRouter } from '../server/videoEditor/videoEditorRoutes.js';
import { probeMedia } from '../server/videoEditor/mediaProbe.js';
import { decodePng } from '../server/imageEditor/imageCodec.js';
import type { SerializedVideoProject } from '../server/videoEditor/types.js';

const BUILD = 'p31-build';
const ROOT = process.cwd();
const DIRS = ['.video_media', '.video_projects', '.video_artifacts', '.video_previews', '.video_jobs'].map((d) => path.join(ROOT, d, BUILD));

let server: Server;
let origin = '';
let project: SerializedVideoProject;

async function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${origin}${urlPath}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* binary or plain */ }
  return { status: res.status, json, text };
}
const api = (p: string) => `/api/builds/${BUILD}/video-editor${p}`;

async function op(operation: unknown): Promise<any> {
  const r = await call('POST', api('/operations'), { project, operation });
  assert.equal(r.status, 200, `op failed: ${r.text.slice(0, 300)}`);
  project = r.json.project;
  return r.json.result;
}

function px(frame: ReturnType<typeof decodePng>, x: number, y: number): [number, number, number] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

describe('SquadForge Phase 31: Integrated Editor — end-to-end workflow over HTTP', () => {
  before(async () => {
    for (const dir of DIRS) fs.mkdirSync(dir, { recursive: true });
    const mediaDir = DIRS[0];
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=3:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(mediaDir, 'red.mp4')], { stdio: 'pipe' });
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(mediaDir, 'blue.mp4')], { stdio: 'pipe' });

    const app = express();
    app.use(express.json({ limit: '30mb' }));
    const router = createVideoEditorRouter({
      requireAuth: (_req, _res, next) => next(),
      verifyBuildOwnership: (_req, res, buildId) => {
        if (buildId !== BUILD) {
          res.status(404).json({ error: 'build not found' });
          return null;
        }
        return { id: BUILD } as any;
      }
    });
    app.use('/api/builds/:id/video-editor', router);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    for (const dir of DIRS) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('The complete workflow: create → import → edit → preview → save → reopen → export', { timeout: 900_000 }, async () => {
    // 1. The web editor page is served and wired to the real API.
    const appPage = await call('GET', api('/app'));
    assert.equal(appPage.status, 200);
    for (const needle of ['/operations', '/preview/frame', '/project/save', '/export/jobs', '/media/import', '/captions/export']) {
      assert.ok(appPage.text.includes(needle), `editor page must call ${needle}`);
    }
    const status = await call('GET', api('/status'));
    assert.equal(status.json.ffmpegFound, true);

    // 2. Create a project through the API (what the UI's New button does).
    const created = await call('POST', api('/project/create'), { name: 'E2E Film', width: 320, height: 240, fps: 30 });
    assert.equal(created.status, 200, created.text.slice(0, 200));
    project = created.json.project;
    assert.equal(project.project.tracks.length, 2);

    // 3. Import media by probing files in the build's media folder.
    for (const name of ['red.mp4', 'blue.mp4']) {
      const probed = await call('POST', api('/probe'), { path: name });
      assert.equal(probed.status, 200, probed.text.slice(0, 200));
      project.media.push(probed.json.asset);
    }
    const red = project.media.find((a) => a.path.endsWith('red.mp4'))!;
    const blue = project.media.find((a) => a.path.endsWith('blue.mp4'))!;

    // 4. Edit: base clip, a new overlay track, a PiP clip, transform,
    // effect, fades, caption — all through the operations endpoint.
    const baseTrackId = project.project.tracks[0].id;
    const baseClip = (await op({ type: 'addClip', trackId: baseTrackId, clip: { mediaId: red.id, trackStart: 0, sourceIn: 0, sourceOut: 3 } })).clip;
    const overlayTrack = (await op({ type: 'addTrack', kind: 'video', name: 'Overlay' })).track;
    const pipClip = (await op({ type: 'addClip', trackId: overlayTrack.id, clip: { mediaId: blue.id, trackStart: 0, sourceIn: 0, sourceOut: 3 } })).clip;
    await op({ type: 'setTransform', clipId: pipClip.id, transform: { x: 160, y: 120, scale: 0.5, rotationDeg: 0, opacity: 1 } });
    await op({ type: 'addEffect', clipId: baseClip.id, effectType: 'brightness', value: 0.15 });
    await op({ type: 'setFades', clipId: baseClip.id, fadeInSec: 0.5, fadeOutSec: 0.5 });
    await op({ type: 'addCaption', caption: { startSec: 0, endSec: 2, text: 'HELLO E2E' } });
    await op({ type: 'addText', text: { text: 'TITLE', trackStart: 0, durationSec: 2, x: 20, y: 20, fontSize: 28, color: '#FFFFFF' } });

    // 5. Playback info agrees with the edited timeline.
    const info = await call('POST', api('/playback/info'), { project });
    assert.equal(info.status, 200);
    assert.ok(Math.abs(info.json.info.durationSec - 3) < 0.2, `duration ~3s, got ${info.json.info.durationSec}`);

    // 6. Preview frame: real pixels — blue PiP inside its window, red base outside.
    const frameRes = await call('POST', api('/preview/frame'), { project, timeSec: 1 });
    assert.equal(frameRes.status, 200, frameRes.text.slice(0, 300));
    const imgRes = await fetch(`${origin}${frameRes.json.frame.imageUrl}`);
    assert.equal(imgRes.status, 200);
    const frame = decodePng(Buffer.from(await imgRes.arrayBuffer()));
    const [pr, pg, pb] = px(frame, 240, 180);
    assert.ok(pb > 150 && pr < 110, `PiP centre must be blue, got (${pr},${pg},${pb})`);
    const [br, bg, bb] = px(frame, 12, 228);
    assert.ok(br > 120 && bb < 110, `base corner must be red, got (${br},${bg},${bb})`);

    // 7. Waveform + analysis endpoints work on the imported media.
    const wave = await call('POST', api('/waveform'), { path: 'red.mp4', bucketsPerSecond: 10 });
    assert.equal(wave.status, 200, wave.text.slice(0, 200));
    assert.ok(wave.json.waveform.peaks.length >= 25);
    const analysis = await call('POST', api('/analyze'), { path: 'red.mp4' });
    assert.equal(analysis.status, 200, analysis.text.slice(0, 200));
    assert.equal(analysis.json.analysis.status, 'success');

    // 8. Save (autosave endpoint), then reopen: everything survives.
    const saved = await call('POST', api('/project/save'), { project });
    assert.equal(saved.status, 200, saved.text.slice(0, 200));
    const loaded = await call('GET', api('/project/load'));
    assert.equal(loaded.status, 200, loaded.text.slice(0, 200));
    assert.equal(loaded.json.journalState, 'saved');
    const reopened: SerializedVideoProject = loaded.json.project;
    assert.equal(reopened.project.tracks.length, 3);
    assert.equal(reopened.project.captions?.length, 1);
    assert.equal(reopened.project.captions?.[0].text, 'HELLO E2E');
    project = reopened;

    // 9. Captions export as real SRT.
    const srt = await call('POST', api('/captions/export'), { project, format: 'srt' });
    assert.equal(srt.status, 200);
    assert.ok(srt.json.content.includes('HELLO E2E'));
    assert.ok(srt.json.content.includes('00:00:00,000 --> 00:00:02,000'));

    // 10. Export through a background job at the 720p preset; poll to
    // completion; the file exists and ffprobe validates it.
    const submitted = await call('POST', api('/export/jobs'), { project, preset: '720p', settings: { encoderPreference: 'software' } });
    assert.equal(submitted.status, 202, submitted.text.slice(0, 300));
    const jobId = submitted.json.job.id;
    let job: any = null;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const polled = await call('GET', api(`/export/jobs/${jobId}`));
      job = polled.json.job;
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(job.status, 'succeeded', `job failed: ${job.error}`);
    assert.equal(job.progress, 1);
    assert.ok(fs.existsSync(job.outputPath), 'exported file must exist');
    const probe = await probeMedia(job.outputPath);
    assert.equal(probe.width, 1280);
    assert.equal(probe.height, 720);
    assert.equal(probe.hasAudio, true);
    assert.ok(Math.abs(probe.durationSec - 3) < 0.6, `export duration ~3s, got ${probe.durationSec}`);

    // 11. The export is in history.
    const history = await call('GET', api('/export/history'));
    assert.equal(history.status, 200);
    assert.ok(history.json.history.some((h: any) => h.id === jobId && h.status === 'succeeded'));

    // 12. Ownership is enforced: another build id gets nothing.
    const foreign = await call('GET', '/api/builds/someone-else/video-editor/status');
    assert.equal(foreign.status, 404);
  });
});
