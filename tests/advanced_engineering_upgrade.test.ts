import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { 
  DependencyResolverService, 
  validatePackageName, 
  isTrustedHttpsUrl, 
  deriveSubpathUrl,
  TRUSTED_HTTPS_PACKAGE_ORIGINS 
} from '../server/swarm/dependencyResolver.js';
import { PreviewGenerator, sanitizeProjectFilePath } from '../server/swarm/previewGenerator.js';
import { BrowserRuntimeVerifier } from '../server/swarm/runtimeVerifier.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { Build, ProjectFile } from '../server/types.js';

describe('SquadForge Advanced Autonomous Engineering Upgrade Test Suite', () => {
  const testUserId = 'adv_user_1';
  const otherUserId = 'adv_user_intruder';
  const testBuildId = 'bld_adv_upgrade_1';

  beforeEach(() => {
    // Reset any custom allowed packages
    DependencyResolverService.resetAllowedPackages();

    // Register test users
    if (!db.getUser(testUserId)) {
      db.saveUser({
        id: testUserId,
        email: 'adv_user_1@example.com',
        name: 'Engineer One',
        githubConnected: false,
        costLimitPerBuild: 10.0,
        enabledModelIds: ['gemini-2.5-pro'],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    if (!db.getUser(otherUserId)) {
      db.saveUser({
        id: otherUserId,
        email: 'intruder@example.com',
        name: 'Intruder',
        githubConnected: false,
        costLimitPerBuild: 5.0,
        enabledModelIds: ['gemini-2.5-flash'],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // Initialize test build
    const testBuild: Build = {
      id: testBuildId,
      userId: testUserId,
      idea: 'Real-time collaborative diagramming application',
      status: 'completed',
      selectedModels: ['gemini-2.5-pro'],
      totalTokens: 0,
      totalCost: 0,
      costLimit: 10.0,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0,
      autoPushGithub: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      requirementsChecklist: [
        {
          id: 'req_canvas',
          category: 'diagram',
          description: 'Vector rendering canvas component for interactive shapes',
          satisfied: false
        },
        {
          id: 'req_export',
          category: 'export',
          description: 'SVG and PNG export capability for diagrams',
          satisfied: false
        }
      ]
    };
    db.saveBuild(testBuild);
  });

  describe('1. Dependency Resolution Engine Hardening', () => {
    test('validates package names and rejects dangerous or invalid specifiers', () => {
      assert.equal(validatePackageName('react').valid, true);
      assert.equal(validatePackageName('@types/react').valid, true);
      assert.equal(validatePackageName('lucide-react').valid, true);
      assert.equal(validatePackageName('canvas-confetti').valid, true);

      // Path traversal or shell injections rejected
      assert.equal(validatePackageName('../malicious/path').valid, false);
      assert.equal(validatePackageName('react; rm -rf /').valid, false);
      assert.equal(validatePackageName('http://evil.com/pkg').valid, false);
      assert.equal(validatePackageName('/absolute/path').valid, false);
    });

    test('enforces trusted HTTPS origins for custom package URLs', () => {
      assert.equal(isTrustedHttpsUrl('https://esm.sh/canvas-confetti@1.9.4'), true);
      assert.equal(isTrustedHttpsUrl('https://cdn.jsdelivr.net/npm/canvas-confetti'), true);
      assert.equal(isTrustedHttpsUrl('https://unpkg.com/canvas-confetti'), true);

      // Rejects HTTP (unencrypted) or untrusted domains
      assert.equal(isTrustedHttpsUrl('http://esm.sh/canvas-confetti'), false);
      assert.equal(isTrustedHttpsUrl('https://untrusted-cdn.attacker.com/malicious.js'), false);
      assert.equal(isTrustedHttpsUrl('javascript:alert(1)'), false);
    });

    test('respects custom package URLs during exact and subpath resolution', () => {
      DependencyResolverService.registerAllowedPackage('my-icons', {
        url: 'https://cdn.jsdelivr.net/npm/my-icons@2.0.0/+esm',
        allowSubpaths: true
      });

      const exact = DependencyResolverService.resolveSpecifier('my-icons');
      assert.equal(exact.allowed, true);
      assert.equal(exact.esmUrl, 'https://cdn.jsdelivr.net/npm/my-icons@2.0.0/+esm');

      const subpath = DependencyResolverService.resolveSpecifier('my-icons/arrows');
      assert.equal(subpath.allowed, true);
      assert.ok(subpath.esmUrl?.startsWith('https://cdn.jsdelivr.net/npm/my-icons@2.0.0/arrows'));
    });

    test('enforces allowSubpaths: false consistently', () => {
      DependencyResolverService.registerAllowedPackage('strict-pkg', {
        url: 'https://esm.sh/strict-pkg@1.0.0',
        allowSubpaths: false
      });

      const exact = DependencyResolverService.resolveSpecifier('strict-pkg');
      assert.equal(exact.allowed, true);

      const subpath = DependencyResolverService.resolveSpecifier('strict-pkg/internal');
      assert.equal(subpath.allowed, false);
      assert.equal(subpath.status, 'rejected_subpath');
      assert.ok(subpath.diagnostic?.includes('Subpaths are not permitted'));
    });

    test('detects Node.js built-ins including node: prefix and rejects them for browser preview', () => {
      const bareFs = DependencyResolverService.resolveSpecifier('fs');
      assert.equal(bareFs.allowed, false);
      assert.equal(bareFs.status, 'rejected_server');

      const nodeFs = DependencyResolverService.resolveSpecifier('node:fs');
      assert.equal(nodeFs.allowed, false);
      assert.equal(nodeFs.status, 'rejected_server');

      const nodePath = DependencyResolverService.resolveSpecifier('node:path');
      assert.equal(nodePath.allowed, false);
      assert.equal(nodePath.status, 'rejected_server');

      const bareChildProcess = DependencyResolverService.resolveSpecifier('child_process');
      assert.equal(bareChildProcess.allowed, false);
      assert.equal(bareChildProcess.status, 'rejected_server');
    });

    test('avoids false positives in code comments and normal strings', () => {
      const codeSnippet = `
        // import fs from 'fs';
        /* import child_process from 'child_process';
           const x = require('node:os');
        */
        const textTemplate = "Here is an example: import badModule from 'evil-module';";
        import React from 'react';
        import { useState } from 'react';
        export { render } from 'react-dom';
      `;

      const scanned = DependencyResolverService.parseCodeImports(codeSnippet, 'src/test.tsx');
      const specifiers = scanned.map(s => s.specifier);

      assert.ok(specifiers.includes('react'), 'Should detect genuine react import');
      assert.ok(specifiers.includes('react-dom'), 'Should detect genuine react-dom export');
      assert.equal(specifiers.includes('fs'), false, 'Must ignore commented import fs');
      assert.equal(specifiers.includes('child_process'), false, 'Must ignore commented import child_process');
      assert.equal(specifiers.includes('node:os'), false, 'Must ignore commented require');
      assert.equal(specifiers.includes('evil-module'), false, 'Must ignore import inside ordinary string literal');
    });

    test('produces precise diagnostics with file path and rejected dependency', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/components/BadComponent.tsx',
          content: `import fs from 'node:fs';\nexport const Bad = () => null;`,
          version: 1,
          history: []
        }
      ];

      const result = DependencyResolverService.resolveProjectDependencies(files);
      assert.equal(result.valid, false);
      assert.ok(result.diagnostics.length > 0);
      const diag = result.diagnostics.find(d => d.includes('BadComponent.tsx'));
      assert.ok(diag, 'Diagnostic must mention the culprit file path');
      assert.ok(diag.includes('node:fs'), 'Diagnostic must mention the rejected dependency');
    });

    test('produces sorted and deduplicated import maps without duplicate entries', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/A.tsx',
          content: `import React from 'react'; import { useState } from 'react';`,
          version: 1,
          history: []
        },
        {
          path: 'src/B.tsx',
          content: `import React from 'react'; import { useEffect } from 'react';`,
          version: 1,
          history: []
        }
      ];

      const res = DependencyResolverService.resolveProjectDependencies(files);
      assert.ok(res.importMap['react'], 'Must include react');
      const keys = Object.keys(res.importMap);
      const uniqueKeys = Array.from(new Set(keys));
      assert.equal(keys.length, uniqueKeys.length, 'No duplicate keys in import map');
    });
  });

  describe('2. Live Preview Security & Sandbox Isolation', () => {
    test('sanitizes project file paths against directory traversal and dangerous characters', () => {
      assert.equal(sanitizeProjectFilePath('../secret.key'), null);
      assert.equal(sanitizeProjectFilePath('/etc/passwd'), null);
      assert.equal(sanitizeProjectFilePath('src/../../root.txt'), null);
      assert.equal(sanitizeProjectFilePath('C:\\Windows\\System32'), null);
      assert.equal(sanitizeProjectFilePath('src/components/Canvas.tsx'), 'src/components/Canvas.tsx');
    });

    test('generates secure preview HTML with parent isolation, storage virtualization, and strict postMessage', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `export default function App() { return <div className="p-4">App Loaded</div>; }`,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateLivePreview('react', 'Test App', files);
      assert.ok(preview.html, 'Must generate preview HTML');
      assert.ok(preview.html.includes('Content-Security-Policy'), 'Must have Content Security Policy');
      assert.ok(preview.html.includes('Object.defineProperty(window, \'parent\''), 'Must isolate window.parent');
      assert.ok(preview.html.includes('Object.defineProperty(window, \'top\''), 'Must isolate window.top');
      assert.ok(preview.html.includes('Object.defineProperty(document, \'cookie\''), 'Must virtualize document.cookie');
      assert.ok(!preview.html.includes('http://'), 'Must not inject insecure unencrypted HTTP scripts');
      assert.ok(preview.html.includes('script-src'), 'Must enforce strict script-src CSP policy');
    });
  });

  describe('3. Truthful Preview Verification & Runtime Distinctions', () => {
    test('distinguishes between compilation success and actual browser runtime verification', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `export default function App() { return <div>Canvas</div>; }`,
          version: 1,
          history: []
        }
      ];

      // A fallback preview or static placeholder is never falsely reported as verified running code
      const runtimeReport = BrowserRuntimeVerifier.verifyPreviewRuntime(
        {
          mode: 'fallback_preview',
          html: '<div>Fallback Mock UI</div>',
          compilationStatus: 'compiled'
        },
        files
      );

      assert.equal(runtimeReport.verified, false, 'Fallback preview cannot be verified as running application code');
      assert.equal(runtimeReport.verdict, 'failed');
    });

    test('validates DOM mount point and entry script presence in browser runtime verification', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/App.tsx',
          content: `import React from 'react'; export default function App() { return <div className="min-h-screen p-4 flex"><button>Click</button></div>; }`,
          version: 1,
          history: []
        }
      ];

      const preview = PreviewGenerator.generateLivePreview('react', 'Test App', files);
      const runtimeReport = BrowserRuntimeVerifier.verifyPreviewRuntime(preview, files);

      assert.ok(runtimeReport.checks.length > 0, 'Runtime verification must run dimensional checks');
      assert.ok(runtimeReport.domMountVerified, 'DOM mount point must be verified');
      assert.ok(runtimeReport.dependencyIntegrityVerified, 'Browser import map dependencies verified');
      assert.ok(runtimeReport.responsiveLayoutVerified, 'Viewport and responsive layout verified');
    });
  });

  describe('4. Project Memory Integrity, Assumption Separation & Bounded Repair', () => {
    test('strictly preserves confirmed requirements against unconfirmed agent assumptions', () => {
      ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId);

      // Record a confirmed user requirement fact
      ProjectMemoryService.recordFact(testBuildId, testUserId, {
        category: 'requirement',
        statement: 'System must render SVG vector graphics with zoom controls',
        confidence: 'confirmed',
        source: 'user_prompt'
      });

      const updated = ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId)!;
      const confirmedFact = updated.facts.find(f => f.statement.includes('SVG vector graphics'));
      assert.ok(confirmedFact, 'Confirmed fact must be recorded');
      assert.equal(confirmedFact.confidence, 'confirmed');

      // Attempting to overwrite with an agent assumption cannot demote confirmed requirement
      ProjectMemoryService.recordFact(testBuildId, testUserId, {
        category: 'requirement',
        statement: 'System must render SVG vector graphics with zoom controls',
        confidence: 'assumption',
        source: 'architect_agent'
      });

      const afterAttempt = ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId)!;
      const factAfter = afterAttempt.facts.find(f => f.statement.includes('SVG vector graphics'));
      assert.equal(factAfter?.confidence, 'confirmed', 'Confirmed fact must remain confirmed, not downgraded to assumption');
    });

    test('heals corrupted or missing memory array structures defensively', () => {
      // Simulate corrupted memory record in database
      const rawMemory = {
        projectId: testBuildId,
        userId: testUserId,
        facts: null, // corrupted
        architectureDecisions: undefined, // corrupted
        knownDefects: null, // corrupted
        requirements: null, // corrupted
        revisions: null, // corrupted
        lastUpdated: Date.now()
      };
      db.saveProjectMemory(rawMemory as any);

      // Service heals data structure cleanly without throwing TypeError
      const healed = ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId)!;
      assert.ok(Array.isArray(healed.facts), 'facts must be healed to array');
      assert.ok(Array.isArray(healed.architectureDecisions), 'architectureDecisions must be healed to array');
      assert.ok(Array.isArray(healed.knownDefects), 'knownDefects must be healed to array');
      assert.ok(Array.isArray(healed.requirements), 'requirements must be healed to array');
    });

    test('tracks defects and bounds repair workflow with repair attempt limits and regression tests', () => {
      const defectId = ProjectMemoryService.recordDefect(testBuildId, testUserId, {
        description: 'Canvas export throws DOMException on tainted canvas',
        filePaths: ['src/components/CanvasExport.tsx'],
        severity: 'high'
      });

      assert.ok(defectId, 'Defect ID must be returned');

      // Attempt 1: record targeted repair and regression test
      const res1 = ProjectMemoryService.recordRepairAttempt(
        testBuildId,
        testUserId,
        defectId,
        'Applied crossOrigin="anonymous" to canvas image source',
        true,
        'tests/canvas_export.test.ts'
      );
      assert.equal(res1.attempts, 1);
      assert.equal(res1.allowed, true);

      // Check defect state
      const mem1 = ProjectMemoryService.getOrInitializeMemory(testBuildId, testUserId)!;
      const def1 = mem1.knownDefects.find(d => d.id === defectId);
      assert.ok(def1?.regressionTests?.includes('tests/canvas_export.test.ts'));
      assert.ok(def1?.failedRepairs?.includes('Applied crossOrigin="anonymous" to canvas image source'));

      // Attempt 2
      const res2 = ProjectMemoryService.recordRepairAttempt(
        testBuildId,
        testUserId,
        defectId,
        'Second attempt',
        false
      );
      assert.equal(res2.attempts, 2);
      assert.equal(res2.allowed, true);

      // Attempt 3: reaches limit
      const res3 = ProjectMemoryService.recordRepairAttempt(
        testBuildId,
        testUserId,
        defectId,
        'Third attempt',
        false
      );
      assert.equal(res3.attempts, 3);
      assert.equal(res3.allowed, false, 'Further attempts must be disallowed after reaching limit');

      // Mark resolved
      const resolved = ProjectMemoryService.resolveDefect(testBuildId, testUserId, defectId);
      assert.equal(resolved, true);
    });

    test('enforces cross-user authorization guards on memory access', () => {
      // Intruder attempting to read or write Engineer One build memory is rejected
      assert.throws(() => {
        ProjectMemoryService.getRequirements(testBuildId, otherUserId);
      }, /Forbidden/i);

      assert.throws(() => {
        ProjectMemoryService.recordFact(testBuildId, otherUserId, {
          category: 'requirement',
          statement: 'Hacked',
          confidence: 'assumption',
          source: 'architect_agent'
        });
      }, /Forbidden/i);
    });
  });

  describe('5. Requirement-Based Verification & Honest Reporting', () => {
    test('reports verified requirements with relevantFiles, verificationMethod, and limitations', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/components/CanvasView.tsx',
          content: 'export const CanvasView = () => <canvas id="main-diagram" />;',
          version: 1,
          history: []
        }
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
            details: [{ name: 'CanvasView vector rendering canvas component test', passed: true }]
          }
        },
        { mode: 'real_application' }
      );

      const canvasReq = verified.find(r => r.id === 'req_canvas')!;
      assert.ok(canvasReq);
      assert.ok(canvasReq.satisfied);
      assert.ok(canvasReq.relevantFiles?.includes('src/components/CanvasView.tsx'));
      assert.equal(canvasReq.verificationMethod, 'automated_test_suite');
      assert.ok(canvasReq.evidence?.includes('All 1 relevant test(s) passed cleanly'));
      assert.ok(Array.isArray(canvasReq.remainingLimitations));

      // Export requirement has no matching implementation files
      const exportReq = verified.find(r => r.id === 'req_export')!;
      assert.ok(exportReq);
      assert.equal(exportReq.satisfied, false);
      assert.equal(exportReq.status, 'failed');
      assert.ok((exportReq.remainingLimitations?.length ?? 0) > 0);
      assert.ok(exportReq.remainingLimitations?.[0]?.includes('No implementation files found'));
    });
  });
});
