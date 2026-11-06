/**
 * SquadForge GitHub Lifecycle Service (Phase 14)
 * Orchestrates authentic GitHub integration, repository lifecycle, branch management,
 * diff computation, atomic commits with human approval gates, pull requests,
 * non-destructive synchronization, and conflict resolution.
 */

import crypto from 'node:crypto';
import { db, computeContentHash } from '../store.js';
import { GitHubClient, GitHubApiError } from './githubClient.js';
import { ApprovalGateService } from '../swarm/approvalGateService.js';
import {
  Build,
  ProjectFile,
  GitHubRepoInfo,
  GitHubBranchInfo,
  GitHubCommitInfo,
  GitHubPullRequestInfo,
  GitHubFileDiff,
  GitHubConflictRecord
} from '../types.js';

export interface DiffSummary {
  files: GitHubFileDiff[];
  summary: {
    totalFiles: number;
    added: number;
    modified: number;
    deleted: number;
    hasSensitiveChanges: boolean;
    sensitiveFiles: string[];
  };
}

export class GitHubLifecycleService {
  private static customClientFactory?: (token: string) => GitHubClient;

  /**
   * For testing: inject custom client or mock handler
   */
  public static setCustomClientFactory(factory?: (token: string) => GitHubClient): void {
    this.customClientFactory = factory;
  }

  public static getClient(userId: string): GitHubClient {
    const token = db.getGithubToken(userId);
    if (!token) {
      throw new Error('No GitHub account or Personal Access Token connected. Connect GitHub in Settings to proceed.');
    }
    if (this.customClientFactory) {
      return this.customClientFactory(token);
    }
    return new GitHubClient({ token });
  }

  // --- Task 1: Account Connection & Status ---

  public static async getUserStatus(userId: string): Promise<{
    connected: boolean;
    username?: string;
    name?: string;
    avatarUrl?: string;
    publicRepos?: number;
    error?: string;
  }> {
    const token = db.getGithubToken(userId);
    if (!token) {
      return { connected: false };
    }

    try {
      const client = this.getClient(userId);
      const user = await client.getUser();
      return {
        connected: true,
        username: user.login,
        name: user.name || user.login,
        avatarUrl: user.avatar_url,
        publicRepos: user.public_repos
      };
    } catch (err: any) {
      if (err.status === 401) {
        db.disconnectGithub(userId);
        return { connected: false, error: 'GitHub token has expired or was revoked. Disconnected.' };
      }
      return { connected: false, error: err.message || 'Failed to verify GitHub connection' };
    }
  }

  // --- Task 2: List and Connect Authorized Repositories ---

