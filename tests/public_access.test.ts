import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { resolveUser } from '../server.js';
import { hashPassword, generateSessionToken } from '../server/crypto.js';
import { User, Build } from '../server/types.js';
import { GitHubService } from '../server/github.js';

describe('SquadForge Public Access, Multi-Tenant Session Isolation & Security', () => {
  beforeEach(() => {
    db.resetTestClock();
  });

  test('Public visitors without credentials receive an isolated guest session automatically', () => {
    const mockReq1: any = {
      cookies: {},
      headers: {},
      ip: '127.0.0.1'
    };
    const mockRes1: any = {
      cookie: (name: string, val: string, opts: any) => {
        mockReq1.cookies[name] = val;
      }
    };

    const guest1 = resolveUser(mockReq1, mockRes1);
    assert.ok(guest1);
    assert.ok(guest1.id.startsWith('guest_'), 'Guest user ID should start with guest_');
    assert.equal(guest1.isAnonymous, true, 'isAnonymous flag must be true');
    assert.equal(guest1.costLimitPerBuild, 2.0, 'Abuse prevention cost cap of $2.00 must be enforced');
    assert.ok(mockReq1.sessionToken, 'Session token must be populated');
    assert.ok(mockReq1.cookies['squadforge_session'], 'Session cookie must be issued');

    // Calling resolveUser again with the issued session cookie returns the exact same guest
    const mockReqRevisit: any = {
      cookies: { squadforge_session: mockReq1.cookies['squadforge_session'] },
      headers: {},
      ip: '127.0.0.1'
    };
    const mockResRevisit: any = { cookie: () => {} };

    const revisitedUser = resolveUser(mockReqRevisit, mockResRevisit);
    assert.equal(revisitedUser.id, guest1.id, 'Refreshing page or subsequent requests must maintain the same guest session');
  });

  test('Different public visitors receive isolated sessions and cannot see or overwrite each others builds', () => {
    // Visitor 1
    const mockReq1: any = { cookies: {}, headers: {}, ip: '192.168.1.1' };
    const mockRes1: any = { cookie: (n: string, v: string) => { mockReq1.cookies[n] = v; } };
    const guest1 = resolveUser(mockReq1, mockRes1);

    // Visitor 2
    const mockReq2: any = { cookies: {}, headers: {}, ip: '192.168.1.2' };
    const mockRes2: any = { cookie: (n: string, v: string) => { mockReq2.cookies[n] = v; } };
    const guest2 = resolveUser(mockReq2, mockRes2);

    assert.notEqual(guest1.id, guest2.id, 'Each visitor must receive a unique guest ID');

    // Create build for Visitor 1
    const build1 = db.saveBuild({
      id: `bld_guest1_${Date.now()}`,
      userId: guest1.id,
      idea: 'Public Visitor 1 Project',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 50,
      totalCost: 0.001,
      costLimit: 2.0,
      maxDurationSeconds: 120,
      patchesAppliedCount: 1
    });

    // Create build for Visitor 2
    const build2 = db.saveBuild({
      id: `bld_guest2_${Date.now()}`,
      userId: guest2.id,
      idea: 'Public Visitor 2 Project',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 100,
      totalCost: 0.002,
      costLimit: 2.0,
      maxDurationSeconds: 120,
      patchesAppliedCount: 2
    });

    const guest1Builds = db.getAllBuilds(guest1.id);
    assert.ok(guest1Builds.some(b => b.id === build1.id), 'Visitor 1 should see own project');
    assert.equal(guest1Builds.some(b => b.id === build2.id), false, 'Visitor 1 must NOT see Visitor 2 project');

    const guest2Builds = db.getAllBuilds(guest2.id);
    assert.ok(guest2Builds.some(b => b.id === build2.id), 'Visitor 2 should see own project');
    assert.equal(guest2Builds.some(b => b.id === build1.id), false, 'Visitor 2 must NOT see Visitor 1 project');
  });

  test('Registered accounts and authentication records remain intact and recoverable', async () => {
    const existingEmail = `registered.${Date.now()}@squadforge.test`;
    const passwordHash = await hashPassword('RegisteredPass#2026');

    const registeredUser: User = {
      id: `usr_reg_${Date.now()}`,
      email: existingEmail,
      name: 'Registered Senior Engineer',
      passwordHash,
      githubConnected: true,
      githubUsername: 'octocat',
      costLimitPerBuild: 10.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    };
    db.createUser(registeredUser);

    // Verify user can still be fetched from persistent database
    const foundUser = db.findUserByEmail(existingEmail);
    assert.ok(foundUser);
    assert.equal(foundUser.name, 'Registered Senior Engineer');
    assert.equal(foundUser.githubUsername, 'octocat');
    assert.equal(foundUser.costLimitPerBuild, 10.0);

    // Verify registered user session resolves correctly when session cookie is provided
    const userSessionToken = generateSessionToken();
    db.createSession(registeredUser.id, userSessionToken);

    const mockReqUser: any = {
      cookies: { squadforge_session: userSessionToken },
      headers: {},
      ip: '127.0.0.1'
    };
    const mockResUser: any = { cookie: () => {} };

    const resolved = resolveUser(mockReqUser, mockResUser);
    assert.equal(resolved.id, registeredUser.id, 'Existing authenticated session must resolve to the registered user');
    assert.equal(resolved.isAnonymous, undefined, 'Registered user is not anonymous');
  });

  test('Abuse prevention: public guest users cannot exceed safe cost limit', () => {
    const mockReq: any = { cookies: {}, headers: {}, ip: '10.0.0.1' };
    const mockRes: any = { cookie: () => {} };
    const guest = resolveUser(mockReq, mockRes);

    assert.ok(guest.costLimitPerBuild <= 2.0, 'Guest user default cost limit must be capped at $2.00');
  });

  test('Security: Guest A cannot access or modify Guest B project files', () => {
    const mockReqA: any = { cookies: {}, headers: {}, ip: '10.0.0.1' };
    const mockResA: any = { cookie: (n: string, v: string) => { mockReqA.cookies[n] = v; } };
    const guestA = resolveUser(mockReqA, mockResA);

    const mockReqB: any = { cookies: {}, headers: {}, ip: '10.0.0.2' };
    const mockResB: any = { cookie: (n: string, v: string) => { mockReqB.cookies[n] = v; } };
    const guestB = resolveUser(mockReqB, mockResB);

    const buildB = db.saveBuild({
      id: `bld_priv_${Date.now()}`,
      userId: guestB.id,
      idea: 'Guest B Private Work',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 10,
      totalCost: 0.0001,
      costLimit: 2.0,
      maxDurationSeconds: 60,
      patchesAppliedCount: 1
    });

    // Check build ownership
    const fetchedBuild = db.getBuild(buildB.id);
    assert.ok(fetchedBuild);
    assert.equal(fetchedBuild.userId, guestB.id);
    assert.notEqual(fetchedBuild.userId, guestA.id, 'Build must belong strictly to Guest B');
  });

  test('Security: Production requires valid APP_URL for OAuth redirects and rejects unverified hosts', () => {
    const origEnv = process.env.NODE_ENV;
    const origAppUrl = process.env.APP_URL;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.APP_URL;

      // In production without APP_URL, getTrustedOrigin falls back to loopback and never trusts arbitrary headers
      const trusted = GitHubService.getTrustedOrigin({
        headers: { host: 'malicious-spoofed-host.evil.com' },
        protocol: 'https'
      } as any);

      assert.equal(trusted.includes('malicious-spoofed-host.evil.com'), false, 'Must not trust spoofed host in production');
      assert.match(trusted, /^http:\/\/127\.0\.0\.1:/, 'Must fall back safely to loopback origin');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origAppUrl !== undefined) {
        process.env.APP_URL = origAppUrl;
      } else {
        delete process.env.APP_URL;
      }
    }
  });
});
