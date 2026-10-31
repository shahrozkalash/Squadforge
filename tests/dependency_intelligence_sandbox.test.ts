import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DependencyResolverService } from '../server/swarm/dependencyResolver.js';
import { PreviewGenerator } from '../server/swarm/previewGenerator.js';
import { BrowserRuntimeVerifier } from '../server/swarm/runtimeVerifier.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { db } from '../server/store.js';
import { ProjectFile, User, Build } from '../server/types.js';

describe('SquadForge Advanced Engineering: Dependency Intelligence, Sandbox Security & QA', () => {

  describe('1. Dependency Intelligence & Subpath Enforcement', () => {
    test('Enforces allowSubpaths: false for packages that do not support subpaths', () => {
      // clsx has allowSubpaths: false
      const clsxSub = DependencyResolverService.resolveSpecifier('clsx/lite');
      assert.equal(clsxSub.allowed, false);
      assert.equal(clsxSub.status, 'rejected_subpath');
      assert.match(clsxSub.diagnostic || '', /Subpaths are not permitted for package "clsx"/);

      // axios has allowSubpaths: false
      const axiosSub = DependencyResolverService.resolveSpecifier('axios/lib/adapters/http');
      assert.equal(axiosSub.allowed, false);
      assert.equal(axiosSub.status, 'rejected_subpath');

      // canvas-confetti has allowSubpaths: false
      const confettiSub = DependencyResolverService.resolveSpecifier('canvas-confetti/dist');
      assert.equal(confettiSub.allowed, false);
      assert.equal(confettiSub.status, 'rejected_subpath');

      // tailwind-merge has allowSubpaths: false
      const twSub = DependencyResolverService.resolveSpecifier('tailwind-merge/bundle');
      assert.equal(twSub.allowed, false);
      assert.equal(twSub.status, 'rejected_subpath');
    });

    test('Permits subpaths for registered packages with allowSubpaths: true', () => {
      // lucide-react has allowSubpaths: true
      const lucideSub = DependencyResolverService.resolveSpecifier('lucide-react/icons/star');
      assert.equal(lucideSub.allowed, true);
      assert.equal(lucideSub.status, 'allowed');
      assert.equal(lucideSub.subpath, 'icons/star');
      assert.ok(lucideSub.esmUrl?.includes('lucide-react@0.546.0/icons/star'));

      // @tanstack/react-query has allowSubpaths: true
      const tanstackSub = DependencyResolverService.resolveSpecifier('@tanstack/react-query/devtools');
      assert.equal(tanstackSub.allowed, true);
      assert.equal(tanstackSub.status, 'allowed');
      assert.equal(tanstackSub.packageName, '@tanstack/react-query');
      assert.equal(tanstackSub.subpath, 'devtools');

      // date-fns has allowSubpaths: true
      const dateSub = DependencyResolverService.resolveSpecifier('date-fns/format');
      assert.equal(dateSub.allowed, true);
      assert.equal(dateSub.status, 'allowed');
      assert.equal(dateSub.subpath, 'format');
    });

    test('Maintains consistent pinned versions matching package.json', () => {
      const reactRes = DependencyResolverService.resolveSpecifier('react');
      assert.equal(reactRes.esmUrl, 'https://esm.sh/react@19?dev');

      const reactDomRes = DependencyResolverService.resolveSpecifier('react-dom');
      assert.equal(reactDomRes.esmUrl, 'https://esm.sh/react-dom@19?dev');

      const lucideRes = DependencyResolverService.resolveSpecifier('lucide-react');
      assert.equal(lucideRes.esmUrl, 'https://esm.sh/lucide-react@0.546.0?dev');

      const motionRes = DependencyResolverService.resolveSpecifier('motion');
      assert.equal(motionRes.esmUrl, 'https://esm.sh/motion@12.23.24?dev');
    });

    test('Correctly extracts base package for scoped packages', () => {
      assert.equal(DependencyResolverService.extractBasePackage('@tanstack/react-query'), '@tanstack/react-query');
      assert.equal(DependencyResolverService.extractBasePackage('@tanstack/react-query/devtools'), '@tanstack/react-query');
      assert.equal(DependencyResolverService.extractBasePackage('@google/genai'), '@google/genai');
      assert.equal(DependencyResolverService.extractBasePackage('react-dom/client'), 'react-dom');
    });

    test('Detects and rejects Node.js built-ins and server modules with clear diagnostics', () => {
      const nodeFs = DependencyResolverService.resolveSpecifier('node:fs');
      assert.equal(nodeFs.allowed, false);
      assert.equal(nodeFs.status, 'rejected_server');
      assert.match(nodeFs.diagnostic || '', /Server-side Node\.js module "node:fs"/);

      const nodePath = DependencyResolverService.resolveSpecifier('node:path');
      assert.equal(nodePath.allowed, false);
      assert.equal(nodePath.status, 'rejected_server');

      const bareFs = DependencyResolverService.resolveSpecifier('fs');
      assert.equal(bareFs.allowed, false);
      assert.equal(bareFs.status, 'rejected_server');

      const express = DependencyResolverService.resolveSpecifier('express');
      assert.equal(express.allowed, false);
      assert.equal(express.status, 'rejected_server');

      const betterSqlite = DependencyResolverService.resolveSpecifier('better-sqlite3');
      assert.equal(betterSqlite.allowed, false);
      assert.equal(betterSqlite.status, 'rejected_server');
    });

    test('Parses static, dynamic, re-export, and CommonJS require statements', () => {
      const sampleCode = `
        import React from 'react';
        import { Star } from 'lucide-react';
        export { format } from 'date-fns';
        const express = require('express');
        async function load() {
          const mod = await import('canvas-confetti');
        }
      `;

      const scanned = DependencyResolverService.parseCodeImports(sampleCode, 'src/test.tsx');
      assert.equal(scanned.length, 5);

      const staticReact = scanned.find(s => s.specifier === 'react');
      assert.equal(staticReact?.type, 'static_import');
      assert.equal(staticReact?.status, 'allowed');

      const reExport = scanned.find(s => s.specifier === 'date-fns');
      assert.equal(reExport?.type, 're_export');
      assert.equal(reExport?.status, 'allowed');

      const requireExp = scanned.find(s => s.specifier === 'express');
      assert.equal(requireExp?.type, 'require');
      assert.equal(requireExp?.status, 'rejected_server');

      const dynamicImport = scanned.find(s => s.specifier === 'canvas-confetti');
      assert.equal(dynamicImport?.type, 'dynamic_import');
      assert.equal(dynamicImport?.status, 'allowed');
    });

    test('Rejects project preview when unsupported or server modules are imported', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `
            import React from 'react';
            import fs from 'node:fs';
            export default function App() { return <div>Server Code</div>; }
          `,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('Server Preview Test', files, 'fullstack');
      assert.equal(preview.mode, 'fallback_preview');
      assert.equal(preview.compilationStatus, 'failed');
      assert.equal(preview.dependencyStatus, 'server_rejected');
      assert.ok(preview.diagnosticInfo?.includes('Server-side Node.js module "node:fs"'));
    });
  });

  describe('2. Secure Preview Sandbox & Accurate Metadata', () => {
    test('Injects restrictive CSP and security isolation script into real preview HTML', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `
            import React, { useState } from 'react';
            export default function App() {
              const [val] = useState('Secure');
              return <div>{val} App</div>;
            }
          `,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('Secure Preview Test', files, 'fullstack');
      assert.equal(preview.mode, 'real_application');
      assert.equal(preview.compilationStatus, 'compiled');
      assert.equal(preview.runtimeStatus, 'verified');
      assert.equal(preview.dependencyStatus, 'clean');

      // Check CSP
      assert.ok(preview.html.includes('Content-Security-Policy'));
      assert.ok(preview.html.includes("default-src 'none'"));
      assert.ok(preview.html.includes('https://esm.sh'));

      // Check window.parent isolation
      assert.ok(preview.html.includes('Object.defineProperty(window, \'parent\''));
      assert.ok(preview.html.includes('SF_PREVIEW_COMMAND'));
    });

    test('Never presents a fallback demonstration as a successfully executed real application', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `import React from 'react'; export default broken syntax {{{{`,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('Broken App', files, 'fullstack');
      assert.equal(preview.mode, 'fallback_preview');
      assert.equal(preview.compilationStatus, 'failed');
      assert.notEqual(preview.mode, 'real_application');
      assert.ok(preview.html.includes('Fallback Demonstration'));
    });
  });

  describe('3. Browser Runtime Verification (10 Checks)', () => {
    test('Performs all 10 distinct runtime verification checks on valid application', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `
            import React, { useState } from 'react';
            export default function App() {
              const [count, setCount] = useState(0);
              return (
                <div className="min-h-screen bg-neutral-900 text-white p-6 flex flex-col sm:flex-row">
                  <header><h1 className="text-xl font-bold">Verified Suite</h1></header>
                  <main className="flex-1">
                    <button id="btn" onClick={() => setCount(c => c + 1)}>Count: {count}</button>
                  </main>
                </div>
              );
            }
          `,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateInteractivePreview('10-Checks Verified App', files, 'fullstack');
      const report = BrowserRuntimeVerifier.verifyPreviewRuntime(preview, files);

      assert.equal(report.verified, true);
      assert.equal(report.verdict, 'verified');
      assert.ok(report.checks.length >= 10, `Expected at least 10 checks, got ${report.checks.length}`);

      // Verify specific check categories
      const checkNames = report.checks.map(c => c.name);
      assert.ok(checkNames.some(n => n.includes('HTML Document Structure')));
      assert.ok(checkNames.some(n => n.includes('JavaScript Execution')));
      assert.ok(checkNames.some(n => n.includes('DOM Mount Target')));
      assert.ok(checkNames.some(n => n.includes('Browser Dependency Import Map')));
      assert.ok(checkNames.some(n => n.includes('Meaningful Content')));
      assert.ok(checkNames.some(n => n.includes('Interactive Controls')));
      assert.ok(checkNames.some(n => n.includes('Required Routes')));
      assert.ok(checkNames.some(n => n.includes('Responsive Viewport')));
      assert.ok(checkNames.some(n => n.includes('Browser Console')));
      assert.ok(checkNames.some(n => n.includes('Unhandled Promise Rejection')));
    });

    test('Separates compilation success from runtime errors', () => {
      const compiledWithRuntimeError = {
        html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Err</title></head><body><div id="root"></div></body></html>`,
        mode: 'real_application' as const,
        entryPoint: 'src/App.tsx',
        compilationStatus: 'compiled' as const,
        runtimeErrors: ['Uncaught TypeError: Cannot read properties of undefined']
      };

      const report = BrowserRuntimeVerifier.verifyPreviewRuntime(compiledWithRuntimeError, []);
      assert.equal(report.verified, false);
      assert.equal(report.verdict, 'partially_verified');
      assert.ok(report.errors.some(e => e.includes('TypeError')));
    });
  });

  describe('4. Project Memory Authorization & Sub-Resources', () => {
    const userA = 'usr_suite_a';
    const userB = 'usr_suite_b';
    const buildA = 'bld_suite_a_proj';

    beforeEach(() => {
      const uA: User = {
        id: userA,
        email: 'userA@test.local',
        name: 'User A',
        costLimitPerBuild: 5,
        enabledModelIds: ['gemini-2.5-flash'],
        githubConnected: false,
        createdAt: Date.now()
      };
      const uB: User = {
        id: userB,
        email: 'userB@test.local',
        name: 'User B',
        costLimitPerBuild: 5,
        enabledModelIds: ['gemini-2.5-flash'],
        githubConnected: false,
        createdAt: Date.now()
      };
      db.saveUser(uA);
      db.saveUser(uB);

      const bA: Build = {
        id: buildA,
        userId: userA,
        idea: 'Project Memory Auth Testing App',
        status: 'running',
        autoPushGithub: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        selectedModels: ['gemini-2.5-flash'],
        totalTokens: 0,
        totalCost: 0,
        costLimit: 5,
        maxDurationSeconds: 300,
        patchesAppliedCount: 0,
        requirementsChecklist: [
          {
            id: 'req_auth_test',
            description: 'Enforce user ownership authorization',
            satisfied: true,
            status: 'implemented'
          }
        ]
      };
      db.saveBuild(bA);
    });

    test('getMemory, getDefects, getDecisions, getFacts enforce user ownership', () => {
      // User A can access
      const memA = ProjectMemoryService.getMemory(buildA, userA);
      assert.ok(memA);
      assert.equal(memA?.userId, userA);

      const reqsA = ProjectMemoryService.getRequirements(buildA, userA);
      assert.equal(reqsA.length, 1);

      // User B is strictly forbidden
      assert.throws(() => {
        ProjectMemoryService.getMemory(buildA, userB);
      }, /Forbidden: Access denied to project memory/);

      assert.throws(() => {
        ProjectMemoryService.getRequirements(buildA, userB);
      }, /Forbidden: Access denied to project memory/);

      assert.throws(() => {
        ProjectMemoryService.getDefects(buildA, userB);
      }, /Forbidden: Access denied to project memory/);

      assert.throws(() => {
        ProjectMemoryService.getDecisions(buildA, userB);
      }, /Forbidden: Access denied to project memory/);
    });

    test('recordFact and recordDecision reject operations without valid userId', () => {
      assert.throws(() => {
        (ProjectMemoryService as any).recordFact(buildA, '', {
          category: 'architecture',
          statement: 'Invalid call',
          confidence: 'confirmed',
          source: 'user_prompt'
        });
      }, /Forbidden: Unauthorized/);
    });
  });

  describe('5. Agent Coordination & Conflict-Free File Locking', () => {
    test('TaskManager prevents concurrent models from claiming tasks on actively locked files', () => {
      const buildId = `bld_coord_test_${Date.now()}`;
      const userCoord: User = {
        id: 'usr_coord',
        email: 'coord@test.local',
        name: 'Coordinator',
        costLimitPerBuild: 5,
        enabledModelIds: ['model_a', 'model_b'],
        githubConnected: false,
        createdAt: Date.now()
      };
      db.saveUser(userCoord);

      db.saveBuild({
        id: buildId,
        userId: userCoord.id,
        idea: 'Coordination Test',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        selectedModels: ['model_a', 'model_b'],
        autoPushGithub: false,
        totalTokens: 0,
        totalCost: 0,
        costLimit: 5,
        maxDurationSeconds: 300,
        patchesAppliedCount: 0
      });

      // Create two tasks targeting the same file: src/App.tsx
      TaskManager.createNewTask(buildId, {
        title: 'Task 1: Add Navbar',
        description: 'Edit App.tsx',
        filePaths: ['src/App.tsx'],
        priority: 2
      });

      TaskManager.createNewTask(buildId, {
        title: 'Task 2: Add Footer',
        description: 'Edit App.tsx as well',
        filePaths: ['src/App.tsx'],
        priority: 2
      });

      // Model A claims Task 1
      const claimedA = TaskManager.claimTask(buildId, 'model_a', ['frontend']);
      assert.ok(claimedA);
      assert.equal(claimedA?.claimedBy, 'model_a');
      assert.ok(claimedA?.filePaths.includes('src/App.tsx'));

      // Model B attempts to claim Task 2 targeting the SAME file src/App.tsx
      // Should return null to prevent concurrent conflicting edits!
      const claimedB = TaskManager.claimTask(buildId, 'model_b', ['frontend']);
      assert.equal(claimedB, null, 'Model B must not claim task on file actively locked by Model A');

      // Once Model A completes Task 1, Model B can claim Task 2
      TaskManager.completeTask(buildId, claimedA.id, 'model_a');

      const claimedBAfter = TaskManager.claimTask(buildId, 'model_b', ['frontend']);
      assert.ok(claimedBAfter);
      assert.equal(claimedBAfter?.claimedBy, 'model_b');
    });
  });
});
