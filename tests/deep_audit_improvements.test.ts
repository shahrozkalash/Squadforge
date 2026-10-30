import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../server/store.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { PreviewGenerator, cleanupTempDir, sanitizeProjectFilePath } from '../server/swarm/previewGenerator.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { Build, ProjectFile } from '../server/types.js';

describe('SquadForge Deep Audit Verification & Quality Improvements', () => {
  const testUserId = 'test_user_audit_1';
  const testBuildId = 'bld_audit_test_1';

  beforeEach(() => {
    // Register test user
    const existingUser = db.getUser(testUserId);
    if (!existingUser) {
      db.saveUser({
        id: testUserId,
        email: 'audit_test@example.com',
        name: 'auditor',
        githubConnected: false,
        costLimitPerBuild: 5.0,
        enabledModelIds: ['gemini-2.5-pro'],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // Initialize clean test build
    const build: Build = {
      id: testBuildId,
      userId: testUserId,
      idea: 'Realtime collaborative whiteboard with auth and canvas drawing',
      projectType: 'fullstack',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-pro'],
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5.0,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0,
      requirementsChecklist: [
        {
          id: 'req_auth',
          category: 'auth',
          description: 'User authentication and JWT session login',
          satisfied: false
        },
        {
          id: 'req_canvas',
          category: 'ui',
          description: 'Interactive canvas drawing surface with shape tools',
          satisfied: false
        },
        {
          id: 'req_storage',
          category: 'database',
          description: 'Persistent SQLite database store for whiteboard canvas boards',
          satisfied: false
        }
      ]
    };
    db.saveBuild(build);
  });

  describe('1. Requirement Verification & Honest Success Reporting', () => {
    test('connects requirements to specific matching files, not arbitrary first three files', () => {
      // Add distinct files
      const files: ProjectFile[] = [
        { path: 'src/components/CanvasView.tsx', content: 'export const CanvasView = () => <canvas />;', version: 1, history: [] },
        { path: 'src/services/authService.ts', content: 'export const login = () => { return "jwt_token"; };', version: 1, history: [] },
        { path: 'src/db/sqliteStore.ts', content: 'export const saveBoard = (id: string) => { /* db insert */ };', version: 1, history: [] },
        { path: 'src/utils/logger.ts', content: 'export const log = console.log;', version: 1, history: [] }
      ];

      for (const f of files) {
        db.setFile(testBuildId, f);
      }

      const build = db.getBuild(testBuildId)!;
      const verified = HonestVerificationService.verifyRequirements(
        build,
        files,
        { syntaxErrors: [], testReport: { total: 0, passed: 0, failed: 0, details: [] } },
        { mode: 'real_application' }
      );

      const authReq = verified.find(r => r.id === 'req_auth');
      const canvasReq = verified.find(r => r.id === 'req_canvas');
      const storageReq = verified.find(r => r.id === 'req_storage');

      assert.ok(authReq, 'Auth requirement must exist');
      assert.ok(canvasReq, 'Canvas requirement must exist');
      assert.ok(storageReq, 'Storage requirement must exist');

      // Check specific attribution
      assert.ok(authReq.satisfiedByFiles?.includes('src/services/authService.ts'), 'Auth requirement must link to authService.ts');
      assert.ok(!authReq.satisfiedByFiles?.includes('src/components/CanvasView.tsx'), 'Auth requirement must not arbitrarily link to CanvasView.tsx');

      assert.ok(canvasReq.satisfiedByFiles?.includes('src/components/CanvasView.tsx'), 'Canvas requirement must link to CanvasView.tsx');
      assert.ok(storageReq.satisfiedByFiles?.includes('src/db/sqliteStore.ts'), 'Storage requirement must link to sqliteStore.ts');
    });

    test('marks requirement as failed when required implementation files are completely missing', () => {
      // Only provide unrelated logger file
      const files: ProjectFile[] = [
        { path: 'src/utils/logger.ts', content: 'export const log = console.log;', version: 1, history: [] }
      ];

      for (const f of files) {
        db.setFile(testBuildId, f);
      }

      const build = db.getBuild(testBuildId)!;
      const verified = HonestVerificationService.verifyRequirements(
        build,
        files,
        { syntaxErrors: [], testReport: { total: 0, passed: 0, failed: 0, details: [] } },
        { mode: 'real_application' }
      );

      const authReq = verified.find(r => r.id === 'req_auth');
      assert.ok(authReq);
      assert.equal(authReq.status, 'failed');
      assert.equal(authReq.satisfied, false);
      assert.ok(authReq.evidence?.includes('No implementation files found'));
    });

    test('attaches automated test outcomes to requirement evidence', () => {
      const files: ProjectFile[] = [
        { path: 'src/services/authService.ts', content: 'export const login = () => "jwt";', version: 1, history: [] }
      ];

      const build = db.getBuild(testBuildId)!;
      const verified = HonestVerificationService.verifyRequirements(
        build,
        files,
        {
          syntaxErrors: [],
          testReport: {
            total: 1,
            passed: 1,
            failed: 0,
            details: [{ name: 'authService user login tests', passed: true }]
          }
        },
        { mode: 'real_application' }
      );

      const authReq = verified.find(r => r.id === 'req_auth')!;
      assert.equal(authReq.status, 'implemented');
      assert.ok(authReq.testsExecuted?.includes('authService user login tests'));
      assert.ok(authReq.evidence?.includes('All 1 relevant test(s) passed cleanly'));
    });

    test('evaluates comprehensive VerificationReport with compilationStatus and runtimeStatus', () => {
      const report = HonestVerificationService.evaluateProjectReadiness(testBuildId);
      assert.ok(report.compilationStatus, 'Compilation status must be defined');
      assert.ok(report.runtimeStatus, 'Runtime status must be defined');
      assert.ok(Array.isArray(report.requirementsReport), 'requirementsReport must be an array');
      assert.ok(Array.isArray(report.knownLimitations), 'knownLimitations must be an array');
    });
  });

  describe('2. Preview Pipeline Reliability & Sanitization', () => {
    test('sanitizeProjectFilePath rejects path traversal sequences and null bytes', () => {
      assert.equal(sanitizeProjectFilePath('../secret.env'), null);
      assert.equal(sanitizeProjectFilePath('../../etc/passwd'), null);
      assert.equal(sanitizeProjectFilePath('src/../../root.ts'), null);
      assert.equal(sanitizeProjectFilePath('src/\0evil.ts'), null);

      assert.equal(sanitizeProjectFilePath('src/App.tsx'), 'src/App.tsx');
      assert.equal(sanitizeProjectFilePath('/src/components/Button.tsx'), 'src/components/Button.tsx');
      assert.equal(sanitizeProjectFilePath('C:/app/src/index.tsx'), 'app/src/index.tsx');
    });

    test('bundles real React application with nested source directories', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/components/Button.tsx',
          content: `import React from 'react'; export const Button = () => <button className="px-4 py-2 bg-blue-500">Click</button>;`,
          version: 1,
          history: []
        },
        {
          path: 'src/App.tsx',
          content: `import React from 'react'; import { Button } from './components/Button'; export default function App() { return <div><h1>Canvas App</h1><Button /></div>; }`,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('Test App', files, 'fullstack');
      assert.equal(preview.mode, 'real_application');
      assert.ok(preview.html.includes('Canvas App'));
      assert.ok(preview.html.includes('<script type="importmap">'));
      assert.ok(preview.html.includes('https://esm.sh/react@19?dev'));
    });

    test('captures esbuild compilation diagnostics on syntax errors without falling back silently', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `import React from 'react'; export default function App() { return <div>BROKEN SYNTAX <<<< !!! }`,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('Broken App', files, 'fullstack');
      assert.equal(preview.mode, 'fallback_preview');
      assert.ok(preview.diagnosticInfo, 'Must provide compilation diagnostics');
      assert.ok(preview.diagnosticInfo.includes('Bundle compilation failed'));
      assert.ok(preview.html.includes('Fallback Demonstration'));
    });

    test('dynamically maps external third-party packages in import map', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `import React from 'react'; import confetti from 'canvas-confetti'; export default function App() { return <div>Interactive</div>; }`,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('Confetti App', files, 'fullstack');
      assert.equal(preview.mode, 'real_application');
      assert.ok(preview.html.includes('"canvas-confetti": "https://esm.sh/canvas-confetti?dev"'));
    });

    test('cleanupTempDir safely deletes temporary workspaces in all paths', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadforge_test_cleanup_'));
      fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'hello');
      assert.ok(fs.existsSync(tempDir));

      cleanupTempDir(tempDir);
      assert.ok(!fs.existsSync(tempDir));
    });
  });

  describe('3. Swarm Orchestration & Atomic Task Claiming', () => {
    test('claimTaskAtomic prevents duplicate concurrent claims', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Build Auth Router',
        description: 'Implement auth routes',
        filePaths: ['server/routes/auth.ts'],
        priority: 1
      });

      const expires = Date.now() + 60000;
      // First worker claims
      const claim1 = db.claimTaskAtomic(testBuildId, task.id, 'gemini-2.5-pro', expires);
      assert.ok(claim1, 'First worker claim must return task');
      assert.equal(claim1.claimedBy, 'gemini-2.5-pro');

      // Second worker attempts to claim same task concurrently
      const claim2 = db.claimTaskAtomic(testBuildId, task.id, 'claude-3-5-sonnet', expires);
      assert.equal(claim2, null, 'Second worker claim must be rejected atomically');
    });

    test('tasks with unfinished dependencies cannot be claimed', () => {
      const parentTask = TaskManager.createNewTask(testBuildId, {
        title: 'Define Contracts',
        description: 'Define contracts first',
        filePaths: ['src/types.ts'],
        priority: 1
      });

      const childTask = TaskManager.createNewTask(testBuildId, {
        title: 'Implement Consumer',
        description: 'Must wait for contracts',
        filePaths: ['src/consumer.ts'],
        dependencies: [parentTask.id],
        priority: 1
      });

      // Child task must not be claimable while parent is pending
      const claimedChild = TaskManager.claimTask(testBuildId, 'gemini-2.5-pro');
      assert.notEqual(claimedChild?.id, childTask.id, 'Child task with unmet dependencies must not be claimed');
      assert.equal(claimedChild?.id, parentTask.id, 'Parent task must be claimed first');
    });

    test('expired task lease transitions to failed when max retries exceeded', () => {
      const task = TaskManager.createNewTask(testBuildId, {
        title: 'Flaky Task',
        description: 'Will fail after retries',
        filePaths: ['src/flaky.ts'],
        priority: 1,
        maxRetries: 1
      });

      // Claim and expire lease with retryCount >= maxRetries
      db.updateTask(testBuildId, task.id, {
        status: 'in_progress',
        claimedBy: 'model-a',
        leaseExpiresAt: Date.now() - 1000,
        retryCount: 1,
        maxRetries: 1
      });

      TaskManager.cleanExpiredLeases(testBuildId);

      const updated = db.getTask(testBuildId, task.id)!;
      assert.equal(updated.status, 'failed', 'Task exceeding max retries must fail on lease expiration');
      assert.ok(updated.error?.includes('retries exhausted'));
    });
  });

  describe('4. Project Memory Relevance Ranking', () => {
    test('retrieveTaskContext ranks relevant requirements higher than unrelated ones', () => {
      const task = {
        id: 'task_canvas_ui',
        buildId: testBuildId,
        title: 'Implement Drawing Canvas Component',
        description: 'Create interactive whiteboard canvas drawing surface',
        filePaths: ['src/components/CanvasView.tsx'],
        status: 'pending' as const,
        priority: 1,
        createdAt: Date.now()
      };

      const context = ProjectMemoryService.retrieveTaskContext(testBuildId, testUserId, task, 2000);
      assert.ok(context.includes('TARGET REQUIREMENTS:'));
      assert.ok(context.includes('canvas') || context.includes('drawing'), 'Must prioritize canvas requirement');
    });
  });
});
