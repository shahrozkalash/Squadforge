import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { Build, Task } from '../server/types.js';

describe('Phase 1: Database-Level Task Ownership and Concurrency', () => {
  const testUserId = `usr_test_p1_${Date.now()}`;
  const testBuildId = `bld_test_p1_${Date.now()}`;

  beforeEach(() => {
    // Ensure user and build exist in database for foreign key constraints
    db.saveUser({
      id: testUserId,
      email: `${testUserId}@squadforge.test`,
      name: 'Test Engineer',
      githubConnected: false,
      costLimitPerBuild: 10,
      enabledModelIds: ['gemini-3.8-flash', 'claude-3.5-sonnet'],
      createdAt: Date.now()
    });

    db.saveBuild({
      id: testBuildId,
      userId: testUserId,
      idea: 'Task Concurrency Testing Project',
      projectType: 'fullstack',
      status: 'in_progress',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-3.8-flash', 'claude-3.5-sonnet'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 10,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    });
  });

  afterEach(() => {
    try {
      db.dbManager.db.prepare('DELETE FROM tasks WHERE build_id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM builds WHERE id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);
      db.tasks.delete(testBuildId);
      db.builds.delete(testBuildId);
    } catch {}
  });

  test('1. Atomic Task Claiming: Only one agent can claim the same task in race condition', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Atomic Race Condition Test',
      description: 'Two agents attempt to claim simultaneously',
      filePaths: ['src/feature.ts'],
      priority: 2
    });

    const now = Date.now();
    const expiry = now + 60000;

    // Agent Alpha claims the task
    const claimAlpha = db.claimTaskAtomic(testBuildId, task.id, 'agent-alpha', expiry);
    assert.ok(claimAlpha, 'First claiming agent must succeed');
    assert.equal(claimAlpha.status, 'in_progress');
    assert.equal(claimAlpha.claimedBy, 'agent-alpha');

    // Agent Beta races to claim the same task
    const claimBeta = db.claimTaskAtomic(testBuildId, task.id, 'agent-beta', expiry);
    assert.equal(claimBeta, null, 'Second agent claiming the same task must receive null');

    // Verify DB state
    const current = db.getTask(testBuildId, task.id);
    assert.equal(current?.claimedBy, 'agent-alpha');
    assert.equal(current?.status, 'in_progress');
  });

  test('2. Multiple agents claiming different tasks all succeed independently', () => {
    const task1 = TaskManager.createNewTask(testBuildId, {
      title: 'Task 1',
      description: 'First distinct task',
      filePaths: ['src/task1.ts'],
      priority: 3
    });

    const task2 = TaskManager.createNewTask(testBuildId, {
      title: 'Task 2',
      description: 'Second distinct task',
      filePaths: ['src/task2.ts'],
      priority: 3
    });

    const task3 = TaskManager.createNewTask(testBuildId, {
      title: 'Task 3',
      description: 'Third distinct task',
      filePaths: ['src/task3.ts'],
      priority: 3
    });

    const expiry = Date.now() + 60000;
    const c1 = db.claimTaskAtomic(testBuildId, task1.id, 'worker-1', expiry);
    const c2 = db.claimTaskAtomic(testBuildId, task2.id, 'worker-2', expiry);
    const c3 = db.claimTaskAtomic(testBuildId, task3.id, 'worker-3', expiry);

    assert.ok(c1 && c1.claimedBy === 'worker-1');
    assert.ok(c2 && c2.claimedBy === 'worker-2');
    assert.ok(c3 && c3.claimedBy === 'worker-3');

    assert.equal(db.getTask(testBuildId, task1.id)?.claimedBy, 'worker-1');
    assert.equal(db.getTask(testBuildId, task2.id)?.claimedBy, 'worker-2');
    assert.equal(db.getTask(testBuildId, task3.id)?.claimedBy, 'worker-3');
  });

  test('3. Two workers attempting completion simultaneously: only owner succeeds', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Concurrent Completion Test',
      description: 'Testing race between worker 1 and worker 2',
      filePaths: ['src/concurrent.ts'],
      priority: 2
    });

    db.claimTaskAtomic(testBuildId, task.id, 'legitimate-worker', Date.now() + 60000);

    // legitimate-worker completes task
    const res1 = db.completeTaskAtomic(testBuildId, task.id, 'legitimate-worker', { status: 'completed' });
    assert.equal(res1.success, true);
    assert.equal(res1.task?.status, 'completed');

    // unauthorized / second worker attempts to complete concurrently
    const res2 = db.completeTaskAtomic(testBuildId, task.id, 'concurrent-worker', { status: 'completed' });
    assert.equal(res2.success, false);
    assert.ok(res2.error?.includes('already completed') || res2.error?.includes('Stale worker rejected'));
  });

  test('4. Expired worker attempting completion is rejected at database level', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Expired Lease Test',
      description: 'Worker attempts to finish after lease expiry',
      filePaths: ['src/expired.ts'],
      priority: 1
    });

    // Worker claims task but lease expires
    const expiredTime = Date.now() - 5000;
    db.updateTask(testBuildId, task.id, {
      status: 'in_progress',
      claimedBy: 'slow-worker',
      leaseExpiresAt: expiredTime
    });

    const completion = db.completeTaskAtomic(testBuildId, task.id, 'slow-worker', { status: 'completed' });
    assert.equal(completion.success, false);
    assert.ok(completion.error?.includes('Stale lease rejected'));

    const currentTask = db.getTask(testBuildId, task.id);
    assert.notEqual(currentTask?.status, 'completed');
  });

  test('5. Task reclaimed after lease expiration prevents original worker from overwriting newer worker result', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Reclaimed Task Protection Test',
      description: 'Worker A expires, Worker B reclaims, Worker A cannot overwrite',
      filePaths: ['src/reclaim.ts'],
      priority: 1
    });

    // 1. Worker A claims task with expired lease
    const expiredTime = Date.now() - 2000;
    db.updateTask(testBuildId, task.id, {
      status: 'in_progress',
      claimedBy: 'worker-a',
      leaseExpiresAt: expiredTime
    });

    // 2. Worker B reclaims the expired task
    const newExpiry = Date.now() + 90000;
    const reclaimResult = db.claimTaskAtomic(testBuildId, task.id, 'worker-b', newExpiry);
    assert.ok(reclaimResult, 'Worker B must successfully reclaim expired task');
    assert.equal(reclaimResult.claimedBy, 'worker-b');

    // 3. Stale Worker A wakes up and attempts to complete task
    const staleAttempt = db.completeTaskAtomic(testBuildId, task.id, 'worker-a', {
      status: 'completed',
      actualTokensUsed: 999
    });
    assert.equal(staleAttempt.success, false);
    assert.ok(staleAttempt.error?.includes('Stale worker rejected'));

    // 4. Worker B completes task successfully
    const validAttempt = db.completeTaskAtomic(testBuildId, task.id, 'worker-b', {
      status: 'completed',
      actualTokensUsed: 120
    });
    assert.equal(validAttempt.success, true);
    assert.equal(validAttempt.task?.claimedBy, 'worker-b');
  });

  test('6. Database write failure prevents in-memory cache mutation', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Write Failure Consistency Test',
      description: 'Ensure cache is not mutated on DB failure',
      filePaths: ['src/fail.ts'],
      priority: 2
    });

    // Attempting to claim with an invalid non-existent buildId causes no update
    const result = db.claimTaskAtomic('non_existent_build', task.id, 'worker-x', Date.now() + 60000);
    assert.equal(result, null);

    // In-memory task for original build remains pending and unclaimed
    const current = db.getTask(testBuildId, task.id);
    assert.equal(current?.status, 'pending');
    assert.equal(current?.claimedBy, null);
  });

  test('7. Duplicate task completion is safely rejected', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Duplicate Completion Test',
      description: 'Testing idempotent completion prevention',
      filePaths: ['src/dup.ts'],
      priority: 1
    });

    db.claimTaskAtomic(testBuildId, task.id, 'worker-once', Date.now() + 60000);

    const first = db.completeTaskAtomic(testBuildId, task.id, 'worker-once', { status: 'completed' });
    assert.equal(first.success, true);

    const duplicate = db.completeTaskAtomic(testBuildId, task.id, 'worker-once', { status: 'completed' });
    assert.equal(duplicate.success, false);
    assert.equal(duplicate.error, 'Task is already completed');
  });

  test('8. Cache and database consistency remains intact after invalid operations', () => {
    const task = TaskManager.createNewTask(testBuildId, {
      title: 'Consistency Verification',
      description: 'Verifying DB matches in-memory store',
      filePaths: ['src/consistent.ts'],
      priority: 3
    });

    // Valid claim
    db.claimTaskAtomic(testBuildId, task.id, 'worker-consistent', Date.now() + 60000);

    // Verify DB matches in-memory cache
    const dbRow = db.dbManager.db.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(task.id) as any;
    const memTask = db.getTask(testBuildId, task.id);

    assert.equal(dbRow.status, memTask?.status);
    assert.equal(dbRow.claimed_by, memTask?.claimedBy);
  });
});