  public static async listAuthorizedRepos(userId: string): Promise<GitHubRepoInfo[]> {
    const client = this.getClient(userId);
    const repos = await client.listUserRepos({ sort: 'updated', per_page: 100 });
    return repos.map(r => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner?.login || '',
      private: Boolean(r.private),
      htmlUrl: r.html_url,
      description: r.description || undefined,
      defaultBranch: r.default_branch || 'main',
      permissions: {
        admin: Boolean(r.permissions?.admin),
        push: Boolean(r.permissions?.push),
        pull: Boolean(r.permissions?.pull ?? true)
      },
      updatedAt: r.updated_at
    }));
  }

  public static async connectRepoToProject(
    userId: string,
    buildId: string,
    params: { owner: string; repo: string; branch?: string }
  ): Promise<{ success: boolean; repoInfo: GitHubRepoInfo; branch: string; baseSha: string }> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');

    const client = this.getClient(userId);
    const repo = await client.getRepo(params.owner, params.repo);
    const targetBranch = params.branch || repo.default_branch || 'main';

    const branchRef = await client.getRef(params.owner, params.repo, `heads/${targetBranch}`);
    const baseSha = branchRef.object?.sha;
    if (!baseSha) {
      throw new Error(`Failed to retrieve commit SHA for branch ${targetBranch}`);
    }

    build.githubRepoUrl = repo.html_url;
    build.githubOwner = params.owner;
    build.githubRepoName = params.repo;
    build.gitBranch = targetBranch;
    build.githubBaseSha = baseSha;
    build.githubSyncedAt = db.getTime();
    db.saveBuild(build);

    const repoInfo: GitHubRepoInfo = {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner?.login || params.owner,
      private: Boolean(repo.private),
      htmlUrl: repo.html_url,
      description: repo.description,
      defaultBranch: repo.default_branch || 'main',
      permissions: {
        admin: Boolean(repo.permissions?.admin),
        push: Boolean(repo.permissions?.push),
        pull: Boolean(repo.permissions?.pull ?? true)
      },
      updatedAt: repo.updated_at
    };

    return { success: true, repoInfo, branch: targetBranch, baseSha };
  }

  // --- Task 3: Import Repository Files ---

  public static async importRepository(
    userId: string,
    buildId: string | null,
    params: { owner: string; repo: string; branch?: string; idea?: string }
  ): Promise<{
    success: boolean;
    buildId: string;
    importedFilesCount: number;
    branch: string;
    commitSha: string;
    repoUrl: string;
  }> {
    const client = this.getClient(userId);
    const repoData = await client.getRepo(params.owner, params.repo);
    const targetBranch = params.branch || repoData.default_branch || 'main';

    const branchRef = await client.getRef(params.owner, params.repo, `heads/${targetBranch}`);
    const commitSha = branchRef.object?.sha;
    if (!commitSha) {
      throw new Error(`Could not find commit reference for branch ${targetBranch}`);
    }

    // Retrieve recursive git tree
    const treeData = await client.getTree(params.owner, params.repo, commitSha, true);
    if (!treeData?.tree || !Array.isArray(treeData.tree)) {
      throw new Error('Repository git tree is empty or could not be read');
    }

    // Filter tree blobs (skip .git, package-lock huge blobs if text only, binary assets)
    const blobEntries = treeData.tree.filter((entry: any) => {
      if (entry.type !== 'blob') return false;
      const p = entry.path.toLowerCase();
      if (p.startsWith('.git/') || p.includes('/.git/')) return false;
      // Skip very large binary files > 500KB for text repo representation
      if (entry.size && entry.size > 500 * 1024) return false;
      return true;
    });

    let targetBuild: Build;
    if (buildId) {
      const existing = db.getBuild(buildId);
      if (!existing) throw new Error('Specified project build not found');
      if (existing.userId !== userId) throw new Error('Forbidden: You do not own this project');
      targetBuild = existing;
    } else {
      const newBuildId = `bld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      targetBuild = {
        id: newBuildId,
        userId,
        idea: params.idea || `Imported repository ${params.owner}/${params.repo} (${targetBranch})`,
        status: 'completed',
        createdAt: db.getTime(),
        updatedAt: db.getTime(),
        selectedModels: ['gemini-2.5-flash'],
        autoPushGithub: false,
        totalTokens: 0,
        totalCost: 0,
        costLimit: 5.0,
        maxDurationSeconds: 300,
        patchesAppliedCount: 0
      };
    }

    targetBuild.githubRepoUrl = repoData.html_url;
    targetBuild.githubOwner = params.owner;
    targetBuild.githubRepoName = params.repo;
    targetBuild.gitBranch = targetBranch;
    targetBuild.githubBaseSha = commitSha;
    targetBuild.githubSyncedAt = db.getTime();
    db.saveBuild(targetBuild);

    let importedCount = 0;
    for (const entry of blobEntries) {
      try {
        const blob = await client.getBlob(params.owner, params.repo, entry.sha);
        let content = '';
        if (blob.encoding === 'base64') {
          content = Buffer.from(blob.content, 'base64').toString('utf-8');
        } else {
          content = blob.content || '';
        }

        const projectFile: ProjectFile = {
          buildId: targetBuild.id,
          path: entry.path,
          content,
          version: 1,
          ownerModel: 'github_import',
          createdAt: db.getTime(),
          updatedAt: db.getTime()
        };

        db.setFile(targetBuild.id, projectFile);
        importedCount++;
      } catch (err: any) {
        console.warn(`[GitHub Import] Could not fetch blob ${entry.path}: ${err.message}`);
      }
    }

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId: targetBuild.id,
      timestamp: db.getTime(),
      type: 'plan_created',
      details: `Successfully imported ${importedCount} files from GitHub repository ${params.owner}/${params.repo} on branch ${targetBranch} (commit: ${commitSha.slice(0, 7)})`
    });

    return {
      success: true,
      buildId: targetBuild.id,
      importedFilesCount: importedCount,
      branch: targetBranch,
      commitSha,
      repoUrl: repoData.html_url
    };
  }

  // --- Task 4: Branch Creation & Switching ---

  public static async listBranches(userId: string, buildId: string): Promise<GitHubBranchInfo[]> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const branches = await client.listBranches(build.githubOwner, build.githubRepoName);
    return branches.map(b => ({
      name: b.name,
      commitSha: b.commit?.sha || '',
      protected: Boolean(b.protected),
      isDefault: b.name === (build.gitBranch || 'main')
    }));
  }

  public static async createBranch(
    userId: string,
    buildId: string,
    params: { newBranch: string; fromBranch?: string }
  ): Promise<{ success: boolean; branch: string; commitSha: string }> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const cleanBranch = params.newBranch.trim();
    if (!cleanBranch || /[\s~^:?*\[\\]/.test(cleanBranch)) {
      throw new Error(`Invalid branch name: "${cleanBranch}". Follow standard git ref naming conventions.`);
    }

    const client = this.getClient(userId);
    const fromBranch = params.fromBranch || build.gitBranch || 'main';
    const baseRef = await client.getRef(build.githubOwner, build.githubRepoName, `heads/${fromBranch}`);
    const baseSha = baseRef.object?.sha;
    if (!baseSha) {
      throw new Error(`Base branch "${fromBranch}" commit SHA could not be retrieved from GitHub`);
    }

    await client.createRef(build.githubOwner, build.githubRepoName, `refs/heads/${cleanBranch}`, baseSha);

    build.gitBranch = cleanBranch;
    build.githubBaseSha = baseSha;
    db.saveBuild(build);

    return {
      success: true,
      branch: cleanBranch,
      commitSha: baseSha
    };
  }

  public static async switchBranch(
    userId: string,
    buildId: string,
    params: { branch: string; checkoutFiles?: boolean; force?: boolean }
  ): Promise<{ success: boolean; branch: string; checkedOut: boolean; hasLocalChanges?: boolean }> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const branchRef = await client.getRef(build.githubOwner, build.githubRepoName, `heads/${params.branch}`);
    const branchSha = branchRef.object?.sha;
    if (!branchSha) {
      throw new Error(`Branch "${params.branch}" not found on GitHub`);
    }

    if (params.checkoutFiles) {
      // Invariant: Never overwrite local changes silently.
      if (!params.force) {
        const diff = await this.computeDiff(userId, buildId);
        const hasUncommitted = diff.summary.added > 0 || diff.summary.modified > 0 || diff.summary.deleted > 0;
        if (hasUncommitted) {
          return {
            success: false,
            branch: build.gitBranch || 'main',
            checkedOut: false,
            hasLocalChanges: true
          };
        }
      }

      // Check out files from remote branch
      const treeData = await client.getTree(build.githubOwner, build.githubRepoName, branchSha, true);
      if (treeData?.tree && Array.isArray(treeData.tree)) {
        for (const entry of treeData.tree) {
          if (entry.type === 'blob' && entry.path && !entry.path.startsWith('.git/')) {
            try {
              const blob = await client.getBlob(build.githubOwner, build.githubRepoName, entry.sha);
              const content = blob.encoding === 'base64'
                ? Buffer.from(blob.content, 'base64').toString('utf-8')
                : (blob.content || '');
              
              db.setFile(buildId, {
                buildId,
                path: entry.path,
                content,
                version: 1,
                ownerModel: 'github_checkout',
                updatedAt: db.getTime()
              });
            } catch {}
          }
        }
      }
    }

    build.gitBranch = params.branch;
    build.githubBaseSha = branchSha;
    db.saveBuild(build);

    return {
      success: true,
      branch: params.branch,
      checkedOut: Boolean(params.checkoutFiles)
    };
  }

  // --- Task 5: Detect Modified Files and Display Diffs ---

  public static async computeDiff(userId: string, buildId: string): Promise<DiffSummary> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const targetBranch = build.gitBranch || 'main';

    // Retrieve remote branch commit and tree
    let remoteTreeEntries: Map<string, { sha: string; size: number }> = new Map();
    try {
      const branchRef = await client.getRef(build.githubOwner, build.githubRepoName, `heads/${targetBranch}`);
      const headSha = branchRef.object?.sha;
      if (headSha) {
        const treeData = await client.getTree(build.githubOwner, build.githubRepoName, headSha, true);
        if (treeData?.tree && Array.isArray(treeData.tree)) {
          for (const item of treeData.tree) {
            if (item.type === 'blob' && item.path) {
              remoteTreeEntries.set(item.path, { sha: item.sha, size: item.size || 0 });
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[GitHub Diff] Unable to fetch remote tree: ${err.message}`);
    }

    // Copy live project files across await
    const localFiles = db.getAllFiles(buildId).map(f => ({ ...f }));
    const localFileMap = new Map<string, ProjectFile>();
    for (const f of localFiles) {
      if (!f.isDeleted) {
        localFileMap.set(f.path, f);
      }
    }

    const diffList: GitHubFileDiff[] = [];
    const sensitiveFiles: string[] = [];

    // 1. Process local files against remote tree
    for (const [path, localFile] of localFileMap.entries()) {
      const isSensitive = ApprovalGateService.isSensitiveFilePath(path);
      if (isSensitive) sensitiveFiles.push(path);

      const remoteMeta = remoteTreeEntries.get(path);
      if (!remoteMeta) {
        // File exists locally, not in remote -> Added
        const lines = localFile.content.split('\n');
        diffList.push({
          path,
          status: 'added',
          isSensitive,
          localContent: localFile.content,
          remoteContent: '',
          diffHunks: lines.map(l => `+${l}`),
          additions: lines.length,
          deletions: 0
        });
      } else {
        // File exists in both. Fetch remote content to compare
        let remoteContent = '';
        try {
          const blob = await client.getBlob(build.githubOwner, build.githubRepoName, remoteMeta.sha);
          remoteContent = blob.encoding === 'base64'
            ? Buffer.from(blob.content, 'base64').toString('utf-8')
            : (blob.content || '');
        } catch {
          remoteContent = '';
        }

        if (remoteContent !== localFile.content) {
          const hunks = this.generateUnifiedDiffHunks(remoteContent, localFile.content);
          const additions = hunks.filter(h => h.startsWith('+') && !h.startsWith('+++')).length;
          const deletions = hunks.filter(h => h.startsWith('-') && !h.startsWith('---')).length;

          diffList.push({
            path,
            status: 'modified',
            isSensitive,
            localContent: localFile.content,
            remoteContent,
            diffHunks: hunks,
            additions,
            deletions
          });
        }
      }
    }

    // 2. Process remote files absent locally -> Deleted
    for (const [path, remoteMeta] of remoteTreeEntries.entries()) {
      if (!localFileMap.has(path)) {
        const isSensitive = ApprovalGateService.isSensitiveFilePath(path);
        if (isSensitive) sensitiveFiles.push(path);

        let remoteContent = '';
        try {
          const blob = await client.getBlob(build.githubOwner, build.githubRepoName, remoteMeta.sha);
          remoteContent = blob.encoding === 'base64'
            ? Buffer.from(blob.content, 'base64').toString('utf-8')
            : (blob.content || '');
        } catch {}

        const lines = remoteContent.split('\n');
        diffList.push({
          path,
          status: 'deleted',
          isSensitive,
          localContent: '',
          remoteContent,
          diffHunks: lines.map(l => `-${l}`),
          additions: 0,
          deletions: lines.length
        });
      }
    }

    const added = diffList.filter(d => d.status === 'added').length;
    const modified = diffList.filter(d => d.status === 'modified').length;
    const deleted = diffList.filter(d => d.status === 'deleted').length;

    return {
      files: diffList,
      summary: {
        totalFiles: diffList.length,
        added,
        modified,
        deleted,
        hasSensitiveChanges: sensitiveFiles.length > 0,
        sensitiveFiles
      }
    };
  }

  // --- Task 6: Commit Approved Changes (Atomic Git Data API) ---

  public static async commitApprovedChanges(
    userId: string,
    buildId: string,
    params: {
      message: string;
      files?: string[];
      approvalRequestId?: string;
    }
  ): Promise<{
    success: boolean;
    commitSha?: string;
    branch?: string;
    requiresApproval?: boolean;
    approvalRequest?: any;
    error?: string;
  }> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const message = params.message?.trim();
    if (!message) throw new Error('Commit message is required');

    const client = this.getClient(userId);
    const targetBranch = build.gitBranch || 'main';

    // 1. Compute diff and identify modified files
    const diff = await this.computeDiff(userId, buildId);
    let targetFiles = diff.files;
    if (params.files && params.files.length > 0) {
      const allowed = new Set(params.files);
      targetFiles = diff.files.filter(f => allowed.has(f.path));
    }

    if (targetFiles.length === 0) {
      return { success: false, error: 'No changes detected to commit.' };
    }

    // 2. Sensitive operation & Approval Gate enforcement
    // Operations that touch sensitive files (env, keys, package.json, workflows)
    // OR target the default branch (main/master) require an approval gate.
    const isSensitiveBranch = targetBranch === 'main' || targetBranch === 'master';
    const touchesSensitiveFiles = targetFiles.some(f => f.isSensitive || ApprovalGateService.isSensitiveFilePath(f.path));
    const requiresApprovalGate = isSensitiveBranch || touchesSensitiveFiles;

    if (requiresApprovalGate) {
      let isAuthorized = false;

      // Check explicitly provided approval request
      if (params.approvalRequestId) {
        const req = db.getApprovalRequest(params.approvalRequestId);
        if (req && req.buildId === buildId && req.status === 'approved') {
          isAuthorized = true;
        }
      }

      // Check existing approved requests for these files
      const fingerprints: Record<string, string> = {};
      for (const f of targetFiles) {
        fingerprints[f.path] = computeContentHash(f.localContent || '');
      }

      if (!isAuthorized) {
        const filePaths = targetFiles.map(f => f.path);
        // Only existing per-file approvals can authorize if not a sensitive branch commit
        const hasApproval = !isSensitiveBranch && touchesSensitiveFiles && ApprovalGateService.hasApprovedRequestForFiles(buildId, filePaths, fingerprints);
        if (hasApproval) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        // Create HumanApprovalRequest requiring real user review
        const reqResult = ApprovalGateService.requestApproval(buildId, userId, {
          requestingAgent: 'devops_release_specialist',
          requestingRole: 'devops_release_specialist',
          operationType: 'github_sensitive_commit',
          explanation: `Commit ${targetFiles.length} file(s) to GitHub repository ${build.githubOwner}/${build.githubRepoName} on branch "${targetBranch}": "${message}"`,
          riskLevel: touchesSensitiveFiles ? 'critical' : 'high',
          affectedFiles: targetFiles.map(f => f.path),
          proposedChanges: targetFiles.map(f => `${f.status.toUpperCase()}: ${f.path}`).join('\n'),
          contentHashes: fingerprints
        });

        return {
          success: false,
          requiresApproval: true,
          approvalRequest: reqResult.request,
          error: 'Sensitive GitHub commit requires human approval before execution.'
        };
      }
    }

    // 3. Execute Atomic Git Commit via GitHub Git Data API
    // Retrieve latest branch reference and tree
    const branchRef = await client.getRef(build.githubOwner, build.githubRepoName, `heads/${targetBranch}`);
    const parentSha = branchRef.object?.sha;
    if (!parentSha) {
      throw new Error(`Failed to retrieve parent commit SHA for branch ${targetBranch}`);
    }

    const parentCommit = await client.getCommit(build.githubOwner, build.githubRepoName, parentSha);
    const baseTreeSha = parentCommit.tree?.sha;

    // Create blobs for added/modified files
    const treeEntries: Array<{ path: string; mode: string; type: string; sha?: string | null }> = [];
    for (const f of targetFiles) {
      if (f.status === 'deleted') {
        treeEntries.push({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: null
        });
      } else {
        const blobRes = await client.createBlob(build.githubOwner, build.githubRepoName, f.localContent || '', 'utf-8');
        treeEntries.push({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blobRes.sha
        });
      }
    }

    // Create new Git Tree
    const newTree = await client.createTree(build.githubOwner, build.githubRepoName, baseTreeSha, treeEntries);
    if (!newTree?.sha) {
      throw new Error('Failed to create Git tree on GitHub');
    }

    // Create Git Commit with Shahroz author identity
    const commitDate = new Date().toISOString();
    const newCommit = await client.createCommit(
      build.githubOwner,
      build.githubRepoName,
      message,
      newTree.sha,
      [parentSha],
      {
        name: 'Shahrozkalash',
        email: 'shahrozkalash@gmail.com',
        date: commitDate
      }
    );

    if (!newCommit?.sha) {
      throw new Error('Failed to create Git commit on GitHub');
    }

    // Update branch reference pointer
    await client.updateRef(build.githubOwner, build.githubRepoName, `heads/${targetBranch}`, newCommit.sha, false);

    // Consume approved files in gate service
    ApprovalGateService.consumeApprovedFiles(buildId, targetFiles.map(f => f.path));

    // Update build record metadata
    build.githubBaseSha = newCommit.sha;
    build.githubSyncedAt = db.getTime();
    db.saveBuild(build);

    db.addEvent({
      id: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      buildId,
      timestamp: db.getTime(),
      type: 'patch_applied',
      details: `Committed ${targetFiles.length} file(s) to GitHub branch "${targetBranch}": commit ${newCommit.sha.slice(0, 7)} - "${message}"`
    });

    return {
      success: true,
      commitSha: newCommit.sha,
      branch: targetBranch
    };
  }

  // --- Task 7: Pull Requests ---

  public static async listPullRequests(
    userId: string,
    buildId: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<GitHubPullRequestInfo[]> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const pulls = await client.listPullRequests(build.githubOwner, build.githubRepoName, { state });
    return pulls.map(p => ({
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body || '',
      state: p.state,
      htmlUrl: p.html_url,
      headBranch: p.head?.ref || '',
      baseBranch: p.base?.ref || '',
      createdAt: p.created_at,
      mergedAt: p.merged_at || undefined,
      mergeable: p.mergeable,
      author: p.user?.login || ''
    }));
  }

  public static async createPullRequest(
    userId: string,
    buildId: string,
    params: { title: string; body?: string; headBranch?: string; baseBranch?: string }
  ): Promise<GitHubPullRequestInfo> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const title = params.title?.trim();
    if (!title) throw new Error('Pull Request title is required');

    const client = this.getClient(userId);
    const headBranch = params.headBranch || build.gitBranch || 'feature/squadforge-development';
    const baseBranch = params.baseBranch || 'main';

    const body = params.body || `### SquadForge Autonomous Swarm PR\n\n- **Project:** ${build.idea || 'Application'}\n- **Verified By:** SquadForge Autonomous Development Swarm`;

    const pr = await client.createPullRequest(
      build.githubOwner,
      build.githubRepoName,
      title,
      body,
      headBranch,
      baseBranch
    );

    build.pullRequestUrl = pr.html_url;
    db.saveBuild(build);

    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      state: pr.state,
      htmlUrl: pr.html_url,
      headBranch: pr.head?.ref || headBranch,
      baseBranch: pr.base?.ref || baseBranch,
      createdAt: pr.created_at,
      mergedAt: pr.merged_at || undefined,
      mergeable: pr.mergeable,
      author: pr.user?.login || ''
    };
  }

  public static async getPullRequest(
    userId: string,
    buildId: string,
    pullNumber: number
  ): Promise<GitHubPullRequestInfo> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const pr = await client.getPullRequest(build.githubOwner, build.githubRepoName, pullNumber);
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      state: pr.state,
      htmlUrl: pr.html_url,
      headBranch: pr.head?.ref || '',
      baseBranch: pr.base?.ref || '',
      createdAt: pr.created_at,
      mergedAt: pr.merged_at || undefined,
      mergeable: pr.mergeable,
      author: pr.user?.login || ''
    };
  }

  public static async mergePullRequest(
    userId: string,
    buildId: string,
    pullNumber: number,
    options: { commitMessage?: string; mergeMethod?: 'merge' | 'squash' | 'rebase' } = {}
  ): Promise<{ success: boolean; message: string }> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const result = await client.mergePullRequest(build.githubOwner, build.githubRepoName, pullNumber, options);
    return {
      success: true,
      message: result.message || 'Pull request merged successfully'
    };
  }

  // --- Task 8 & 9: Synchronization and Conflict Resolution ---

  public static async synchronizeChanges(
    userId: string,
    buildId: string
  ): Promise<{
    status: 'synced' | 'conflicts_detected' | 'up_to_date';
    syncedFilesCount: number;
    conflicts?: GitHubConflictRecord[];
    message?: string;
  }> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const targetBranch = build.gitBranch || 'main';

    const branchRef = await client.getRef(build.githubOwner, build.githubRepoName, `heads/${targetBranch}`);
    const remoteHeadSha = branchRef.object?.sha;
    if (!remoteHeadSha) {
      throw new Error(`Failed to retrieve commit SHA for branch ${targetBranch}`);
    }

    // 1. Check if remote matches base
    if (remoteHeadSha === build.githubBaseSha) {
      // Remote has not changed. Check if local has pending modifications
      return {
        status: 'up_to_date',
        syncedFilesCount: 0,
        message: 'Workspace is already in sync with remote branch.'
      };
    }

    // 2. Fetch remote tree at remoteHeadSha
    const remoteTreeData = await client.getTree(build.githubOwner, build.githubRepoName, remoteHeadSha, true);
    const remoteEntries = new Map<string, any>();
    if (remoteTreeData?.tree && Array.isArray(remoteTreeData.tree)) {
      for (const entry of remoteTreeData.tree) {
        if (entry.type === 'blob' && entry.path && !entry.path.startsWith('.git/')) {
          remoteEntries.set(entry.path, entry);
        }
      }
    }

    // 3. Inspect local files (copy across await)
    const localFiles = db.getAllFiles(buildId).map(f => ({ ...f }));
    const localMap = new Map<string, ProjectFile>();
    for (const f of localFiles) {
      localMap.set(f.path, f);
    }

    // Check base commit files if baseSha exists
    let baseFileMap = new Map<string, string>();
    if (build.githubBaseSha) {
      try {
        const baseCommit = await client.getCommit(build.githubOwner, build.githubRepoName, build.githubBaseSha);
        if (baseCommit?.tree?.sha) {
          const baseTreeData = await client.getTree(build.githubOwner, build.githubRepoName, baseCommit.tree.sha, true);
          if (baseTreeData?.tree && Array.isArray(baseTreeData.tree)) {
            for (const bEntry of baseTreeData.tree) {
              if (bEntry.type === 'blob') {
                baseFileMap.set(bEntry.path, bEntry.sha);
              }
            }
          }
        }
      } catch {}
    }

    const conflictsFound: GitHubConflictRecord[] = [];
    const filesToFastForward: Array<{ path: string; content: string }> = [];

    // Check all remote files
    for (const [path, remoteEntry] of remoteEntries.entries()) {
      const local = localMap.get(path);
      const baseSha = baseFileMap.get(path);

      // Fetch remote blob content
      let remoteContent = '';
      try {
        const blob = await client.getBlob(build.githubOwner, build.githubRepoName, remoteEntry.sha);
        remoteContent = blob.encoding === 'base64'
          ? Buffer.from(blob.content, 'base64').toString('utf-8')
          : (blob.content || '');
      } catch {}

      if (!local) {
        // File is new in remote -> Fast forward pull
        filesToFastForward.push({ path, content: remoteContent });
      } else {
        // File exists both locally and remotely
        if (local.content === remoteContent) {
          // Contents match, no conflict
          continue;
        }

        // Did local file change compared to base?
        const isLocallyModified = local.version > 1 || (local.history && local.history.length > 1);
        const isRemotelyModified = baseSha ? (baseSha !== remoteEntry.sha) : true;

        if (isLocallyModified && isRemotelyModified) {
          // CONFLICT! Both local and remote modified the file independently.
          // Invariant: Never overwrite remote or local changes silently.
          const conflictId = `conf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          const conflictRecord: GitHubConflictRecord = {
            id: conflictId,
            buildId,
            filePath: path,
            localContent: local.content,
            remoteContent,
            status: 'unresolved',
            createdAt: db.getTime()
          };
          db.saveGitHubConflict(conflictRecord);
          conflictsFound.push(conflictRecord);
        } else if (!isLocallyModified && isRemotelyModified) {
          // Clean fast-forward: only remote modified it
          filesToFastForward.push({ path, content: remoteContent });
        }
      }
    }

    // Apply safe fast-forward files (no conflicts)
    for (const f of filesToFastForward) {
      db.setFile(buildId, {
        buildId,
        path: f.path,
        content: f.content,
        version: 1,
        ownerModel: 'github_sync',
        updatedAt: db.getTime()
      });
    }

    if (conflictsFound.length > 0) {
      return {
        status: 'conflicts_detected',
        syncedFilesCount: filesToFastForward.length,
        conflicts: conflictsFound,
        message: `${conflictsFound.length} conflict(s) detected. Conflicts must be resolved before finalizing sync.`
      };
    }

    // Clean sync complete
    build.githubBaseSha = remoteHeadSha;
    build.githubSyncedAt = db.getTime();
    db.saveBuild(build);

    return {
      status: 'synced',
      syncedFilesCount: filesToFastForward.length,
      message: `Synchronized ${filesToFastForward.length} file(s) from remote branch.`
    };
  }

  public static listConflicts(buildId: string): GitHubConflictRecord[] {
    return db.getGitHubConflicts(buildId);
  }

  public static resolveConflict(
    userId: string,
    buildId: string,
    conflictId: string,
    params: { resolutionType: 'ours' | 'theirs' | 'manual'; resolvedContent?: string }
  ): { success: boolean; conflict: GitHubConflictRecord; allResolved: boolean } {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');

    const conflict = db.getGitHubConflict(conflictId);
    if (!conflict || conflict.buildId !== buildId) {
      throw new Error('Conflict record not found for this project');
    }

    let finalContent = conflict.localContent;
    if (params.resolutionType === 'theirs') {
      finalContent = conflict.remoteContent;
    } else if (params.resolutionType === 'manual') {
      if (params.resolvedContent === undefined) {
        throw new Error('resolvedContent must be provided for manual conflict resolution');
      }
      finalContent = params.resolvedContent;
    }

    // Apply resolved content to project workspace
    const existingFile = db.getFile(buildId, conflict.filePath);
    const newVersion = (existingFile?.version || 1) + 1;
    db.setFile(buildId, {
      buildId,
      path: conflict.filePath,
      content: finalContent,
      version: newVersion,
      ownerModel: `conflict_resolved_${params.resolutionType}`,
      updatedAt: db.getTime()
    });

    // Mark conflict resolved in DB
    const resolvedRecord = db.resolveGitHubConflict(conflictId, params.resolutionType, finalContent);
    if (!resolvedRecord) throw new Error('Failed to save resolved conflict');

    // Check if any unresolved conflicts remain
    const remaining = db.getGitHubConflicts(buildId, 'unresolved');
    const allResolved = remaining.length === 0;

    if (allResolved) {
      build.githubSyncedAt = db.getTime();
      db.saveBuild(build);
    }

    return {
      success: true,
      conflict: resolvedRecord,
      allResolved
    };
  }

  // --- Task 10: Commit History ---

  public static async listCommitHistory(
    userId: string,
    buildId: string,
    options: { branch?: string; perPage?: number } = {}
  ): Promise<GitHubCommitInfo[]> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    const targetBranch = options.branch || build.gitBranch || 'main';
    const commits = await client.listCommits(build.githubOwner, build.githubRepoName, {
      sha: targetBranch,
      per_page: options.perPage || 30
    });

    return commits.map(c => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit?.message || '',
      authorName: c.commit?.author?.name || c.author?.login || 'Unknown',
      authorEmail: c.commit?.author?.email || '',
      authorAvatarUrl: c.author?.avatar_url,
      date: c.commit?.author?.date || c.commit?.committer?.date || '',
      htmlUrl: c.html_url
    }));
  }

  public static async getCommitDetails(
    userId: string,
    buildId: string,
    commitSha: string
  ): Promise<any> {
    const build = db.getBuild(buildId);
    if (!build) throw new Error('Project build not found');
    if (build.userId !== userId) throw new Error('Forbidden: You do not own this project');
    if (!build.githubOwner || !build.githubRepoName) {
      throw new Error('Project is not connected to a GitHub repository');
    }

    const client = this.getClient(userId);
    return client.getCommit(build.githubOwner, build.githubRepoName, commitSha);
  }

  // --- Helper: Diff Generation ---

  private static generateUnifiedDiffHunks(oldText: string, newText: string): string[] {
    const oldLines = oldText ? oldText.split('\n') : [];
    const newLines = newText ? newText.split('\n') : [];
    const hunks: string[] = [];

    let i = 0;
    let j = 0;
    while (i < oldLines.length && j < newLines.length) {
      if (oldLines[i] === newLines[j]) {
        hunks.push(` ${oldLines[i]}`);
        i++;
        j++;
      } else {
        hunks.push(`-${oldLines[i]}`);
        hunks.push(`+${newLines[j]}`);
        i++;
        j++;
      }
    }

    while (i < oldLines.length) {
      hunks.push(`-${oldLines[i]}`);
      i++;
    }
    while (j < newLines.length) {
      hunks.push(`+${newLines[j]}`);
      j++;
    }

    return hunks;
  }
}
