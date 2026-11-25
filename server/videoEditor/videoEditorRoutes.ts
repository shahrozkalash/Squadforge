import express, { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../store.js';
import { Build } from '../types.js';
import { VideoProjectGenerator } from './videoProjectGenerator.js';
import { deserializeVideoProject, serializeVideoProject } from './timeline.js';
import { applyEditOperation, type EditOperation } from './editingOps.js';
import { defaultExportSettings, exportVideo } from './videoExporter.js';
import { playbackInfo, renderPreviewFrame } from './playback.js';
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
      height: req.body?.height ? Number(req.body.height) : undefined
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

  // 4. Real export: project JSON -> ffmpeg -> ffprobe-validated MP4
  router.post('/export', requireAuth, owned(async (build, req, res) => {
    const data = req.body?.project as SerializedVideoProject;
    if (!data) return res.status(400).json({ error: 'project is required' });
    const { project, mediaAssets } = deserializeVideoProject(data);
    const settings: ExportSettings = {
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

  return router;
}
