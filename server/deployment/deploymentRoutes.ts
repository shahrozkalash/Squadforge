/**
 * SquadForge Phase 15: Deployment API Routes
 * Express router handling deployment operations, authorization, secrets, artifacts, and live previews.
 */

import express, { Router, Request, Response } from 'express';
import { db } from '../store.js';
import { DeploymentService } from './deploymentService.js';
import { PreDeploymentValidator } from './preDeploymentValidator.js';
import { DeploymentSecretManager } from './secretManager.js';
import { ProductionBuilder } from './productionBuilder.js';
import { staticHostRegistry } from './adapters/staticHostAdapter.js';

export function createDeploymentRouter(requireAuth: express.RequestHandler): Router {
  const router = Router();

  // Helper to ensure authenticated user owns the build
  const verifyBuildOwnership = (req: Request, res: Response, buildId: string): boolean => {
    const build = db.getBuild(buildId);
    if (!build) {
      res.status(404).json({ error: 'Project build not found' });
      return false;
    }
    if (build.userId !== req.user?.id) {
      res.status(403).json({ error: 'Forbidden: You do not own this project' });
      return false;
    }
    return true;
  };

  // Helper to ensure authenticated user owns the deployment
  const verifyDeploymentOwnership = (req: Request, res: Response, deploymentId: string) => {
    const deployment = db.getDeployment(deploymentId);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return null;
    }
    if (deployment.userId !== req.user?.id) {
      res.status(403).json({ error: 'Forbidden: You do not own this deployment' });
      return null;
    }
    return deployment;
  };

  // 1. List Available Providers
  router.get('/api/deployments/providers', requireAuth, (_req: Request, res: Response) => {
    try {
      const providers = DeploymentService.listProviders();
      res.json({ providers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Pre-Deployment Truthful Validation
  router.get('/api/builds/:id/pre-deploy-validation', requireAuth, (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!verifyBuildOwnership(req, res, id)) return;

      const report = PreDeploymentValidator.validateProject(id);
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3. List Deployments for a Build (History)
  router.get('/api/builds/:id/deployments', requireAuth, (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!verifyBuildOwnership(req, res, id)) return;

      const deployments = db.getDeployments(id);
      res.json({ deployments });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Create New Deployment (Enforces Validation & Approval Gate)
  router.post('/api/builds/:id/deployments', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!verifyBuildOwnership(req, res, id)) return;

      const { provider = 'static_host', environment = 'production', config = {}, commitSha, skipApprovalGate } = req.body;

      const result = await DeploymentService.createDeployment({
        userId: req.user!.id,
        buildId: id,
        provider,
        environment,
        config,
        commitSha,
        skipApprovalGate
      });

      if (result.requiresApproval) {
        return res.status(202).json({
          status: 'pending_approval',
          message: 'Production deployment initiated. Explicit user approval is required before release.',
          deployment: result.deployment,
          approvalRequestId: result.approvalRequestId
        });
      }

      res.status(201).json({
        status: 'created',
        deployment: result.deployment
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 5. Get Deployment Details and Logs
  router.get('/api/deployments/:id', requireAuth, (req: Request, res: Response) => {
    try {
      const deployment = verifyDeploymentOwnership(req, res, req.params.id);
      if (!deployment) return;

      res.json({ deployment });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Approve Pending Deployment
  router.post('/api/deployments/:id/approve', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deployment = await DeploymentService.approveDeployment(id, req.user!.id);
      res.json({
        message: 'Deployment approved. Build and release pipeline in progress.',
        deployment
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 7. Cancel Pending Deployment
  router.post('/api/deployments/:id/cancel', requireAuth, (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const deployment = DeploymentService.cancelDeployment(id, req.user!.id);
      res.json({
        message: 'Deployment cancelled.',
        deployment
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 8. Rollback Deployment
  router.post('/api/deployments/:id/rollback', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { targetDeploymentId } = req.body;

      if (!targetDeploymentId) {
        return res.status(400).json({ error: 'targetDeploymentId is required for rollback.' });
      }

      const rolledBack = await DeploymentService.rollback(id, targetDeploymentId, req.user!.id);
      res.json({
        message: 'Rollback initiated successfully.',
        deployment: rolledBack
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 9. Configure Custom Domain
  router.post('/api/deployments/:id/custom-domain', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { domain } = req.body;

      if (!domain) {
        return res.status(400).json({ error: 'domain is required.' });
      }

      const result = await DeploymentService.configureCustomDomain(id, domain, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 10. Verify Custom Domain
  router.get('/api/deployments/:id/custom-domain/verify', requireAuth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const result = await DeploymentService.verifyCustomDomain(id, req.user!.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 11. Download Production Build ZIP Artifact
  router.get('/api/deployments/:id/artifact', requireAuth, async (req: Request, res: Response) => {
    try {
      const deployment = verifyDeploymentOwnership(req, res, req.params.id);
      if (!deployment) return;

      const buffer = await ProductionBuilder.getArtifactBuffer(deployment.id, deployment.buildArtifactPath);
      if (!buffer) {
        return res.status(404).json({ error: 'Build artifact not found for this deployment.' });
      }

      const filename = `squadforge-build-${deployment.id.slice(0, 8)}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 12. List Safe Deployment Secrets (Masked Values)
  router.get('/api/builds/:id/deployment-secrets', requireAuth, (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!verifyBuildOwnership(req, res, id)) return;

      const secrets = DeploymentSecretManager.listSafeSecrets(id);
      res.json({ secrets });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 13. Create or Update Deployment Secret (AES-256-GCM Encrypted)
  router.post('/api/builds/:id/deployment-secrets', requireAuth, (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!verifyBuildOwnership(req, res, id)) return;

      const { key, value, environment } = req.body;
      if (!key || value === undefined) {
        return res.status(400).json({ error: 'key and value are required.' });
      }

      const secret = DeploymentSecretManager.setSecret({
        userId: req.user!.id,
        buildId: id,
        key,
        value,
        environment
      });

      res.status(201).json({ secret });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // 14. Delete Deployment Secret
  router.delete('/api/builds/:id/deployment-secrets/:secretId', requireAuth, (req: Request, res: Response) => {
    try {
      const { id, secretId } = req.params;
      if (!verifyBuildOwnership(req, res, id)) return;

      DeploymentSecretManager.deleteSecret(secretId, req.user!.id, id);
      res.json({ success: true, message: 'Secret deleted successfully.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Public Express middleware for serving live static hosted deployments at /deployments/:id/*
 */
export function serveStaticDeployment(req: Request, res: Response, next: express.NextFunction) {
  const match = req.path.match(/^\/deployments\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/);
  if (!match) return next();

  const deploymentId = match[1];
  const relativePath = match[2] ? match[2].replace(/^\/+/, '') : '';

  const deployment = db.getDeployment(deploymentId);
  if (!deployment) {
    return res.status(404).send('Deployment not found');
  }

  const fileMap = staticHostRegistry.get(deploymentId);
  if (!fileMap) {
    // If not in memory, serve fallback HTML info
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!doctype html>
<html>
<head><title>SquadForge Deployment - ${deployment.id.slice(0, 8)}</title></head>
<body style="background:#0a0a0a; color:#fff; font-family:sans-serif; padding:2rem;">
  <h2>Deployment Status: ${deployment.status.toUpperCase()}</h2>
  <p>Environment: ${deployment.environment}</p>
  <p>Created: ${new Date(deployment.createdAt).toLocaleString()}</p>
</body>
</html>`);
  }

  // Look for exact file match
  const requestedFile = fileMap.get(relativePath);
  if (requestedFile) {
    res.setHeader('Content-Type', requestedFile.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(requestedFile.content);
  }

  // SPA fallback to index.html
  const indexFile = fileMap.get('index.html');
  if (indexFile) {
    res.setHeader('Content-Type', indexFile.contentType);
    return res.send(indexFile.content);
  }

  res.status(404).send('Not found');
}
