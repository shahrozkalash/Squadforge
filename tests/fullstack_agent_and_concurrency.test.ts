import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { modelRegistry, AGENT_SPECS } from '../server/modelRegistry.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { getAgentMeta } from '../src/utils/diffEngine.js';
import { Build, ProjectFile, AgentTaskResult } from '../server/types.js';

describe('SquadForge Fullstack Developer Agent & Concurrency Upgrade Test Suite', () => {
  const testUserId = 'user_fullstack_concurrency';
  const testBuildId = 'build_fullstack_concurrency_test';

  beforeEach(() => {
    if (!db.getUser(testUserId)) {
      db.saveUser({
        id: testUserId,
        email: 'fullstack_test@example.com',
        name: 'SquadForge Engineer',
        githubConnected: false,
        costLimitPerBuild: 20.0,
        enabledModelIds: ['gemini-fullstack', 'gemini-2.5-pro'],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // Reset test build in store
    const build: Build = {
      id: testBuildId,
      userId: testUserId,
      idea: 'E-Commerce Platform with Cart and Stripe Checkout',
      projectType: 'fullstack',
      status: 'running',
      selectedModels: ['gemini-fullstack', 'gemini-2.5-pro'],
      milestones: [
        { id: 'm1', title: 'Milestone 1', description: 'Architecture', status: 'pending', taskIds: [] },
        { id: 'm2', title: 'Milestone 2', description: 'Core Dev', status: 'pending', taskIds: [] }
      ],
      totalCost: 0,
      costLimit: 5.0,
      totalTokens: 0,
      tokenBudget: 100000,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0,
      autoPushGithub: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      architectureDecisions: []
    };

    db.saveBuild(build);
    db.tasks.delete(testBuildId);
    db.files.delete(testBuildId);
  });

  describe('1. Fullstack Developer Agent Integration', () => {
    test('Role is fully registered in ModelRegistry and AGENT_SPECS with correct capabilities', () => {
      const spec = AGENT_SPECS.fullstack_developer;
      assert.ok(spec, 'AGENT_SPECS must have fullstack_developer role');
      assert.equal(spec.role, 'fullstack_developer');
      assert.ok(spec.responsibilities.length > 0);
      assert.equal(spec.assignedModelId, 'gemini-fullstack');

      const model = modelRegistry.getModel('gemini-fullstack');
      assert.ok(model, 'gemini-fullstack must be registered in ModelRegistry');
      assert.equal(model.agentRole, 'fullstack_developer');
      assert.ok(model.strengths.includes('frontend'));
      assert.ok(model.strengths.includes('backend'));
      assert.ok(model.strengths.includes('architecture'));
    });

    test('TaskManager prioritizes fullstack_developer for fullstack tasks and bridges frontend/backend', () => {
      const fullstackTask = TaskManager.createNewTask(testBuildId, {
        title: 'Integrate Fullstack Shopping Cart & Checkout API',
        description: 'Connect frontend cart state with backend API route in /api/checkout',
        filePaths: ['src/components/Cart.tsx', 'server/routes/checkout.ts'],
        priority: 2,
        assignedRole: 'fullstack_developer'
      });

      const frontendTask = TaskManager.createNewTask(testBuildId, {
        title: 'Build Product Card Component',
        description: 'Create responsive product card view',
        filePaths: ['src/components/ProductCard.tsx'],
        priority: 3,
        assignedRole: 'frontend_developer'
      });

      // Claiming with gemini-fullstack should select fullstackTask first (+25 match score)
      const claimed = TaskManager.claimTask(testBuildId, 'gemini-fullstack');
      assert.ok(claimed, 'gemini-fullstack should claim an eligible task');
      assert.equal(claimed.id, fullstackTask.id, 'Must prioritize fullstack_developer assigned task');

      // Now complete or finish fullstackTask
      db.setFile(testBuildId, { path: 'src/components/Cart.tsx', content: 'export const Cart = () => null;', version: 1, history: [] });
      db.setFile(testBuildId, { path: 'server/routes/checkout.ts', content: 'export const checkout = () => null;', version: 1, history: [] });
      TaskManager.completeTask(testBuildId, fullstackTask.id, 'gemini-fullstack');

      // Now next claim by gemini-fullstack should pick up frontendTask via cross-discipline capability
      const secondClaim = TaskManager.claimTask(testBuildId, 'gemini-fullstack');
      assert.ok(secondClaim, 'gemini-fullstack should be able to claim frontend task when no fullstack tasks remain');
      assert.equal(secondClaim.id, frontendTask.id);
    });

    test('UI diff metadata correctly resolves Fullstack Dev branding and styling', () => {
      const meta = getAgentMeta('gemini-fullstack');
      assert.match(meta.displayName, /Fullstack/i);
      assert.match(meta.badgeClass, /violet/i);
      assert.match(meta.lineHighlight, /violet/i);
    });
  });

  describe('2. Multi-Agent Concurrency, Leases, and Atomicity', () => {
    test('Simultaneous conflicting lease acquisition is rejected', () => {
      const file: ProjectFile = {
        path: 'src/sharedState.ts',
        content: 'export const state = {};',
        version: 1,
        history: []
      };
      db.setFile(testBuildId, file);

      // Model A acquires lease
      const leaseA = MergeManager.acquireFileLeases(testBuildId, 'model_alpha', ['src/sharedState.ts'], 5000);
      assert.equal(leaseA.success, true);

      // Model B attempts to acquire same file while lease is active
      const leaseB = MergeManager.acquireFileLeases(testBuildId, 'model_beta', ['src/sharedState.ts'], 5000);
      assert.equal(leaseB.success, false);
      assert.equal(leaseB.lockedBy, 'model_alpha');

      // Release lease
      MergeManager.releaseFileLeases(testBuildId, 'model_alpha', ['src/sharedState.ts']);
    });

    test('Expired file leases are safely reclaimed and re-acquirable', () => {
      const file: ProjectFile = {
        path: 'src/abandoned.ts',
        content: 'export const old = 1;',
        version: 1,
        leaseOwner: 'abandoned_worker',
        leaseExpiresAt: Date.now() - 1000, // already expired
        history: []
      };
      db.setFile(testBuildId, file);

      // New model should automatically reclaim expired lease
      const res = MergeManager.acquireFileLeases(testBuildId, 'fresh_worker', ['src/abandoned.ts'], 5000);
      assert.equal(res.success, true);
      const updated = db.getFile(testBuildId, 'src/abandoned.ts');
      assert.equal(updated?.leaseOwner, 'fresh_worker');
    });

    test('Lease renewal only succeeds for current owner on active lease', () => {
      const file: ProjectFile = {
        path: 'src/longRunning.ts',
        content: 'export const work = 1;',
        version: 1,
        history: []
      };
      db.setFile(testBuildId, file);

      MergeManager.acquireFileLeases(testBuildId, 'worker_1', ['src/longRunning.ts'], 4000);

      // Other worker cannot renew worker_1's lease
      const imposterRenew = MergeManager.renewFileLeases(testBuildId, 'worker_imposter', ['src/longRunning.ts'], 10000);
      assert.equal(imposterRenew.success, false);
      assert.match(imposterRenew.error || '', /not leased by/i);

      // Current owner can renew
      const validRenew = MergeManager.renewFileLeases(testBuildId, 'worker_1', ['src/longRunning.ts'], 10000);
      assert.equal(validRenew.success, true);
    });

    test('Stale agents cannot overwrite newer file versions', async () => {
      const file: ProjectFile = {
        path: 'src/versioned.ts',
        content: 'const v = 2;',
        version: 2,
        history: []
      };
      db.setFile(testBuildId, file);

      // Patch expects version 1, but file is already version 2
      const result = await MergeManager.applyPatch(testBuildId, 'stale_worker', {
        path: 'src/versioned.ts',
        expectedVersion: 1,
        edits: [{ find: 'const v = 2;', replace: 'const v = 3;' }]
      });

      assert.equal(result.success, false);
      assert.match(result.error || '', /Version conflict/i);

      const unchanged = db.getFile(testBuildId, 'src/versioned.ts');
      assert.equal(unchanged?.version, 2);
      assert.equal(unchanged?.content, 'const v = 2;');
    });

    test('Failed patch operations do not corrupt file history or content', async () => {
      const file: ProjectFile = {
        path: 'src/intact.ts',
        content: 'const valid = true;\nconst secondLine = true;\n',
        version: 1,
        history: [{
          version: 1,
          content: 'const valid = true;\nconst secondLine = true;\n',
          authorModel: 'system',
          timestamp: Date.now()
        }]
      };
      db.setFile(testBuildId, file);

      // Attempt patch with non-existent target text
      const failedPatch = await MergeManager.applyPatch(testBuildId, 'erroneous_agent', {
        path: 'src/intact.ts',
        edits: [{ find: 'THIS TEXT DOES NOT EXIST', replace: 'REPLACED' }]
      });

      assert.equal(failedPatch.success, false);
      assert.match(failedPatch.error || '', /not found/i);

      // Verify file history is completely intact
      const after = db.getFile(testBuildId, 'src/intact.ts');
      assert.equal(after?.version, 1);
      assert.equal(after?.history.length, 1);
      assert.equal(after?.content, 'const valid = true;\nconst secondLine = true;\n');
    });

    test('Task retries cannot create duplicate execution records', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Implement Payment Gateway Service',
        description: 'Create server/payment.ts with Stripe client',
        filePaths: ['server/payment.ts'],
        priority: 2,
        assignedRole: 'backend_developer'
      });

      db.setFile(testBuildId, {
        path: 'server/payment.ts',
        content: 'export class PaymentService {}',
        version: 1,
        history: []
      });

      TaskManager.claimTask(testBuildId, 'gemini-fullstack');

      const taskResult: AgentTaskResult = {
        taskId: task.id,
        agentModelId: 'gemini-fullstack',
        workCompleted: 'Implemented payment service',
        filesCreated: ['server/payment.ts'],
        filesModified: [],
        dependencies: [],
        architecturalDecisionsUsed: [],
        issuesDiscovered: [],
        testsExecuted: [
          { name: 'payment unit test', passed: true, status: 'passed' }
        ],
        executionEvidence: {
          command: 'node --test tests/payment.test.ts',
          exitCode: 0,
          durationMs: 40,
          executionSource: 'isolated_vm',
          verifiedAt: Date.now()
        },
        confidence: 1.0,
        evidence: '1/1 test passed',
        timestamp: Date.now()
      };

      // First completion
      TaskManager.completeTask(testBuildId, task.id, 'gemini-fullstack', taskResult);
      const afterFirst = db.getTask(testBuildId, task.id);
      const initialHistoryLength = afterFirst?.verificationHistory?.length || 0;
      assert.equal(initialHistoryLength, 1);

      // Immediate retry/duplicate completion call
      TaskManager.completeTask(testBuildId, task.id, 'gemini-fullstack', taskResult);
      const afterSecond = db.getTask(testBuildId, task.id);
      assert.equal(afterSecond?.verificationHistory?.length, 1, 'Retry must not append duplicate execution record');
      assert.equal(afterSecond?.taskResult?.testsExecuted?.length, 1, 'testsExecuted must not contain duplicate records');
    });
  });

  describe('3. Real TypeScript Verification and Readiness Evidence', () => {
    test('runTypeCheck detects genuine TypeScript type errors with diagnostic codes and line numbers', async () => {
      // Type error: assigning string to number
      const codeWithTypeMismatch = `
        export interface UserProfile {
          id: number;
          username: string;
        }

        export const adminUser: UserProfile = {
          id: "not_a_number", // Type error: TS2322
          username: "admin"
        };
      `;

      const typeReport = await ExecutionAdapter.runTypeCheck([
        { path: 'src/models.ts', content: codeWithTypeMismatch, version: 1, history: [] }
      ]);

      assert.equal(typeReport.passed, false, 'Type check must fail on type mismatch');
      assert.equal(typeReport.status, 'failed');
      assert.ok(typeReport.diagnostics.length > 0, 'Diagnostics must be captured');
      assert.ok(typeReport.errors.length > 0);

      const diag = typeReport.diagnostics[0];
      assert.ok(diag.code, 'Must have diagnostic error code');
      assert.match(String(diag.code), /TS\d+/);
      assert.ok(diag.line && diag.line > 0, 'Must report exact line number');
      assert.match(diag.message, /assignable/i, 'Must contain compiler explanation');
    });

    test('runTypeCheck passes on clean, strictly typed TypeScript code', async () => {
      const cleanCode = `
        export interface Counter {
          count: number;
          increment(): number;
        }

        export class SafeCounter implements Counter {
          count: number = 0;
          increment(): number {
            this.count += 1;
            return this.count;
          }
        }
      `;

      const typeReport = await ExecutionAdapter.runTypeCheck([
        { path: 'src/counter.ts', content: cleanCode, version: 1, history: [] }
      ]);

      assert.equal(typeReport.passed, true);
      assert.equal(typeReport.status, 'passed');
      assert.equal(typeReport.errors.length, 0);
    });

    test('evaluateProjectReadiness strictly rejects "verified" verdict when type checking fails', async () => {
      // Seed project files with a type error
      db.setFile(testBuildId, {
        path: 'src/brokenType.ts',
        content: 'const num: number = "not_a_number";',
        version: 1,
        history: []
      });

      const readiness = await HonestVerificationService.evaluateProjectReadiness(testBuildId);

      assert.notEqual(readiness.verdict, 'verified', 'Must not give verified verdict when type errors exist');
      assert.ok(readiness.unresolvedCriteria.some(c => /type/i.test(c)), 'Must report type checking issue in unresolved criteria');
    });
  });
});
