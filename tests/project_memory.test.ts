import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseManager } from '../server/db/database.js';
import { db } from '../server/store.js';
import { ProjectMemoryService, ProjectFact, ArchitectureDecision } from '../server/swarm/projectMemory.js';
import { Build, Task, ProjectFile } from '../server/types.js';

describe('SquadForge Project Intelligence & Persistent Memory Architecture', () => {
  const userA = 'usr_memory_tester_a';
  const userB = 'usr_memory_tester_b';
  const buildId = 'bld_memory_test_123';

  beforeEach(() => {
    // Register users
    db.createUser({
      id: userA,
      email: 'usera@memory.local',
      name: 'User A',
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    });

    db.createUser({
      id: userB,
      email: 'userb@memory.local',
      name: 'User B',
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini'],
      createdAt: Date.now()
    });

    // Create initial build for User A
    db.saveBuild({
      id: buildId,
      userId: userA,
      idea: 'High-Throughput Financial Telemetry Dashboard',
      projectType: 'saas_dashboard',
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini', 'claude'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5.0,
      maxDurationSeconds: 300,
      patchesAppliedCount: 0,
      techStack: {
        frontend: 'React 19 + TypeScript + Tailwind CSS',
        backend: 'Node.js Express + TypeScript Server API',
        database: 'SQLite Persistent Database',
        testing: 'Node.js Native Test Runner (node:test + assert)',
        security: 'OWASP Defensive Validation'
      },
      architectureDecisions: [
        {
          id: 'ADR-001',
          title: 'ADR-001: Component Architecture',
          status: 'accepted',
          context: 'Need modular UI components',
          decision: 'Build single-responsibility files under 150 lines',
          timestamp: Date.now()
        }
      ],
      requirementsChecklist: [
        {
          id: 'req_kpi_1',
          title: 'Financial KPI Summary Cards',
          category: 'frontend',
          description: 'Render responsive summary cards showing cash flow and revenue',
          priority: 'must_have',
          satisfied: false,
          status: 'pending'
        }
      ]
    });
  });

  afterEach(() => {
    db.deleteProjectMemory(buildId);
  });

  test('1. Memory initializes automatically from build metadata (backward-compatible migration)', () => {
    const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userA);
    assert.ok(memory);
    assert.equal(memory.projectId, buildId);
    assert.equal(memory.userId, userA);
    assert.equal(memory.projectType, 'saas_dashboard');
    assert.equal(memory.architectureDecisions.length, 1);
    assert.equal(memory.requirements.length, 1);
    assert.ok(memory.facts.length >= 2, 'Should establish initial facts from user prompt');
    assert.ok(memory.conventions.length > 0, 'Should include default coding conventions');
  });

  test('2. Multi-tenant isolation: User B is strictly forbidden from accessing User A project memory', () => {
    // Verify accessing someone else's memory throws a forbidden security error
    assert.throws(() => {
      ProjectMemoryService.getOrInitializeMemory(buildId, userB);
    }, /Forbidden: Access denied to project memory/);
  });

  test('3. Fact recording prevents duplicates and upgrades assumptions to confirmed', () => {
    ProjectMemoryService.getOrInitializeMemory(buildId, userA);

    // Record an initial assumption
    const success1 = ProjectMemoryService.recordFact(buildId, userA, {
      category: 'constraint',
      statement: 'Latency must remain under 100ms for ticker feeds',
      confidence: 'assumption',
      source: 'architect_agent'
    });
    assert.equal(success1, true);

    let memory = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    const fact = memory.facts.find(f => f.statement.includes('under 100ms'));
    assert.ok(fact);
    assert.equal(fact.confidence, 'assumption');

    // Upgrade the same fact to confirmed
    const success2 = ProjectMemoryService.recordFact(buildId, userA, {
      category: 'constraint',
      statement: 'Latency must remain under 100ms for ticker feeds',
      confidence: 'confirmed',
      source: 'user_prompt'
    });
    assert.equal(success2, true);

    memory = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    const matchingFacts = memory.facts.filter(f => f.statement.includes('under 100ms'));
    assert.equal(matchingFacts.length, 1, 'Duplicate statements must not create new records');
    assert.equal(matchingFacts[0].confidence, 'confirmed', 'Confidence must upgrade to confirmed');
  });

  test('4. Architecture decisions record, update, and synchronize with build record', () => {
    const newDecision: ArchitectureDecision = {
      id: 'ADR-002',
      title: 'ADR-002: In-Memory Ring Buffer for Market Depth',
      status: 'accepted',
      context: 'High-frequency quote updates require zero allocation overhead',
      decision: 'Implement fixed-size ring buffer for order book ticks',
      rationale: 'Avoids garbage collection pauses during peak market hours',
      consequences: 'Bounded memory usage with deterministic O(1) insertion',
      timestamp: Date.now()
    };

    const recorded = ProjectMemoryService.recordDecision(buildId, userA, newDecision);
    assert.equal(recorded, true);

    const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    assert.equal(memory.architectureDecisions.length, 2);
    assert.equal(memory.architectureDecisions[1].id, 'ADR-002');

    // Verify build entity in store also synchronized
    const build = db.getBuild(buildId)!;
    assert.equal(build.architectureDecisions?.length, 2);
    assert.equal(build.architectureDecisions?.[1].id, 'ADR-002');
  });

  test('5. Requirements satisfaction updates and defect lifecycle management', () => {
    // 1. Update requirement status
    const reqUpdated = ProjectMemoryService.updateRequirement(
      buildId,
      userA,
      'req_kpi_1',
      true,
      ['src/components/KPICard.tsx'],
      'Verified with automated rendering test'
    );
    assert.equal(reqUpdated, true);

    const memoryAfterReq = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    const req = memoryAfterReq.requirements.find(r => r.id === 'req_kpi_1');
    assert.ok(req);
    assert.equal(req.satisfied, true);
    assert.equal(req.status, 'satisfied');
    assert.deepEqual(req.satisfiedByFiles, ['src/components/KPICard.tsx']);

    // 2. Record defect
    const defectId = ProjectMemoryService.recordDefect(buildId, userA, {
      description: 'TypeError: undefined is not a function in WebSocket ticker reconnect',
      filePaths: ['src/services/marketFeed.ts'],
      severity: 'high'
    });
    assert.ok(defectId);

    const memoryWithDefect = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    const defect = memoryWithDefect.knownDefects.find(d => d.id === defectId);
    assert.ok(defect);
    assert.equal(defect.resolved, false);

    // 3. Resolve defect
    const resolved = ProjectMemoryService.resolveDefect(buildId, userA, defectId!);
    assert.equal(resolved, true);

    const memoryResolved = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    const resolvedDefect = memoryResolved.knownDefects.find(d => d.id === defectId);
    assert.ok(resolvedDefect);
    assert.equal(resolvedDefect.resolved, true);
    assert.ok(resolvedDefect.resolvedAt! > 0);
  });

  test('6. Module relationships are extracted accurately from source files', () => {
    const files: ProjectFile[] = [
      {
        path: 'src/components/Dashboard.tsx',
        content: `
          import React from 'react';
          import { KPICard } from './KPICard.js';
          import { MarketChart } from './MarketChart.js';
          export function Dashboard() { return <div>Dashboard</div>; }
        `,
        version: 1,
        ownerModel: 'gemini',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      },
      {
        path: 'src/components/KPICard.tsx',
        content: `
          export interface KPIProps { value: number; }
          export function KPICard(props: KPIProps) { return <div>{props.value}</div>; }
        `,
        version: 1,
        ownerModel: 'claude',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      }
    ];

    ProjectMemoryService.updateModuleRelationships(buildId, userA, files);

    const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    assert.equal(memory.moduleRelationships.length, 2);

    const dashboardRel = memory.moduleRelationships.find(r => r.sourcePath === 'src/components/Dashboard.tsx');
    assert.ok(dashboardRel);
    assert.ok(dashboardRel.imports.includes('./KPICard.js'));
    assert.ok(dashboardRel.exports.includes('Dashboard'));
  });

  test('7. retrieveTaskContext returns compact, task-relevant context without token blowup', () => {
    const task: Task = {
      id: 'tsk_kpi_build',
      buildId,
      title: 'Implement Financial KPI Card Component',
      description: 'Create responsive metric card display',
      filePaths: ['src/components/KPICard.tsx'],
      priority: 2,
      status: 'pending',
      claimedBy: null,
      leaseExpiresAt: null,
      createdAt: Date.now()
    };

    const context = ProjectMemoryService.retrieveTaskContext(buildId, userA, task, 1200);
    assert.ok(context.length > 0);
    assert.ok(context.length <= 1200);
    assert.ok(context.includes('SAAS_DASHBOARD'));
    assert.ok(context.includes('ADR-001'));
    assert.ok(context.includes('CODING CONVENTIONS'));
  });

  test('8. Persistence across reload: Project memory persists in database store', () => {
    ProjectMemoryService.getOrInitializeMemory(buildId, userA);
    ProjectMemoryService.recordFact(buildId, userA, {
      category: 'environment',
      statement: 'Persistence test verification token 987654',
      confidence: 'confirmed',
      source: 'user_prompt'
    });

    // Read directly from DB
    const loaded = db.getProjectMemory(buildId);
    assert.ok(loaded);
    assert.equal(loaded.projectId, buildId);
    assert.equal(loaded.userId, userA);
    assert.ok(loaded.facts.some(f => f.statement.includes('987654')));
  });

  test('9. Revision recording updates memory revisions and supersedes previous assumptions', () => {
    // Record an assumption first
    ProjectMemoryService.recordFact(buildId, userA, {
      category: 'constraint',
      statement: 'Default chart colors should be monochrome slate',
      confidence: 'assumption',
      source: 'architect_agent'
    });

    // User applies a revision to use neon amber palette
    const revision = {
      id: 'rev_test_color_palette',
      revisionNumber: 1,
      prompt: 'Change default chart colors to vibrant neon amber palette',
      createdAt: Date.now(),
      status: 'in_progress' as const,
      summary: 'Change chart colors',
      tasksGenerated: ['tsk_rev_1']
    };

    const recorded = ProjectMemoryService.recordRevision(buildId, userA, revision);
    assert.equal(recorded, true);

    const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userA)!;
    assert.ok(memory.revisions.some(r => r.id === 'rev_test_color_palette'));

    // Check revision confirmed fact exists
    const revFact = memory.facts.find(f => f.source === 'user_revision');
    assert.ok(revFact);
    assert.equal(revFact.confidence, 'confirmed');

    // Check old assumption statement is superseded
    const oldFact = memory.facts.find(f => f.statement.includes('monochrome slate'));
    assert.ok(oldFact);
    assert.ok(oldFact.statement.startsWith('[SUPERSEDED by Rev #1]'));
  });

  test('10. Corrupted or unparseable project memory record is handled gracefully without crashing', () => {
    const corruptBuildId = 'bld_corrupt_memory_test';
    db.saveBuild({
      id: corruptBuildId,
      userId: userA,
      idea: 'Corrupt Memory Recovery Test',
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini'],
      autoPushGithub: false,
      totalTokens: 0,
      totalCost: 0,
      costLimit: 5,
      maxDurationSeconds: 100,
      patchesAppliedCount: 0
    });

    // Directly insert corrupt JSON in project_memories table
    db.dbManager.db.prepare(`
      INSERT OR REPLACE INTO project_memories (project_id, user_id, memory_data, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(corruptBuildId, userA, '{invalid:json:data', Date.now());

    // Service must safely handle and re-initialize rather than throw syntax error
    const recovered = ProjectMemoryService.getOrInitializeMemory(corruptBuildId, userA);
    assert.ok(recovered);
    assert.equal(recovered.projectId, corruptBuildId);
    assert.equal(recovered.userId, userA);
    assert.ok(recovered.facts.length > 0);
  });
});
