import express, { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../store.js';
import { Build } from '../types.js';
import { VideoProjectGenerator } from './videoProjectGenerator.js';
import { createProject, deserializeVideoProject, recoverVideoProject, saveVideoProject, serializeVideoProject } from './timeline.js';
import { EDITOR_WEB_APP_HTML } from './editorWebApp.js';
import { applyEditOperation, type EditOperation } from './editingOps.js';
import { defaultExportSettings, exportVideo } from './videoExporter.js';
import { playbackInfo, renderPreviewFrame, PreviewFrameCache } from './playback.js';
import { computeWaveform } from './waveform.js';
import { formatCaptions, parseCaptions } from './captions.js';
import { analyzeMedia } from './aiEditing.js';
import { captionProviderConfigFromEnv, generateCaptionsWithProvider, type CaptionProviderConfig } from './captionProviders.js';
import { renderCapabilities, settingsForPreset } from './renderEngine.js';
import { RenderJobManager } from './renderJobs.js';
import { detectFfmpeg, detectFfprobe, importMedia } from './mediaProbe.js';
import type { ExportSettings, SerializedVideoProject } from './types.js';
import { assertSafeWorkspacePath } from '../pathSecurity.js';

export interface VideoEditorRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createVideoEditorRouter(deps: VideoEditorRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });

  // Phase 30: one background render-job manager per build, persisted
  // under .video_jobs/<buildId> so interrupted jobs survive restarts.
  const jobManagers = new Map<string, RenderJobManager>();
  const jobsFor = (buildId: string): RenderJobManager => {
    let manager = jobManagers.get(buildId);
    if (!manager) {
      manager = new RenderJobManager(path.join(process.cwd(), '.video_jobs', buildId));
      jobManagers.set(buildId, manager);
    }
    return manager;
  };

  // Phase 3 (Video Editor Roadmap): one bounded preview-frame cache
  // per build, so scrubbing back over an already-rendered frame does
  // not re-decode it. Keys fingerprint the submitted project + media
  // files, so any edit misses the cache and re-renders.
  const previewCaches = new Map<string, PreviewFrameCache>();
  const previewCacheFor = (buildId: string): PreviewFrameCache => {
    let cache = previewCaches.get(buildId);
    if (!cache) {
      cache = new PreviewFrameCache(path.join(process.cwd(), '.video_previews', buildId, 'cache'), 120);
      previewCaches.set(buildId, cache);
    }
    return cache;
  };

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Video editor operation failed' });
      }
    };

  // 1. Generate the video-editing application source into the build's files
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const appName = (req.body?.appName as string) || 'ClipForge';
    const config = VideoProjectGenerator.getDefaultConfig(appName);
    const files = VideoProjectGenerator.generateProjectFiles(config);
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, {
        path: filePath,
        content,
        version: 1,
        ownerModel: req.user?.name || 'Video Editor Swarm'
      });
    }
    return res.json({ success: true, config, fileCount: Object.keys(files).length, files: Object.keys(files) });
  }));

  // 1b. Phase 31: the web-based editor application for this build.
  // A single self-contained page whose every control calls the real
  // API routes below — no decorative controls.
  router.get('/app', requireAuth, owned(async (_build, _req, res) => {
    res.type('html').send(EDITOR_WEB_APP_HTML);
  }));

  // 1c. Phase 31: create a fresh serialized project.
  router.post('/project/create', requireAuth, owned(async (_build, req, res) => {
    const name = String(req.body?.name || 'Untitled project');
    const width = Number(req.body?.width || 1280);
    const height = Number(req.body?.height || 720);
    const fps = Number(req.body?.fps || 30);
    if (!(width >= 16 && width <= 7680) || !(height >= 16 && height <= 4320)) {
      return res.status(400).json({ error: 'width/height out of range' });
    }
    if (!(fps >= 1 && fps <= 120)) return res.status(400).json({ error: 'fps out of range' });
    const project = createProject(name, width, height, fps);
    return res.json({ success: true, project: serializeVideoProject(project, new Map()) });
  }));

  // 1d. Phase 31: autosave / save the project (atomic write + journal).
  router.post('/project/save', requireAuth, owned(async (build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const dir = path.join(process.cwd(), '.video_projects', build.id);
    await saveVideoProject(dir, project, mediaAssets);
    return res.json({ success: true, savedAt: new Date().toISOString() });
  }));

  // 1e. Phase 31: load the saved project, with its journal state so
  // the UI can say honestly whether the last session ended cleanly.
  router.get('/project/load', requireAuth, owned(async (build, _req, res) => {
    const dir = path.join(process.cwd(), '.video_projects', build.id);
    try {
      const { project, mediaAssets, journalState } = await recoverVideoProject(dir);
      return res.json({ success: true, journalState, project: serializeVideoProject(project, mediaAssets) });
    } catch {
      return res.status(404).json({ success: false, error: 'No saved project for this build yet.' });
    }
  }));

  // 2. Toolchain status (honest detection)
  router.get('/status', requireAuth, owned(async (_build, _req, res) => {
    return res.json({
      success: true,
      ffmpegFound: Boolean(detectFfmpeg()),
      ffprobeFound: Boolean(detectFfprobe())
    });
  }));

  // 3. Probe + register a real media file from the build's media workspace
  router.post('/probe', requireAuth, owned(async (build, req, res) => {
    const rel = String(req.body?.path || '');
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const baseDir = path.join(process.cwd(), '.video_media', build.id);
    fs.mkdirSync(baseDir, { recursive: true });
    const abs = assertSafeWorkspacePath(baseDir, rel);
    const asset = await importMedia(abs);
    return res.json({ success: true, asset });
  }));

  // 3b. Phase 26: apply ONE validated, non-destructive edit operation
  // to a submitted project and return the updated project. Source
  // media files are never touched by editing operations.
  router.post('/operations', requireAuth, owned(async (_build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    const op = req.body?.operation as EditOperation;
    if (!data) return res.status(400).json({ error: 'project is required' });
    if (!op || typeof op.type !== 'string') return res.status(400).json({ error: 'operation with a type is required' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const result = applyEditOperation(project, mediaAssets, op);
    return res.json({ success: true, result, project: serializeVideoProject(project, mediaAssets) });
  }));

  // 3c. Phase 27: playback info for a submitted project (duration,
  // frame grid) — the numbers the player UI syncs against.
  router.post('/playback/info', requireAuth, owned(async (_build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const { project } = deserializeVideoProject(data);
    return res.json({ success: true, info: playbackInfo(project) });
  }));

  // 3d. Phase 27: render ONE real composited preview frame at a
  // timeline instant (actual decoding via input-seeked ffmpeg, the
  // exporter's own transform chain). Errors are explicit, never a
  // placeholder image.
  router.post('/preview/frame', requireAuth, owned(async (build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const timeSec = Number(req.body?.timeSec);
    if (!Number.isFinite(timeSec)) return res.status(400).json({ error: 'timeSec must be a number' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const hiddenTrackIds = new Set<string>(Array.isArray(req.body?.hiddenTrackIds) ? req.body.hiddenTrackIds : []);
    const outDir = path.join(process.cwd(), '.video_previews', build.id);
    fs.mkdirSync(outDir, { recursive: true });
    const framePath = path.join(outDir, `frame_${Math.round(timeSec * project.fps)}.png`);
    const result = await renderPreviewFrame(project, mediaAssets, timeSec, framePath, {
      hiddenTrackIds,
      width: req.body?.width ? Number(req.body.width) : undefined,
      height: req.body?.height ? Number(req.body.height) : undefined,
      maxWidth: req.body?.maxWidth ? Number(req.body.maxWidth) : undefined,
      maxHeight: req.body?.maxHeight ? Number(req.body.maxHeight) : undefined,
      cache: previewCacheFor(build.id)
    });
    if (result.status === 'error') return res.status(422).json({ success: false, error: result.error });
    return res.json({
      success: true,
      frame: {
        ...result,
        path: path.relative(process.cwd(), result.framePath),
        imageUrl: `/api/builds/${build.id}/video-editor/preview/image?path=${encodeURIComponent(path.basename(result.framePath))}`
      }
    });
  }));

  // 3e. Phase 27: serve a previously rendered preview frame (scoped
  // to this build's preview directory; basename only).
  router.get('/preview/image', requireAuth, owned(async (build, req, res) => {
    const name = path.basename(String(req.query?.path || ''));
    if (!name.endsWith('.png')) return res.status(400).json({ error: 'a preview .png path is required' });
    const baseDir = path.join(process.cwd(), '.video_previews', build.id);
    const abs = assertSafeWorkspacePath(baseDir, name);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'preview frame not found' });
    res.type('png');
    return res.sendFile(abs);
  }));

  // 3f. Phase 29: import an audio file (e.g. a voiceover recorded in
  // the browser) into the build's media workspace and probe it.
  router.post('/media/import', requireAuth, owned(async (build, req, res) => {
    const filename = path.basename(String(req.body?.filename || ''));
    const dataBase64 = String(req.body?.dataBase64 || '');
    if (!filename || !dataBase64) return res.status(400).json({ error: 'filename and dataBase64 are required' });
    if (!/\.(mp3|wav|m4a|aac|ogg|opus|flac|mp4|mov|webm|mkv|png|jpe?g|webp|gif|bmp)$/i.test(filename)) {
      return res.status(400).json({ error: 'unsupported media extension' });
    }
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length === 0) return res.status(400).json({ error: 'empty upload' });
    if (data.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'upload exceeds 25 MB' });
    const baseDir = path.join(process.cwd(), '.video_media', build.id);
    fs.mkdirSync(baseDir, { recursive: true });
    const abs = assertSafeWorkspacePath(baseDir, filename);
    fs.writeFileSync(abs, data);
    const asset = await importMedia(abs);
    return res.json({ success: true, asset });
  }));

  // 3g. Phase 29: waveform peaks computed from the actual audio.
  router.post('/waveform', requireAuth, owned(async (build, req, res) => {
    const rel = String(req.body?.path || '');
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const baseDir = path.join(process.cwd(), '.video_media', build.id);
    const abs = assertSafeWorkspacePath(baseDir, rel);
    const result = await computeWaveform(abs, {
      bucketsPerSecond: req.body?.bucketsPerSecond ? Number(req.body.bucketsPerSecond) : undefined
    });
    if (result.status === 'error') return res.status(422).json({ success: false, error: result.error });
    return res.json({ success: true, waveform: result });
  }));

  // 3h. Phase 29: media analysis (scene + silence detection -> suggested cuts).
  router.post('/analyze', requireAuth, owned(async (build, req, res) => {
    const rel = String(req.body?.path || '');
    if (!rel) return res.status(400).json({ error: 'path is required' });
    const baseDir = path.join(process.cwd(), '.video_media', build.id);
    const abs = assertSafeWorkspacePath(baseDir, rel);
    const result = await analyzeMedia(abs, {
      sceneThreshold: req.body?.sceneThreshold ? Number(req.body.sceneThreshold) : undefined,
      silenceNoiseDb: req.body?.silenceNoiseDb ? Number(req.body.silenceNoiseDb) : undefined,
      silenceMinDurationSec: req.body?.silenceMinDurationSec ? Number(req.body.silenceMinDurationSec) : undefined
    });
    if (result.status === 'error') return res.status(422).json({ success: false, error: result.error });
    return res.json({ success: true, analysis: result });
  }));

  // 3i. Phase 29: caption import (SRT/VTT -> project cues).
  router.post('/captions/import', requireAuth, owned(async (_build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    const format = req.body?.format as 'srt' | 'vtt';
    const content = String(req.body?.content || '');
    if (!data) return res.status(400).json({ error: 'project is required' });
    if (format !== 'srt' && format !== 'vtt') return res.status(400).json({ error: "format must be 'srt' or 'vtt'" });
    if (!content) return res.status(400).json({ error: 'content is required' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const cues = parseCaptions(content, format);
    project.captions = cues;
    return res.json({ success: true, imported: cues.length, project: serializeVideoProject(project, mediaAssets) });
  }));

  // 3j. Phase 29: caption export (project cues -> SRT/VTT text).
  router.post('/captions/export', requireAuth, owned(async (_build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    const format = req.body?.format as 'srt' | 'vtt';
    if (!data) return res.status(400).json({ error: 'project is required' });
    if (format !== 'srt' && format !== 'vtt') return res.status(400).json({ error: "format must be 'srt' or 'vtt'" });
    const { project } = deserializeVideoProject(data);
    return res.json({ success: true, format, content: formatCaptions(project.captions ?? [], format) });
  }));

  // 3k. Phase 29: automatic captions via the configured provider
  // adapter (server-side config only; 'none' reports unavailable and
  // fabricates nothing).
  router.post('/captions/generate', requireAuth, owned(async (build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const rel = String(req.body?.path || '');
    if (!rel) return res.status(400).json({ error: 'path (media to transcribe) is required' });
    const baseDir = path.join(process.cwd(), '.video_media', build.id);
    const abs = assertSafeWorkspacePath(baseDir, rel);
    const config: CaptionProviderConfig = {
      ...captionProviderConfigFromEnv(),
      ...(req.body?.provider === 'whisper-cli' ? { provider: 'whisper-cli' as const } : {}),
      language: req.body?.language ? String(req.body.language) : undefined
    };
    const result = await generateCaptionsWithProvider(abs, config);
    if (result.status !== 'success') {
      return res.status(422).json({ success: false, status: result.status, provider: result.provider, error: result.error });
    }
    const { project, mediaAssets } = deserializeVideoProject(data);
    project.captions = result.cues!;
    return res.json({
      success: true,
      provider: result.provider,
      generated: result.cues!.length,
      project: serializeVideoProject(project, mediaAssets)
    });
  }));

  // 4. Real export: project JSON -> ffmpeg -> ffprobe-validated MP4
  router.post('/export', requireAuth, owned(async (build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const settings: ExportSettings = req.body?.preset
      ? settingsForPreset(project, String(req.body.preset), (req.body?.settings || {}) as Partial<ExportSettings>)
      : {
          ...defaultExportSettings(project),
          ...(req.body?.settings || {}),
          format: 'mp4',
          videoCodec: 'libx264',
          audioCodec: 'aac'
        };
    const outDir = path.join(process.cwd(), '.video_artifacts', build.id);
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4`);
    const journalDir = path.join(process.cwd(), '.video_projects', build.id);
    const result = await exportVideo(project, mediaAssets, settings, outputPath, { journalDir });
    return res.status(result.status === 'success' ? 200 : 422).json({
      success: result.status === 'success',
      result,
      project: serializeVideoProject(project, mediaAssets)
    });
  }));

  // 5. Phase 30: render capabilities (presets + probe-verified encoders)
  router.get('/render/capabilities', requireAuth, owned(async (_build, _req, res) => {
    return res.json({ success: true, capabilities: await renderCapabilities() });
  }));

  // 6. Phase 30: submit a background render job (202; poll the job).
  router.post('/export/jobs', requireAuth, owned(async (build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const settings: ExportSettings = req.body?.preset
      ? settingsForPreset(project, String(req.body.preset), (req.body?.settings || {}) as Partial<ExportSettings>)
      : {
          ...defaultExportSettings(project),
          ...(req.body?.settings || {}),
          format: 'mp4',
          videoCodec: 'libx264',
          audioCodec: 'aac'
        };
    const manager = jobsFor(build.id);
    await manager.load();
    const outDir = path.join(process.cwd(), '.video_artifacts', build.id);
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const outputPath = path.join(outDir, `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${stamp}.mp4`);
    const job = await manager.submit({ buildId: build.id, project, mediaAssets, settings, outputPath });
    return res.status(202).json({ success: true, job });
  }));

  // 7. Phase 30: list render jobs for this build.
  router.get('/export/jobs', requireAuth, owned(async (build, _req, res) => {
    const manager = jobsFor(build.id);
    await manager.load();
    return res.json({ success: true, jobs: manager.list(build.id) });
  }));

  // 8. Phase 30: one render job (progress / status polling).
  router.get('/export/jobs/:jobId', requireAuth, owned(async (build, req, res) => {
    const manager = jobsFor(build.id);
    await manager.load();
    const job = manager.get(req.params.jobId);
    if (!job || job.buildId !== build.id) return res.status(404).json({ error: 'render job not found' });
    return res.json({ success: true, job });
  }));

  // 9. Phase 30: cancel a queued or running render job.
  router.post('/export/jobs/:jobId/cancel', requireAuth, owned(async (build, req, res) => {
    const manager = jobsFor(build.id);
    await manager.load();
    const job = manager.get(req.params.jobId);
    if (!job || job.buildId !== build.id) return res.status(404).json({ error: 'render job not found' });
    const cancelled = manager.cancel(job.id);
    return res.json({ success: true, cancelled, job: manager.get(job.id) });
  }));

  // 10. Phase 30: retry a failed / cancelled / interrupted job.
  router.post('/export/jobs/:jobId/retry', requireAuth, owned(async (build, req, res) => {
    const manager = jobsFor(build.id);
    await manager.load();
    const job = manager.get(req.params.jobId);
    if (!job || job.buildId !== build.id) return res.status(404).json({ error: 'render job not found' });
    const retried = await manager.retry(job.id);
    return res.status(202).json({ success: true, job: retried });
  }));

  // 11. Phase 30: delete a finished job's output file (record kept).
  router.delete('/export/jobs/:jobId/output', requireAuth, owned(async (build, req, res) => {
    const manager = jobsFor(build.id);
    await manager.load();
    const job = manager.get(req.params.jobId);
    if (!job || job.buildId !== build.id) return res.status(404).json({ error: 'render job not found' });
    const updated = await manager.deleteOutput(job.id);
    return res.json({ success: true, job: updated });
  }));

  // 12. Phase 30: export history (finished jobs, newest first).
  router.get('/export/history', requireAuth, owned(async (build, _req, res) => {
    const manager = jobsFor(build.id);
    await manager.load();
    return res.json({ success: true, history: manager.history(build.id) });
  }));

  return router;
}
