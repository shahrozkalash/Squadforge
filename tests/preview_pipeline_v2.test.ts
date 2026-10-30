import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewGenerator } from '../server/swarm/previewGenerator.js';
import { HonestVerificationService } from '../server/verificationService.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { IntegrationAgent } from '../server/swarm/integrationAgent.js';
import { db } from '../server/store.js';
import { ProjectFile } from '../server/types.js';

describe('SquadForge V2: Preview Pipeline, Honesty & Bounded Self-Repair', () => {

  test('PreviewGenerator compiles real React application into real_application mode', () => {
    const files: ProjectFile[] = [
      {
        path: 'src/App.tsx',
        content: `import React, { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div className="p-8 text-center">
      <h1 className="text-2xl font-bold">Counter Test</h1>
      <button id="counter-btn" onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </div>
  );
}`,
        version: 1,
        ownerModel: 'frontend_developer',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const result = PreviewGenerator.generateInteractivePreview('Interactive Counter App', files, 'fullstack');
    assert.equal(result.mode, 'real_application');
    assert.ok(result.html.includes('react@19'));
    assert.ok(result.html.includes('Counter Test'));
    assert.ok(result.html.includes('runtimeErrorOverlay'));
    assert.ok(!result.html.includes('Fallback Demonstration'));
  });

  test('PreviewGenerator renders static_html mode when only index.html is provided', () => {
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content: `<!DOCTYPE html><html><head><title>Static Page</title></head><body><h1>Welcome Static</h1></body></html>`,
        version: 1,
        ownerModel: 'frontend_developer',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const result = PreviewGenerator.generateInteractivePreview('Static Page Test', files, 'landing_page');
    assert.equal(result.mode, 'static_html');
    assert.ok(result.html.includes('Welcome Static'));
  });

  test('PreviewGenerator generates fallback_preview with prominent warning when no runnable entry point exists', () => {
    const files: ProjectFile[] = [
      {
        path: 'docs/architecture.md',
        content: `# Architecture Notes\nNo code here.`,
        version: 1,
        ownerModel: 'software_architect',
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ];

    const result = PreviewGenerator.generateInteractivePreview('Architecture Docs Only', files, 'fullstack');
    assert.equal(result.mode, 'fallback_preview');
    assert.ok(result.html.includes('Fallback Demonstration'));
    assert.ok(result.html.includes('Unverified Execution'));
  });

  test('HonestVerificationService rejects verified status when preview is in fallback_preview mode', () => {
    const buildId = `bld_test_preview_honesty_${Date.now()}`;
    const userId = `usr_honesty_${Date.now()}`;

    db.saveBuild({
      id: buildId,
      userId,
      idea: 'Honest Verification Test',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1000,
      totalCost: 0.05,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 5
    });

    // Save only a markdown file so preview falls back to fallback_preview
    db.setFile(buildId, {
      path: 'README.md',
      content: '# Only Readme',
      version: 1,
      ownerModel: 'project_manager',
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    assert.notEqual(report.verdict, 'verified', 'Must never be verified when preview is fallback demonstration');
    assert.equal(report.previewMode, 'fallback_preview');
    assert.equal(report.previewPassed, false);
    assert.ok(report.unresolvedRisks.some(r => r.includes('fallback')));
  });

  test('ProjectMemoryService bounds defect repairs to max 3 attempts', () => {
    const buildId = `bld_defect_test_${Date.now()}`;
    const userId = `usr_defect_test_${Date.now()}`;

    db.saveBuild({
      id: buildId,
      userId,
      idea: 'Defect Repair Test',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1000,
      totalCost: 0.05,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 5
    });

    const defectId = ProjectMemoryService.recordDefect(buildId, userId, {
      description: 'Module import error in src/core/engine.ts',
      filePaths: ['src/core/engine.ts'],
      severity: 'high'
    });
    assert.ok(defectId);

    // Attempt 1
    const att1 = ProjectMemoryService.recordRepairAttempt(buildId, userId, defectId, 'First attempt', true);
    assert.equal(att1.attempts, 1);
    assert.equal(att1.allowed, true);

    // Attempt 2
    const att2 = ProjectMemoryService.recordRepairAttempt(buildId, userId, defectId, 'Second attempt', true);
    assert.equal(att2.attempts, 2);
    assert.equal(att2.allowed, true);

    // Attempt 3
    const att3 = ProjectMemoryService.recordRepairAttempt(buildId, userId, defectId, 'Third attempt', true);
    assert.equal(att3.attempts, 3);
    assert.equal(att3.allowed, false, 'After 3 attempts, further repair attempts must be blocked');

    // Attempt 4
    const att4 = ProjectMemoryService.recordRepairAttempt(buildId, userId, defectId, 'Fourth attempt', true);
    assert.equal(att4.allowed, false);
  });

  test('IntegrationAgent halts spawning fix tasks once repair limit is reached', () => {
    const buildId = `bld_integration_limit_${Date.now()}`;
    const userId = `usr_integration_limit_${Date.now()}`;

    db.saveBuild({
      id: buildId,
      userId,
      idea: 'Integration Limit Test',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1000,
      totalCost: 0.05,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 5
    });

    const issue = {
      type: 'missing_imported_file' as const,
      sourceFile: 'src/App.tsx',
      targetFile: 'src/components/Broken.tsx',
      message: 'File src/App.tsx imports from ./components/Broken, but target does not exist.',
      severity: 'error' as const
    };

    // First spawn: should create 1 fix task and record attempt 1
    IntegrationAgent.spawnIntegrationFixTasks(buildId, [issue]);
    let tasks = db.getTasks(buildId);
    assert.equal(tasks.filter(t => t.isFixTask).length, 1);

    // Simulate task failed and reset status to allow recheck
    db.updateTask(buildId, tasks[0].id, { status: 'failed' });

    // Second spawn: attempt 2
    IntegrationAgent.spawnIntegrationFixTasks(buildId, [issue]);
    tasks = db.getTasks(buildId);
    assert.equal(tasks.filter(t => t.isFixTask).length, 2);

    db.updateTask(buildId, tasks[1].id, { status: 'failed' });

    // Third spawn: attempt 3
    IntegrationAgent.spawnIntegrationFixTasks(buildId, [issue]);
    tasks = db.getTasks(buildId);
    assert.equal(tasks.filter(t => t.isFixTask).length, 3);

    db.updateTask(buildId, tasks[2].id, { status: 'failed' });

    // Fourth spawn: should be blocked by bounded self-repair (max 3 attempts)
    IntegrationAgent.spawnIntegrationFixTasks(buildId, [issue]);
    tasks = db.getTasks(buildId);
    assert.equal(tasks.filter(t => t.isFixTask).length, 3, 'Must not spawn a 4th fix task past the bounded limit');
  });

});
