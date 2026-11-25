import express, { Router, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../store.js';
import { Build } from '../types.js';
import type { DesktopBuildOptions, DesktopProjectConfig } from './types.js';
import { DesktopProjectGenerator } from './desktopProjectGenerator.js';
import { DesktopBuildPipeline } from './desktopBuildPipeline.js';
import { PeInspector } from './peInspector.js';
import {
  assertScopedArtifactPath,
  validateArtifactScope,
  validateArtifactFilename,
  validateBuildId
} from '../pathSecurity.js';

export { validateArtifactFilename, validateBuildId };

const ARTIFACTS_BASE_DIR = path.resolve(process.cwd(), '.desktop_artifacts');
const artifactBufferCache: Map<string, Map<string, Buffer>> = new Map();

export function storeDesktopArtifactBuffer(buildId: string, filename: string, buffer: Buffer) {
  if (!validateBuildId(buildId) || !validateArtifactFilename(filename)) {
    throw new Error(`Security Violation: Invalid buildId or filename for artifact storage: ${filename}`);
  }
  let buildMap = artifactBufferCache.get(buildId);
  if (!buildMap) {
    buildMap = new Map();
    artifactBufferCache.set(buildId, buildMap);
  }
  buildMap.set(filename, buffer);
  try {
    const fullPath = assertScopedArtifactPath(ARTIFACTS_BASE_DIR, buildId, filename);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, buffer);
  } catch (err: any) {
    console.warn(`[Desktop] Failed to write artifact to disk: ${err?.message || err}`);
  }
}

export function getDesktopArtifactBuffer(buildId: string, filename: string): Buffer | undefined {
  if (!validateBuildId(buildId) || !validateArtifactFilename(filename)) return undefined;
  const inMemory = artifactBufferCache.get(buildId)?.get(filename);
  if (inMemory) return inMemory;
  try {
    const scopeCheck = validateArtifactScope(ARTIFACTS_BASE_DIR, buildId, filename);
    if (!scopeCheck.valid || !scopeCheck.resolvedPath) return undefined;
    if (fs.existsSync(scopeCheck.resolvedPath)) {
      const buf = fs.readFileSync(scopeCheck.resolvedPath);
      let buildMap = artifactBufferCache.get(buildId);
      if (!buildMap) {
        buildMap = new Map();
        artifactBufferCache.set(buildId, buildMap);
      }
      buildMap.set(filename, buf);
      return buf;
    }
  } catch {
    // ignore
  }
  return undefined;
}

export interface DesktopRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createDesktopRouter(deps: DesktopRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });

  function getProjectFilesRecord(buildId: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const f of db.getAllFiles(buildId)) {
      if (!f.isDeleted) result[f.path] = f.content;
    }
    return result;
  }

  function getOrCreateConfig(build: Build): DesktopProjectConfig {
    if ((build as any).desktopConfig) return (build as any).desktopConfig;
    const cleanName =
      (build.idea || 'SquadForge')
        .split(' ')
        .slice(0, 3)
        .join('')
        .replace(/[^a-zA-Z0-9]/g, '') || 'SquadForgeApp';
    const config = DesktopProjectGenerator.getDefaultConfig(cleanName);
    (build as any).desktopConfig = config;
    db.saveBuild(build);
    return config;
  }

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(500).json({ error: err.message || 'Desktop operation failed' });
      }
    };

  // 1. Generate / scaffold a Windows desktop project
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const { appName, assemblyName, version, company, requireAdministrator } = req.body || {};
    const base = getOrCreateConfig(build);
    const config: DesktopProjectConfig = {
      ...base,
      appName: appName || base.appName,
      assemblyName: assemblyName || base.assemblyName,
      version: version || base.version,
      company: company || base.company,
      requireAdministrator: requireAdministrator ?? base.requireAdministrator
    };
    const errors = DesktopProjectGenerator.validateConfig(config);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });

    const files = DesktopProjectGenerator.generateProjectFiles(config);
    (build as any).desktopConfig = config;
    db.saveBuild(build);
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, {
        path: filePath,
        content,
        version: 1,
        ownerModel: req.user?.name || 'Desktop Swarm'
      });
    }
    return res.json({
      success: true,
      config,
      fileCount: Object.keys(files).length,
      files: Object.keys(files)
    });
  }));

  // 2. Toolchain status (honest detection, nothing assumed)
  router.get('/status', requireAuth, owned(async (_build, _req, res) => {
    const dotnet = DesktopProjectGenerator.detectDotnet();
    return res.json({
      success: true,
      platform: 'windows',
      dotnetFound: Boolean(dotnet),
      dotnetPath: dotnet,
      sdks: dotnet ? DesktopProjectGenerator.listSdks(dotnet) : [],
      buildSupported: Boolean(dotnet)
    });
  }));

  // 3. Genuine build: restore + compile + PE-verified artifact harvest
  router.post('/build', requireAuth, owned(async (build, req, res) => {
    const configuration = req.body?.configuration === 'Release' ? 'Release' : 'Debug';
    const options: DesktopBuildOptions = { configuration, restore: req.body?.restore !== false };
    const config = getOrCreateConfig(build);
    let files = getProjectFilesRecord(build.id);
    if (!files[`src/${config.assemblyName}/${config.assemblyName}.csproj`]) {
      files = DesktopProjectGenerator.generateProjectFiles(config);
      for (const [filePath, content] of Object.entries(files)) {
        db.setFile(build.id, { path: filePath, content, version: 1, ownerModel: 'Desktop Swarm' });
      }
    }
    const pipeline = new DesktopBuildPipeline();
    const result = await pipeline.build(build.id, config, files, options);
    if (result.status === 'success') {
      for (const artifact of result.artifacts) {
        const buf = fs.readFileSync(path.join(ARTIFACTS_BASE_DIR, build.id, artifact.filename));
        storeDesktopArtifactBuffer(build.id, artifact.filename, buf);
      }
    }
    return res.status(result.status === 'success' ? 200 : 422).json({ success: result.status === 'success', result });
  }));

  // 4. Download a verified artifact (auth + ownership enforced by `owned`)
  router.get('/artifacts/:filename', requireAuth, owned(async (build, req, res) => {
    const filename = req.params.filename;
    if (!validateArtifactFilename(filename)) {
      return res.status(400).json({ error: 'Invalid artifact filename' });
    }
    const buf = getDesktopArtifactBuffer(build.id, filename);
    if (!buf) return res.status(404).json({ error: 'Artifact not found' });
    if (filename.toLowerCase().endsWith('.exe')) {
      const pe = PeInspector.inspect(buf);
      if (!pe.isPeFile) return res.status(422).json({ error: 'Stored artifact failed PE validation' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buf);
  }));

  return router;
}
