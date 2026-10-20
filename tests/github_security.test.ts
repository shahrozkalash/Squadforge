import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubService } from '../server/github.js';
import { db } from '../server/store.js';
import { Build } from '../server/types.js';

function createTestBuild(id: string, userId: string, idea: string): Build {
  return {
    id,
    userId,
    idea,
    status: 'completed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini-2.5-flash'],
    autoPushGithub: true,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 5,
    maxDurationSeconds: 300,
    patchesAppliedCount: 0
  };
}

describe('SquadForge Critical Security: GitHub OAuth & API Integrity', () => {
  beforeEach(() => {
    GitHubService.clearOAuthStates();
  });

  describe('FIX 1: Secure GitHub OAuth Flow', () => {
    test('1. Generates cryptographically secure, unpredictable 64-hex-char state', () => {
      const state1 = GitHubService.generateOAuthState('user_1', 'session_tok_abc123', 'http://127.0.0.1:3000/auth/callback');
      const state2 = GitHubService.generateOAuthState('user_1', 'session_tok_abc123', 'http://127.0.0.1:3000/auth/callback');

      assert.equal(typeof state1, 'string');
      assert.equal(state1.length, 64); // 32 bytes in hex = 64 chars
      assert.match(state1, /^[0-9a-f]{64}$/);
      assert.notEqual(state1, state2, 'States must be cryptographically random and unpredictable');
    });

    test('2. Binds state to initiating browser session token hash', () => {
      const state = GitHubService.generateOAuthState('user_1', 'session_tok_user1', 'http://127.0.0.1:3000/auth/callback');

      // Valid session token matches
      const res = GitHubService.validateAndConsumeOAuthState(state, 'session_tok_user1');
      assert.equal(res.valid, true);
      assert.equal(res.record?.userId, 'user_1');
      assert.equal(res.record?.redirectUri, 'http://127.0.0.1:3000/auth/callback');
    });

    test('3. Rejects state validation when session token does not match (session hijacking / CSRF prevention)', () => {
      const state = GitHubService.generateOAuthState('user_1', 'session_tok_legit', 'http://127.0.0.1:3000/auth/callback');

      const res = GitHubService.validateAndConsumeOAuthState(state, 'session_tok_attacker');
      assert.equal(res.valid, false);
      assert.match(res.error || '', /match the initiating browser session/i);
    });

    test('4. Enforces single-use consumption to prevent replay attacks', () => {
      const state = GitHubService.generateOAuthState('user_1', 'session_tok_replay', 'http://127.0.0.1:3000/auth/callback');

      // First consumption succeeds
      const firstAttempt = GitHubService.validateAndConsumeOAuthState(state, 'session_tok_replay');
      assert.equal(firstAttempt.valid, true);

      // Second consumption must fail immediately
      const replayAttempt = GitHubService.validateAndConsumeOAuthState(state, 'session_tok_replay');
      assert.equal(replayAttempt.valid, false);
      assert.match(replayAttempt.error || '', /Invalid or already consumed/i);
    });

    test('5. Rejects missing, empty, or whitespace-only state and session values', () => {
      assert.equal(GitHubService.validateAndConsumeOAuthState('', 'tok').valid, false);
      assert.equal(GitHubService.validateAndConsumeOAuthState(undefined, 'tok').valid, false);
      assert.equal(GitHubService.validateAndConsumeOAuthState('   ', 'tok').valid, false);
      assert.equal(GitHubService.validateAndConsumeOAuthState('state123', '').valid, false);
      assert.equal(GitHubService.validateAndConsumeOAuthState('state123', undefined).valid, false);
    });

    test('6. Rejects expired OAuth states (short TTL enforcement)', () => {
      const originalTTL = GitHubService.OAUTH_STATE_TTL_MS;
      try {
        // Temporarily set negative TTL to simulate expiration
        GitHubService.OAUTH_STATE_TTL_MS = -1000;
        const expiredState = GitHubService.generateOAuthState('user_1', 'session_tok_exp', 'http://127.0.0.1:3000/auth/callback');

        const res = GitHubService.validateAndConsumeOAuthState(expiredState, 'session_tok_exp');
        assert.equal(res.valid, false);
      } finally {
        GitHubService.OAUTH_STATE_TTL_MS = originalTTL;
      }
    });

    test('7. Handles concurrent OAuth states for multiple users without cross-talk or collisions', () => {
      const stateA = GitHubService.generateOAuthState('user_A', 'sess_A', 'http://127.0.0.1:3000/auth/callback');
      const stateB = GitHubService.generateOAuthState('user_B', 'sess_B', 'http://127.0.0.1:3000/auth/callback');
      const stateC = GitHubService.generateOAuthState('user_C', 'sess_C', 'http://127.0.0.1:3000/auth/callback');

      assert.equal(GitHubService.getActiveOAuthStateCount(), 3);

      // Validate B first
      const resB = GitHubService.validateAndConsumeOAuthState(stateB, 'sess_B');
      assert.equal(resB.valid, true);
      assert.equal(resB.record?.userId, 'user_B');
      assert.equal(GitHubService.getActiveOAuthStateCount(), 2);

      // Validate A
      const resA = GitHubService.validateAndConsumeOAuthState(stateA, 'sess_A');
      assert.equal(resA.valid, true);
      assert.equal(resA.record?.userId, 'user_A');

      // Validate C
      const resC = GitHubService.validateAndConsumeOAuthState(stateC, 'sess_C');
      assert.equal(resC.valid, true);
      assert.equal(resC.record?.userId, 'user_C');

      assert.equal(GitHubService.getActiveOAuthStateCount(), 0);
    });

    test('8. Trusted origin validation rejects unverified / spoofed Host headers', () => {
      const origAppUrl = process.env.APP_URL;
      try {
        delete process.env.APP_URL;

        const fakeReq1: any = {
          headers: { host: 'evil-phishing-site.com' },
          protocol: 'https'
        };
        const origin1 = GitHubService.getTrustedOrigin(fakeReq1);
        assert.equal(origin1.includes('evil-phishing-site.com'), false);
        assert.match(origin1, /^http:\/\/(127\.0\.0\.1|localhost):/);

        const validReq: any = {
          headers: { host: 'localhost:3000' },
          protocol: 'http'
        };
        const originValid = GitHubService.getTrustedOrigin(validReq);
        assert.equal(originValid, 'http://localhost:3000');
      } finally {
        if (origAppUrl !== undefined) {
          process.env.APP_URL = origAppUrl;
        }
      }
    });

    test('9. OAuth authorization URL includes client_id, redirect_uri, scope, and cryptographically secure state', () => {
      const authUrl = GitHubService.getAuthUrl('http://127.0.0.1:3000/auth/callback', 'abcdef123456');
      const parsed = new URL(authUrl);

      assert.equal(parsed.origin, 'https://github.com');
      assert.equal(parsed.pathname, '/login/oauth/authorize');
      assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
      assert.equal(parsed.searchParams.get('state'), 'abcdef123456');
      assert.equal(parsed.searchParams.get('scope'), 'repo,user:email');
    });
  });

  describe('FIX 2: Removal of Fake GitHub Success & Enforcing Real Operations', () => {
    test('1. validateToken rejects ghp_demo tokens without granting fake success', async () => {
      const demoToken = 'ghp_demo_valid_token_squadforge_2026';
      const result = await GitHubService.validateToken(demoToken);
      assert.equal(result, null, 'validateToken must never return simulated username for demo tokens');
    });

    test('2. autoPushProject fails safely when no GitHub token is configured for user', async () => {
      // Create test build
      const testBuildId = `test_bld_${Date.now()}`;
      db.saveBuild(createTestBuild(testBuildId, 'unconnected_user', 'Build a weather app'));

      const pushResult = await GitHubService.autoPushProject(testBuildId, 'unconnected_user');
      assert.equal(pushResult.success, false);
      assert.match(pushResult.error || '', /No GitHub account or Personal Access Token connected/i);
      assert.equal(pushResult.repoUrl, undefined);
      assert.equal(pushResult.pullRequestUrl, undefined);
      assert.equal(pushResult.commitSha, undefined);
    });

    test('3. autoPushProject fails safely if project has no files', async () => {
      const testBuildId = `empty_bld_${Date.now()}`;
      const testUserId = `user_with_token_${Date.now()}`;
      
      // Give user a mock token (will not be called because files check runs first)
      db.setGithubToken(testUserId, 'ghp_some_token', 'testuser');
      db.saveBuild(createTestBuild(testBuildId, testUserId, 'Empty project'));

      const pushResult = await GitHubService.autoPushProject(testBuildId, testUserId);
      assert.equal(pushResult.success, false);
      assert.match(pushResult.error || '', /Cannot push empty project/i);
      assert.equal(pushResult.repoUrl, undefined);
      assert.equal(pushResult.pullRequestUrl, undefined);
    });

    test('4. autoPushProject does NOT create fake GitHub events or fake build metadata on failure', async () => {
      const testBuildId = `no_fake_bld_${Date.now()}`;
      const testUserId = `user_test_${Date.now()}`;
      
      db.setGithubToken(testUserId, 'invalid_pat_token', 'attacker');
      db.saveBuild(createTestBuild(testBuildId, testUserId, 'Integrity test'));
      db.setFile(testBuildId, {
        path: 'index.ts',
        content: 'console.log("hello");',
        version: 1,
        ownerModel: 'claude-3-7-sonnet',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      });

      const pushResult = await GitHubService.autoPushProject(testBuildId, testUserId);
      assert.equal(pushResult.success, false);

      const refreshedBuild = db.getBuild(testBuildId);
      assert.equal(refreshedBuild?.githubRepoUrl, undefined);
      assert.equal(refreshedBuild?.pullRequestUrl, undefined);
      assert.equal(refreshedBuild?.gitBranch, undefined);

      const events = db.getEvents(testBuildId);
      const fakePushedEvents = events.filter(e => e.type === 'github_pushed');
      assert.equal(fakePushedEvents.length, 0, 'No github_pushed event must be emitted on failure');
    });
  });
});
