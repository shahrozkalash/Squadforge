import express, { Router, Request, Response } from 'express';
import { db } from '../store.js';
import { Build } from '../types.js';
import { IosProjectGenerator } from './iosProjectGenerator.js';
import { generateVideoEditorProject, getVideoEditorConfig } from './videoEditorGenerator.js';
import { IosProjectValidator } from './iosProjectValidator.js';
import { IosBuildPipeline } from './iosBuildPipeline.js';
import { IosProjectConfig } from './types.js';

export interface IosRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

function configFromBody(body: any): IosProjectConfig {
  const defaults = IosProjectGenerator.getDefaultConfig(
    typeof body?.appName === 'string' ? body.appName : 'FitTrack',
    typeof body?.bundleId === 'string' ? body.bundleId : 'com.squadforge.fittrack'
  );
  const config: IosProjectConfig = {
    ...defaults,
    ...(body?.marketingVersion ? { marketingVersion: String(body.marketingVersion) } : {}),
    ...(body?.buildNumber ? { buildNumber: String(body.buildNumber) } : {}),
    ...(body?.deploymentTarget ? { deploymentTarget: String(body.deploymentTarget) } : {}),
    ...(body?.swiftVersion ? { swiftVersion: String(body.swiftVersion) } : {}),
    ...(body?.teamId ? { teamId: String(body.teamId) } : {}),
    ...(body?.accentColorHex ? { accentColorHex: String(body.accentColorHex) } : {}),
    ...(Array.isArray(body?.permissions) ? { permissions: body.permissions } : {}),
    ...(Array.isArray(body?.dependencies) ? { dependencies: body.dependencies } : {})
  };
  config.moduleName = IosProjectGenerator.sanitizeModuleName(config.appName);
  return config;
}

export function createIosRouter(deps: IosRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(400).json({ error: err.message || 'iOS operation failed' });
      }
    };

  // Generate a native iOS (Swift/SwiftUI) project into the build's files
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const config = configFromBody(req.body ?? {});
    const validation = IosProjectGenerator.validateConfig(config);
    if (!validation.valid) return res.status(400).json({ error: 'invalid iOS project config', validation });
    const files = IosProjectGenerator.generateProjectFiles(config);
    const projectValidation = IosProjectValidator.validateProjectFiles(files, config);
    if (!projectValidation.valid) {
      return res.status(500).json({ error: 'generated project failed structural validation', validation: projectValidation });
    }
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, { path: filePath, content, version: 1, ownerModel: req.user?.name || 'iOS Swarm' });
    }
    db.setFile(build.id, {
      path: '.squadforge/ios-config.json',
      content: JSON.stringify(config, null, 2),
      version: 1,
      ownerModel: 'iOS Swarm'
    });
    return res.json({ success: true, config, validation: projectValidation, fileCount: Object.keys(files).length, files: Object.keys(files) });
  }));

  // Phase 35: Generate the native iOS video editor (ClipForge)
  router.post('/video-editor/generate', requireAuth, owned(async (build, req, res) => {
    const config = getVideoEditorConfig(
      typeof req.body?.appName === 'string' ? req.body.appName : 'ClipForge',
      typeof req.body?.bundleId === 'string' ? req.body.bundleId : 'com.squadforge.clipforge'
    );
    const validation = IosProjectGenerator.validateConfig(config);
    if (!validation.valid) return res.status(400).json({ error: 'invalid iOS project config', validation });
    const files = generateVideoEditorProject(config);
    const projectValidation = IosProjectValidator.validateProjectFiles(files, config);
    if (!projectValidation.valid) {
      return res.status(500).json({ error: 'generated video editor project failed structural validation', validation: projectValidation });
    }
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, { path: filePath, content, version: 1, ownerModel: req.user?.name || 'iOS Swarm' });
    }
    db.setFile(build.id, {
      path: '.squadforge/ios-config.json',
      content: JSON.stringify(config, null, 2),
      version: 1,
      ownerModel: 'iOS Swarm'
    });
    return res.json({
      success: true,
      config,
      validation: projectValidation,
      fileCount: Object.keys(files).length,
      files: Object.keys(files),
      editor: 'clipforge'
    });
  }));

  router.get('/config', requireAuth, owned(async (build, _req, res) => {
    const stored = db.getFile(build.id, '.squadforge/ios-config.json');
    return res.json({
      config: stored ? JSON.parse(stored.content) : IosProjectGenerator.getDefaultConfig(),
      registryEntry: 'native_ios_swift',
      note: 'Signing certificates and provisioning profiles are never stored in SquadForge; Xcode manages them on the Mac.'
    });
  }));

  // Structural validation of the stored project (not a compilation)
  router.post('/validate', requireAuth, owned(async (build, req, res) => {
    const config = configFromBody(req.body ?? {});
    const files = db.getAllFiles(build.id);
    const map: Record<string, string> = {};
    for (const f of files) if (!f.path.startsWith('.squadforge/')) map[f.path] = f.content;
    if (!Object.keys(map).length) return res.status(400).json({ error: 'no iOS project generated for this build yet' });
    return res.json({ validation: IosProjectValidator.validateProjectFiles(map, config) });
  }));

  router.get('/environment', requireAuth, owned(async (_build, _req, res) =>
    res.json(await IosBuildPipeline.describeRuntimeSupport())
  ));

  // Genuine build — macOS/Xcode only; elsewhere honestly environment-unavailable
  router.post('/build', requireAuth, owned(async (build, req, res) => {
    const config = configFromBody(req.body ?? {});
    const files = db.getAllFiles(build.id);
    const map: Record<string, string> = {};
    for (const f of files) if (!f.path.startsWith('.squadforge/')) map[f.path] = f.content;
    if (!Object.keys(map).length) return res.status(400).json({ error: 'no iOS project generated for this build yet' });
    const result = await IosBuildPipeline.build(`ios_${build.id}_${Date.now()}`, config, map, {
      destination: req.body?.destination === 'generic' ? 'generic' : 'simulator',
      exportIpa: Boolean(req.body?.exportIpa)
    });
    return res.json({ result });
  }));

  return router;
}
