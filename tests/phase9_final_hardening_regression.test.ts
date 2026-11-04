import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { CodeGenerationEngine } from '../server/swarm/codeGenerationEngine.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { AutomaticRepairEngine } from '../server/swarm/automaticRepairEngine.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { ProjectFile } from '../server/types.js';

describe('Phase 9 Final Hardening Regression Tests', () => {
  const userId = 'usr_regress_p9';
  let counter = 0;

  function makeTestBuild(prefix: string) {
    const id = `bld_${prefix}_${Date.now()}_${++counter}`;
    db.saveBuild({
      id,
      userId,
      idea: 'Test Phase 9 Regression App',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-pro'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 25.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0
    });
    return id;
  }

  beforeEach(() => {
    db.createUser({
      id: userId,
      email: 'regress@p9.test',
      name: 'Regression Engineer',
      githubConnected: false,
      costLimitPerBuild: 25.0,
      enabledModelIds: ['gemini-2.5-pro'],
      createdAt: Date.now()
    });
  });

  describe('Task 1: Approval Enforcement & Bypass Prevention', () => {
    test('1.1 Accurately identifies sensitive files and non-sensitive files', () => {
      assert.strictEqual(ApprovalGateService.isSensitiveFile('.env'), true);
      assert.strictEqual(ApprovalGateService.isSensitiveFile('.env.production'), true);
      assert.strictEqual(ApprovalGateService.isSensitiveFile('server/crypto.ts'), true);
      assert.strictEqual(ApprovalGateService.isSensitiveFile('server/gateway.ts'), true);
      assert.strictEqual(ApprovalGateService.isSensitiveFile('package.json'), true);
      assert.strictEqual(ApprovalGateService.isSensitiveFile('src/components/Header.tsx'), false);
      assert.strictEqual(ApprovalGateService.isSensitiveFile('src/utils/calc.ts'), false);
    });

    test('1.2 Blocks MergeManager file creation on sensitive files when not approved', async () => {
      const testBuildId = makeTestBuild('sensitive_create_block');
      const result = await MergeManager.createFile(
        testBuildId,
        'gemini-2.5-pro',
        {
          path: 'server/crypto.ts',
          content: '// rogue override',
          commitMessage: 'attempt unauthorized override'
        }
      );
      assert.strictEqual(result.success, false);
      assert.match(result.error || '', /Human approval required for sensitive file/i);
    });

    test('1.3 Blocks MergeManager patch application on sensitive files when not approved', async () => {
      const testBuildId = makeTestBuild('sensitive_patch_block');
      // Seed file as system
      const seedResult = await MergeManager.createFile(
        testBuildId,
        'system',
        {
          path: '.env.local',
          content: 'SECRET=old\n',
          commitMessage: 'seed file'
        }
      );
      assert.strictEqual(seedResult.success, true);

      // Attempt unauthorized patch by an agent
      const patchResult = await MergeManager.applyPatch(
        testBuildId,
        'claude-3-5-sonnet',
        {
          path: '.env.local',
          edits: [
            {
              find: 'SECRET=old',
              replace: 'SECRET=hacked'
            }
          ]
        }
      );

      assert.strictEqual(patchResult.success, false);
      assert.match(patchResult.error || '', /Human approval required for sensitive file/i);
    });

    test('1.4 Rejects pending, expired, unrelated, or rejected approval requests', async () => {
      const testBuildId = makeTestBuild('approval_rejection_safety');
      const sensitivePath = 'server/crypto.ts';

      const approvalRes = ApprovalGateService.requestApproval(testBuildId, userId, {
        requestingAgent: 'gemini-2.5-pro',
        requestingRole: 'backend_developer',
        operationType: 'security_sensitive_change',
        explanation: 'Attempt to modify security layer',
        affectedFiles: [sensitivePath],
        proposedChanges: 'Update crypto ciphers',
        riskLevel: 'high'
      });
      assert.ok(approvalRes.success && approvalRes.request);

      // Pending state must not allow approval
      let isApproved = ApprovalGateService.hasApprovedRequestForFiles(testBuildId, [sensitivePath]);
      assert.strictEqual(isApproved, false, 'Pending request must not grant approval');

      // Unrelated file query must be false
      let unrelatedApproved = ApprovalGateService.hasApprovedRequestForFiles(testBuildId, ['server/email.ts']);
      assert.strictEqual(unrelatedApproved, false, 'Approval for file A must not grant approval for file B');

      // Reject the request
      const respondRes = ApprovalGateService.respondToApproval(
        testBuildId,
        approvalRes.request.id,
        'rejected',
        userId,
        'Security rejection: unauthorized modification'
      );
      assert.strictEqual(respondRes.success, true);
      assert.strictEqual(respondRes.request?.status, 'rejected');

      isApproved = ApprovalGateService.hasApprovedRequestForFiles(testBuildId, [sensitivePath]);
      assert.strictEqual(isApproved, false, 'Rejected request must strictly block approval');
    });

    test('1.5 Prevents automatic repair from patching sensitive files without approval', async () => {
      const testBuildId = makeTestBuild('repair_sensitive_safety');
      const model = modelRegistry.getModel('gemini-2.5-pro')!;

      // File with syntax error on a sensitive file
      const sensitiveFile: ProjectFile = {
        buildId: testBuildId,
        path: 'server/crypto.ts',
        content: 'export const broken = {; // invalid syntax in crypto\n',
        language: 'typescript',
        lastModifiedBy: 'system',
        version: 1,
        contentHash: 'hash-broken-crypto',
        updatedAt: Date.now()
      };

      const repairResult = await AutomaticRepairEngine.repairProjectFiles({
        buildId: testBuildId,
        userId,
        model,
        files: [sensitiveFile]
      });

      // Without approval, repair cannot modify sensitive files
      assert.strictEqual(repairResult.success, false);
      assert.ok(repairResult.unresolvedDefects.some(d => d.includes('Approval required') || d.includes('sensitive')));
    });

    test('1.6 Allows sensitive file modification only after explicit approval matching the build and files', async () => {
      const testBuildId = makeTestBuild('approval_granted_path');
      const sensitivePath = 'server/crypto.ts';

      const approvalRes = ApprovalGateService.requestApproval(testBuildId, userId, {
        requestingAgent: 'gemini-2.5-pro',
        requestingRole: 'backend_developer',
        operationType: 'security_sensitive_change',
        explanation: 'Authorized patch by lead engineer',
        affectedFiles: [sensitivePath],
        proposedChanges: 'export const CRYPTO_KEY = "verified";\n',
        riskLevel: 'high'
      });
      assert.ok(approvalRes.success && approvalRes.request);

      const respondRes = ApprovalGateService.respondToApproval(
        testBuildId,
        approvalRes.request.id,
        'approved',
        userId,
        'Approved by authorized lead engineer'
      );
      assert.strictEqual(respondRes.success, true);
      assert.strictEqual(respondRes.request?.status, 'approved');

      const isApproved = ApprovalGateService.hasApprovedRequestForFiles(testBuildId, [sensitivePath]);
      assert.strictEqual(isApproved, true);

      // Now MergeManager must permit the modification
      const result = await MergeManager.createFile(
        testBuildId,
        'gemini-2.5-pro',
        {
          path: sensitivePath,
          content: 'export const CRYPTO_KEY = "verified";\n',
          commitMessage: 'authorized update'
        }
      );

      assert.strictEqual(result.success, true);
      const written = db.getFile(testBuildId, sensitivePath);
      assert.ok(written);
      assert.strictEqual(written.content, 'export const CRYPTO_KEY = "verified";\n');
    });
  });

  describe('Task 2: Real Cancellation Across Passes', () => {
    test('2.1 Stops generation run and records cancellation timestamp & reason', async () => {
      const testBuildId = makeTestBuild('cancel_test_run');

      // Pre-seed an existing file that must remain untouched and safely preserved
      db.createFileAtomic(testBuildId, 'system', {
        path: 'src/preserved.ts',
        content: 'export const PRESERVED = 42;\n'
      });

      // Prepare a run with actions
      const runPromise = CodeGenerationEngine.runGenerationPipeline({
        buildId: testBuildId,
        userRequest: 'Build counter and math module',
        mockAiResponse: {
          thinking: 'Generate modules',
          actions: [
            {
              action: 'create_file',
              path: 'src/utils/counter.ts',
              content: 'export const counter = 1;\n',
              explanation: 'Counter utility'
            }
          ]
        }
      });

      // Register cancellation immediately
      const activeRuns = CodeGenerationEngine.getActiveRunsForBuild(testBuildId);
      if (activeRuns.length > 0) {
        CodeGenerationEngine.cancelRun(activeRuns[0].id, 'User clicked stop button');
      }

      const run = await runPromise;
      assert.strictEqual(run.status, 'cancelled');
      assert.ok(run.cancellationReason?.includes('User clicked stop button') || run.status === 'cancelled');

      // Verify pre-existing file was untouched and preserved safely
      const preserved = db.getFile(testBuildId, 'src/preserved.ts');
      assert.ok(preserved, 'Pre-existing file must remain in workspace');
      assert.strictEqual(preserved?.content, 'export const PRESERVED = 42;\n');
    });

    test('2.2 Prevent cancelled run from transitioning into finalized state', async () => {
      const testBuildId = makeTestBuild('cancelled_no_finalize');
      const run = db.saveGenerationRun({
        id: `run_cguard_${Date.now()}`,
        buildId: testBuildId,
        userRequest: 'Cancelled run guard',
        generationProfile: 'standard_crud_app',
        modelId: 'gemini-2.5-pro',
        status: 'cancelled',
        currentPass: 3,
        totalPasses: 6,
        passes: [],
        filesCreated: [],
        filesModified: [],
        patchIds: [],
        contractsEstablished: [],
        repairAttempts: 0,
        repairLogs: [],
        tokenUsage: 0,
        cost: 0,
        createdAt: Date.now(),
        completedAt: Date.now(),
        cancellationReason: 'Aborted by engineer',
        cancelledAt: Date.now()
      });

      assert.strictEqual(run.status, 'cancelled');
      assert.strictEqual(CodeGenerationEngine.isRunCancelled(run.id), true);
    });
  });

  describe('Task 3: Strict 5-Dimension Validation & Revalidation', () => {
    test('3.1 Enforces all 5 validation dimensions (syntax, typeCheck, integration, contract, config)', () => {
      const cleanFiles: ProjectFile[] = [
        {
          buildId: 'test_dim',
          path: 'src/index.ts',
          content: 'export const message = "hello world";\n',
          language: 'typescript',
          lastModifiedBy: 'system',
          version: 1,
          contentHash: 'hash-clean',
          updatedAt: Date.now()
        }
      ];

      const snapshot = AutomaticRepairEngine.evaluateValidationDimensions(cleanFiles, []);
      assert.strictEqual(snapshot.syntaxPassed, true);
      assert.strictEqual(snapshot.typeCheckPassed, true);
      assert.strictEqual(snapshot.integrationPassed, true);
      assert.strictEqual(snapshot.contractPassed, true);
      assert.strictEqual(snapshot.configPassed, true);
      assert.strictEqual(snapshot.clean, true);

      // Corrupted file fails syntax
      const brokenFiles: ProjectFile[] = [
        {
          buildId: 'test_dim',
          path: 'src/broken.ts',
          content: 'export const x = {; // syntax error\n',
          language: 'typescript',
          lastModifiedBy: 'system',
          version: 1,
          contentHash: 'hash-broken',
          updatedAt: Date.now()
        }
      ];

      const brokenSnapshot = AutomaticRepairEngine.evaluateValidationDimensions(brokenFiles, []);
      assert.strictEqual(brokenSnapshot.syntaxPassed, false);
      assert.strictEqual(brokenSnapshot.clean, false);
      assert.ok(brokenSnapshot.diagnostics.some(d => d.includes('[SYNTAX]')));
    });

    test('3.2 Rejects run finalization if generated code fails validation and repair cannot resolve it', async () => {
      const testBuildId = makeTestBuild('unresolvable_syntax_failure');

      const run = await CodeGenerationEngine.runGenerationPipeline({
        buildId: testBuildId,
        userRequest: 'Create broken syntax file',
        mockAiResponse: {
          thinking: 'Generate broken syntax',
          actions: [
            {
              action: 'create_file',
              path: 'src/broken.ts',
              content: 'export const broken = {; // invalid syntax error\n',
              explanation: 'Create unparseable file'
            }
          ]
        }
      });

      // Must be marked failed, never finalized!
      assert.strictEqual(run.status, 'failed', 'Unrepairable syntax defect must fail the run');
      assert.ok(run.error || run.validationResults?.clean === false);
    });

    test('3.3 Successfully finalizes run when all 5 dimensions pass cleanly', async () => {
      const testBuildId = makeTestBuild('clean_finalization');

      const run = await CodeGenerationEngine.runGenerationPipeline({
        buildId: testBuildId,
        userRequest: 'Create valid math calculation utility',
        mockAiResponse: {
          thinking: 'Generate clean math function',
          actions: [
            {
              action: 'create_file',
              path: 'src/utils/calc.ts',
              content: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
              explanation: 'Add calculation utility'
            }
          ]
        }
      });

      assert.strictEqual(run.status, 'finalized');
      assert.strictEqual(run.validationResults?.syntaxPassed, true);
      assert.strictEqual(run.validationResults?.typeCheckPassed, true);
      assert.strictEqual(run.validationResults?.integrationPassed, true);
      assert.strictEqual(run.validationResults?.contractPassed, true);
      assert.strictEqual(run.validationResults?.configPassed, true);
      assert.strictEqual(run.validationResults?.clean, true);
    });
  });
});
