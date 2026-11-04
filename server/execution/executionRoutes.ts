import express from 'express';
import { db } from '../store.js';
import { Build } from '../types.js';
import { planDependencies } from './dependencyService.js';
import { ExecutionError, ExecutionSessionManager } from './executionSessionManager.js';
import { PreviewSessionService } from './previewSessionService.js';

type VerifyOwnership = (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;

interface RouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: VerifyOwnership;
  manager: ExecutionSessionManager;
  previews: PreviewSessionService;
}

export function createExecutionRouter(deps: RouteDependencies): express.Router {
  const { requireAuth, verifyBuildOwnership, manager, previews } = deps;
  const router = express.Router({ mergeParams: true });

  /** Every route runs its action only after the build ownership check. */
  const owned = (action: (build: Build, req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
    async (req: express.Request, res: express.Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        const result = await action(build, req, res);
        if (!res.headersSent) res.json(result);
      } catch (err: any) {
        const status = err instanceof ExecutionError ? err.status : 500;
        if (!res.headersSent) res.status(status).json({ error: err.message || 'Execution request failed' });
      }
    };

  const requireOwnSession = (build: Build, sessionId: string) => {
    const session = db.getExecutionSession(sessionId);
    if (!session || session.buildId !== build.id) throw new ExecutionError('Execution session not found', 404);
    return session;
  };

  router.use(requireAuth);

  router.get('/capabilities', owned(async build => ({
    capabilities: await manager.capabilities(),
    previewsEnabled: Boolean(previews.config.baseDomain),
    project: planDependencies(db.getAllFiles(build.id))
  })));

  router.get('/sessions', owned(build => ({ sessions: db.getExecutionSessions(build.id) })));

  router.post('/sessions', owned((build, req) => {
    return manager.createSession(build, req.user!);
  }));

  router.get('/sessions/:sessionId', owned((build, req) => ({
    session: requireOwnSession(build, req.params.sessionId),
    installs: db.getDependencyInstalls(req.params.sessionId),
    previews: db.getActivePreviews(req.params.sessionId).map(({ tokenHash, cookieHash, ...preview }) => preview)
  })));

  router.get('/sessions/:sessionId/logs', owned((build, req) => {
    requireOwnSession(build, req.params.sessionId);
    const after = Number(req.query.after) || 0;
    return { logs: db.getExecutionLogs(req.params.sessionId, after) };
  }));

  router.get('/sessions/:sessionId/usage', owned(async (build, req) => ({
    usage: await manager.usage(build, req.params.sessionId)
  })));

  router.post('/sessions/:sessionId/dependencies', owned((build, req) => {
    return manager.installDependencies(build, req.params.sessionId, {
      allowScripts: req.body?.allowScripts === true
    });
  }));

  router.post('/sessions/:sessionId/start', owned((build, req) => {
    const { script } = req.body || {};
    if (typeof script !== 'string') throw new ExecutionError('script is required');
    return manager.startScript(build, req.params.sessionId, script);
  }));

  router.post('/sessions/:sessionId/stop', owned((build, req) => manager.stop(build, req.params.sessionId)));
  router.post('/sessions/:sessionId/restart', owned((build, req) => manager.restart(build, req.params.sessionId)));
  router.delete('/sessions/:sessionId', owned((build, req) => manager.destroySession(build.id, req.params.sessionId)));

  router.post('/sessions/:sessionId/preview', owned(async (build, req) => {
    const { preview, url } = await previews.open(build, req.params.sessionId);
    return { previewId: preview.id, port: preview.port, url };
  }));

  router.post('/previews/:previewId/link', owned((build, req) => ({
    url: previews.refreshToken(build, req.params.previewId)
  })));

  router.delete('/previews/:previewId', owned(async (build, req) => {
    await previews.close(build, req.params.previewId);
    return { success: true };
  }));

  return router;
}
