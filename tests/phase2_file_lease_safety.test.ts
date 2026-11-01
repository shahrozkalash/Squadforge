import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { MergeManager } from '../server/swarm/mergeManager.js';

describe('Phase 2: File Lease and Merge Safety', () => {
  const testUserId = `usr_test_p2_${Date.now()}`;
  const testBuildId = `bld_test_p2_${Date.now()}`;

  beforeEach(() => {
    db.saveUser({
      id: testUserId,
      email: `${testUserId}@squadforge.test`,
      name: 'Test Engineer Phase 2',
      githubConnected: false,
      costLimitPerBuild: 10,
      enabledModelIds: ['gemini-3.8-flash', 'claude-3.5-sonnet'],
      createdAt: Date.now()
    });

    db.saveBuild({
      id: testBuildId,
      userId: testUserId,
      idea: 'File Lease and Merge Safety Project',
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
      db.dbManager.db.prepare('DELETE FROM file_versions WHERE build_id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM project_files WHERE build_id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM builds WHERE id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM users WHERE id = ?').run(testUserId);
      db.files.delete(testBuildId);
      db.builds.delete(testBuildId);
    } catch {}
  });

  test('1. Two agents requesting the same file: first wins, second rejected with lockedBy', () => {
    const file = 'src/shared.ts';
    const agent1 = 'gemini-3.8-flash';
    const agent2 = 'claude-3.5-sonnet';

    const res1 = MergeManager.acquireFileLeases(testBuildId, agent1, [file], 30000);
    assert.strictEqual(res1.success, true, 'Agent 1 should successfully acquire lease');
    assert.deepStrictEqual(res1.acquiredPaths, [file]);

    const res2 = MergeManager.acquireFileLeases(testBuildId, agent2, [file], 30000);
    assert.strictEqual(res2.success, false, 'Agent 2 should be rejected');
    assert.strictEqual(res2.lockedBy, agent1, 'Agent 2 should know who holds the lease');
  });

  test('2. Multiple-file acquisition succeeds atomically', () => {
    const files = ['src/b.ts', 'src/a.ts', 'src/c.ts'];
    const agent = 'gemini-3.8-flash';

    const res = MergeManager.acquireFileLeases(testBuildId, agent, files, 30000);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.acquiredPaths.length, 3);
    assert.deepStrictEqual(res.acquiredPaths.sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('3. Partial acquisition failure rolls back all requested files', () => {
    const agent1 = 'gemini-3.8-flash';
    const agent2 = 'claude-3.5-sonnet';

    // Agent 1 locks file B
    MergeManager.acquireFileLeases(testBuildId, agent1, ['src/b.ts'], 30000);

    // Agent 2 attempts to lock [A, B, C]
    const res2 = MergeManager.acquireFileLeases(testBuildId, agent2, ['src/a.ts', 'src/b.ts', 'src/c.ts'], 30000);
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.lockedBy, agent1);

    // Confirm neither A nor C was left acquired by agent 2
    const leaseA = db.getFileLease(testBuildId, 'src/a.ts');
    const leaseC = db.getFileLease(testBuildId, 'src/c.ts');
    assert.strictEqual(leaseA, null, 'src/a.ts must have been rolled back and remain unleased');
    assert.strictEqual(leaseC, null, 'src/c.ts must have been rolled back and remain unleased');
  });

  test('4. Expired lease rejection and reclaiming', () => {
    const file = 'src/expired.ts';
    const agent1 = 'gemini-3.8-flash';
    const agent2 = 'claude-3.5-sonnet';

    // Acquire lease for 1ms
    MergeManager.acquireFileLeases(testBuildId, agent1, [file], 1);

    // Wait until expired
    const start = Date.now();
    while (Date.now() - start < 10) {}

    // Agent 2 should now be able to reclaim expired lease
    const res2 = MergeManager.acquireFileLeases(testBuildId, agent2, [file], 30000);
    assert.strictEqual(res2.success, true, 'Agent 2 must be able to reclaim expired file lease');
    assert.deepStrictEqual(res2.acquiredPaths, [file]);
  });

  test('5. Lease renewal by the wrong agent fails', () => {
    const file = 'src/owned.ts';
    const agent1 = 'gemini-3.8-flash';
    const imposter = 'claude-3.5-sonnet';

    MergeManager.acquireFileLeases(testBuildId, agent1, [file], 30000);

    const renewRes = MergeManager.renewFileLeases(testBuildId, imposter, [file], 30000);
    assert.strictEqual(renewRes.success, false, 'Imposter must not be able to renew another agent lease');
    assert.ok(renewRes.error?.includes('Active lease held by another model') || renewRes.error?.includes('not held'));
  });

  test('6. Lease release by the wrong agent fails', () => {
    const file = 'src/protect.ts';
    const agent1 = 'gemini-3.8-flash';
    const imposter = 'claude-3.5-sonnet';

    MergeManager.acquireFileLeases(testBuildId, agent1, [file], 30000);

    const releaseRes = MergeManager.releaseFileLeases(testBuildId, imposter, [file]);
    assert.strictEqual(releaseRes.success, false, 'Imposter must not be able to release another agent lease');

    // Verify agent 1 still has the lease
    const activeLease = db.getFileLease(testBuildId, file);
    assert.ok(activeLease);
    assert.strictEqual(activeLease?.modelId, agent1);
  });

  test('7. Stale patch rejection: version mismatch or expired lease', async () => {
    const filePath = 'src/calc.ts';
    await MergeManager.createFile(testBuildId, 'agent-init', {
      action: 'create_file',
      path: filePath,
      content: 'export const add = (a: number, b: number) => a + b;\n'
    });

    const file = db.getFile(testBuildId, filePath);
    assert.ok(file);
    const initialVersion = file!.version;

    // Agent 1 applies a valid patch
    const patch1 = await MergeManager.applyPatch(testBuildId, 'agent-1', {
      path: filePath,
      expectedVersion: initialVersion,
      edits: [{ find: 'a + b', replace: 'a + b + 0' }]
    });
    assert.strictEqual(patch1.success, true);

    // Agent 2 attempts patch with stale expectedVersion
    const stalePatch = await MergeManager.applyPatch(testBuildId, 'agent-2', {
      path: filePath,
      expectedVersion: initialVersion, // Stale! Current version is initialVersion + 1
      edits: [{ find: 'a + b', replace: 'a + b + 999' }]
    });
    assert.strictEqual(stalePatch.success, false, 'Stale patch with mismatched version must be rejected');
    assert.ok(stalePatch.error?.includes('Version conflict'));
  });

  test('8. Concurrent merge attempts are serialized and maintain file version consistency', async () => {
    const filePath = 'src/counter.ts';
    await MergeManager.createFile(testBuildId, 'agent-init', {
      action: 'create_file',
      path: filePath,
      content: 'count = 0;\n'
    });

    // Run 3 sequential patches dispatched concurrently to the queue
    const p1 = MergeManager.applyPatch(testBuildId, 'agent-a', {
      path: filePath,
      edits: [{ find: 'count = 0', replace: 'count = 1' }]
    });
    const p2 = MergeManager.applyPatch(testBuildId, 'agent-b', {
      path: filePath,
      edits: [{ find: 'count = 1', replace: 'count = 2' }]
    });
    const p3 = MergeManager.applyPatch(testBuildId, 'agent-c', {
      path: filePath,
      edits: [{ find: 'count = 2', replace: 'count = 3' }]
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.strictEqual(r1.success, true);
    assert.strictEqual(r2.success, true);
    assert.strictEqual(r3.success, true);

    const finalFile = db.getFile(testBuildId, filePath);
    assert.strictEqual(finalFile?.content, 'count = 3;\n');
    assert.strictEqual(finalFile?.version, 4); // Created (v1) + 3 edits = v4
  });

  test('9. Merge failure does not deadlock queue; subsequent patch succeeds', async () => {
    const filePath = 'src/queue_test.ts';
    await MergeManager.createFile(testBuildId, 'agent-init', {
      action: 'create_file',
      path: filePath,
      content: 'initial text;\n'
    });

    // Deliberately failing patch (target text does not exist)
    const failingPatch = MergeManager.applyPatch(testBuildId, 'agent-bad', {
      path: filePath,
      edits: [{ find: 'NON_EXISTENT_TEXT', replace: 'foo' }]
    });

    // Valid subsequent patch
    const goodPatch = MergeManager.applyPatch(testBuildId, 'agent-good', {
      path: filePath,
      edits: [{ find: 'initial text', replace: 'updated text' }]
    });

    const [badRes, goodRes] = await Promise.all([failingPatch, goodPatch]);
    assert.strictEqual(badRes.success, false, 'Bad patch must fail gracefully');
    assert.strictEqual(goodRes.success, true, 'Queue must not deadlock and subsequent patch must succeed');

    const finalFile = db.getFile(testBuildId, filePath);
    assert.strictEqual(finalFile?.content, 'updated text;\n');
  });

  test('10. Duplicate patch prevention returns cached safe result without duplicate side-effects', async () => {
    const filePath = 'src/idempotent.ts';
    await MergeManager.createFile(testBuildId, 'agent-init', {
      action: 'create_file',
      path: filePath,
      content: 'let val = 10;\n'
    });

    const patchAction = {
      path: filePath,
      edits: [{ find: 'let val = 10;', replace: 'let val = 20;' }]
    };

    const res1 = await MergeManager.applyPatch(testBuildId, 'agent-x', patchAction);
    assert.strictEqual(res1.success, true);

    // Identical patch submitted immediately
    const res2 = await MergeManager.applyPatch(testBuildId, 'agent-x', patchAction);
    assert.strictEqual(res2.success, true);

    const file = db.getFile(testBuildId, filePath);
    // Version should be 2, not incremented a second time
    assert.strictEqual(file?.version, 2);
    assert.strictEqual(file?.content, 'let val = 20;\n');
  });
});
