import express, { Router, Request, Response } from 'express';
import { db } from '../store.js';
import { Build } from '../types.js';
import { Scene3dProjectGenerator } from './scene3dProjectGenerator.js';
import { deserializeScene, type SerializedScene } from './scene.js';
import { renderScene } from './renderer.js';
import { exportGltf, exportObj } from './exporters.js';
import { encodePng } from '../imageEditor/imageCodec.js';

export interface Scene3dRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createScene3dRouter(deps: Scene3dRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(500).json({ error: err.message || '3D operation failed' });
      }
    };

  // 1. Generate the 3D creation application source into the build's files
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const appName = (req.body?.appName as string) || 'ModelForge';
    const config = Scene3dProjectGenerator.getDefaultConfig(appName);
    const files = Scene3dProjectGenerator.generateProjectFiles(config);
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, {
        path: filePath,
        content,
        version: 1,
        ownerModel: req.user?.name || '3D Swarm'
      });
    }
    return res.json({ success: true, config, fileCount: Object.keys(files).length, files: Object.keys(files) });
  }));

  // 2. Render a scene server-side with the software renderer -> real PNG
  router.post('/render', requireAuth, owned(async (_build, req, res) => {
    const data = req.body?.scene as SerializedScene;
    if (!data) return res.status(400).json({ error: 'scene is required' });
    const scene = deserializeScene(data);
    const width = Math.min(1024, Math.max(16, Number(req.body?.width) || 320));
    const height = Math.min(1024, Math.max(16, Number(req.body?.height) || 240));
    const img = renderScene(scene, { width, height, background: { r: 24, g: 24, b: 32 } });
    const png = encodePng(img);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="render.png"');
    return res.send(png);
  }));

  // 3. Export a scene as glTF 2.0 or OBJ/MTL
  router.post('/export', requireAuth, owned(async (_build, req, res) => {
    const data = req.body?.scene as SerializedScene;
    if (!data) return res.status(400).json({ error: 'scene is required' });
    const scene = deserializeScene(data);
    if (req.body?.format === 'obj') {
      const { obj, mtl } = exportObj(scene);
      return res.json({ success: true, obj, mtl });
    }
    return res.json({ success: true, gltf: exportGltf(scene) });
  }));

  return router;
}
