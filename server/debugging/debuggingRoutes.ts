import express from 'express';
import { db } from '../store.js';
import { Build, RepairRun } from '../types.js';
import { requireSameOrigin } from '../execution/executionRoutes.js';
import { ExecutionError } from '../execution/executionSessionManager.js';
import { ProjectMemoryService } from '../swarm/projectMemory.js';
import { DiagnosticCollector, ReportedProblem } from './diagnosticCollector.js';
import { RepairCoordinator, RepairError } from './repairCoordinator.js';
import { RootCauseEngine } from './rootCauseEngine.js';

const MAX_REPORTS = 10;
const MAX_REPORT_LENGTH = 2000;

type VerifyOwnership = (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;

interface RouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: VerifyOwnership;
  coordinator: RepairCoordinator;
}

/** Keeps stored file contents out of responses. */
function publicRun(run: RepairRun): RepairRun {
  return { ...run, fileChanges: run.fileChanges.map(({ beforeContent, ...change }) => change) };
}

/** A report is a claim from the client, so only its shape is accepted. */
function parseReports(value: unknown): ReportedProblem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REPORTS) {
    throw new RepairError(`reports must be a list of at most ${MAX_REPORTS} items`);
  }
  return value.map(item => {
    if ((item?.kind !== 'runtime' && item?.kind !== 'api') || typeof item.message !== 'string' || !item.message.trim()) {
      throw new RepairError('Each report needs a kind of "runtime" or "api", and a message');
    }
    return {
      kind: item.kind,
      message: item.message.slice(0, MAX_REPORT_LENGTH),
      filePath: typeof item.filePath === 'string' ? item.filePath : undefined,
      line: Number.isInteger(item.line) ? item.line : undefined,
      stack: typeof item.stack === 'string' ? item.stack.slice(0, MAX_REPORT_LENGTH) : undefined
    };
  });
}

export function createDebuggingRouter(deps: RouteDependencies): express.Router {
  const { requireAuth, verifyBuildOwnership, coordinator } = deps;
  const router = express.Router({ mergeParams: true });

  /** Every route runs its action only after the build ownership check. */
  const owned = (action: (build: Build, req: express.Request) => Promise<unknown> | unknown) =>
    async (req: express.Request, res: express.Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        res.json(await action(build, req));
      } catch (err: any) {
        const status = err instanceof RepairError || err instanceof ExecutionError ? err.status : 500;
        res.status(status).json({ error: err.message || 'Debugging request failed' });
      }
    };

  router.use(requireSameOrigin);
  router.use(requireAuth);

  router.post('/analyze', owned(async (build, req) => {
    const { probeSessionId } = req.body || {};
    const probes = typeof probeSessionId === 'string' ? await coordinator.probe(build, probeSessionId) : [];
    const report = await DiagnosticCollector.collect(build.id, parseReports(req.body?.reports), { probes });
    const lessons = ProjectMemoryService.getRepairLessons(build.id, req.user!.id);
    return {
      report,
      rootCauses: RootCauseEngine.analyze(db.getAllFiles(build.id), report.diagnostics, lessons)
    };
  }));

  router.get('/repairs', owned(build => ({ repairs: coordinator.list(build).map(publicRun) })));

  router.post('/repairs', owned((build, req) => {
    const { rootCauseId, modelId, maxAttempts, reports, repairAll, probeSessionId } = req.body || {};
    const run = coordinator.start(build, req.user!, {
      rootCauseId: typeof rootCauseId === 'string' ? rootCauseId : undefined,
      modelId: typeof modelId === 'string' ? modelId : undefined,
      maxAttempts: typeof maxAttempts === 'number' ? maxAttempts : undefined,
      reports: parseReports(reports),
      repairAll: repairAll === true,
      probeSessionId: typeof probeSessionId === 'string' ? probeSessionId : undefined
    });
    return { repair: publicRun(run) };
  }));

  router.get('/repairs/:repairId', owned((build, req) => ({
    repair: publicRun(coordinator.get(build, req.params.repairId))
  })));

  router.post('/repairs/:repairId/cancel', owned(async (build, req) => ({
    repair: publicRun(await coordinator.cancel(build, req.params.repairId))
  })));

  router.post('/repairs/:repairId/rollback', owned(async (build, req) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    return { repair: publicRun(await coordinator.rollback(build, req.params.repairId, reason)) };
  }));

  router.post('/repairs/:repairId/verify', owned((build, req) => ({
    repair: publicRun(coordinator.verifyAgain(build, req.user!, req.params.repairId))
  })));

  router.get('/lessons', owned((build, req) => ({
    lessons: ProjectMemoryService.getRepairLessons(build.id, req.user!.id)
  })));

  return router;
}
