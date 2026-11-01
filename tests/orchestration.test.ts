import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { 
  callUnifiedGateway, 
  extractAndParseJson, 
  parseVerifierResponse, 
  validateModelActionResponse 
} from '../server/gateway.js';
import { modelRegistry, AGENT_SPECS } from '../server/modelRegistry.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { SandboxRunner } from '../server/swarm/sandboxRunner.js';
import { db } from '../server/store.js';
import { Build, Task, ProjectFile, User } from '../server/types.js';
import { 
  hashPassword, 
  verifyPassword, 
  generateSessionToken, 
  encryptToken, 
  decryptToken 
} from '../server/crypto.js';

describe('SquadForge Model Routing & Gateway Reliability', () => {
  test('Unsupported model identifier returns UNSUPPORTED_MODEL error', async () => {
    const result = await callUnifiedGateway({
      modelId: 'non-existent-super-ai',
      prompt: 'Generate code'
    });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'UNSUPPORTED_MODEL');
    assert.equal(result.actualModelUsed, 'none');
    assert.equal(result.providerUsed, 'none');
    assert.ok(result.error?.includes('not registered'));
  });

  test('3P model without API key and allowFallback=false fails with NO_PROVIDER', async () => {
    const result = await callUnifiedGateway({
      modelId: 'grok',
      prompt: 'Write server route',
      allowFallback: false
    });

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'NO_PROVIDER');
    assert.equal(result.isFallback, false);
    assert.equal(result.actualModelUsed, 'none');
    assert.ok(result.error?.includes('requires OPENROUTER_API_KEY'));
  });

  test('Configured fallback accurately flags isFallback and real model in metadata', async () => {
    const result = await callUnifiedGateway({
      modelId: 'claude',
      prompt: 'Output JSON: {"actions": [{"action": "create_file", "path": "src/test.ts", "content": "export const x = 1;"}]}',
      allowFallback: true
    });

    if (result.success) {
      assert.equal(result.isFallback, true);
      assert.equal(result.providerUsed, 'gemini');
      assert.equal(result.actualModelUsed, 'gemini-3.8-flash');
      assert.ok(result.fallbackReason?.includes('Primary provider'));
      assert.notEqual(result.actualModelUsed, 'anthropic/claude-3.5-sonnet');
    } else {
      assert.equal(result.success, false);
      assert.ok(['NO_PROVIDER', 'INVALID_API_KEY', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'RATE_LIMITED'].includes(result.errorCode || ''));
    }
  });

  test('Malformed JSON action response is not accepted as success', () => {
    const rawAiGarbage = 'Here is your file:\n```javascript\nconst x = 10;\n```\nHope this helps!';
    const parsed = extractAndParseJson(rawAiGarbage);
    assert.equal(parsed, null);
  });

  test('Action validator rejects invalid or empty actions', () => {
    assert.equal(validateModelActionResponse({ actions: [{ action: 'create_file' }] }), null);
    assert.equal(validateModelActionResponse({ actions: [{ action: 'delete_database' }] }), null);
    assert.equal(validateModelActionResponse({ actions: [] }), null);
    assert.equal(validateModelActionResponse({ actions: [{ action: 'patch_file', path: 'src/App.tsx' }] }), null);
  });

  test('Action validator accepts valid structured patch, create, and task actions', () => {
    const valid = validateModelActionResponse({
      actions: [
        {
          action: 'create_file',
          path: 'src/valid.ts',
          content: 'export const hello = "world";'
        },
        {
          action: 'patch_file',
          path: 'src/existing.ts',
          edits: [{ find: 'a', replace: 'b' }]
        },
        {
          action: 'create_task',
          title: 'Add test suite',
          description: 'Comprehensive assertions',
          filePaths: ['tests/valid.test.ts'],
          priority: 2,
          dependencies: ['tsk_prev_1']
        }
      ]
    });

    assert.ok(valid);
    assert.equal(valid.actions.length, 3);
  });

  after(() => {
    const handles = (process as any)._getActiveHandles();
    for (const h of handles) {
      if (h && typeof h.destroy === 'function' && h?.constructor?.name?.includes('Socket')) {
        try { h.destroy(); } catch {}
      }
    }
  });
});

