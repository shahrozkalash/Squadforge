import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { hashPassword, verifyPassword, generateSessionToken } from '../server/crypto.js';
import { User, Build } from '../server/types.js';

describe('SquadForge Authentication Security & Multi-Tenant Authorization', () => {
  let userA: User;
  let userB: User;

  beforeEach(async () => {
    db.resetTestClock();
    const passHashA = await hashPassword('SecurePasswordA#2026');
    const passHashB = await hashPassword('SecurePasswordB#2026');

    userA = {
      id: `usr_a_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      email: 'user.a@squadforge.test',
      name: 'User A',
      passwordHash: passHashA,
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    };
    db.createUser(userA);

    userB = {
      id: `usr_b_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      email: 'user.b@squadforge.test',
      name: 'User B',
      passwordHash: passHashB,
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    };
    db.createUser(userB);
  });

  test('Session tokens store securely and expire after SESSION_DURATION', () => {
    const plainToken = generateSessionToken();
    const session = db.createSession(userA.id, plainToken);
    assert.ok(session);
    assert.equal(session.userId, userA.id);

    // Retrieve with valid token
    const fetched = db.getSession(plainToken);
    assert.ok(fetched);
    assert.equal(fetched.userId, userA.id);

    // Simulate clock expiration past 7 days
    const mockExpiry = session.expiresAt + 1000;
    db.setTestClock(() => mockExpiry);

    const expired = db.getSession(plainToken);
    assert.equal(expired, undefined, 'Expired session must return undefined and be deleted');
  });

  test('IDOR protection: User A cannot see User B builds', () => {
    const buildA = db.saveBuild({
      id: `bld_a_${Date.now()}`,
      userId: userA.id,
      idea: 'User A Private Project',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 0
    });

    const buildB = db.saveBuild({
      id: `bld_b_${Date.now()}`,
      userId: userB.id,
      idea: 'User B Private Project',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 0
    });

    const userABuilds = db.getAllBuilds(userA.id);
    assert.ok(userABuilds.some(b => b.id === buildA.id));
    assert.equal(userABuilds.some(b => b.id === buildB.id), false, 'User A must NOT see User B build');

    const userBBuilds = db.getAllBuilds(userB.id);
    assert.ok(userBBuilds.some(b => b.id === buildB.id));
    assert.equal(userBBuilds.some(b => b.id === buildA.id), false, 'User B must NOT see User A build');
  });

  test('Rate limiting triggers lockout after 5 consecutive failed login attempts', () => {
    const ipKey = 'rate_test_ip_127.0.0.1';
    db.clearRateLimit(ipKey);

    assert.equal(db.checkRateLimit(ipKey).allowed, true);

    // 4 failed attempts: still allowed
    for (let i = 0; i < 4; i++) {
      db.recordFailedLogin(ipKey);
      assert.equal(db.checkRateLimit(ipKey).allowed, true);
    }

    // 5th failed attempt: locked out
    db.recordFailedLogin(ipKey);
    const check = db.checkRateLimit(ipKey);
    assert.equal(check.allowed, false);
    assert.ok(check.retryAfterSeconds > 800, 'Should lock for ~15 minutes (900s)');
  });
});
