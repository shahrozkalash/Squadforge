import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { db } from './server/store.js';
import { modelRegistry } from './server/modelRegistry.js';
import { SwarmOrchestrator } from './server/swarm/swarmOrchestrator.js';
import { GitHubService } from './server/github.js';
import { ConcurrencyTester } from './server/swarm/conflictTest.js';
import { MergeManager } from './server/swarm/mergeManager.js';
import { TaskManager } from './server/swarm/taskManager.js';
import { SandboxRunner } from './server/swarm/sandboxRunner.js';

dotenv.config();

const app = express();
const PORT = 3000;
const APP_URL = process.env.APP_URL || 'https://ais-dev-fwrtdp4bsqhlus5qd4v3d3-856192480482.asia-southeast1.run.app';

app.use(express.json({ limit: '10mb' }));

// --- API ROUTES ---

// 1. Model Registry
app.get('/api/models', (req, res) => {
  res.json({ models: modelRegistry.getAll() });
});

app.post('/api/models', (req, res) => {
  const config = req.body;
  if (!config.id || !config.displayName || !config.providerModel) {
    return res.status(400).json({ error: 'id, displayName, and providerModel are required' });
  }
  modelRegistry.registerModel({
    ...config,
    strengths: config.strengths || ['backend'],
    maxTokens: config.maxTokens || 4096,
    enabled: config.enabled ?? true,
    avatarColor: config.avatarColor || 'bg-neutral-800 text-neutral-300 border-neutral-700',
    badge: config.badge || config.id.slice(0, 4).toUpperCase(),
    description: config.description || 'Custom registered model'
  });
  res.json({ success: true, models: modelRegistry.getAll() });
});