describe('Verifier Response Validation & False Completion Prevention', () => {
  test('Malformed verifier response is safely rejected as null', () => {
    assert.equal(parseVerifierResponse('The project looks good to me!'), null);
    assert.equal(parseVerifierResponse('{"status": "ok", "summary": "completed"}'), null);
    assert.equal(parseVerifierResponse('{"approved": "yes"}'), null);
  });

  test('Failed verification correctly extracts missing requirements', () => {
    const raw = JSON.stringify({
      approved: false,
      summary: 'Missing unit test coverage and authentication guard',
      missingRequirements: ['Write test fixtures', 'Add route guard']
    });

    const parsed = parseVerifierResponse(raw);
    assert.ok(parsed);
    assert.equal(parsed.approved, false);
    assert.equal(parsed.summary, 'Missing unit test coverage and authentication guard');
    assert.equal(parsed.missingRequirements?.length, 2);
    assert.equal(parsed.missingRequirements?.[0], 'Write test fixtures');
  });

  test('Successful verification requires strict boolean approved: true', () => {
    const raw = JSON.stringify({
      approved: true,
      summary: 'All requirements verified against specification',
      missingRequirements: []
    });

    const parsed = parseVerifierResponse(raw);
    assert.ok(parsed);
    assert.equal(parsed.approved, true);
    assert.equal(parsed.missingRequirements?.length, 0);
  });
});

describe('Task State Machine, Dependencies & Retry Exhaustion', () => {
  const buildId = 'test_retry_build_123';

  beforeEach(() => {
    db.saveBuild({
      id: buildId,
      userId: 'test_user',
      idea: 'Test Retry Exhaustion',
      status: 'running',
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
  });

  test('Task tracks retry count and marks failed when retries are exhausted', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Flaky Integration Task',
      description: 'Will fail multiple times',
      filePaths: ['src/flaky.ts'],
      priority: 2,
      maxRetries: 3
    });

    assert.ok(task.status === 'open' || task.status === 'pending');
    assert.equal(task.retryCount || 0, 0);

    // Attempt 1 fails
    TaskManager.releaseTask(buildId, task.id, 'model-1', 'Compile error attempt 1');
    let updated = db.getTask(buildId, task.id);
    assert.ok(updated?.status === 'open' || updated?.status === 'retrying' || updated?.status === 'pending');
    assert.equal(updated?.retryCount, 1);
    assert.equal(updated?.lastError, 'Compile error attempt 1');

    // Attempt 2 fails
    TaskManager.releaseTask(buildId, task.id, 'model-2', 'Compile error attempt 2');
    updated = db.getTask(buildId, task.id);
    assert.ok(updated?.status === 'open' || updated?.status === 'retrying' || updated?.status === 'pending');
    assert.equal(updated?.retryCount, 2);

    // Attempt 3 fails -> Must transition to 'failed' and NOT loop infinitely
    TaskManager.releaseTask(buildId, task.id, 'model-3', 'Compile error attempt 3');
    updated = db.getTask(buildId, task.id);
    assert.equal(updated?.status, 'failed');
    assert.ok(updated?.error?.includes('Exhausted retries (3/3)'));
    assert.equal(updated?.claimedBy, null);
  });

  test('Successful task marks completed and clears active errors', () => {
    db.setFile(buildId, {
      path: 'src/success.ts',
      content: 'export const success = true;',
      version: 1,
      history: []
    });

    const task = TaskManager.createNewTask(buildId, {
      title: 'Successful Task',
      description: 'Completes cleanly',
      filePaths: ['src/success.ts'],
      priority: 2
    });

    TaskManager.completeTask(buildId, task.id, 'gemini');
    const updated = db.getTask(buildId, task.id);
    assert.ok(updated?.status === 'done' || updated?.status === 'completed');
    assert.ok(updated?.completedAt);
    assert.equal(updated?.error, undefined);
  });

  test('Dependency-aware scheduling blocks child tasks until prerequisites complete', () => {
    db.setFile(buildId, {
      path: 'src/db/schema.ts',
      content: 'export const schema = {};',
      version: 1,
      history: []
    });

    const parentTask = TaskManager.createNewTask(buildId, {
      title: 'Database Schema Design',
      description: 'Create initial database schema',
      filePaths: ['src/db/schema.ts'],
      priority: 2
    });

    const childTask = TaskManager.createNewTask(buildId, {
      title: 'Backend API using Database',
      description: 'Endpoints that query the database',
      filePaths: ['src/api/routes.ts'],
      priority: 2,
      dependencies: [parentTask.id]
    });

    // Parent is not completed yet -> child dependencies are not met
    assert.equal(TaskManager.areDependenciesMet(buildId, childTask), false);

    // Complete parent
    TaskManager.completeTask(buildId, parentTask.id, 'nemotron');

    // Now child dependencies are met!
    assert.equal(TaskManager.areDependenciesMet(buildId, childTask), true);
  });
});

