import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, PersistentDatabase } from '../server/store.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { BrowserRuntimeVerifier } from '../server/swarm/runtimeVerifier.js';
import { ProjectFile, Task } from '../server/types.js';

describe('SquadForge Phase 4: Production Reliability, Ownership Enforcement & Patch Integrity', () => {
  const buildId = 'p4_test_build';

  beforeEach(() => {
    // Clean and initialize build state
    try {
      db.dbManager.db.prepare('DELETE FROM tasks WHERE build_id = ?').run(buildId);
      db.dbManager.db.prepare('DELETE FROM project_files WHERE build_id = ?').run(buildId);
      db.dbManager.db.prepare('DELETE FROM file_versions WHERE build_id = ?').run(buildId);
      db.dbManager.db.prepare('DELETE FROM swarm_events WHERE build_id = ?').run(buildId);
    } catch {}
    db.tasks.delete(buildId);
    db.files.delete(buildId);
    db.events.delete(buildId);

    db.saveBuild({
      id: buildId,
      userId: 'p4_user',
      idea: 'Production Reliability Swarm Platform',
      status: 'in_progress',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini', 'claude', 'gpt4'],
      autoPushGithub: false,
      totalTokens: 5000,
      totalCost: 0.1,
      costLimit: 10,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0
    });
  });

  // ==========================================
  // 1. TASK CONCURRENCY & OWNERSHIP TESTS
  // ==========================================

  test('1. Two workers attempting to claim the same task: only one succeeds', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Atomic Concurrent Task',
      description: 'Test simultaneous claim',
      filePaths: ['src/core.ts'],
      priority: 1
    });

    // Worker 1 claims task
    const claim1 = TaskManager.claimNextTask(buildId, 'worker_alpha', ['backend']);
    assert.ok(claim1, 'Worker alpha should successfully claim the task');
    assert.equal(claim1?.id, task.id);
    assert.equal(claim1?.claimedBy, 'worker_alpha');

    // Worker 2 attempts to claim the same task
    const claim2 = TaskManager.claimNextTask(buildId, 'worker_beta', ['backend']);
    assert.equal(claim2, null, 'Worker beta must not claim an already claimed active task');

    // Authoritative DB verification
    const dbTask = db.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(dbTask?.claimed_by, 'worker_alpha');
  });

  test('2. A worker completing a task after losing ownership: rejected', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Ownership Loss Test',
      description: 'Worker loses task ownership before completion',
      filePaths: ['src/loss.ts'],
      priority: 1
    });

    // Worker A claims task
    TaskManager.claimNextTask(buildId, 'worker_a', ['backend']);

    // Simulate task being reassigned to worker_b in database
    db.dbManager.db.prepare(
      'UPDATE tasks SET claimed_by = ?, lease_expires_at = ? WHERE id = ?'
    ).run('worker_b', Date.now() + 60000, task.id);

    // Stale Worker A attempts to complete the task
    const completionResult = TaskManager.completeTask(buildId, task.id, 'worker_a');
    assert.equal(completionResult.success, false, 'Stale worker must be rejected from completing task');
    assert.ok(
      completionResult.error?.includes('Stale worker') || completionResult.error?.includes('ownership'),
      `Expected ownership error, got: ${completionResult.error}`
    );

    // Database status remains in_progress under worker_b
    const current = db.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(current?.status, 'in_progress');
    assert.equal(current?.claimed_by, 'worker_b');
  });

  test('3. Completion after lease expiration: rejected', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Lease Expiration Task',
      description: 'Task lease expires before completion attempt',
      filePaths: ['src/expire.ts'],
      priority: 1
    });

    TaskManager.claimNextTask(buildId, 'worker_slow', ['backend']);

    // Backdate the lease expiration timestamp into the past
    const pastTime = Date.now() - 5000;
    db.dbManager.db.prepare(
      'UPDATE tasks SET lease_expires_at = ? WHERE id = ?'
    ).run(pastTime, task.id);

    // Worker attempts completion with expired lease
    const result = TaskManager.completeTask(buildId, task.id, 'worker_slow');
    assert.equal(result.success, false, 'Completion must be rejected when lease is expired');
    assert.ok(
      result.error?.includes('expired') || result.error?.includes('Lease'),
      `Expected lease expiration error, got: ${result.error}`
    );
  });

  test('4. An unclaimed task being completed: rejected', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Unclaimed Task Completion Attack',
      description: 'Task is pending and unclaimed',
      filePaths: ['src/unclaimed.ts'],
      priority: 1
    });

    // Worker attempts to complete task without claiming it
    const result = TaskManager.completeTask(buildId, task.id, 'arbitrary_worker');
    assert.equal(result.success, false, 'Unclaimed task must never be completed by arbitrary worker');
    assert.ok(
      result.error?.includes('unclaimed') || result.error?.includes('ownership') || result.error?.includes('in_progress'),
      `Expected unclaimed error, got: ${result.error}`
    );
  });

  test('5. Two workers attempting to fail the same task: rejected with no duplicate events', () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Concurrent Failure Task',
      description: 'Two workers race to fail the task',
      filePaths: ['src/fail.ts'],
      priority: 1
    });

    TaskManager.claimNextTask(buildId, 'worker_legit', ['backend']);

    // Rogue worker attempts to fail legit worker's task
    const rogueFail = TaskManager.failTask(buildId, task.id, 'worker_rogue', 'Rogue failure attempt');
    assert.equal(rogueFail.success, false, 'Rogue worker cannot fail another worker task');

    // Legitimate owner fails the task
    const legitFail = TaskManager.failTask(buildId, task.id, 'worker_legit', 'Legit error encountered');
    assert.equal(legitFail.success, true, 'Owning worker can fail the task');

    // Duplicate failure attempt by owner
    const initialEventsCount = db.getEvents(buildId).filter(e => e.type === 'task_failed').length;
    const duplicateFail = TaskManager.failTask(buildId, task.id, 'worker_legit', 'Second failure attempt');
    assert.equal(duplicateFail.success, false, 'Duplicate failure must be rejected');

    const finalEventsCount = db.getEvents(buildId).filter(e => e.type === 'task_failed').length;
    assert.equal(finalEventsCount, initialEventsCount, 'Zero duplicate failure events must be emitted');
  });

  test('6. Retry after failure and reassignment: cleans stale ownership for fresh claim', async () => {
    const task = TaskManager.createNewTask(buildId, {
      title: 'Retry & Reassign Task',
      description: 'Task fails and is retried by another worker',
      filePaths: ['src/retry.ts'],
      priority: 1
    });

    // Worker 1 claims and fails
    TaskManager.claimNextTask(buildId, 'worker_failing', ['backend']);
    TaskManager.failTask(buildId, task.id, 'worker_failing', 'Temporary API timeout');

    // Retry the task
    const retryResult = TaskManager.retryTask(buildId, task.id);
    assert.equal(retryResult.success, true, 'Task retry must succeed');

    // Verify database state has cleared stale owner and lease
    const dbTask = db.dbManager.db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as any;
    assert.equal(dbTask?.status, 'pending');
    assert.equal(dbTask?.claimed_by, null, 'Stale owner must be cleared on retry');
    assert.equal(dbTask?.lease_expires_at, null, 'Lease expiration must be cleared on retry');

    // Fresh worker claims the retried task
    const freshClaim = TaskManager.claimNextTask(buildId, 'worker_recovery', ['backend']);
    assert.ok(freshClaim, 'Fresh worker must be able to claim retried task');
    assert.equal(freshClaim?.id, task.id);
    assert.equal(freshClaim?.claimedBy, 'worker_recovery');

    // Create target file so honest file verification passes
    await MergeManager.createFile(buildId, 'worker_recovery', {
      action: 'create_file',
      path: 'src/retry.ts',
      content: 'export const retrySuccess = true;'
    });

    // Fresh worker completes the task successfully
    const completeResult = TaskManager.completeTask(buildId, task.id, 'worker_recovery');
    assert.equal(completeResult.success, true);
  });

  // ==========================================
  // 2. FILE INTEGRITY & LEASE LIFECYCLE TESTS
  // ==========================================

  test('7. Two agents requesting the same file: second is rejected with lockedBy info', async () => {
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/shared.ts',
      content: 'export const shared = 1;'
    });

    // Agent A acquires lease
    const leaseA = MergeManager.acquireFileLeases(buildId, 'agent_a', ['src/shared.ts'], 30000);
    assert.equal(leaseA.success, true);
    assert.deepEqual(leaseA.acquiredPaths, ['src/shared.ts']);

    // Agent B requests the same file
    const leaseB = MergeManager.acquireFileLeases(buildId, 'agent_b', ['src/shared.ts'], 30000);
    assert.equal(leaseB.success, false);
    assert.equal(leaseB.lockedBy, 'agent_a');
  });

  test('8. Multi-file acquisition with one conflicting file: all rolled back, zero partial leases', async () => {
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/file1.ts',
      content: 'export const f1 = 1;'
    });
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/file2.ts',
      content: 'export const f2 = 2;'
    });
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/file3.ts',
      content: 'export const f3 = 3;'
    });

    // Agent A holds lease on file2
    MergeManager.acquireFileLeases(buildId, 'agent_a', ['src/file2.ts'], 30000);

    // Agent B attempts to acquire all three files [file1, file2, file3]
    const multiAcquire = MergeManager.acquireFileLeases(buildId, 'agent_b', ['src/file1.ts', 'src/file2.ts', 'src/file3.ts']);
    assert.equal(multiAcquire.success, false);
    assert.equal(multiAcquire.lockedBy, 'agent_a');

    // Verify neither file1 nor file3 was leased to Agent B (all or nothing rollback)
    const f1 = db.getFile(buildId, 'src/file1.ts');
    const f3 = db.getFile(buildId, 'src/file3.ts');
    assert.ok(!f1?.leaseOwner, 'file1 lease must be rolled back');
    assert.ok(!f3?.leaseOwner, 'file3 lease must be rolled back');
  });

  test('9. Expired lease renewal: rejected, cannot revive already expired lease', async () => {
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/renewable.ts',
      content: 'export const ren = 1;'
    });

    // Agent A acquires lease
    MergeManager.acquireFileLeases(buildId, 'agent_a', ['src/renewable.ts'], 5000);

    // Backdate lease in DB to simulate expiration
    const past = Date.now() - 1000;
    db.dbManager.db.prepare(
      'UPDATE project_files SET lease_expires_at = ? WHERE build_id = ? AND path = ?'
    ).run(past, buildId, 'src/renewable.ts');

    // Agent A attempts to renew the expired lease
    const renewal = MergeManager.renewFileLeases(buildId, 'agent_a', ['src/renewable.ts'], 10000);
    assert.equal(renewal.success, false, 'Expired lease must not be renewed');
    assert.ok(renewal.error?.includes('expired') || renewal.error?.includes('No active lease'));
  });

  test('10. Unauthorized lease release: agent cannot release another agents lease', async () => {
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/protected.ts',
      content: 'export const prot = true;'
    });

    MergeManager.acquireFileLeases(buildId, 'agent_rightful', ['src/protected.ts'], 30000);

    // Malicious or accidental agent attempts release
    const rogueRelease = MergeManager.releaseFileLeases(buildId, 'agent_unauthorized', ['src/protected.ts']);
    assert.equal(rogueRelease.success, false);
    assert.ok(rogueRelease.error?.includes('not held') || rogueRelease.error?.includes('agent_rightful'));

    // Verify lease is still actively held by rightful agent
    const file = db.getFile(buildId, 'src/protected.ts');
    assert.equal(file?.leaseOwner, 'agent_rightful');
  });

  test('11. Stale patch after another agent updates file: rejected with version & hash conflict', async () => {
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/concurrent_patch.ts',
      content: 'export const count = 0;'
    });

    const initial = db.getFile(buildId, 'src/concurrent_patch.ts');
    assert.equal(initial?.version, 1);
    const initialHash = initial?.contentHash;

    // Agent B updates the file to v2
    const patchB = await MergeManager.applyPatch(buildId, 'agent_b', {
      action: 'patch_file',
      path: 'src/concurrent_patch.ts',
      edits: [{ find: 'count = 0', replace: 'count = 1' }],
      expectedVersion: 1
    });
    assert.equal(patchB.success, true);
    assert.equal(patchB.version, 2);

    // Agent A tries to apply patch using stale expectedVersion 1
    const staleVersionPatch = await MergeManager.applyPatch(buildId, 'agent_a', {
      action: 'patch_file',
      path: 'src/concurrent_patch.ts',
      edits: [{ find: 'count = 0', replace: 'count = 99' }],
      expectedVersion: 1
    });
    assert.equal(staleVersionPatch.success, false);
    assert.ok(staleVersionPatch.error?.includes('Version conflict'));

    // Agent A tries to apply patch using stale contentHash
    const staleHashPatch = await MergeManager.applyPatch(buildId, 'agent_a', {
      action: 'patch_file',
      path: 'src/concurrent_patch.ts',
      edits: [{ find: 'count = 1', replace: 'count = 99' }],
      expectedContentHash: initialHash
    });
    assert.equal(staleHashPatch.success, false);
    assert.ok(staleHashPatch.error?.includes('Content hash conflict'));
  });

  test('12. Database failure during multi-file patch batch: rollbacks cleanly to snapshot state', async () => {
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/batch1.ts',
      content: 'export const b1 = 1;'
    });
    await MergeManager.createFile(buildId, 'agent_init', {
      action: 'create_file',
      path: 'src/batch2.ts',
      content: 'export const b2 = 2;'
    });

    // Execute atomic batch where 2nd action intentionally fails (missing target text)
    const batchResult = await MergeManager.applyBatchActions(buildId, 'agent_batch', [
      {
        action: 'create_file',
        path: 'src/batch_created.ts',
        content: 'export const newlyCreated = true;'
      },
      {
        action: 'patch_file',
        path: 'src/batch1.ts',
        edits: [{ find: 'this text does not exist in batch1', replace: 'foo' }]
      }
    ]);

    assert.equal(batchResult.success, false);
    assert.equal(batchResult.reverted, true);

    // Workspace state must be strictly identical to pre-batch snapshot
    const createdFile = db.getFile(buildId, 'src/batch_created.ts');
    assert.ok(!createdFile, 'Newly created file in failed batch must be completely cleaned up');

    const b1 = db.getFile(buildId, 'src/batch1.ts');
    assert.equal(b1?.version, 1);
    assert.equal(b1?.content, 'export const b1 = 1;');
  });

  test('13. Recovery after process restart: sweeps expired leases and cleans stale task state', () => {
    // Insert an expired task lease and expired file lease directly into the database
    const pastTime = Date.now() - 10000;

    const task = TaskManager.createNewTask(buildId, {
      title: 'Abandoned Worker Task',
      description: 'Worker crashed before finishing',
      filePaths: ['src/crash.ts'],
      priority: 1
    });

    db.dbManager.db.prepare(
      'UPDATE tasks SET claimed_by = ?, lease_expires_at = ?, status = ? WHERE id = ?'
    ).run('crashed_worker', pastTime, 'in_progress', task.id);

    // Insert project file with expired lease directly into database
    db.dbManager.db.prepare(
      `INSERT INTO project_files (id, build_id, path, content, version, owner_model, lease_owner, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('pf_abandoned', buildId, 'src/abandoned_file.ts', 'export const crash = true;', 1, 'crashed_worker', 'crashed_worker', pastTime, pastTime, pastTime);

    // Simulate server startup / new PersistentDatabase instance loading authoritative DB
    const freshStore = new PersistentDatabase();
    freshStore.initialize();

    // Verify crashed task was reset to pending
    const recoveredTask = freshStore.getTask(buildId, task.id);
    assert.equal(recoveredTask?.status, 'pending');
    assert.equal(recoveredTask?.claimedBy, null, 'Crashed worker ownership must be wiped on restart');
    assert.equal(recoveredTask?.leaseExpiresAt, null);

    // Verify expired file lease was released
    const recoveredFile = freshStore.getFile(buildId, 'src/abandoned_file.ts');
    assert.equal(recoveredFile?.leaseOwner, null, 'Abandoned file lease must be released on restart');
    assert.equal(recoveredFile?.leaseExpiresAt, null);
  });

  // ==========================================
  // 3. VERIFICATION INTEGRITY TESTS
  // ==========================================

  test('14. Skipped tests: never treated as passed in execution report or verdict', () => {
    const filesWithSkippedTest: ProjectFile[] = [
      {
        path: 'src/calculator.ts',
        content: 'export const add = (a: number, b: number) => a + b;',
        version: 1,
        history: []
      },
      {
        path: 'tests/calculator.test.ts',
        content: `
          import { test } from 'node:test';
          test.skip('skipped test scenario', () => {
            // Nothing executed
          });
        `,
        version: 1,
        history: []
      }
    ];

    const testReport = ExecutionAdapter.runIsolatedTests('build_skip_test', filesWithSkippedTest);
    assert.equal(testReport.status, 'skipped', 'Overall test status must be skipped, never passed');
    assert.equal(testReport.passed, 0, '0 tests must be reported passed');
    assert.ok(testReport.skipped >= 1);

    const fullExec = ExecutionAdapter.runCompleteVerification('build_skip_test', filesWithSkippedTest);
    assert.equal(fullExec.passed, false, 'Complete verification must not pass when tests are skipped');
  });

  test('15. Missing dependencies: reported as diagnostics and fails verification', () => {
    const filesWithMissingDep: ProjectFile[] = [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'missing-dep-test',
          version: '1.0.0',
          dependencies: { react: '^19.0.0' }
        }),
        version: 1,
        history: []
      },
      {
        path: 'src/uninstalled.ts',
        content: `
          import { nonExistentFunction } from 'ghost-package-xyz-not-installed';
          export const run = () => nonExistentFunction();
        `,
        version: 1,
        history: []
      }
    ];

    const typeReport = ExecutionAdapter.runTypeCheck('build_missing_dep', filesWithMissingDep);
    assert.equal(typeReport.status, 'failed');
    assert.equal(typeReport.passed, false);
    assert.ok(typeReport.missingDependencies.includes('ghost-package-xyz-not-installed'));
    assert.ok(typeReport.errors.some(e => e.message.includes('ghost-package-xyz-not-installed')));
  });

  test('16. Invalid TypeScript configuration: reported as config error and fails verification', () => {
    const filesWithBadTsConfig: ProjectFile[] = [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'bad-tsconfig-test', version: '1.0.0' }),
        version: 1,
        history: []
      },
      {
        path: 'tsconfig.json',
        content: '{ "compilerOptions": { "strict": true, ', // Unclosed JSON syntax error
        version: 1,
        history: []
      },
      {
        path: 'src/main.ts',
        content: 'export const x = 1;',
        version: 1,
        history: []
      }
    ];

    const configErrors = ExecutionAdapter.validateConfigs(filesWithBadTsConfig);
    assert.ok(configErrors.some(e => e.includes('Invalid tsconfig.json')));

    const typeReport = ExecutionAdapter.runTypeCheck('build_bad_config', filesWithBadTsConfig);
    assert.equal(typeReport.status, 'failed');
    assert.equal(typeReport.passed, false);
    assert.ok(typeReport.configErrors.length > 0 || typeReport.errors.some(e => e.filePath === 'tsconfig.json'));
  });

  test('17. Build failure: cannot be hidden by successful syntax checks', () => {
    const filesWithBuildFailure: ProjectFile[] = [
      {
        path: 'package.json',
        content: JSON.stringify({ name: 'build-fail-test', version: '1.0.0' }),
        version: 1,
        history: []
      },
      {
        path: 'src/main.tsx',
        // Valid syntax, but references an unresolvable local module that crashes bundler
        content: `
          import { nonExistentModule } from './does_not_exist_file.js';
          console.log(nonExistentModule);
        `,
        version: 1,
        history: []
      }
    ];

    // Syntax validation passes because individual file AST is syntactically valid TypeScript
    const syntaxErrors = ExecutionAdapter.validateSyntax(filesWithBuildFailure);
    assert.equal(syntaxErrors.length, 0, 'Syntax validation alone must pass for valid AST');

    // Bundling must fail and report build error
    const buildReport = ExecutionAdapter.runProductionBuild('build_fail_test', filesWithBuildFailure);
    assert.equal(buildReport.status, 'failed');
    assert.equal(buildReport.passed, false);
    assert.ok(buildReport.errors.length > 0);

    // Full verification must fail despite passing syntax
    const completeVer = ExecutionAdapter.runCompleteVerification('build_fail_test', filesWithBuildFailure);
    assert.equal(completeVer.passed, false, 'Build failure must never be masked by syntax checks');
  });

  test('18. Fallback preview: cannot be presented as real application execution', () => {
    const fallbackPreview = {
      html: '<!DOCTYPE html><html><head><title>Preview</title></head><body><div id="root">Preview</div></body></html>',
      mode: 'fallback_preview' as const,
      entryPoint: 'fallback.html',
      diagnosticInfo: 'Demo mode active'
    };

    const runtimeReport = BrowserRuntimeVerifier.verifyPreviewRuntime(fallbackPreview, []);
    assert.equal(runtimeReport.verified, false, 'Fallback preview must never be verified as real execution');
  });

  test('19. Accurate final verdict: verified only with genuine passing evidence across all stages', async () => {
    const verdictBuildId = 'verdict_evidence_build';
    db.saveBuild({
      id: verdictBuildId,
      userId: 'verdict_user',
      idea: 'Complete Verified App',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1000,
      totalCost: 0.05,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 3
    });

    // 1. Add documentation
    await MergeManager.createFile(verdictBuildId, 'agent_doc', {
      action: 'create_file',
      path: 'README.md',
      content: '# Complete App\nSetup and run instructions.'
    });

    // 2. Add package.json
    await MergeManager.createFile(verdictBuildId, 'agent_cfg', {
      action: 'create_file',
      path: 'package.json',
      content: JSON.stringify({ name: 'complete-verified-app', version: '1.0.0' })
    });

    // 3. Add clean TypeScript source code
    await MergeManager.createFile(verdictBuildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/index.ts',
      content: 'export const compute = (x: number): number => x * 2;'
    });

    // 4. Add passing automated test suite
    await MergeManager.createFile(verdictBuildId, 'agent_qa', {
      action: 'create_file',
      path: 'tests/index.test.ts',
      content: `
        import { test } from 'node:test';
        import assert from 'node:assert/strict';
        import { compute } from '../src/index.ts';

        test('compute multiplies input by 2', () => {
          assert.equal(compute(4), 8);
        });
      `
    });

    // 5. Add completed task
    const task = TaskManager.createNewTask(verdictBuildId, {
      title: 'Build Verified Feature',
      description: 'Implement core multiply logic',
      filePaths: ['src/index.ts'],
      priority: 1
    });
    // Claim and then complete the task with valid ownership
    const claimed = TaskManager.claimTask(verdictBuildId, 'agent_dev', ['backend'], 'backend_developer');
    assert.ok(claimed, 'Task must be claimed');
    const compRes = TaskManager.completeTask(verdictBuildId, task.id, 'agent_dev');
    assert.equal(compRes.success, true);

    const report = HonestVerificationService.evaluateProjectReadiness(verdictBuildId);
    assert.ok(
      report.verdict === 'verified' || report.verdict === 'partially_verified',
      `Verdict must reflect true evidence, got: ${report.verdict}`
    );
    assert.equal(report.syntaxChecksPassed, true);
    assert.equal(report.securityAuditPassed, true);
    assert.equal(report.knownDefects.length, 0);
  });
});
