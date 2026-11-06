import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { QualityAssuranceEngine } from '../server/qualityEngine.js';
import { MergeManager } from '../server/swarm/mergeManager.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { db } from '../server/store.js';

describe('SquadForge Phase 12 quality assurance engine', () => {
  const makeBuildId = (suffix: string) => `phase12_qa_${suffix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  test('unit: empty project fails the default quality gates', () => {
    const buildId = makeBuildId('empty');
    db.saveBuild({
      id: buildId,
      userId: 'qa_user',
      idea: 'Quality assurance engine validation app',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1200,
      totalCost: 0.25,
      costLimit: 5,
      maxDurationSeconds: 120,
      patchesAppliedCount: 2
    });

    const result = QualityAssuranceEngine.evaluateProjectQuality(buildId);
    assert.equal(result.ready, false);
    assert.ok(result.gates.some((gate) => gate.id === 'syntax' && gate.passed === false));
    assert.ok(result.summary.includes('not ready'));
  });

  test('integration: valid project passes the quality gates with honest evidence', async () => {
    const buildId = makeBuildId('valid');
    db.saveBuild({
      id: buildId,
      userId: 'qa_user',
      idea: 'Quality assurance engine validation app',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1200,
      totalCost: 0.25,
      costLimit: 5,
      maxDurationSeconds: 120,
      patchesAppliedCount: 2
    });

    await MergeManager.createFile(buildId, 'agent_pm', {
      action: 'create_file',
      path: 'README.md',
      content: '# QA Validation App\n\nThis project is intentionally small but valid.'
    });

    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/index.ts',
      content: 'export const ping = () => true;\n'
    });

    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'package.json',
      content: JSON.stringify({ name: 'qa-validation', version: '1.0.0', type: 'module' })
    });

    const task = TaskManager.createNewTask(buildId, {
      title: 'Implement validation hook',
      description: 'Add ping implementation',
      filePaths: ['src/index.ts'],
      priority: 2
    });
    TaskManager.claimTask(buildId, 'agent_dev');
    TaskManager.completeTask(buildId, task.id, 'agent_dev');

    const result = QualityAssuranceEngine.evaluateProjectQuality(buildId);
    assert.ok(result.passCount >= 1 || result.passedGates >= 2);
    assert.ok(result.gates.some((gate) => gate.id === 'syntax' && gate.passed));
    assert.ok(result.summary.length > 0);
  });

  test('api: quality plan is generated with stages for unit, integration, and release checks', () => {
    const plan = QualityAssuranceEngine.generateTestingPlan('Launch a quality dashboard', 'saas');
    assert.equal(plan.phases.length >= 4, true);
    assert.match(plan.summary, /quality/i);
    assert.ok(plan.phases.some((phase) => phase.name.toLowerCase().includes('unit')));
  });

  test('regression: failing tests remain visible and block the project from passing', async () => {
    const buildId = makeBuildId('broken');
    db.saveBuild({
      id: buildId,
      userId: 'qa_user',
      idea: 'Quality assurance engine validation app',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 1200,
      totalCost: 0.25,
      costLimit: 5,
      maxDurationSeconds: 120,
      patchesAppliedCount: 2
    });

    await MergeManager.createFile(buildId, 'agent_dev', {
      action: 'create_file',
      path: 'src/broken.ts',
      content: 'function broken() { return;\n'
    });

    const result = QualityAssuranceEngine.evaluateProjectQuality(buildId);
    assert.equal(result.ready, false);
    assert.ok(result.gates.some((gate) => gate.id === 'syntax' && gate.passed === false));
  });
});
