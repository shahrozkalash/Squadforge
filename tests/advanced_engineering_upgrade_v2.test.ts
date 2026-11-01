import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { 
  computeMyersDiff,
  normalizeCodeForComparison,
  isFormattingOnlyChange,
  computeAgentDiff,
  checkGenuineRevert
} from '../src/utils/diffEngine.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { IntegrationAgent } from '../server/swarm/integrationAgent.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { Build, ProjectFile, AgentTaskResult } from '../server/types.js';

describe('SquadForge Advanced Engineering Upgrade V2 Test Suite', () => {
  const testUserId = 'adv_v2_user';
  const testBuildId = 'bld_adv_v2_test';

  beforeEach(() => {
    if (!db.getUser(testUserId)) {
      db.saveUser({
        id: testUserId,
        email: 'adv_v2@example.com',
        name: 'SquadForge Engineer',
        githubConnected: false,
        costLimitPerBuild: 20.0,
        enabledModelIds: ['gemini-2.5-pro'],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    const testBuild: Build = {
      id: testBuildId,
      userId: testUserId,
      idea: 'Autonomous Multi-Agent Enterprise Engineering Platform',
      status: 'completed',
      selectedModels: ['gemini-2.5-pro', 'claude-3-7-sonnet'],
      totalTokens: 0,
      totalCost: 0,
      costLimit: 20.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 0,
      autoPushGithub: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    db.saveBuild(testBuild);
    db.tasks.delete(testBuildId);
    db.files.delete(testBuildId);
  });

  describe('1. Upgraded Diff Engine & Syntax-Aware Formatting Detection', () => {
    test('Myers diff correctly computes additions, deletions, and modifications with stable line IDs', () => {
      const oldCode = 'const a = 1;\nconst b = 2;\nconsole.log(a + b);';
      const newCode = 'const a = 1;\nconst b = 3;\nconst c = 4;\nconsole.log(a + b + c);';

      const hunks = computeMyersDiff(oldCode, newCode);
      assert.ok(hunks.length > 0, 'Should generate diff hunks');

      const diff = computeAgentDiff(oldCode, newCode, {
        oldVersion: 1,
        newVersion: 2,
        defaultTargetAgent: 'gemini-2.5-pro'
      });

      assert.ok(diff.summary.totalChanges > 0, 'Total changes should be positive');
      assert.ok(diff.lines.every(l => typeof l.lineId === 'string' && l.lineId.length > 0), 'Every line must have stable lineId');
      assert.ok(diff.splitRows.length > 0, 'Split rows must be populated');
    });

    test('Preserves string literal contents in formatting check: whitespace change in string is SEMANTIC', () => {
      const code1 = 'const greeting = "hello  world";';
      const code2 = 'const greeting = "hello world";';

      assert.notEqual(
        normalizeCodeForComparison(code1),
        normalizeCodeForComparison(code2),
        'String literal contents with different internal whitespace must NOT normalize to identical values'
      );

      assert.equal(
        isFormattingOnlyChange(code1, code2),
        false,
        'Whitespace change inside a string literal MUST NOT be classified as formatting-only'
      );
    });

    test('Preserves template literal contents in formatting check', () => {
      const t1 = 'const msg = `Count is ${count}   items`;';
      const t2 = 'const msg = `Count is ${count} items`;';

      assert.equal(
        isFormattingOnlyChange(t1, t2),
        false,
        'Whitespace changes in template literal text must be recognized as semantic changes'
      );
    });

    test('Distinguishes different operators as semantic changes', () => {
      const plusCode = 'const sum = a + b;';
      const minusCode = 'const sum = a - b;';

      assert.equal(
        isFormattingOnlyChange(plusCode, minusCode),
        false,
        'Changing + to - operator must NEVER be classified as formatting-only'
      );
    });

    test('Identifies pure indentation, whitespace around tokens, and comments as formatting-only', () => {
      const rawCode = 'function test(a,b){\nreturn a+b;\n}';
      const formattedCode = '  function test(a, b) {\n    // addition logic\n    return a + b;\n  }\n';

      assert.equal(
        isFormattingOnlyChange(rawCode, formattedCode),
        true,
        'Pure indentation, comma spacing, and comments should be classified as formatting-only'
      );
    });

    test('Genuine revert detection requires historical context and actual revision comparison', () => {
      const history = [
        { version: 1, content: 'export const PORT = 3000;\nconst a = 1;', authorModel: 'arch', timestamp: 100 },
        { version: 2, content: 'export const PORT = 8080;\nconst a = 1;', authorModel: 'dev', timestamp: 200 },
        { version: 3, content: 'export const PORT = 3000;\nconst a = 1;', authorModel: 'verifier', timestamp: 300 }
      ];

      // Version 3 restored PORT = 3000 from version 1
      const isRevert = checkGenuineRevert('export const PORT = 3000;', history, 3);
      assert.equal(isRevert, true, 'Restoring line changed in v2 back to v1 value is a genuine revert');

      // Trivial identical line present everywhere without prior change is NOT a revert
      const isA1Revert = checkGenuineRevert('const a = 1;', history, 3);
      assert.equal(isA1Revert, false, 'Line that was never modified across history is not a revert');
    });
  });

  describe('2. Multi-Agent File Locking & Merge Concurrency', () => {
    test('Acquires and releases file leases in consistent alphabetical order', () => {
      const file1: ProjectFile = {
        path: 'src/b_service.ts',
        content: 'export const b = 2;',
        version: 1,
        history: []
      };
      const file2: ProjectFile = {
        path: 'src/a_service.ts',
        content: 'export const a = 1;',
        version: 1,
        history: []
      };

      db.setFile(testBuildId, file1);
      db.setFile(testBuildId, file2);

      // Acquire leases on multiple files unordered
      const result = MergeManager.acquireFileLeases(
        testBuildId,
        'gemini-2.5-pro',
        ['src/b_service.ts', 'src/a_service.ts'],
        5000
      );

      assert.equal(result.success, true);
      assert.deepEqual(result.acquiredPaths, ['src/a_service.ts', 'src/b_service.ts'], 'Must acquire in alphabetical order');

      // Conflicting acquisition by another agent while active lease held
      const conflict = MergeManager.acquireFileLeases(
        testBuildId,
        'claude-3-7-sonnet',
        ['src/a_service.ts'],
        5000
      );
      assert.equal(conflict.success, false);
      assert.equal(conflict.lockedBy, 'gemini-2.5-pro');

      // Release leases
      const released = MergeManager.releaseFileLeases(testBuildId, 'gemini-2.5-pro', ['src/a_service.ts', 'src/b_service.ts']);
      assert.equal(released.success, true);
    });

    test('Renews active file leases for long-running tasks', () => {
      const file: ProjectFile = {
        path: 'src/calc.ts',
        content: 'export function calc() { return 42; }',
        version: 1,
        history: []
      };
      db.setFile(testBuildId, file);

      MergeManager.acquireFileLeases(testBuildId, 'agent_worker', ['src/calc.ts'], 2000);
      const renew = MergeManager.renewFileLeases(testBuildId, 'agent_worker', ['src/calc.ts'], 10000);

      assert.equal(renew.success, true);
      const updated = db.getFile(testBuildId, 'src/calc.ts');
      assert.ok(updated?.leaseExpiresAt && updated.leaseExpiresAt > Date.now() + 5000);

      MergeManager.releaseFileLeases(testBuildId, 'agent_worker', ['src/calc.ts']);
    });

    test('Detects version conflicts when expectedVersion does not match current version', async () => {
      const file: ProjectFile = {
        path: 'src/config.ts',
        content: 'export const TIMEOUT = 1000;',
        version: 3,
        history: []
      };
      db.setFile(testBuildId, file);

      // Stale agent submits patch based on expectedVersion: 2
      const patchResult = await MergeManager.applyPatch(testBuildId, 'stale_agent', {
        path: 'src/config.ts',
        expectedVersion: 2,
        edits: [{ find: 'TIMEOUT = 1000', replace: 'TIMEOUT = 5000' }]
      });

      assert.equal(patchResult.success, false);
      assert.match(patchResult.error || '', /Version conflict/i);
    });
  });

  describe('3. Honest Task Verification & Execution Evidence', () => {
    test('Does not fabricate passed test results when none were executed', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Build auth router',
        description: 'Implement JWT authentication router in server/auth.ts',
        filePaths: ['server/auth.ts'],
        priority: 2,
        assignedRole: 'backend_developer'
      });

      // File exists in workspace
      db.setFile(testBuildId, {
        path: 'server/auth.ts',
        content: 'export const auth = () => true;',
        version: 1,
        history: []
      });

      // Complete task without providing taskResult (or without tests executed)
      TaskManager.completeTask(testBuildId, task.id, 'gemini-2.5-pro');

      const completed = db.getTask(testBuildId, task.id);
      assert.ok(completed);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.verificationOutput?.testsPassed, false, 'Must not claim tests passed when none were executed');
      assert.deepEqual(completed.taskResult?.testsExecuted, [], 'testsExecuted must be empty, not fabricated');
      assert.ok(completed.verificationHistory && completed.verificationHistory.length > 0, 'Verification history must be preserved');
    });

    test('Verifies target files actually exist and catches missing files', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Create user controller',
        description: 'Create server/userController.ts',
        filePaths: ['server/missingUserController.ts'],
        priority: 2,
        assignedRole: 'backend_developer'
      });

      // Task complete attempted, but file was never created!
      TaskManager.completeTask(testBuildId, task.id, 'gemini-2.5-pro');

      const updated = db.getTask(testBuildId, task.id);
      assert.ok(updated);
      assert.equal(updated.status, 'failed', 'Task should fail verification when expected file is missing');
      assert.equal(updated.verificationOutput?.filesVerified, false);
      assert.match(updated.error || '', /was not found/i);
    });

    test('Records executed test results with explicit statuses (passed, failed, skipped)', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Implement math module',
        description: 'Module in src/math.ts',
        filePaths: ['src/math.ts'],
        priority: 2,
        assignedRole: 'fullstack_developer'
      });

      db.setFile(testBuildId, {
        path: 'src/math.ts',
        content: 'export const add = (a: number, b: number) => a + b;',
        version: 1,
        history: []
      });

      const taskResult: AgentTaskResult = {
        taskId: task.id,
        agentModelId: 'gemini-2.5-pro',
        workCompleted: 'Implemented add function and ran unit tests',
        filesCreated: ['src/math.ts'],
        filesModified: [],
        dependencies: [],
        architecturalDecisionsUsed: [],
        issuesDiscovered: [],
        testsExecuted: [
          { name: 'test add positive', passed: true, status: 'passed', durationMs: 12 },
          { name: 'test add negative', passed: true, status: 'passed', durationMs: 8 }
        ],
        executionEvidence: {
          command: 'node --test tests/math.test.ts',
          exitCode: 0,
          durationMs: 25,
          verifiedAt: Date.now()
        },
        confidence: 1.0,
        evidence: '2/2 tests passed',
        timestamp: Date.now()
      };

      TaskManager.completeTask(testBuildId, task.id, 'gemini-2.5-pro', taskResult);

      const updated = db.getTask(testBuildId, task.id);
      assert.ok(updated);
      assert.equal(updated.status, 'completed');
      assert.equal(updated.verificationOutput?.testsPassed, true);
      assert.equal(updated.verificationOutput?.status, 'passed');
      assert.equal(updated.verificationHistory?.[0]?.command, 'node --test tests/math.test.ts');
    });
  });

  describe('4. Integration Agent Intelligence & Path Aliases', () => {
    test('Resolves path aliases (@/* and ~/*) correctly to src/* files', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/components/Button.tsx',
          content: 'export const Button = () => null;',
          version: 1,
          history: []
        },
        {
          path: 'src/App.tsx',
          content: 'import { Button } from "@/components/Button";\nexport default function App() { return null; }',
          version: 1,
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(files);
      const missingFileIssues = report.issues.filter(i => i.type === 'missing_imported_file');
      assert.equal(missingFileIssues.length, 0, 'Should resolve @/components/Button to src/components/Button without error');
    });

    test('AST environment variable scanner extracts bracketed, destructured, and import.meta.env without comment false positives', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/services/api.ts',
          content: `
            // process.env.IGNORED_COMMENT_VAR should not be detected
            /* process.env.ANOTHER_COMMENT_VAR */
            const dbUrl = process.env.DATABASE_URL;
            const port = process.env['SERVER_PORT'];
            const { API_SECRET, JWT_KEY } = process.env;
            const viteUrl = import.meta.env.VITE_CLIENT_URL;
            const viteMode = import.meta.env['VITE_APP_MODE'];
            export const run = () => true;
          `,
          version: 1,
          history: []
        },
        {
          path: '.env.example',
          content: 'DATABASE_URL=\nSERVER_PORT=\nAPI_SECRET=\nJWT_KEY=\nVITE_CLIENT_URL=\nVITE_APP_MODE=\n',
          version: 1,
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(files);
      assert.ok(report.environmentVarsUsed.includes('DATABASE_URL'));
      assert.ok(report.environmentVarsUsed.includes('SERVER_PORT'));
      assert.ok(report.environmentVarsUsed.includes('API_SECRET'));
      assert.ok(report.environmentVarsUsed.includes('JWT_KEY'));
      assert.ok(report.environmentVarsUsed.includes('VITE_CLIENT_URL'));
      assert.ok(report.environmentVarsUsed.includes('VITE_APP_MODE'));

      assert.equal(report.environmentVarsUsed.includes('IGNORED_COMMENT_VAR'), false);
      assert.equal(report.environmentVarsUsed.includes('ANOTHER_COMMENT_VAR'), false);
    });

    test('Detects incompatible interface when function is called with missing required parameters', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/utils/math.ts',
          content: 'export function computeArea(width: number, height: number): number { return width * height; }',
          version: 1,
          history: []
        },
        {
          path: 'src/index.ts',
          content: 'import { computeArea } from "./utils/math.js";\nconst res = computeArea(10); // missing height!',
          version: 1,
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(files);
      const interfaceIssues = report.issues.filter(i => i.type === 'incompatible_interface');
      assert.ok(interfaceIssues.length > 0, 'Should detect incompatible interface for missing parameter');
      assert.match(interfaceIssues[0].message, /computeArea/);
    });

    test('Deduplicates circular dependency reports to avoid noisy redundant cycles', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/a.ts',
          content: 'import { b } from "./b.js"; export const a = 1;',
          version: 1,
          history: []
        },
        {
          path: 'src/b.ts',
          content: 'import { a } from "./a.js"; export const b = 2;',
          version: 1,
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(files);
      const cycles = report.circularDependencyChains;
      assert.equal(cycles.length, 1, 'Reciprocal cycle (a <-> b) must only be reported once in deduplicated cycles');
    });
  });

  describe('5. Strengthened Project Memory & Defect Lifecycle', () => {
    test('Confirmed requirements cannot be overwritten or displaced by unverified assumptions', () => {
      ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId);

      // Record confirmed fact
      ProjectMemoryService.recordFact(testBuildId, testUserId, {
        category: 'architecture',
        statement: 'Database must use SQLite embedded database with WAL mode',
        confidence: 'confirmed',
        source: 'user_prompt'
      });

      // Attempt to record contradictory assumption
      const added = ProjectMemoryService.recordFact(testBuildId, testUserId, {
        category: 'architecture',
        statement: 'Database must not use SQLite embedded database with WAL mode',
        confidence: 'assumption',
        source: 'architect_agent'
      });

      assert.equal(added, false, 'Contradictory assumption must be rejected');

      const facts = ProjectMemoryService.getFacts(testBuildId, testUserId);
      const sqliteFact = facts.find(f => f.statement.includes('SQLite embedded'));
      assert.ok(sqliteFact);
      assert.equal(sqliteFact.confidence, 'confirmed');
    });

    test('Defect lifecycle transitions through discovered -> scheduled -> resolved with evidence', () => {
      ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId);

      const defectId = ProjectMemoryService.recordDefect(testBuildId, testUserId, {
        description: 'Broken imports in src/auth.ts',
        filePaths: ['src/auth.ts'],
        severity: 'high',
        expectedCorrection: 'Export verifyToken function'
      });

      assert.ok(defectId);
      let defects = ProjectMemoryService.getDefects(testBuildId, testUserId);
      let d = defects.find(x => x.id === defectId);
      assert.equal(d?.status, 'discovered');
      assert.equal(d?.resolved, false);

      // Schedule repair task
      ProjectMemoryService.scheduleRepairTask(testBuildId, testUserId, defectId, 'task_fix_123');
      defects = ProjectMemoryService.getDefects(testBuildId, testUserId);
      d = defects.find(x => x.id === defectId);
      assert.equal(d?.status, 'scheduled');

      // Execute repair attempt
      const execResult = ProjectMemoryService.recordRepairExecution(
        testBuildId,
        testUserId,
        defectId,
        'Implemented verifyToken and passed tests',
        true
      );
      assert.equal(execResult.attempts, 1);

      defects = ProjectMemoryService.getDefects(testBuildId, testUserId);
      d = defects.find(x => x.id === defectId);
      assert.equal(d?.status, 'resolved');
      assert.equal(d?.resolved, true);
    });

    test('Safe context truncation preserves complete lines and items without character chopping', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Component refactor',
        description: 'Refactor navbar',
        filePaths: ['src/components/Navbar.tsx'],
        priority: 3
      });

      const context = ProjectMemoryService.retrieveTaskContext(testBuildId, testUserId, task, 250);
      assert.ok(context.length <= 250, 'Context must respect maxChars constraint');
      assert.ok(!context.endsWith('...[truncated for token limit]'), 'Should safely truncate at complete lines without abrupt chopping');
      // Verify no broken tags or halved words at the end
      const lastLine = context.split('\n').filter(Boolean).pop() || '';
      assert.ok(lastLine.length > 0);
    });
  });

  describe('6. Honest Readiness Scoring & Prevention of False Verdicts', () => {
    test('Failing tests or syntax errors strictly prevent a verified verdict even with 100% completed tasks', () => {
      // Create project files with a deliberate syntax error
      const brokenFiles: ProjectFile[] = [
        {
          path: 'src/main.tsx',
          content: 'const x: = ; // broken syntax',
          version: 1,
          history: []
        },
        {
          path: 'README.md',
          content: '# Project\nSetup docs',
          version: 1,
          history: []
        }
      ];

      for (const f of brokenFiles) {
        db.setFile(testBuildId, f);
      }

      const report = HonestVerificationService.evaluateProjectReadiness(testBuildId);
      assert.equal(report.verdict, 'failed', 'Must report failed verdict when syntax is broken');
      assert.equal(report.syntaxChecksPassed, false);

      // Verify that every check item has both status and passed defined
      for (const check of report.checks) {
        assert.ok(typeof check.status === 'string', `Check ${check.name} must have a status string`);
        assert.ok(typeof check.passed === 'boolean', `Check ${check.name} must have a passed boolean`);
      }
    });
  });
});