app.put('/api/models/:id', (req, res) => {
  const updated = modelRegistry.updateModel(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Model not found' });
  res.json({ success: true, model: updated });
});

// 2. Authentication & User Profile
app.get('/api/auth/me', (req, res) => {
  const defaultUser = db.getUser('usr_default_admin');
  res.json({ user: defaultUser });
});

app.post('/api/auth/login', (req, res) => {
  const { email, name } = req.body;
  const user = db.getUser('usr_default_admin')!;
  if (email) user.email = email;
  if (name) user.name = name;
  db.saveUser(user);
  res.json({ success: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true });
});

// 3. GitHub OAuth & Connection
app.get('/api/auth/github/url', (req, res) => {
  const redirectOrigin = (req.headers.origin as string) || APP_URL;
  const url = GitHubService.getAuthUrl(redirectOrigin);
  res.json({ url });
});

// OAuth Callback handling popup postMessage per OAuth skill
const handleOAuthCallback = async (req: express.Request, res: express.Response) => {
  const code = req.query.code as string;
  const origin = APP_URL;
  const redirectUri = `${origin}/auth/callback`;

  if (code) {
    const exchange = await GitHubService.exchangeCodeForToken(code, redirectUri);
    if (exchange) {
      db.setGithubToken('usr_default_admin', exchange.token, exchange.username);
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Connecting GitHub...</title>
      </head>
      <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center; padding: 24px; background: #1e293b; border-radius: 12px; border: 1px solid #334155;">
          <h2 style="margin: 0 0 12px; color: #38bdf8;">GitHub Connected</h2>
          <p style="margin: 0 0 16px; color: #94a3b8;">Authentication successful. Closing this window...</p>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
            setTimeout(() => window.close(), 600);
          } else {
            window.location.href = '/';
          }
        </script>
      </body>
    </html>
  `);
};

app.get('/auth/callback', handleOAuthCallback);
app.get('/auth/callback/', handleOAuthCallback);

app.post('/api/auth/github/connect-pat', async (req, res) => {
  const { token, username } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const validUsername = await GitHubService.validateToken(token);
  if (!validUsername && !token.startsWith('ghp_demo')) {
    return res.status(400).json({ error: 'Invalid GitHub token or insufficient scopes (repo required)' });
  }

  const finalUsername = username || validUsername || 'squadforge-dev';
  db.setGithubToken('usr_default_admin', token, finalUsername);
  res.json({ success: true, username: finalUsername });
});

app.post('/api/auth/github/disconnect', (req, res) => {
  db.disconnectGithub('usr_default_admin');
  res.json({ success: true });
});

app.put('/api/user/settings', (req, res) => {
  const user = db.getUser('usr_default_admin');
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { costLimitPerBuild, defaultRepo, enabledModelIds } = req.body;
  if (costLimitPerBuild !== undefined) user.costLimitPerBuild = costLimitPerBuild;
  if (defaultRepo !== undefined) user.defaultRepo = defaultRepo;
  if (enabledModelIds !== undefined) user.enabledModelIds = enabledModelIds;
  db.saveUser(user);
  res.json({ success: true, user });
});

// 4. Builds & Swarm Operations
app.get('/api/builds', (req, res) => {
  const builds = db.getAllBuilds('usr_default_admin');
  res.json({ builds });
});

app.post('/api/builds', async (req, res) => {
  const { idea, selectedModels, autoPushGithub, costLimit, maxDurationSeconds } = req.body;
  if (!idea || !idea.trim()) {
    return res.status(400).json({ error: 'Idea is required' });
  }

  const buildId = `bld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const user = db.getUser('usr_default_admin')!;

  const modelsToUse = Array.isArray(selectedModels) && selectedModels.length > 0 
    ? selectedModels 
    : user.enabledModelIds;

  const newBuild = db.saveBuild({
    id: buildId,
    userId: user.id,
    idea: idea.trim(),
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: modelsToUse,
    autoPushGithub: autoPushGithub ?? true,
    totalTokens: 0,
    totalCost: 0,
    costLimit: costLimit || user.costLimitPerBuild || 5.0,
    maxDurationSeconds: maxDurationSeconds || 300,
    patchesAppliedCount: 0
  });

  // Launch swarm in background without blocking initial HTTP response
  setImmediate(() => {
    SwarmOrchestrator.startSwarm(buildId).catch(err => {
      console.error(`Swarm run error for ${buildId}:`, err);
    });
  });

  res.json({ success: true, build: newBuild });
});

app.get('/api/builds/:id', (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  const tasks = db.getTasks(build.id);
  const files = db.getAllFiles(build.id);
  const events = db.getEvents(build.id);
  const modelRuns = db.getAllModelRuns(build.id);
  const checkpoints = db.getCheckpoints(build.id);

  res.json({
    build,
    tasks,
    files,
    events,
    modelRuns,
    checkpoints
  });
});

app.post('/api/builds/:id/stop', (req, res) => {
  SwarmOrchestrator.stopSwarm(req.params.id);
  res.json({ success: true });
});

app.post('/api/builds/:id/push-github', async (req, res) => {
  const result = await GitHubService.autoPushProject(req.params.id, 'usr_default_admin');
  res.json(result);
});

app.post('/api/builds/:id/rollback-checkpoint', async (req, res) => {
  const { checkpointId } = req.body;
  if (!checkpointId) return res.status(400).json({ error: 'checkpointId is required' });
  const success = await MergeManager.revertToCheckpoint(req.params.id, checkpointId);
  res.json({ success });
});

app.post('/api/builds/:id/rollback-file', async (req, res) => {
  const { filePath, version } = req.body;
  if (!filePath || version === undefined) {
    return res.status(400).json({ error: 'filePath and version are required' });
  }
  const success = await MergeManager.revertFileVersion(req.params.id, filePath, version);
  res.json({ success });
});

app.post('/api/builds/:id/retry-failed', (req, res) => {
  const buildId = req.params.id;
  const tasks = db.getTasks(buildId);
  for (const t of tasks) {
    if (t.status === 'failed') {
      db.updateTask(buildId, t.id, {
        status: 'open',
        claimedBy: null,
        leaseExpiresAt: null,
        error: undefined
      });
    }
  }
  res.json({ success: true });
});

// 5. Real-Time Server-Sent Events (SSE) Stream
app.get('/api/builds/:id/stream', (req, res) => {
  const buildId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const listenerId = `sse_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  db.addSSEListener(listenerId, res, buildId);

  // Send initial ping
  res.write(`event: ping\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  req.on('close', () => {
    db.removeSSEListener(listenerId);
  });
});

// 6. Concurrency Benchmark Test endpoint
app.post('/api/test-concurrency', async (req, res) => {
  try {
    const report = await ConcurrencyTester.run10ModelConcurrencyTest();
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Concurrency test failure' });
  }
});

// Mount Vite in dev mode
async function startServer() {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SquadForge Full-Stack Server running on port ${PORT}`);
  });
}

startServer();
