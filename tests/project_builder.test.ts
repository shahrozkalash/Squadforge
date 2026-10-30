import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { IntegrationAgent } from '../server/swarm/integrationAgent.js';
import { PreviewGenerator } from '../server/swarm/previewGenerator.js';
import { db } from '../server/store.js';
import { ProjectType, ProjectFile, Build, Task } from '../server/types.js';

describe('Project Builder Intelligence & Autonomous Architecture Tests', () => {

  describe('Project Type Detection & Stacks', () => {
    it('accurately classifies user prompt into appropriate ProjectType', () => {
      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Build an e-commerce clothing store with cart and checkout'),
        'ecommerce'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Create a high-converting landing page with hero and pricing tiers'),
        'landing_page'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Build a SaaS analytics metrics dashboard with user management tables'),
        'saas_dashboard'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Create a personal portfolio and creative showcase with contact form'),
        'portfolio'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Build a secure REST API microservice with token authentication and rate limiting'),
        'api_service'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Build an internal customer support console and workflow admin tool'),
        'internal_tool'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Create a tech blog publication with reading time calculator and articles'),
        'blog_content'
      );

      assert.strictEqual(
        SwarmOrchestrator.detectProjectType('Build a full-stack collaborative kanban board with database storage'),
        'fullstack'
      );
    });

    it('tailors optimal tech stack to detected project type', () => {
      const ecomStack = SwarmOrchestrator.selectOptimalTechStack('ecommerce');
      assert.match(ecomStack.frontend, /cart|storefront|tailwind|icons/i);

      const apiStack = SwarmOrchestrator.selectOptimalTechStack('api_service');
      assert.match(apiStack.backend, /express|rest|router|server/i);

      const dashStack = SwarmOrchestrator.selectOptimalTechStack('saas_dashboard');
      assert.match(dashStack.frontend, /tailwind/i);
    });
  });

  describe('Architecture Decision Records (ADRs) & Requirements Memory', () => {
    it('generates 3 structured ADRs with accepted status and complete context', () => {
      const adrs = SwarmOrchestrator.generateArchitectureDecisions(
        'Enterprise Analytics Workspace',
        'saas_dashboard'
      );

      assert.strictEqual(adrs.length, 3);
      assert.strictEqual(adrs[0].id, 'ADR-001');
      assert.strictEqual(adrs[1].id, 'ADR-002');
      assert.strictEqual(adrs[2].id, 'ADR-003');

      for (const adr of adrs) {
        assert.strictEqual(adr.status, 'accepted');
        assert.ok(adr.title.length > 5, 'ADR title must be descriptive');
        assert.ok(adr.context.length > 10, 'ADR context must explain background');
        assert.ok(adr.decision.length > 10, 'ADR decision must detail architectural choice');
        assert.ok(adr.consequences && adr.consequences.length > 10, 'ADR consequences must state trade-offs');
      }
    });

    it('generates domain-specific requirements checklist items with pending status', () => {
      const items = SwarmOrchestrator.generateRequirementsChecklist(
        'Artisan Coffee Store',
        'ecommerce'
      );

      assert.ok(items.length >= 4, 'Must generate at least 4 requirement items');
      const categories = items.map(i => i.category);
      assert.ok(categories.includes('frontend'), 'Must have frontend requirement');
      assert.ok(categories.includes('core') || categories.includes('backend'), 'Must have core/backend requirement');
      assert.ok(categories.includes('testing'), 'Must have testing requirement');
      assert.ok(categories.includes('security'), 'Must have security requirement');

      for (const item of items) {
        assert.strictEqual(item.status, 'pending');
        assert.ok(item.title && item.title.length > 3);
        assert.strictEqual(item.satisfied, false);
      }
    });
  });

  describe('Integration Agent Contract Validation', () => {
    it('validates clean module contracts with no errors', () => {
      const cleanFiles: ProjectFile[] = [
        {
          path: 'src/utils/math.ts',
          content: 'export function add(a: number, b: number): number { return a + b; }',
          version: 1,
          ownerModel: 'gemini-2.5-pro',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          history: []
        },
        {
          path: 'src/components/Calculator.tsx',
          content: 'import { add } from "../utils/math";\nexport function Calculator() { return add(1, 2); }',
          version: 1,
          ownerModel: 'gemini-2.5-flash',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(cleanFiles);
      assert.strictEqual(report.passed, true);
      assert.strictEqual(report.issues.filter(i => i.severity === 'error').length, 0);
    });

    it('detects missing imported files and flags integration failures', () => {
      const brokenFiles: ProjectFile[] = [
        {
          path: 'src/components/Dashboard.tsx',
          content: 'import { fetchMetrics } from "../services/metricsService";\nexport function Dashboard() { return null; }',
          version: 1,
          ownerModel: 'gemini-2.5-flash',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(brokenFiles);
      assert.strictEqual(report.passed, false);
      const errors = report.issues.filter(i => i.severity === 'error');
      assert.ok(errors.length > 0);
      assert.ok(errors.some(e => e.targetFile?.includes('metricsService')));
    });

    it('creates high-priority repair tasks when integration contracts fail', () => {
      const buildId = 'build-integration-test';
      const testBuild: Build = {
        id: buildId,
        userId: 'guest_user_test',
        idea: 'Integration Repair Test',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        selectedModels: ['gemini-2.5-pro'],
        autoPushGithub: false,
        totalTokens: 0,
        totalCost: 0,
        costLimit: 5.0,
        maxDurationSeconds: 600,
        patchesAppliedCount: 0
      };
      db.saveBuild(testBuild);

      const brokenFiles: ProjectFile[] = [
        {
          path: 'src/components/Dashboard.tsx',
          content: 'import { nonExistentModule } from "../lib/missingModule";',
          version: 1,
          ownerModel: 'gemini-2.5-flash',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          history: []
        }
      ];

      const report = IntegrationAgent.analyzeProjectContracts(brokenFiles);
      IntegrationAgent.spawnIntegrationFixTasks(buildId, report.issues);

      const tasks = db.getTasks(buildId);
      const repairTask = tasks.find(t => t.title.includes('[Integration Fix]'));

      assert.ok(repairTask !== undefined);
      assert.strictEqual(repairTask?.priority, 1);
      assert.strictEqual(repairTask?.isFixTask, true);
    });
  });

  describe('Interactive Live Preview Generator', () => {
    it('produces complete standalone responsive HTML preview bundle', () => {
      const files: ProjectFile[] = [
        {
          path: 'src/components/Header.tsx',
          content: 'export function Header() { return <header>Store</header>; }',
          version: 1,
          ownerModel: 'gemini-2.5-pro',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          history: []
        },
        {
          path: 'src/components/Cart.tsx',
          content: 'export function Cart() { return <div>Cart Items</div>; }',
          version: 1,
          ownerModel: 'gemini-2.5-pro',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          history: []
        }
      ];

      const preview = PreviewGenerator.generateLivePreview(
        'ecommerce',
        'Artisanal Coffee & Roasters E-Commerce Store',
        files
      );

      assert.ok(preview.html.includes('<!DOCTYPE html>'));
      assert.ok(preview.html.includes('viewport'));
      assert.ok(preview.html.includes('tailwindcss'));
      assert.ok(preview.html.includes('lucide'));
      assert.ok(preview.html.includes('Artisanal Coffee'));
      assert.strictEqual(preview.entryPoint, 'preview.html');
      assert.ok(preview.supportedDevices.includes('desktop'));
      assert.ok(preview.supportedDevices.includes('tablet'));
      assert.ok(preview.supportedDevices.includes('mobile'));
    });

    it('handles projects without explicit files gracefully', () => {
      const preview = PreviewGenerator.generateLivePreview(
        'landing_page',
        'Next-Gen Cloud Orchestration Platform',
        []
      );

      assert.ok(preview.html.includes('<!DOCTYPE html>'));
      assert.ok(preview.html.includes('Cloud Orchestration'));
      assert.ok(preview.html.length > 500);
    });
  });

  describe('Natural Language Revisions Dispatch & Execution', () => {
    it('creates targeted revision tasks and records revision history', async () => {
      const testBuild: Build = {
        id: 'rev-test-build',
        userId: 'guest_user_rev_test',
        idea: 'Distributed Key-Value Engine',
        status: 'completed',
        costLimit: 5.0,
        totalCost: 0.1,
        totalTokens: 500,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxDurationSeconds: 600,
        patchesAppliedCount: 0,
        autoPushGithub: false,
        selectedModels: ['gemini-2.5-pro', 'claude-3-5-sonnet-20241022'],
        projectType: 'api_service',
        revisions: []
      };

      db.saveBuild(testBuild);

      const revisionResult = await SwarmOrchestrator.applyRevision(
        testBuild,
        'Add Redis-compatible RESP protocol parser with unit tests'
      );

      assert.strictEqual(revisionResult.success, true);
      assert.ok(revisionResult.revision !== undefined);
      assert.strictEqual(revisionResult.revision?.revisionNumber, 1);
      assert.strictEqual(revisionResult.revision?.prompt, 'Add Redis-compatible RESP protocol parser with unit tests');
      assert.ok((revisionResult.revision?.tasksGenerated?.length || 0) >= 1, 'Should generate revision task');

      // Check build in DB
      const updatedBuild = db.getBuild(testBuild.id);
      assert.strictEqual(updatedBuild?.revisions?.length, 1);
      assert.strictEqual(updatedBuild?.status, 'running');

      // Check task generated in store
      const buildTasks = db.getTasks(testBuild.id);
      const revTask = buildTasks.find((t: Task) => t.title.includes('Revision #1'));
      assert.ok(revTask !== undefined);
      assert.strictEqual(revTask?.priority, 1);
    });
  });

});
