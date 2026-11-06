import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { GitHubClient, GitHubApiError } from '../server/github/githubClient.js';
import { GitHubLifecycleService } from '../server/github/githubLifecycleService.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { Build, ProjectFile } from '../server/types.js';

function createMockFetch(routes: Record<string, { status?: number; data?: any; error?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const key = `${method} ${urlStr}`;

    // Exact match first, then longest matching URL pattern
    let matchKey = Object.keys(routes).find(k => k === key);
    if (!matchKey) {
      const sortedKeys = Object.keys(routes).sort((a, b) => b.length - a.length);
      matchKey = sortedKeys.find(k => {
        const cleanK = k.replace(/^[A-Z]+\s+/, '');
        return urlStr === cleanK || urlStr.includes(cleanK);
      });
    }
    const route = matchKey ? routes[matchKey] : undefined;

    if (!route) {
      return new Response(JSON.stringify({ message: `Not Found: ${key}` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const status = route.status || 200;
    const body = route.data !== undefined ? JSON.stringify(route.data) : (route.error ? JSON.stringify({ message: route.error }) : '');
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as any;
}

function createTestBuild(id: string, userId: string, overrides: Partial<Build> = {}): Build {
  const b: Build = {
    id,
    userId,
    idea: 'Test Application',
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini-2.5-flash'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 5,
    maxDurationSeconds: 300,
    patchesAppliedCount: 0,
    ...overrides
  };
  db.saveBuild(b);
  return b;
}

describe('SquadForge Phase 14: GitHub Integration & Project Lifecycle', () => {
  const testUserId = `user_p14_${Date.now()}`;
  const mockToken = 'ghp_mock_token_1234567890abcdefghijklmnopqrstuvwxyz';

  beforeEach(() => {
    // Connect GitHub token securely for test user
    db.setGithubToken(testUserId, mockToken, 'test-github-user');
  });

  afterEach(() => {
    GitHubLifecycleService.setCustomClientFactory(undefined);
  });

  // Task 1: Secure Account Connection
  describe('Task 1: Secure GitHub Account Connection', () => {
    test('1.1 Token is securely encrypted and never returned in plaintext status check', async () => {
      // Direct store check: token stored in encrypted form
      const rawStored = db.encryptedGithubTokens.get(testUserId);
      assert.ok(rawStored, 'Encrypted token should be present in store');
      assert.notEqual(rawStored, mockToken, 'Token must not be stored in plaintext');

      const mockFetch = createMockFetch({
        'GET https://api.github.com/user': {
          data: {
            login: 'test-github-user',
            name: 'Test Engineer',
            avatar_url: 'https://avatars.githubusercontent.com/u/12345',
            public_repos: 12
          }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const status = await GitHubLifecycleService.getUserStatus(testUserId);
      assert.equal(status.connected, true);
      assert.equal(status.username, 'test-github-user');
      assert.equal(status.name, 'Test Engineer');
      // Invariant: tokens must never be exposed
      assert.equal((status as any).token, undefined);
      assert.equal((status as any).plainToken, undefined);
    });

    test('1.2 Handles expired/revoked token by disconnecting gracefully', async () => {
      const mockFetch = createMockFetch({
        'GET https://api.github.com/user': {
          status: 401,
          error: 'Bad credentials'
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const status = await GitHubLifecycleService.getUserStatus(testUserId);
      assert.equal(status.connected, false);
      assert.match(status.error || '', /expired or was revoked/i);
      assert.equal(db.getGithubToken(testUserId), null, 'Token should be disconnected on 401');
    });
  });

  // Task 2: List and Connect Authorized Repositories
  describe('Task 2: List and Connect Authorized Repositories', () => {
    test('2.1 Lists authorized repos with permissions and default branches', async () => {
      const mockFetch = createMockFetch({
        'GET https://api.github.com/user/repos': {
          data: [
            {
              id: 101,
              name: 'repo-one',
              full_name: 'test-user/repo-one',
              owner: { login: 'test-user' },
              private: false,
              html_url: 'https://github.com/test-user/repo-one',
              description: 'First test repo',
              default_branch: 'main',
              permissions: { admin: true, push: true, pull: true },
              updated_at: '2026-11-06T00:00:00Z'
            },
            {
              id: 102,
              name: 'repo-readonly',
              full_name: 'org/repo-readonly',
              owner: { login: 'org' },
              private: true,
              html_url: 'https://github.com/org/repo-readonly',
              description: 'Read-only fork',
              default_branch: 'master',
              permissions: { admin: false, push: false, pull: true },
              updated_at: '2026-11-05T00:00:00Z'
            }
          ]
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const repos = await GitHubLifecycleService.listAuthorizedRepos(testUserId);
      assert.equal(repos.length, 2);
      assert.equal(repos[0].name, 'repo-one');
      assert.equal(repos[0].permissions?.push, true);
      assert.equal(repos[1].name, 'repo-readonly');
      assert.equal(repos[1].permissions?.push, false);
    });

    test('2.2 Connects repository to project and validates permissions and base SHA', async () => {
      const build = createTestBuild(`bld_conn_${Date.now()}`, testUserId);

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one': {
          data: {
            id: 101,
            name: 'repo-one',
            full_name: 'test-user/repo-one',
            html_url: 'https://github.com/test-user/repo-one',
            default_branch: 'main',
            permissions: { admin: true, push: true, pull: true },
            updated_at: '2026-11-06T00:00:00Z'
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: {
            ref: 'refs/heads/main',
            object: { sha: 'sha_base_initial_12345' }
          }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const res = await GitHubLifecycleService.connectRepoToProject(testUserId, build.id, {
        owner: 'test-user',
        repo: 'repo-one'
      });

      assert.equal(res.success, true);
      assert.equal(res.branch, 'main');
      assert.equal(res.baseSha, 'sha_base_initial_12345');

      const updated = db.getBuild(build.id);
      assert.equal(updated?.githubOwner, 'test-user');
      assert.equal(updated?.githubRepoName, 'repo-one');
      assert.equal(updated?.gitBranch, 'main');
      assert.equal(updated?.githubBaseSha, 'sha_base_initial_12345');
    });
  });

  // Task 3: Import Repository Files
  describe('Task 3: Import Repository Files into SquadForge Projects', () => {
    test('3.1 Recursively imports repository files and creates project records', async () => {
      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one': {
          data: {
            id: 101,
            name: 'repo-one',
            html_url: 'https://github.com/test-user/repo-one',
            default_branch: 'main'
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: {
            ref: 'refs/heads/main',
            object: { sha: 'sha_tree_head_11111' }
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/sha_tree_head_11111?recursive=1': {
          data: {
            sha: 'sha_tree_head_11111',
            tree: [
              { path: 'package.json', type: 'blob', sha: 'blob_pkg_sha', size: 120 },
              { path: 'src/index.ts', type: 'blob', sha: 'blob_src_sha', size: 250 },
              { path: 'README.md', type: 'blob', sha: 'blob_readme_sha', size: 80 },
              { path: '.git/config', type: 'blob', sha: 'blob_git_sha', size: 50 } // Must be filtered
            ]
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/blob_pkg_sha': {
          data: { encoding: 'utf-8', content: '{\n  "name": "imported-project"\n}' }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/blob_src_sha': {
          data: { encoding: 'base64', content: Buffer.from('console.log("hello world");').toString('base64') }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/blob_readme_sha': {
          data: { encoding: 'utf-8', content: '# Imported Project\n\nDocs here.' }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const importRes = await GitHubLifecycleService.importRepository(testUserId, null, {
        owner: 'test-user',
        repo: 'repo-one',
        idea: 'Imported Test Repo'
      });

      assert.equal(importRes.success, true);
      assert.equal(importRes.importedFilesCount, 3);
      assert.equal(importRes.commitSha, 'sha_tree_head_11111');

      const importedBuild = db.getBuild(importRes.buildId);
      assert.ok(importedBuild);
      assert.equal(importedBuild?.githubOwner, 'test-user');
      assert.equal(importedBuild?.githubRepoName, 'repo-one');

      const files = db.getAllFiles(importRes.buildId);
      assert.equal(files.length, 3);
      const pkg = files.find(f => f.path === 'package.json');
      const src = files.find(f => f.path === 'src/index.ts');
      assert.ok(pkg?.content.includes('"imported-project"'));
      assert.ok(src?.content.includes('hello world'));
    });
  });

  // Task 4: Branch Creation & Switching
  describe('Task 4: Support Branch Creation and Switching', () => {
    test('4.1 Creates a new branch from base and updates project active pointer', async () => {
      const build = createTestBuild(`bld_br_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main'
      });

      let createdRefPayload: any = null;
      const mockFetch = (async (input: any, init: any) => {
        const url = String(input);
        if (url.includes('/git/ref/heads/main')) {
          return new Response(JSON.stringify({ object: { sha: 'base_main_sha_999' } }), { status: 200 });
        }
        if (url.includes('/git/refs') && init?.method === 'POST') {
          createdRefPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({ ref: createdRefPayload.ref, object: { sha: createdRefPayload.sha } }), { status: 201 });
        }
        return new Response('{}', { status: 200 });
      }) as any;

      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const result = await GitHubLifecycleService.createBranch(testUserId, build.id, {
        newBranch: 'feature/payment-integration',
        fromBranch: 'main'
      });

      assert.equal(result.success, true);
      assert.equal(result.branch, 'feature/payment-integration');
      assert.equal(createdRefPayload?.ref, 'refs/heads/feature/payment-integration');
      assert.equal(createdRefPayload?.sha, 'base_main_sha_999');

      const updated = db.getBuild(build.id);
      assert.equal(updated?.gitBranch, 'feature/payment-integration');
    });

    test('4.2 Rejects switching branch with checkout when uncommitted local changes exist', async () => {
      const build = createTestBuild(`bld_switch_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main',
        githubBaseSha: 'base_sha_123'
      });

      // Add a locally modified file
      db.setFile(build.id, {
        buildId: build.id,
        path: 'src/app.ts',
        content: 'const modifiedLocally = true;',
        version: 2
      });

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/feature/other': {
          data: { object: { sha: 'feature_other_sha' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: { object: { sha: 'base_sha_123' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/base_sha_123?recursive=1': {
          data: {
            tree: [{ path: 'src/app.ts', type: 'blob', sha: 'remote_blob_sha' }]
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/remote_blob_sha': {
          data: { encoding: 'utf-8', content: 'const modifiedLocally = false;' }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      // Attempt switch with checkoutFiles=true without force
      const switchRes = await GitHubLifecycleService.switchBranch(testUserId, build.id, {
        branch: 'feature/other',
        checkoutFiles: true,
        force: false
      });

      assert.equal(switchRes.success, false);
      assert.equal(switchRes.hasLocalChanges, true);
    });
  });

  // Task 5: Detect Modified Files and Display Diffs
  describe('Task 5: Detect Modified Files and Display Diffs', () => {
    test('5.1 Accurately classifies added, modified, deleted files and flags sensitive files', async () => {
      const build = createTestBuild(`bld_diff_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main'
      });

      // Local files
      db.setFile(build.id, { buildId: build.id, path: 'src/new-feature.ts', content: 'export const newFeature = 1;', version: 1 });
      db.setFile(build.id, { buildId: build.id, path: '.env', content: 'SECRET_KEY=12345', version: 1 }); // Sensitive!
      db.setFile(build.id, { buildId: build.id, path: 'src/existing.ts', content: 'line 1\nmodified line 2\nline 3', version: 2 });

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: { object: { sha: 'remote_head_sha' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/remote_head_sha?recursive=1': {
          data: {
            tree: [
              { path: 'src/existing.ts', type: 'blob', sha: 'existing_blob_sha' },
              { path: 'src/old-deleted.ts', type: 'blob', sha: 'deleted_blob_sha' }
            ]
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/existing_blob_sha': {
          data: { encoding: 'utf-8', content: 'line 1\nline 2\nline 3' }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/deleted_blob_sha': {
          data: { encoding: 'utf-8', content: 'console.log("will be deleted");' }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const diff = await GitHubLifecycleService.computeDiff(testUserId, build.id);

      assert.equal(diff.summary.added, 2); // src/new-feature.ts and .env
      assert.equal(diff.summary.modified, 1); // src/existing.ts
      assert.equal(diff.summary.deleted, 1); // src/old-deleted.ts
      assert.equal(diff.summary.hasSensitiveChanges, true);
      assert.ok(diff.summary.sensitiveFiles.includes('.env'));

      const envDiff = diff.files.find(f => f.path === '.env');
      assert.equal(envDiff?.isSensitive, true);
      assert.equal(envDiff?.status, 'added');
    });
  });

  // Task 6: Commit Approved Changes (Atomic Git Data API & Approval Gates)
  describe('Task 6: Commit Approved Changes', () => {
    test('6.1 Requires human approval when committing to default branch or sensitive files', async () => {
      const build = createTestBuild(`bld_commit_gate_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main' // default branch
      });

      db.setFile(build.id, { buildId: build.id, path: 'server/crypto.ts', content: 'export const secure = true;', version: 1 });

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: { object: { sha: 'parent_head_sha' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/parent_head_sha?recursive=1': {
          data: { tree: [] }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const res = await GitHubLifecycleService.commitApprovedChanges(testUserId, build.id, {
        message: 'Add sensitive crypto module'
      });

      // Must be stopped by approval gate
      assert.equal(res.success, false);
      assert.equal(res.requiresApproval, true);
      assert.ok(res.approvalRequest?.id, 'Approval request must be generated');
      assert.equal(res.approvalRequest?.status, 'pending');
    });

    test('6.2 Successfully commits when approved using atomic Git Data API', async () => {
      const build = createTestBuild(`bld_commit_atomic_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'feature/auth-upgrade'
      });

      db.setFile(build.id, { buildId: build.id, path: 'src/feature.ts', content: 'export const v = 2;', version: 1 });

      let createdBlobContent = '';
      let createdCommitPayload: any = null;
      let updatedRefPayload: any = null;

      const mockFetch = (async (input: any, init: any) => {
        const url = String(input);
        const method = init?.method || 'GET';

        if (url.includes('/git/ref/heads/feature/auth-upgrade') && method === 'GET') {
          return new Response(JSON.stringify({ object: { sha: 'parent_sha_777' } }), { status: 200 });
        }
        if (url.includes('/commits/parent_sha_777')) {
          return new Response(JSON.stringify({ sha: 'parent_sha_777', tree: { sha: 'base_tree_sha_333' } }), { status: 200 });
        }
        if (url.includes('/git/trees/parent_sha_777')) {
          return new Response(JSON.stringify({ tree: [] }), { status: 200 });
        }
        if (url.includes('/git/blobs') && method === 'POST') {
          const body = JSON.parse(init.body);
          createdBlobContent = body.content;
          return new Response(JSON.stringify({ sha: 'new_blob_sha_555' }), { status: 201 });
        }
        if (url.includes('/git/trees') && method === 'POST') {
          return new Response(JSON.stringify({ sha: 'new_tree_sha_888' }), { status: 201 });
        }
        if (url.includes('/git/commits') && method === 'POST') {
          createdCommitPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({ sha: 'new_commit_sha_999' }), { status: 201 });
        }
        if (url.includes('/git/refs/heads/feature/auth-upgrade') && method === 'PATCH') {
          updatedRefPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({ object: { sha: 'new_commit_sha_999' } }), { status: 200 });
        }

        return new Response('{}', { status: 200 });
      }) as any;

      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const res = await GitHubLifecycleService.commitApprovedChanges(testUserId, build.id, {
        message: 'Implement auth upgrade'
      });

      assert.equal(res.success, true);
      assert.equal(res.commitSha, 'new_commit_sha_999');
      assert.equal(createdBlobContent, 'export const v = 2;');
      assert.equal(createdCommitPayload?.message, 'Implement auth upgrade');
      assert.equal(createdCommitPayload?.author?.name, 'Shahrozkalash');
      assert.equal(createdCommitPayload?.author?.email, 'shahrozkalash@gmail.com');
      assert.equal(updatedRefPayload?.sha, 'new_commit_sha_999');
    });
  });

  // Task 7: Pull Requests
  describe('Task 7: Pull Request Management', () => {
    test('7.1 Opens, retrieves, and merges Pull Requests', async () => {
      const build = createTestBuild(`bld_pr_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'feature/autonomous-team'
      });

      let prCreatedPayload: any = null;
      let mergeCalled = false;

      const mockFetch = (async (input: any, init: any) => {
        const url = String(input);
        const method = init?.method || 'GET';

        if (url.includes('/pulls') && method === 'POST') {
          prCreatedPayload = JSON.parse(init.body);
          return new Response(JSON.stringify({
            id: 501,
            number: 42,
            title: prCreatedPayload.title,
            body: prCreatedPayload.body,
            state: 'open',
            html_url: 'https://github.com/test-user/repo-one/pull/42',
            head: { ref: prCreatedPayload.head },
            base: { ref: prCreatedPayload.base },
            created_at: '2026-11-06T00:00:00Z',
            mergeable: true
          }), { status: 201 });
        }

        if (url.includes('/pulls/42/merge') && method === 'PUT') {
          mergeCalled = true;
          return new Response(JSON.stringify({ sha: 'merge_sha_444', merged: true, message: 'Pull Request successfully merged' }), { status: 200 });
        }

        if (url.includes('/pulls/42') && method === 'GET') {
          return new Response(JSON.stringify({
            id: 501,
            number: 42,
            title: 'Test PR',
            state: 'open',
            html_url: 'https://github.com/test-user/repo-one/pull/42',
            mergeable: true
          }), { status: 200 });
        }

        return new Response('[]', { status: 200 });
      }) as any;

      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const pr = await GitHubLifecycleService.createPullRequest(testUserId, build.id, {
        title: 'Autonomous Swarm Feature',
        body: 'Details of swarm generation'
      });

      assert.equal(pr.number, 42);
      assert.equal(pr.title, 'Autonomous Swarm Feature');
      assert.equal(pr.mergeable, true);

      // Verify PR details retrieval
      const fetched = await GitHubLifecycleService.getPullRequest(testUserId, build.id, 42);
      assert.equal(fetched.number, 42);

      // Merge PR
      const mergeRes = await GitHubLifecycleService.mergePullRequest(testUserId, build.id, 42);
      assert.equal(mergeRes.success, true);
      assert.equal(mergeCalled, true);
    });
  });

  // Task 8 & 9: Synchronization and Conflict Resolution
  describe('Tasks 8 & 9: Synchronization & Safe Conflict Resolution', () => {
    test('8.1 Fast-forwards clean remote changes safely into local workspace', async () => {
      const build = createTestBuild(`bld_sync_clean_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main',
        githubBaseSha: 'base_sha_100'
      });

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: { object: { sha: 'remote_new_sha_200' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/remote_new_sha_200?recursive=1': {
          data: {
            tree: [{ path: 'server/api.ts', type: 'blob', sha: 'blob_api_sha' }]
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/commits/base_sha_100': {
          data: { tree: { sha: 'base_tree_sha' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/base_tree_sha?recursive=1': {
          data: { tree: [] }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/blob_api_sha': {
          data: { encoding: 'utf-8', content: 'export const api = "clean";' }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const syncResult = await GitHubLifecycleService.synchronizeChanges(testUserId, build.id);

      assert.equal(syncResult.status, 'synced');
      assert.equal(syncResult.syncedFilesCount, 1);

      const file = db.getFile(build.id, 'server/api.ts');
      assert.ok(file);
      assert.equal(file?.content, 'export const api = "clean";');

      const updatedBuild = db.getBuild(build.id);
      assert.equal(updatedBuild?.githubBaseSha, 'remote_new_sha_200');
    });

    test('9.1 Detects conflicts and does NOT overwrite files silently', async () => {
      const build = createTestBuild(`bld_sync_conflict_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main',
        githubBaseSha: 'base_sha_100'
      });

      // Local has modified version 2
      db.setFile(build.id, {
        buildId: build.id,
        path: 'src/config.ts',
        content: 'export const config = { local: true };',
        version: 2
      });

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one/git/ref/heads/main': {
          data: { object: { sha: 'remote_conflict_sha_300' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/remote_conflict_sha_300?recursive=1': {
          data: {
            tree: [{ path: 'src/config.ts', type: 'blob', sha: 'remote_blob_conflict_sha' }]
          }
        },
        'GET https://api.github.com/repos/test-user/repo-one/commits/base_sha_100': {
          data: { tree: { sha: 'base_tree_sha' } }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/trees/base_tree_sha?recursive=1': {
          data: { tree: [{ path: 'src/config.ts', type: 'blob', sha: 'base_blob_sha' }] }
        },
        'GET https://api.github.com/repos/test-user/repo-one/git/blobs/remote_blob_conflict_sha': {
          data: { encoding: 'utf-8', content: 'export const config = { remote: true };' }
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const syncResult = await GitHubLifecycleService.synchronizeChanges(testUserId, build.id);

      assert.equal(syncResult.status, 'conflicts_detected');
      assert.equal(syncResult.conflicts?.length, 1);

      // Local file must NOT be overwritten!
      const localFile = db.getFile(build.id, 'src/config.ts');
      assert.equal(localFile?.content, 'export const config = { local: true };');

      // Verify conflict resolution workflow
      const conflicts = GitHubLifecycleService.listConflicts(build.id);
      assert.equal(conflicts.length, 1);
      const conf = conflicts[0];

      // Resolve using manual merged content
      const resolveRes = GitHubLifecycleService.resolveConflict(testUserId, build.id, conf.id, {
        resolutionType: 'manual',
        resolvedContent: 'export const config = { local: true, remote: true, resolved: true };'
      });

      assert.equal(resolveRes.success, true);
      assert.equal(resolveRes.allResolved, true);

      // Verify file is updated with resolved content
      const resolvedFile = db.getFile(build.id, 'src/config.ts');
      assert.equal(resolvedFile?.content, 'export const config = { local: true, remote: true, resolved: true };');
    });
  });

  // Task 10: Commit History
  describe('Task 10: Repository and Commit History', () => {
    test('10.1 Retrieves and formats authentic repository commit history', async () => {
      const build = createTestBuild(`bld_hist_${Date.now()}`, testUserId, {
        githubOwner: 'test-user',
        githubRepoName: 'repo-one',
        gitBranch: 'main'
      });

      const mockFetch = createMockFetch({
        'GET https://api.github.com/repos/test-user/repo-one/commits?sha=main&per_page=30': {
          data: [
            {
              sha: 'c1234567890abcdef',
              commit: {
                message: 'Merge pull request #1 from feature',
                author: { name: 'Shahrozkalash', email: 'shahrozkalash@gmail.com', date: '2026-11-06T04:00:00Z' }
              },
              author: { login: 'Shahrozkalash', avatar_url: 'https://avatars.githubusercontent.com/u/99' },
              html_url: 'https://github.com/test-user/repo-one/commit/c1234567890abcdef'
            },
            {
              sha: 'b9876543210fedcba',
              commit: {
                message: 'Initial project plan and topology',
                author: { name: 'Shahrozkalash', email: 'shahrozkalash@gmail.com', date: '2026-11-05T20:00:00Z' }
              },
              author: { login: 'Shahrozkalash', avatar_url: 'https://avatars.githubusercontent.com/u/99' },
              html_url: 'https://github.com/test-user/repo-one/commit/b9876543210fedcba'
            }
          ]
        }
      });
      GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

      const history = await GitHubLifecycleService.listCommitHistory(testUserId, build.id);

      assert.equal(history.length, 2);
      assert.equal(history[0].sha, 'c1234567890abcdef');
      assert.equal(history[0].shortSha, 'c123456');
      assert.equal(history[0].authorName, 'Shahrozkalash');
      assert.equal(history[1].message, 'Initial project plan and topology');
    });
  });
});
