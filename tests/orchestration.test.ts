import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { 
  callUnifiedGateway, 
  extractAndParseJson, 
  parseVerifierResponse,
  validateModelActionResponse
} from '../server/gateway.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { SandboxRunner } from '../server/swarm/sandboxRunner.js';
import { db } from '../server/store.js';
import { Build, Task, ProjectFile } from '../server/types.js';

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
    // Calling Grok without OpenRouter key and without fallback
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

    // If Gemini key is set, it will fallback; otherwise it reports NO_PROVIDER
    if (result.success) {
      assert.equal(result.isFallback, true);
      assert.equal(result.providerUsed, 'gemini');
      assert.equal(result.actualModelUsed, 'gemini-3.8-flash');
      assert.ok(result.fallbackReason?.includes('Primary provider'));
      // Model identity in metadata must be transparent:
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
    // Missing required path and content
    assert.equal(validateModelActionResponse({ actions: [{ action: 'create_file' }] }), null);
    // Invalid action type
    assert.equal(validateModelActionResponse({ actions: [{ action: 'delete_database' }] }), null);
    // Empty actions
    assert.equal(validateModelActionResponse({ actions: [] }), null);
    // Patch without edits array
    assert.equal(validateModelActionResponse({ actions: [{ action: 'patch_file', path: 'src/App.tsx' }] }), null);
  });

  test('Action validator accepts valid structured patch and create actions', () => {
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
        }
      ]
    });

    assert.ok(valid);
    assert.equal(valid.actions.length, 2);
  });
});

describe('Verifier Response Validation & False Completion Prevention', () => {
  test('Malformed verifier response is safely rejected as null', () => {
    // Plain string without JSON
    assert.equal(parseVerifierResponse('The project looks good to me!'), null);

    // JSON missing boolean approved field
    assert.equal(parseVerifierResponse('{"status": "ok", "summary": "completed"}'), null);

    // Non-boolean approved (e.g. string "true" or number 1)
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

describe('Task Retry Limits & Exhaustion Handling', () => {
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

    assert.equal(task.status, 'open');
    assert.equal(task.retryCount || 0, 0);

    // Attempt 1 fails
    TaskManager.releaseTask(buildId, task.id, 'model-1', 'Compile error attempt 1');
    let updated = db.getTask(buildId, task.id);
    assert.equal(updated?.status, 'open');
    assert.equal(updated?.retryCount, 1);
    assert.equal(updated?.lastError, 'Compile error attempt 1');

    // Attempt 2 fails
    TaskManager.releaseTask(buildId, task.id, 'model-2', 'Compile error attempt 2');
    updated = db.getTask(buildId, task.id);
    assert.equal(updated?.status, 'open');
    assert.equal(updated?.retryCount, 2);

    // Attempt 3 fails -> Must transition to 'failed' and NOT loop infinitely
    TaskManager.releaseTask(buildId, task.id, 'model-3', 'Compile error attempt 3');
    updated = db.getTask(buildId, task.id);
    assert.equal(updated?.status, 'failed');
    assert.ok(updated?.error?.includes('Exhausted retries (3/3)'));
    assert.equal(updated?.claimedBy, null);
  });

  test('Successful task marks done and clears active errors', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Successful Task',
      description: 'Completes cleanly',
      filePaths: ['src/success.ts'],
      priority: 2
    });

    TaskManager.completeTask(buildId, task.id, 'gemini');
    const updated = db.getTask(buildId, task.id);
    assert.equal(updated?.status, 'done');
    assert.ok(updated?.completedAt);
    assert.equal(updated?.error, undefined);
  });
});

describe('Sandbox Integrity Checks & Fix Task Generation', () => {
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
    // Create malformed file
    await MergeManager.createFile(buildId, 'test-model', {
      action: 'create_file',
      path: 'src/broken.ts',
      content: 'function broken() { if (true) { console.log("missing brace"); }'
    });

    const result = SandboxRunner.runIntegrityCheck(buildId);
    assert.equal(result.passed, false);
    assert.ok(result.errors.length > 0);

    // Verify a priority 1 fix task was created on the living board
    const tasks = db.getTasks(buildId);
    const fixTask = tasks.find(t => t.isFixTask && t.filePaths.includes('src/broken.ts'));
    assert.ok(fixTask);
    assert.equal(fixTask.priority, 1);
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

    const result = SandboxRunner.runIntegrityCheck(cleanBuildId);
    assert.equal(result.passed, true);
    assert.equal(result.errors.length, 0);

    // Verify a checkpoint was created
    const checkpoints = db.getCheckpoints(cleanBuildId);
    assert.ok(checkpoints.length > 0);
  });
});
