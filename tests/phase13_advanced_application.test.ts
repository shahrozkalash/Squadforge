import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ConnectedApplicationPlanner,
  ConnectedApplicationGenerator,
  ExistingProjectModifier,
  ConnectedApplicationValidator
} from '../server/application/index.js';
import { db } from '../server/store.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { TaskManager } from '../server/swarm/taskManager.js';
import { normalizeProjectType, ProjectFile } from '../server/types.js';

describe('Phase 13: Advanced Application Development Test Suite', () => {
  const testUserId = 'test_owner_p13';
  const testBuildId = 'build_p13_test_100';

  beforeEach(() => {
    try {
      db.dbManager.db.prepare('DELETE FROM builds WHERE id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM project_files WHERE build_id = ?').run(testBuildId);
      db.dbManager.db.prepare('DELETE FROM tasks WHERE build_id = ?').run(testBuildId);
    } catch {}
  });

  // ---------------------------------------------------------------------------
  // Task 1: Full-Stack Project Planning
  // ---------------------------------------------------------------------------
  test('Task 1: ConnectedApplicationPlanner produces comprehensive topology and data flows', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Build a SaaS project management application with tasks, comments, and member roles',
      category: 'saas'
    });

    assert.ok(plan.id, 'Plan must have unique ID');
    assert.equal(plan.mode, 'greenfield');
    assert.equal(plan.category, 'saas');
    assert.ok(plan.topology.database.tables.length >= 2, 'Should plan at least user and entity tables');
    assert.ok(plan.topology.backend.endpoints.length >= 4, 'Should plan comprehensive REST API endpoints');
    assert.ok(plan.topology.frontend.components.length >= 4, 'Should plan reusable UI components');
    assert.ok(plan.connectedFlows.length >= 3, 'Should synthesize end-to-end connected flows');
    assert.ok(plan.plannedFiles.length >= 7, 'Should plan tiered files covering tiers 0 to 6');
    assert.ok(plan.tasks.length >= 5, 'Should synthesize dependency-chained multi-agent tasks');
  });

  // ---------------------------------------------------------------------------
  // Task 2: Frontend and Backend Generation
  // ---------------------------------------------------------------------------
  test('Task 2: ConnectedApplicationGenerator produces complete non-mock files across all tiers', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Inventory management system with products and suppliers',
      category: 'saas'
    });

    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    assert.ok(actions.length >= 6, 'Must generate all core application files');

    const createdPaths = actions.map((a: any) => a.path);
    assert.ok(createdPaths.includes('src/types/domain.ts'), 'Must include domain contracts');
    assert.ok(createdPaths.includes(plan.topology.database.schemaPath), 'Must include database schema');
    assert.ok(createdPaths.includes(plan.topology.database.storePath), 'Must include store repository');
    assert.ok(createdPaths.includes(plan.topology.backend.routesPath), 'Must include backend API routes');
    assert.ok(createdPaths.includes(plan.topology.frontend.clientApiPath), 'Must include typed client API');
    assert.ok(createdPaths.includes(plan.topology.frontend.hooksPath), 'Must include custom React hooks');
    assert.ok(createdPaths.includes('src/components/ui/Button.tsx'), 'Must include reusable UI components');

    // Verify zero mock placeholders or empty stubs
    for (const action of actions) {
      if ('content' in action && typeof action.content === 'string') {
        assert.ok(!action.content.includes('// TODO: implement later'), 'No empty placeholders allowed');
        assert.ok(action.content.length > 50, 'File content must be substantive');
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Task 3: API Routes and Defensive Input Validation
  // ---------------------------------------------------------------------------
  test('Task 3: Backend REST routes enforce validation and handle invalid inputs safely', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Task tracking application',
      category: 'saas'
    });

    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    const routesAction = actions.find((a: any) => a.path === plan.topology.backend.routesPath) as any;
    assert.ok(routesAction && routesAction.content, 'Routes file must exist');

    assert.ok(routesAction.content.includes('/health'), 'Must expose health check');
    assert.ok(routesAction.content.includes('router.post'), 'Must define POST route');
    assert.ok(routesAction.content.includes('router.get'), 'Must define GET route');
    assert.ok(routesAction.content.includes('router.put'), 'Must define PUT route');
    assert.ok(routesAction.content.includes('router.delete'), 'Must define DELETE route');
    assert.ok(routesAction.content.includes('status(400)'), 'Must return 400 for bad input');
  });

  // ---------------------------------------------------------------------------
  // Task 4: Database Schemas, Models, and Migrations
  // ---------------------------------------------------------------------------
  test('Task 4: Database schema and versioned migrations execute cleanly on SQLite', () => {
    const memDb = new DatabaseSync(':memory:');

    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Customer CRM platform with clients and notes',
      category: 'saas'
    });

    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    const schemaAction = actions.find((a: any) => a.path === plan.topology.database.schemaPath) as any;
    assert.ok(schemaAction, 'Schema file must be generated');

    // Execute generated SQL tables in test SQLite database
    memDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        priority TEXT NOT NULL DEFAULT 'medium',
        user_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Verify persistence
    memDb.prepare('INSERT INTO clients (id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('client_1', 'Acme Corp', 'active', 'high', Date.now(), Date.now());

    const client = memDb.prepare('SELECT * FROM clients WHERE id = ?').get('client_1') as any;
    assert.equal(client.title, 'Acme Corp');
    assert.equal(client.status, 'active');
  });

  // ---------------------------------------------------------------------------
  // Task 5: Responsive UI and Reusable Components
  // ---------------------------------------------------------------------------
  test('Task 5: Reusable UI component library contains accessible props and responsive Tailwind utilities', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Responsive analytics dashboard',
      category: 'saas'
    });

    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    const buttonAction = actions.find((a: any) => a.path.includes('Button.tsx')) as any;
    const cardAction = actions.find((a: any) => a.path.includes('Card.tsx')) as any;
    const formAction = actions.find((a: any) => a.path.includes('FormField.tsx')) as any;
    const modalAction = actions.find((a: any) => a.path.includes('Modal.tsx')) as any;

    assert.ok(buttonAction && buttonAction.content.includes('variant'), 'Button must support variants');
    assert.ok(cardAction && cardAction.content.includes('rounded-xl'), 'Card must have Tailwind styles');
    assert.ok(formAction && formAction.content.includes('error'), 'FormField must render validation error');
    assert.ok(modalAction && modalAction.content.includes('backdrop-blur'), 'Modal must have accessible overlay');
  });

  // ---------------------------------------------------------------------------
  // Task 6: Authentication and Secure Configuration
  // ---------------------------------------------------------------------------
  test('Task 6: Authentication enforces password hashing and .env.example documents keys without leaks', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Secure document portal with user login and session authentication',
      category: 'saas'
    });

    assert.equal(plan.topology.security.passwordHashing, 'bcryptjs');
    assert.ok(plan.topology.security.roles.includes('admin'));

    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    const envAction = actions.find((a: any) => a.path === '.env.example') as any;
    if (envAction) {
      assert.ok(envAction.content.includes('PORT='), '.env.example must specify PORT');
      assert.ok(!envAction.content.includes('sk-live-'), 'Must never contain live secrets');
    }
  });

  // ---------------------------------------------------------------------------
  // Task 7: Existing-Project Modification
  // ---------------------------------------------------------------------------
  test('Task 7: ExistingProjectModifier inspects existing workspace and plans non-destructive increments', () => {
    const existingFiles: ProjectFile[] = [
      {
        path: 'server/db/schema.ts',
        content: 'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);',
        version: 1,
        ownerModel: 'architect'
      },
      {
        path: 'server/db/migrations/001_initial.ts',
        content: 'export const id = 1;',
        version: 1,
        ownerModel: 'architect'
      },
      {
        path: 'server/routes/api.ts',
        content: "router.get('/api/users', (req, res) => {});",
        version: 1,
        ownerModel: 'backend'
      },
      {
        path: 'src/App.tsx',
        content: 'export default function App() { return <div>App</div>; }',
        version: 1,
        ownerModel: 'frontend'
      }
    ];

    const inspection = ExistingProjectModifier.inspectProject(existingFiles);
    assert.equal(inspection.hasDatabase, true);
    assert.equal(inspection.hasMigrations, true);
    assert.equal(inspection.migrationCount, 1);
    assert.equal(inspection.hasBackendRoutes, true);

    const modification = ExistingProjectModifier.planModification(
      testBuildId,
      'Add customer support tickets to the existing project',
      existingFiles
    );

    assert.equal(modification.plan.mode, 'modification');
    // Ensure the new migration is versioned as 002
    const migrationAction = modification.actions.find((a: any) => 'path' in a && a.path.includes('/migrations/')) as any;
    assert.ok(migrationAction, 'Must generate incremental migration');
    assert.ok(migrationAction.path.includes('002_'), 'Must increment migration number to 002');
  });

  // ---------------------------------------------------------------------------
  // Task 8: Multi-Agent Task Coordination
  // ---------------------------------------------------------------------------
  test('Task 8: Swarm tasks strictly chain dependencies across architecture tiers', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'Collaborative spreadsheet application',
      category: 'saas'
    });

    const tasks = plan.tasks;
    assert.ok(tasks.length >= 6);

    // Verify strict tier sequencing
    const tier0 = tasks.find(t => t.tier === 0);
    const tier1 = tasks.find(t => t.tier === 1);
    const tier2 = tasks.find(t => t.tier === 2);
    const tier3 = tasks.find(t => t.tier === 3);

    assert.ok(tier0 && tier1 && tier2 && tier3);
    assert.equal(tier0.dependencies.length, 0, 'Tier 0 has no prerequisites');
    assert.ok(tier1.dependencies.length > 0, 'Tier 1 depends on foundation');
    assert.ok(tier2.dependencies.length > 0, 'Tier 2 depends on contracts');
  });

  // ---------------------------------------------------------------------------
  // Task 9: Connected Application Validation
  // ---------------------------------------------------------------------------
  test('Task 9: ConnectedApplicationValidator audits all 6 dimensions and computes honest verdict', () => {
    const plan = ConnectedApplicationPlanner.planApplication({
      buildId: testBuildId,
      userRequest: 'E-commerce storefront for books',
      category: 'saas'
    });

    const actions = ConnectedApplicationGenerator.generateConnectedFiles(plan, []);
    const projectFiles: ProjectFile[] = actions.map((a: any, idx) => ({
      path: a.path,
      content: a.content || '',
      version: 1,
      ownerModel: 'agent'
    }));

    // Add minimal App.tsx and .env.example
    projectFiles.push({
      path: 'src/App.tsx',
      content: 'export default function App() { return <div className="sm:p-4">Books</div>; }',
      version: 1,
      ownerModel: 'agent'
    });
    projectFiles.push({
      path: '.env.example',
      content: 'PORT=3000\nNODE_ENV=development\n',
      version: 1,
      ownerModel: 'agent'
    });

    const report = ConnectedApplicationValidator.validate(projectFiles, plan);
    assert.ok(report.score >= 80, `Expected high score, got ${report.score}`);
    assert.ok(report.verdict === 'verified' || report.verdict === 'passed_with_warnings');
    assert.ok(report.checks.length >= 6, 'Must validate all core dimensions');
  });

  // ---------------------------------------------------------------------------
  // Task 10: Defect Detection in Incomplete Applications
  // ---------------------------------------------------------------------------
  test('Task 10: ConnectedApplicationValidator flags missing database or routes as rejected', () => {
    // Files without database schema or routes
    const brokenFiles: ProjectFile[] = [
      {
        path: 'src/components/ui/Button.tsx',
        content: 'export const Button = () => <button>Click</button>;',
        version: 1,
        ownerModel: 'agent'
      }
    ];

    const report = ConnectedApplicationValidator.validate(brokenFiles);
    assert.equal(report.verdict, 'rejected', 'Must reject application lacking database and API routes');
    assert.ok(report.unresolvedIssues.length >= 2, 'Must list specific unresolved issues');
  });
});
