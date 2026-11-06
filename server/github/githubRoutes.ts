/**
 * SquadForge GitHub Integration & Lifecycle API Routes (Phase 14)
 * Server-side authorization, tenant isolation, and approval enforcement.
 */

import express, { Router, Request, Response } from 'express';
import { GitHubLifecycleService } from './githubLifecycleService.js';
import { db } from '../store.js';

export function createGitHubRouter(requireAuth: express.RequestHandler): Router {
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

  // 1. GitHub Connection Status (Token is never exposed to client)
  router.get('/api/github/status', requireAuth, async (req: Request, res: Response) => {
    try {
      const status = await GitHubLifecycleService.getUserStatus(req.user!.id);
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to check GitHub status' });
    }
  });

  // 2. List Authorized Repositories
  router.get('/api/github/repos', requireAuth, async (req: Request, res: Response) => {
    try {
      const repos = await GitHubLifecycleService.listAuthorizedRepos(req.user!.id);
      res.json({ repos });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to list authorized repositories' });
    }
  });

  // 3. Import Repository Files into Project
  router.post('/api/github/import-repo', requireAuth, async (req: Request, res: Response) => {
    try {
      const { owner, repo, branch, idea, buildId } = req.body;
      if (!owner || !repo) {
        return res.status(400).json({ error: 'owner and repo are required to import repository' });
      }

      if (buildId && !verifyBuildOwnership(req, res, buildId)) {
        return;
      }

      const result = await GitHubLifecycleService.importRepository(
        req.user!.id,
        buildId || null,
        { owner, repo, branch, idea }
      );
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to import repository' });
    }
  });

  // 4. Connect Project to Repository
  router.post('/api/builds/:id/github/connect', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;

      const { owner, repo, branch } = req.body;
      if (!owner || !repo) {
        return res.status(400).json({ error: 'owner and repo are required' });
      }

      const result = await GitHubLifecycleService.connectRepoToProject(
        req.user!.id,
        req.params.id,
        { owner, repo, branch }
      );
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to connect repository' });
    }
  });

  // 5. Branch Operations
  router.get('/api/builds/:id/github/branches', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const branches = await GitHubLifecycleService.listBranches(req.user!.id, req.params.id);
      res.json({ branches });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to list branches' });
    }
  });

  router.post('/api/builds/:id/github/branches', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const { newBranch, fromBranch } = req.body;
      if (!newBranch) {
        return res.status(400).json({ error: 'newBranch name is required' });
      }

      const result = await GitHubLifecycleService.createBranch(
        req.user!.id,
        req.params.id,
        { newBranch, fromBranch }
      );
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to create branch' });
    }
  });

  router.post('/api/builds/:id/github/switch-branch', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const { branch, checkoutFiles, force } = req.body;
      if (!branch) {
        return res.status(400).json({ error: 'branch name is required' });
      }

      const result = await GitHubLifecycleService.switchBranch(
        req.user!.id,
        req.params.id,
        { branch, checkoutFiles, force }
      );
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to switch branch' });
    }
  });

  // 6. Diff Computation
  router.get('/api/builds/:id/github/diff', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const diff = await GitHubLifecycleService.computeDiff(req.user!.id, req.params.id);
      res.json(diff);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to compute diff' });
    }
  });

  // 7. Commit Approved Changes
  router.post('/api/builds/:id/github/commit', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const { message, files, approvalRequestId } = req.body;
      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Commit message is required' });
      }

      const result = await GitHubLifecycleService.commitApprovedChanges(
        req.user!.id,
        req.params.id,
        { message, files, approvalRequestId }
      );

      if (result.requiresApproval) {
        return res.status(202).json(result);
      }
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to commit changes' });
    }
  });

  // 8. Pull Requests
  router.get('/api/builds/:id/github/pulls', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const state = (req.query.state as 'open' | 'closed' | 'all') || 'open';
      const pulls = await GitHubLifecycleService.listPullRequests(req.user!.id, req.params.id, state);
      res.json({ pulls });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to list pull requests' });
    }
  });

  router.post('/api/builds/:id/github/pulls', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const { title, body, headBranch, baseBranch } = req.body;
      if (!title) {
        return res.status(400).json({ error: 'Pull request title is required' });
      }

      const pr = await GitHubLifecycleService.createPullRequest(
        req.user!.id,
        req.params.id,
        { title, body, headBranch, baseBranch }
      );
      res.json({ success: true, pullRequest: pr });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to create pull request' });
    }
  });

  router.get('/api/builds/:id/github/pulls/:number', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const pullNumber = parseInt(req.params.number, 10);
      if (isNaN(pullNumber)) {
        return res.status(400).json({ error: 'Invalid pull request number' });
      }

      const pr = await GitHubLifecycleService.getPullRequest(req.user!.id, req.params.id, pullNumber);
      res.json({ pullRequest: pr });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to retrieve pull request' });
    }
  });

  router.post('/api/builds/:id/github/pulls/:number/merge', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const pullNumber = parseInt(req.params.number, 10);
      if (isNaN(pullNumber)) {
        return res.status(400).json({ error: 'Invalid pull request number' });
      }

      const { commitMessage, mergeMethod } = req.body;
      const result = await GitHubLifecycleService.mergePullRequest(
        req.user!.id,
        req.params.id,
        pullNumber,
        { commitMessage, mergeMethod }
      );
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to merge pull request' });
    }
  });

  // 9. Synchronization and Conflicts
  router.post('/api/builds/:id/github/sync', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const result = await GitHubLifecycleService.synchronizeChanges(req.user!.id, req.params.id);
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to synchronize with GitHub' });
    }
  });

  router.get('/api/builds/:id/github/conflicts', requireAuth, (req: Request, res: Response) => {
    if (!verifyBuildOwnership(req, res, req.params.id)) return;
    const conflicts = GitHubLifecycleService.listConflicts(req.params.id);
    res.json({ conflicts });
  });

  router.post('/api/builds/:id/github/conflicts/:conflictId/resolve', requireAuth, (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const { resolutionType, resolvedContent } = req.body;
      if (!resolutionType || !['ours', 'theirs', 'manual'].includes(resolutionType)) {
        return res.status(400).json({ error: "resolutionType must be 'ours', 'theirs', or 'manual'" });
      }

      const result = GitHubLifecycleService.resolveConflict(
        req.user!.id,
        req.params.id,
        req.params.conflictId,
        { resolutionType, resolvedContent }
      );
      res.json(result);
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to resolve conflict' });
    }
  });

  // 10. Repository and Commit History
  router.get('/api/builds/:id/github/commits', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const branch = typeof req.query.branch === 'string' ? req.query.branch : undefined;
      const perPage = req.query.perPage ? parseInt(req.query.perPage as string, 10) : undefined;

      const commits = await GitHubLifecycleService.listCommitHistory(req.user!.id, req.params.id, {
        branch,
        perPage
      });
      res.json({ commits });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to list commit history' });
    }
  });

  router.get('/api/builds/:id/github/commits/:sha', requireAuth, async (req: Request, res: Response) => {
    try {
      if (!verifyBuildOwnership(req, res, req.params.id)) return;
      const details = await GitHubLifecycleService.getCommitDetails(
        req.user!.id,
        req.params.id,
        req.params.sha
      );
      res.json({ commit: details });
    } catch (err: any) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to retrieve commit details' });
    }
  });

  return router;
}
