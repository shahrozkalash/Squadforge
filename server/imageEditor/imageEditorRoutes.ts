import express, { Router, Request, Response } from 'express';
import { db } from '../store.js';
import { Build } from '../types.js';
import { ImageProjectGenerator } from './imageProjectGenerator.js';
import { composite, deserializeProject } from './imageCore.js';
import { exportImage } from './imageCodec.js';
import type { SerializedProject } from './types.js';

export interface ImageEditorRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createImageEditorRouter(deps: ImageEditorRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Image editor operation failed' });
      }
    };

  // 1. Generate the image-editing application source into the build's files
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const appName = (req.body?.appName as string) || 'PixelForge';
    const config = ImageProjectGenerator.getDefaultConfig(appName);
    const files = ImageProjectGenerator.generateProjectFiles(config);
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, {
        path: filePath,
        content,
        version: 1,
        ownerModel: req.user?.name || 'Image Editor Swarm'
      });
    }
    return res.json({ success: true, config, fileCount: Object.keys(files).length, files: Object.keys(files) });
  }));

  // 2. Flatten a project (real compositing) and export it as PNG or BMP
  router.post('/export', requireAuth, owned(async (_build, req, res) => {
    const format = req.body?.format === 'bmp' ? 'bmp' : 'png';
    const projectData = req.body?.project as SerializedProject;
    if (!projectData) return res.status(400).json({ error: 'project is required' });
    const project = deserializeProject(projectData);
    const flat = composite(project);
    const buf = exportImage(flat, format);
    res.setHeader('Content-Type', format === 'png' ? 'image/png' : 'image/bmp');
    res.setHeader('Content-Disposition', `attachment; filename="export.${format}"`);
    return res.send(buf);
  }));

  return router;
}
