import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HonestVerificationService } from '../server/verificationService.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { db } from '../server/store.js';

describe('SquadForge Honest Verification & Readiness Service', () => {
  const buildId = 'test_honest_ver_build';

  beforeEach(() => {
    db.saveBuild({
      id: buildId,
      userId: 'test_ver_user',
      idea: 'Honest Verification Benchmark App',
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
  });

  test('Project without files fails verification with clear evidence', () => {
    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    assert.equal(report.verdict, 'failed');
    assert.ok(report.knownDefects.some(d => d.includes('No source files')));
  });

  test('Project with valid files, completed tasks, and README gets verified verdict', async () => {
    // Add README.md
    await MergeManager.createFile(buildId, 'agent_pm', {
      action: 'create_file',
      path: 'README.md',
      content: '# Honest Verification Benchmark App\n\nInstructions here.'
    });

    // Add source file
    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/index.ts',
      content: 'export const run = () => true;'
    });

    // Add package.json
    await MergeManager.createFile(buildId, 'agent_devops', {
      action: 'create_file',
      path: 'package.json',
      content: JSON.stringify({ name: 'benchmark-app', version: '1.0.0' })
    });

    // Add completed task
    const task = TaskManager.createNewTask(buildId, {
      title: 'Implement Core Feature',
      description: 'Core logic in index.ts',
      filePaths: ['src/index.ts'],
      priority: 2
    });
    TaskManager.completeTask(buildId, task.id, 'agent_dev');

    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    assert.ok(report.verdict === 'verified' || report.verdict === 'partially_verified');
    assert.equal(report.syntaxChecksPassed, true);
    assert.equal(report.securityAuditPassed, true);
    assert.equal(report.requirementsCoveragePercent, 100);
    assert.ok(report.checks.length >= 6);
  });

  test('Failing syntax prevents verified verdict and reports exact defect', async () => {
    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/broken_syntax.ts',
      content: 'function unclosed() { if (true) { let x = 1; '
    });

    const report = HonestVerificationService.evaluateProjectReadiness(buildId);
    assert.equal(report.verdict, 'failed');
    assert.equal(report.syntaxChecksPassed, false);
    assert.ok(report.knownDefects.some(d => d.includes('Syntax error')));
  });
});
