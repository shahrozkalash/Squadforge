import express, { Router, Request, Response } from 'express';
import * as path from 'path';
import { Build } from '../types.js';
import { validateBuildId } from '../pathSecurity.js';
import { TerminalService } from '../ide/terminalService.js';
import { GitService } from '../ide/gitService.js';
import { ReleasePackager, type ReleaseMetadata } from './packager.js';
import { ReleaseStore } from './releaseStore.js';
import { validatePackage } from './packageValidator.js';
import { findCsprojSafe } from './routeHelpers.js';

export interface ReleaseRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

export function createReleaseRouter(deps: ReleaseRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });
  const packager = new ReleasePackager();

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(400).json({ error: err.message || 'Release operation failed' });
      }
    };

  const storeFor = (buildId: string): ReleaseStore => {
    if (!validateBuildId(buildId)) throw new Error('Invalid build id');
    return new ReleaseStore(path.join(process.cwd(), '.release_store', buildId));
  };

  const projectWorkspace = (buildId: string): string => {
    if (!validateBuildId(buildId)) throw new Error('Invalid build id');
    return path.join(process.cwd(), '.ide_workspaces', buildId);
  };

  // Publish + package a release from the build's IDE workspace project
  router.post('/publish', requireAuth, owned(async (build, req, res) => {
    const workspace = projectWorkspace(build.id);
    const metadata: ReleaseMetadata = {
      appName: String(req.body?.appName ?? ''),
      version: String(req.body?.version ?? ''),
      publisher: String(req.body?.publisher ?? 'SquadForge'),
      description: String(req.body?.description ?? ''),
      channel: String(req.body?.channel ?? 'stable'),
      selfContained: Boolean(req.body?.selfContained),
      releaseNotes: String(req.body?.releaseNotes ?? ''),
      signingCertPath: req.body?.signingCertPath ? String(req.body.signingCertPath) : undefined,
      signingCertPassword: req.body?.signingCertPassword ? String(req.body.signingCertPassword) : undefined
    };
    if (!metadata.appName || !metadata.version) {
      return res.status(400).json({ error: 'appName and version are required' });
    }
    // Stamp the version into the project so binary, package and manifest agree
    findCsprojSafe(workspace, metadata.version);
    // Release notes: caller's text, else real git history of the workspace
    if (!metadata.releaseNotes) {
      try {
        const git = new GitService(new TerminalService(workspace));
        if (await git.isRepository()) {
          const log = await git.log(10);
          metadata.releaseNotes = log.map((c) => `- ${c.subject}`).join('\n') || 'Initial release.';
        } else {
          metadata.releaseNotes = 'Release packaged by SquadForge.';
        }
      } catch {
        metadata.releaseNotes = 'Release packaged by SquadForge.';
      }
    }
    const { publishDir, buildLog } = await packager.publishProject(workspace, metadata);
    const packagePath = path.join(workspace, '.release_out', `${metadata.appName}-${metadata.version}.zip`);
    const result = await packager.packageRelease(publishDir, metadata, buildLog, packagePath);
    const stored = storeFor(build.id).publish(result);
    const validation = await validatePackage(path.join(stored.dir, 'package.zip'));
    return res.json({ success: true, manifest: result.manifest, package: { sha256: result.packageSha256, sizeBytes: result.packageSizeBytes }, validation });
  }));

  router.get('/releases', requireAuth, owned(async (build, req, res) => {
    const store = storeFor(build.id);
    const appName = String(req.query.app ?? '');
    return res.json({ versions: store.listVersions(appName), channels: { stable: store.channelVersion(appName, 'stable'), beta: store.channelVersion(appName, 'beta') } });
  }));

  router.get('/feed', requireAuth, owned(async (build, req, res) => {
    const store = storeFor(build.id);
    const feed = store.feed(String(req.query.app ?? ''), String(req.query.channel ?? 'stable'));
    if (!feed) return res.status(404).json({ error: 'No release on that channel' });
    return res.json({ feed });
  }));

  router.post('/rollback', requireAuth, owned(async (build, req, res) => {
    const store = storeFor(build.id);
    const rolled = store.rollback(String(req.body?.appName ?? ''), String(req.body?.channel ?? 'stable'));
    return res.json({ success: true, nowServing: rolled.version });
  }));

  router.post('/validate', requireAuth, owned(async (build, req, res) => {
    const store = storeFor(build.id);
    const release = store.getRelease(String(req.body?.appName ?? ''), String(req.body?.version ?? ''));
    if (!release) return res.status(404).json({ error: 'Release not found in the store' });
    return res.json({ validation: await validatePackage(path.join(release.dir, 'package.zip')) });
  }));

  // Download a stored package (build logs and artifacts are preserved in the store)
  router.get('/download', requireAuth, owned(async (build, req, res) => {
    const store = storeFor(build.id);
    const release = store.getRelease(String(req.query.app ?? ''), String(req.query.version ?? ''));
    if (!release) return res.status(404).json({ error: 'Release not found in the store' });
    return res.download(path.join(release.dir, 'package.zip'), `${release.manifest.appName}-${release.version}.zip`);
  }));

  return router;
}