describe('Sandbox Integrity Checks, Security Auditing & Test Execution', () => {
  const buildId = 'test_sandbox_build_456';

  beforeEach(() => {
    db.saveBuild({
      id: buildId,
      userId: 'test_user',
      idea: 'Test Sandbox Verification',
      status: 'running',
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
  });

  test('Unbalanced brackets or invalid JSON triggers failed sandbox and creates fix task', async () => {
    await MergeManager.createFile(buildId, 'test-model', {
      action: 'create_file',
      path: 'src/broken.ts',
      content: 'function broken() { if (true) { console.log("missing brace"); }'
    });

    const result = SandboxRunner.runIntegrityCheck(buildId);
    assert.equal(result.passed, false);
    assert.ok(result.errors.length > 0);

    const tasks = db.getTasks(buildId);
    const fixTask = tasks.find(t => t.isFixTask && t.filePaths.includes('src/broken.ts'));
    assert.ok(fixTask);
    assert.equal(fixTask.priority, 1);
  });

  test('Security audit catches hardcoded secrets and dangerous eval', async () => {
    const secBuildId = 'test_security_audit_build';
    db.saveBuild({
      id: secBuildId,
      userId: 'test_user',
      idea: 'Security Test',
      status: 'running',
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

    await MergeManager.createFile(secBuildId, 'test-model', {
      action: 'create_file',
      path: 'src/insecure.ts',
      content: 'const key = "sk-123456789012345678901234567890";\neval("console.log(key)");\n'
    });

    const result = SandboxRunner.runIntegrityCheck(secBuildId);
    assert.equal(result.passed, false);
    assert.ok(result.securityAudit);
    assert.ok(result.securityAudit.findings.length >= 2);
    assert.equal(result.securityAudit.passed, false);
  });

  test('Valid files pass sandbox integrity check and create verified checkpoint', async () => {
    const cleanBuildId = 'test_clean_build_789';
    db.saveBuild({
      id: cleanBuildId,
      userId: 'test_user',
      idea: 'Clean Build',
      status: 'running',
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

    await MergeManager.createFile(cleanBuildId, 'test-model', {
      action: 'create_file',
      path: 'src/clean.ts',
      content: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    });

    await MergeManager.createFile(cleanBuildId, 'test-model', {
      action: 'create_file',
      path: 'tests/engine.test.ts',
      content: 'import test from "node:test";\ntest("adds numbers", () => {});\n'
    });

    const result = SandboxRunner.runIntegrityCheck(cleanBuildId);
    assert.equal(result.passed, true);
    assert.equal(result.errors.length, 0);
    assert.ok(result.testReport);
    assert.equal(result.testReport.total, 1);
    assert.equal(result.testReport.passed, 1);

    const checkpoints = db.getCheckpoints(cleanBuildId);
    assert.ok(checkpoints.length > 0);
  });
});

describe('Multi-Agent Development Team & Registry Architecture', () => {
  test('All specialized agent roles are defined with complete specifications', () => {
    const expectedRoles: (keyof typeof AGENT_SPECS)[] = [
      'project_manager',
      'software_architect',
      'frontend_developer',
      'backend_developer',
      'database_specialist',
      'integration_specialist',
      'qa_testing_specialist',
      'debugging_specialist',
      'security_specialist',
      'devops_release_specialist',
      'fullstack_developer'
    ];

    const models = modelRegistry.getAll();
    assert.ok(models.length >= 10);

    for (const role of expectedRoles) {
      const spec = AGENT_SPECS[role];
      assert.ok(spec, `Role spec for ${role} must exist`);
      assert.ok(spec.title.length > 0);
      assert.ok(spec.responsibilities.length >= 3);

      const model = modelRegistry.getByRole(role);
      assert.ok(model, `A model must be registered for role ${role}`);
    }
  });
});

describe('SquadForge Secure Authentication, Sessions & Multi-Tenant Isolation', () => {
  test('Password hashing produces secure salted hash and verifies correctly', async () => {
    const plain = 'SquadForgeMaster2026!';
    const hash = await hashPassword(plain);

    assert.notEqual(hash, plain);
    assert.ok(hash.startsWith('$2')); // Bcrypt format

    const isMatch = await verifyPassword(plain, hash);
    assert.equal(isMatch, true);

    const isBadMatch = await verifyPassword('WrongPassword123', hash);
    assert.equal(isBadMatch, false);
  });

  test('User creation normalizes email and prevents duplicate account registration', () => {
    const testUser: User = {
      id: 'usr_test_auth_1',
      name: 'Auth Tester',
      email: '  TEST.USER@Domain.COM  ',
      passwordHash: 'dummy_hash',
      githubConnected: false,
      costLimitPerBuild: 5,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    };

    db.createUser(testUser);

    const retrieved = db.findUserByEmail('test.user@domain.com');
    assert.ok(retrieved);
    assert.equal(retrieved.email, 'test.user@domain.com');

    // Case-insensitive query
    const retrievedUpper = db.findUserByEmail('TEST.USER@DOMAIN.COM');
    assert.ok(retrievedUpper);
    assert.equal(retrievedUpper.id, 'usr_test_auth_1');
  });

  test('Brute-force login rate limiter locks out after 5 consecutive failures', () => {
    const rateLimitKey = 'test_ip_bruteforce_email@test.com';
    db.clearRateLimit(rateLimitKey);

    let check = db.checkRateLimit(rateLimitKey);
    assert.equal(check.allowed, true);

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      db.recordFailedLogin(rateLimitKey);
      check = db.checkRateLimit(rateLimitKey);
      assert.equal(check.allowed, true);
    }

    // 5th failed attempt locks out
    db.recordFailedLogin(rateLimitKey);
    check = db.checkRateLimit(rateLimitKey);
    assert.equal(check.allowed, false);
    assert.ok(check.retryAfterSeconds > 800); // 15 minute lock

    // Clearing rate limit restores access
    db.clearRateLimit(rateLimitKey);
    assert.equal(db.checkRateLimit(rateLimitKey).allowed, true);
  });

  test('Password reset token is cryptographically secure and consumed strictly once', () => {
    const userEmail = 'test.user@domain.com';
    const plainToken = db.createPasswordResetToken(userEmail);

    assert.ok(plainToken);
    assert.equal(typeof plainToken, 'string');
    assert.ok(plainToken.length >= 32);

    // First consumption succeeds
    const firstVerify = db.verifyAndConsumePasswordResetToken(plainToken);
    assert.equal(firstVerify.valid, true);
    assert.equal(firstVerify.userId, 'usr_test_auth_1');

    // Second consumption fails (token was consumed)
    const secondVerify = db.verifyAndConsumePasswordResetToken(plainToken);
    assert.equal(secondVerify.valid, false);
  });

  test('Sessions store securely, validate token, and clear upon user logout', () => {
    const plainToken = generateSessionToken();
    const session = db.createSession('usr_test_auth_1', plainToken, '127.0.0.1', 'TestSuite');

    assert.ok(session);
    assert.equal(session.userId, 'usr_test_auth_1');

    // Session retrieval by plain token
    const retrievedSession = db.getSession(plainToken);
    assert.ok(retrievedSession);
    assert.equal(retrievedSession.userId, 'usr_test_auth_1');

    // Deleting session
    db.deleteSession(plainToken);
    const postDeleteSession = db.getSession(plainToken);
    assert.equal(postDeleteSession, undefined);
  });

  test('Multi-tenant project data isolation prevents user A from seeing user B projects', () => {
    const userA = 'usr_tenant_A';
    const userB = 'usr_tenant_B';

    db.saveBuild({
      id: 'bld_tenant_A_project',
      userId: userA,
      idea: 'User A Secret App',
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    });

    db.saveBuild({
      id: 'bld_tenant_B_project',
      userId: userB,
      idea: 'User B Public App',
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    });

    const userABuilds = db.getAllBuilds(userA);
    assert.equal(userABuilds.some(b => b.id === 'bld_tenant_A_project'), true);
    assert.equal(userABuilds.some(b => b.id === 'bld_tenant_B_project'), false);

    const userBBuilds = db.getAllBuilds(userB);
    assert.equal(userBBuilds.some(b => b.id === 'bld_tenant_B_project'), true);
    assert.equal(userBBuilds.some(b => b.id === 'bld_tenant_A_project'), false);
  });
});

