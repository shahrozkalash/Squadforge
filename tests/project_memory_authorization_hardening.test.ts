import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { Build, User } from '../server/types.js';

describe('SquadForge Project Memory Authorization & Multi-Tenant Isolation Hardening', () => {
  const userAlphaId = 'usr_alpha_test';
  const userBetaId = 'usr_beta_test';
  const buildAlpha1 = 'bld_alpha_proj_1';
  const buildAlpha2 = 'bld_alpha_proj_2';
  const buildBeta1 = 'bld_beta_proj_1';

  beforeEach(() => {
    // Register two distinct users
    const userAlpha: User = {
      id: userAlphaId,
      email: 'alpha@enterprise.test',
      name: 'Developer Alpha',
      costLimitPerBuild: 10.0,
      enabledModelIds: ['gemini-2.5-pro'],
      githubConnected: false,
      createdAt: Date.now()
    };

    const userBeta: User = {
      id: userBetaId,
      email: 'beta@enterprise.test',
      name: 'Developer Beta',
      costLimitPerBuild: 5.0,
      enabledModelIds: ['gemini-2.5-flash'],
      githubConnected: false,
      createdAt: Date.now()
    };

    db.saveUser(userAlpha);
    db.saveUser(userBeta);

    // Register projects owned by User Alpha
    const projAlpha1: Build = {
      id: buildAlpha1,
      userId: userAlphaId,
      idea: 'Alpha Proprietary Algorithmic Trading Platform',
      projectType: 'saas_dashboard',
      status: 'running',
      autoPushGithub: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-pro'],
      totalTokens: 1200,
      totalCost: 0.05,
      costLimit: 10.0,
      maxDurationSeconds: 600,
      patchesAppliedCount: 3,
      requirementsChecklist: [
        {
          id: 'req_alpha_secret_formula',
          category: 'backend',
          description: 'Proprietary options hedging math algorithm',
          satisfied: true,
          status: 'implemented',
          priority: 'must_have'
        },
        {
          id: 'req_alpha_audit',
          category: 'security',
          description: 'SOC2 immutable trade execution logging',
          satisfied: false,
          status: 'pending',
          priority: 'must_have'
        }
      ]
    };

    const projAlpha2: Build = {
      id: buildAlpha2,
      userId: userAlphaId,
      idea: 'Alpha Mobile Companion App',
      projectType: 'fullstack',
      status: 'running',
      autoPushGithub: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-flash'],
      totalTokens: 500,
      totalCost: 0.01,
      costLimit: 5.0,
      maxDurationSeconds: 300,
      patchesAppliedCount: 1,
      requirementsChecklist: [
        {
          id: 'req_alpha_push_alerts',
          category: 'ui',
          description: 'Realtime trade notification badges',
          satisfied: false,
          status: 'pending',
          priority: 'should_have'
        }
      ]
    };

    // Register project owned by User Beta
    const projBeta1: Build = {
      id: buildBeta1,
      userId: userBetaId,
      idea: 'Beta Social Recipe Sharing Community',
      projectType: 'fullstack',
      status: 'running',
      autoPushGithub: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModels: ['gemini-2.5-flash'],
      totalTokens: 800,
      totalCost: 0.02,
      costLimit: 5.0,
      maxDurationSeconds: 300,
      patchesAppliedCount: 2,
      requirementsChecklist: [
        {
          id: 'req_beta_recipes',
          category: 'database',
          description: 'Recipe ingredient parsing and storage',
          satisfied: true,
          status: 'implemented',
          priority: 'must_have'
        }
      ]
    };

    db.saveBuild(projAlpha1);
    db.saveBuild(projAlpha2);
    db.saveBuild(projBeta1);
  });

  describe('1. Mandatory Ownership Authorization on Memory Reads', () => {
    test('User Alpha successfully retrieves requirements from own projects', () => {
      const alpha1Reqs = ProjectMemoryService.getRequirements(buildAlpha1, userAlphaId);
      assert.ok(Array.isArray(alpha1Reqs));
      assert.equal(alpha1Reqs.length, 2);
      assert.equal(alpha1Reqs[0].id, 'req_alpha_secret_formula');

      const alpha2Reqs = ProjectMemoryService.getRequirements(buildAlpha2, userAlphaId);
      assert.ok(Array.isArray(alpha2Reqs));
      assert.equal(alpha2Reqs.length, 1);
      assert.equal(alpha2Reqs[0].id, 'req_alpha_push_alerts');
    });

    test('User Beta is strictly forbidden from accessing User Alpha project requirements', () => {
      assert.throws(() => {
        ProjectMemoryService.getRequirements(buildAlpha1, userBetaId);
      }, /Forbidden: Access denied to project memory/);

      assert.throws(() => {
        ProjectMemoryService.getRequirements(buildAlpha2, userBetaId);
      }, /Forbidden: Access denied to project memory/);
    });

    test('Calling getRequirements without userId is strictly rejected', () => {
      assert.throws(() => {
        (ProjectMemoryService as any).getRequirements(buildAlpha1, '');
      }, /Forbidden: Unauthorized/);

      assert.throws(() => {
        (ProjectMemoryService as any).getRequirements(buildAlpha1, undefined);
      }, /Forbidden: Unauthorized/);
    });

    test('Accessing missing or deleted project throws project not found', () => {
      assert.throws(() => {
        ProjectMemoryService.getRequirements('bld_non_existent_999', userAlphaId);
      }, /Project not found/);
    });

    test('User Beta accesses User Beta own project requirements cleanly', () => {
      const betaReqs = ProjectMemoryService.getRequirements(buildBeta1, userBetaId);
      assert.ok(Array.isArray(betaReqs));
      assert.equal(betaReqs.length, 1);
      assert.equal(betaReqs[0].id, 'req_beta_recipes');
    });
  });

  describe('2. Mandatory Ownership Authorization on Memory Initialization & State Reads', () => {
    test('getOrInitializeMemory enforces project ownership check', () => {
      // Owner succeeds
      const alphaMem = ProjectMemoryService.getOrInitializeMemory(buildAlpha1, userAlphaId);
      assert.ok(alphaMem);
      assert.equal(alphaMem?.projectId, buildAlpha1);
      assert.equal(alphaMem?.userId, userAlphaId);

      // Non-owner fails
      assert.throws(() => {
        ProjectMemoryService.getOrInitializeMemory(buildAlpha1, userBetaId);
      }, /Forbidden: Access denied/);
    });

    test('Re-accessing stored memory validates user ownership against persistent record', () => {
      // Initialize memory for Alpha
      ProjectMemoryService.getOrInitializeMemory(buildAlpha1, userAlphaId);

      // Verify that Beta cannot read Alpha stored memory even if passing Alpha buildId
      assert.throws(() => {
        ProjectMemoryService.getOrInitializeMemory(buildAlpha1, userBetaId);
      }, /Forbidden/);
    });
  });

  describe('3. Memory Write Authorization & Build Synchronization', () => {
    test('User Alpha updates requirement and changes synchronize to build record', () => {
      const updated = ProjectMemoryService.updateRequirement(
        buildAlpha1,
        userAlphaId,
        'req_alpha_audit',
        {
          satisfied: true,
          status: 'satisfied',
          notes: 'SOC2 logs verified',
          evidence: 'Audit table initialized'
        }
      );
      assert.equal(updated, true);

      // Verify memory record has updated requirement
      const memory = ProjectMemoryService.getOrInitializeMemory(buildAlpha1, userAlphaId);
      const reqInMem = memory?.requirements.find(r => r.id === 'req_alpha_audit');
      assert.equal(reqInMem?.satisfied, true);
      assert.equal(reqInMem?.status, 'satisfied');
      assert.equal(reqInMem?.evidence, 'Audit table initialized');

      // Verify build entity in database was synchronized
      const build = db.getBuild(buildAlpha1);
      const reqInBuild = build?.requirementsChecklist?.find(r => r.id === 'req_alpha_audit');
      assert.equal(reqInBuild?.satisfied, true);
      assert.equal(reqInBuild?.status, 'satisfied');
    });

    test('User Beta is prohibited from updating User Alpha requirements', () => {
      assert.throws(() => {
        ProjectMemoryService.updateRequirement(
          buildAlpha1,
          userBetaId,
          'req_alpha_audit',
          { satisfied: true }
        );
      }, /Forbidden/);
    });

    test('Cross-tenant fact and decision recordings are blocked', () => {
      // Beta cannot record facts into Alpha project
      assert.throws(() => {
        ProjectMemoryService.recordFact(buildAlpha1, userBetaId, {
          category: 'requirement',
          statement: 'Malicious injected requirement',
          confidence: 'confirmed',
          source: 'user_prompt'
        });
      }, /Forbidden/);

      // Beta cannot record decisions into Alpha project
      assert.throws(() => {
        ProjectMemoryService.recordDecision(buildAlpha1, userBetaId, {
          id: 'adr_injected',
          title: 'Malicious ADR',
          status: 'proposed',
          context: 'Cross-tenant attack',
          decision: 'Infiltrate database',
          timestamp: Date.now()
        });
      }, /Forbidden/);
    });

    test('Revision recording updates provenance and supersedes previous assumptions', () => {
      // Record initial assumption
      ProjectMemoryService.recordFact(buildAlpha1, userAlphaId, {
        category: 'architecture',
        statement: 'System will use simple in-memory session cache',
        confidence: 'assumption',
        source: 'architect_agent'
      });

      // User Alpha submits natural language revision changing cache architecture
      const revision = {
        id: 'rev_1',
        prompt: 'Switch session cache to distributed Redis store with replication',
        createdAt: Date.now(),
        status: 'completed' as const,
        revisionNumber: 1
      };

      const recorded = ProjectMemoryService.recordRevision(buildAlpha1, userAlphaId, revision);
      assert.equal(recorded, true);

      const mem = ProjectMemoryService.getOrInitializeMemory(buildAlpha1, userAlphaId);
      const supersededFact = mem?.facts.find(f => f.statement.includes('simple in-memory session cache'));
      assert.ok(supersededFact?.statement.startsWith('[SUPERSEDED by Rev #1]'));

      const revFact = mem?.facts.find(f => f.source === 'user_revision');
      assert.ok(revFact);
      assert.equal(revFact?.confidence, 'confirmed');
    });
  });
});
