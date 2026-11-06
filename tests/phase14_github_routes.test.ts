import test, { describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../server.js';
import { db } from '../server/store.js';
import { GitHubClient } from '../server/github/githubClient.js';
import { GitHubLifecycleService } from '../server/github/githubLifecycleService.js';
import { User, Build } from '../server/types.js';

let serverInstance: any;
let baseUrl = '';

function createMockFetch(routes: Record<string, { status?: number; data?: any; error?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const key = `${method} ${urlStr}`;

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

describe('SquadForge Phase 14: GitHub Express REST Routes & Authorization Security', () => {
  let testUser: User;
  let sessionToken: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    // Start listening on ephemeral port if not already started
    if (!serverInstance) {
      await new Promise<void>((resolve) => {
        serverInstance = app.listen(0, '127.0.0.1', () => {
          const addr = serverInstance.address();
          baseUrl = `http://127.0.0.1:${typeof addr === 'object' ? addr.port : 3000}`;
          resolve();
        });
      });
    }

    const uid = `usr_route_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    testUser = {
      id: uid,
      email: `${uid}@squadforge.test`,
      name: 'Route Test User',
      githubConnected: true,
      githubUsername: 'route-tester',
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini-2.5-flash'],
      createdAt: Date.now()
    };
    db.createUser(testUser);
    db.setGithubToken(testUser.id, 'ghp_route_token_123456789', 'route-tester');

    sessionToken = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    db.createSession(testUser.id, sessionToken);

    headers = {
      'Content-Type': 'application/json',
      'Cookie': `squadforge_session=${sessionToken}`
    };
  });

  afterEach(() => {
    GitHubLifecycleService.setCustomClientFactory(undefined);
  });

  after(() => {
    if (serverInstance) {
      serverInstance.close();
    }
  });

  test('Route 1: GET /api/github/status verifies connection without leaking token', async () => {
    const mockFetch = createMockFetch({
      'GET https://api.github.com/user': {
        data: { login: 'route-tester', name: 'Route Tester', public_repos: 5 }
      }
    });
    GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

    const res = await fetch(`${baseUrl}/api/github/status`, { headers });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.connected, true);
    assert.equal(data.username, 'route-tester');
    assert.equal(data.token, undefined);
  });

  test('Route 2: GET /api/github/repos lists accessible repositories', async () => {
    const mockFetch = createMockFetch({
      'GET https://api.github.com/user/repos': {
        data: [
          {
            id: 201,
            name: 'route-repo',
            full_name: 'route-tester/route-repo',
            owner: { login: 'route-tester' },
            private: false,
            default_branch: 'main',
            permissions: { admin: true, push: true, pull: true },
            updated_at: '2026-11-06T00:00:00Z'
          }
        ]
      }
    });
    GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

    const res = await fetch(`${baseUrl}/api/github/repos`, { headers });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(Array.isArray(data.repos), true);
    assert.equal(data.repos.length, 1);
    assert.equal(data.repos[0].name, 'route-repo');
  });

  test('Route 3: POST /api/github/import-repo imports repository into a new build', async () => {
    const mockFetch = createMockFetch({
      'GET https://api.github.com/repos/route-tester/route-repo': {
        data: { id: 201, name: 'route-repo', html_url: 'https://github.com/route-tester/route-repo', default_branch: 'main' }
      },
      'GET https://api.github.com/repos/route-tester/route-repo/git/ref/heads/main': {
        data: { object: { sha: 'route_sha_123' } }
      },
      'GET https://api.github.com/repos/route-tester/route-repo/git/trees/route_sha_123?recursive=1': {
        data: {
          tree: [{ path: 'server.ts', type: 'blob', sha: 'route_blob_1', size: 100 }]
        }
      },
      'GET https://api.github.com/repos/route-tester/route-repo/git/blobs/route_blob_1': {
        data: { encoding: 'utf-8', content: 'console.log("imported server");' }
      }
    });
    GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

    const res = await fetch(`${baseUrl}/api/github/import-repo`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ owner: 'route-tester', repo: 'route-repo' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.importedFilesCount, 1);
    assert.ok(data.buildId);
  });

  test('Route 4: Enforces tenant isolation (rejects accessing another user build)', async () => {
    const otherUserBuild: Build = {
      id: `bld_foreign_${Date.now()}`,
      userId: 'different_user_id',
      idea: 'Foreign Project',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    };
    db.saveBuild(otherUserBuild);

    const res = await fetch(`${baseUrl}/api/builds/${otherUserBuild.id}/github/branches`, { headers });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Forbidden/i);
  });

  test('Route 5: POST /api/builds/:id/github/commit returns 202 when sensitive approval is required', async () => {
    const userBuild: Build = {
      id: `bld_route_gate_${Date.now()}`,
      userId: testUser.id,
      idea: 'Route Gate Project',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      githubOwner: 'route-tester',
      githubRepoName: 'route-repo',
      gitBranch: 'main', // sensitive branch
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    };
    db.saveBuild(userBuild);
    db.setFile(userBuild.id, {
      buildId: userBuild.id,
      path: '.env',
      content: 'API_KEY=secret_123',
      version: 1
    });

    const mockFetch = createMockFetch({
      'GET https://api.github.com/repos/route-tester/route-repo/git/ref/heads/main': {
        data: { object: { sha: 'head_sha_999' } }
      },
      'GET https://api.github.com/repos/route-tester/route-repo/git/trees/head_sha_999?recursive=1': {
        data: { tree: [] }
      }
    });
    GitHubLifecycleService.setCustomClientFactory(t => new GitHubClient({ token: t, customFetch: mockFetch }));

    const res = await fetch(`${baseUrl}/api/builds/${userBuild.id}/github/commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Add environment configuration' })
    });

    assert.equal(res.status, 202);
    const data = await res.json();
    assert.equal(data.requiresApproval, true);
    assert.ok(data.approvalRequest?.id);
  });
});
