import express, { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../store.js';
import { Build } from '../types.js';
import { VideoProjectGenerator } from './videoProjectGenerator.js';
import { deserializeVideoProject, serializeVideoProject } from './timeline.js';
import { defaultExportSettings, exportVideo } from './videoExporter.js';
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
