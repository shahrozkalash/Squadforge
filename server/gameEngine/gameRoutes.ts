import express, { Router, Request, Response } from 'express';
import { db } from '../store.js';
import { Build } from '../types.js';
import { GameProjectGenerator } from './gameProjectGenerator.js';
import { createDemoWorld, stepWorld, type InputState } from './engine2d.js';
import { profileSimulation } from './profiler.js';
import { GameServer } from './multiplayer.js';

export interface GameRouteDependencies {
  requireAuth: express.RequestHandler;
  verifyBuildOwnership: (req: express.Request, res: express.Response, buildId: string) => Build | null | undefined;
}

// One multiplayer server per build (started/stopped explicitly).
const servers = new Map<string, GameServer>();

export function createGameRouter(deps: GameRouteDependencies): Router {
  const { requireAuth, verifyBuildOwnership } = deps;
  const router = Router({ mergeParams: true });

  const owned = (action: (build: Build, req: Request, res: Response) => Promise<unknown> | unknown) =>
    async (req: Request, res: Response) => {
      const build = verifyBuildOwnership(req, res, req.params.id);
      if (!build) return;
      try {
        await action(build, req, res);
      } catch (err: any) {
        res.status(400).json({ error: err.message || 'Game operation failed' });
      }
    };

  // Generate a game project into the build's files (html5 | winforms3d)
  router.post('/generate', requireAuth, owned(async (build, req, res) => {
    const kind = String(req.body?.kind ?? 'html5');
    const appName = String(req.body?.appName ?? (kind === 'html5' ? 'Coin Quest' : 'CubeQuest'));
    const files =
      kind === 'winforms3d'
        ? GameProjectGenerator.generateWinForms3dGame(GameProjectGenerator.getDefaultConfig(appName))
        : GameProjectGenerator.generateHtml5Game(appName);
    for (const [filePath, content] of Object.entries(files)) {
      db.setFile(build.id, { path: filePath, content, version: 1, ownerModel: req.user?.name || 'Game Swarm' });
    }
    return res.json({ success: true, kind, fileCount: Object.keys(files).length, files: Object.keys(files) });
  }));

  // Headless simulation of the demo world with a scripted input (testing/debugging aid)
  router.post('/simulate', requireAuth, owned(async (_build, req, res) => {
    const world = createDemoWorld();
    const input: InputState = {
      left: Boolean(req.body?.input?.left),
      right: Boolean(req.body?.input?.right),
      jump: Boolean(req.body?.input?.jump)
    };
    const steps = Math.min(3600, Math.max(1, Number(req.body?.steps) || 120));
    for (let i = 0; i < steps; i++) stepWorld(world, input);
    const player = world.entities[0];
    return res.json({
      steps,
      state: world.state,
      score: world.score,
      coins: world.coinsCollected,
      player: { x: Math.round(player.x), y: Math.round(player.y), grounded: player.grounded }
    });
  }));

  router.get('/profile', requireAuth, owned(async (_build, _req, res) =>
    res.json({ profile: profileSimulation(1800) })
  ));

  router.post('/multiplayer/start', requireAuth, owned(async (build, _req, res) => {
    if (servers.has(build.id)) {
      const existing = servers.get(build.id)!;
      return res.json({ success: true, port: existing.port, stats: existing.stats(), alreadyRunning: true });
    }
    const server = new GameServer();
    const port = await server.start(0);
    servers.set(build.id, server);
    return res.json({ success: true, port, stats: server.stats() });
  }));

  router.post('/multiplayer/stop', requireAuth, owned(async (build, _req, res) => {
    const server = servers.get(build.id);
    if (server) {
      await server.stop();
      servers.delete(build.id);
    }
    return res.json({ success: true });
  }));

  router.get('/multiplayer/status', requireAuth, owned(async (build, _req, res) => {
    const server = servers.get(build.id);
    return res.json({ running: !!server, stats: server?.stats() ?? null, port: server?.port ?? null });
  }));

  return router;
}
