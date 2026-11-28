/**
 * Factory Phase F5 — Category AI teams as data.
 *
 * Pins the F5 contract:
 *  (a) every canonical category has a team definition as data, and every
 *      role in it (members, planner-assignable roles, verification
 *      chain) resolves to a registered model — with the registry's two
 *      bindings (AGENT_SPECS assignedModelId and ModelConfig agentRole,
 *      via getByRole) in agreement, aliases included;
 *  (b) team selection: one representative request per target category
 *      selects the expected team + generation profile, and agrees with
 *      the Phase 9 profile matcher's pick on those requests;
 *  (c) replaceability: changing a role's assignedModelId in the
 *      registry (data only) changes the model the orchestrator's
 *      completion chain calls — proven in a full swarm run over the
 *      F2/F3 stub transport, with zero code changes;
 *  (d) loud failure: team data referencing an unknown role, an unknown
 *      profile, or a duplicated role throws a named
 *      CategoryTeamResolutionError — never a silent fallback;
 *  (e) behaviour preservation: the standard fixture's planned and
 *      seeded task graphs (titles, roles, dependencies, milestones)
 *      match the shape captured from the pre-F5 code, and the planner
 *      prompt's role list for the standard team is byte-identical.
 *
 * The full-run test uses the stub transport seam of the F2 gauntlet
 * (smartRouter.executeSmartRequest replaced per test). It proves team
 * resolution and orchestration mechanics; it is NOT a live model (see
 * Factory Phase F1 — no provider keys exist in this environment).
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { AGENT_SPECS, modelRegistry } from '../server/modelRegistry.js';
import { CANONICAL_PROJECT_TYPES, AgentRole, CategoryTeamDefinition } from '../server/types.js';
import { CategoryTeamRegistry, CategoryTeamResolutionError } from '../server/swarm/categoryTeams.js';
import { GenerationProfileRegistry } from '../server/swarm/generationProfiles.js';
import { ConnectedApplicationPlanner } from '../server/application/connectedPlanner.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';

// ---------------------------------------------------------------------------
// (a) Completeness: every category resolves a complete team from data
// ---------------------------------------------------------------------------
const STAGE_ORDER = ['foundation', 'architecture', 'data', 'backend', 'frontend', 'integration', 'verification', 'release'];

test('F5 teams: every canonical category has a team whose roles all resolve to registered models', () => {
  assert.equal(CategoryTeamRegistry.getAll().length, CANONICAL_PROJECT_TYPES.length,
    'exactly one team per canonical category');
  for (const category of CANONICAL_PROJECT_TYPES) {
    const team = CategoryTeamRegistry.selectForCategory(category);
    assert.equal(team.category, category);
    const resolved = CategoryTeamRegistry.resolve(team);

    // The referenced generation profile is real data in the profile registry.
    assert.ok(GenerationProfileRegistry.getAll().some(p => p.id === team.profileId),
      `${category}: profile ${team.profileId} must be registered`);

    // Members: unique roles, stage-ordered, each resolving to the model
    // AGENT_SPECS assigns AND to the same model via getByRole (the two
    // registry bindings agree — aliases canonicalize).
    const seen = new Set<string>();
    let lastStage = -1;
    for (const member of resolved.members) {
      assert.ok(!seen.has(member.role), `${category}: duplicate member role ${member.role}`);
      seen.add(member.role);
      const stageIdx = STAGE_ORDER.indexOf(member.stage);
      assert.ok(stageIdx >= lastStage, `${category}: members must be in stage order (${member.role} is ${member.stage})`);
      lastStage = stageIdx;
      assert.equal(member.modelId, AGENT_SPECS[member.role].assignedModelId,
        `${category}: ${member.role} must resolve to its AGENT_SPECS-assigned model`);
      assert.equal(modelRegistry.getByRole(member.role)?.id, member.modelId,
        `${category}: getByRole(${member.role}) must agree with the team resolution`);
    }

    // Planner-assignable roles and the verification chain resolve too.
    for (const role of team.assignableRoles) {
      assert.equal(CategoryTeamRegistry.resolveRoleModel(role, category).id, AGENT_SPECS[role].assignedModelId,
        `${category}: assignable role ${role} must resolve`);
    }
    assert.equal(resolved.verifierModelId, AGENT_SPECS[team.verification.verifierRole].assignedModelId);
    assert.equal(resolved.integrationModelId, AGENT_SPECS[team.verification.integrationRole].assignedModelId);
    assert.equal(resolved.repairModelId, AGENT_SPECS[team.verification.repairRole].assignedModelId);
    assert.equal(team.verification.sandboxIntegrityCheck, true);
  }
});

test('F5 teams: default verification chain resolves to the models the orchestrator used before F5', () => {
  // Pre-F5 the completion chain hardcoded verifier model 'claude' and
  // fix-task role 'debugging_specialist'. The data must reproduce that.
  const resolved = CategoryTeamRegistry.resolveForCategory('fullstack');
  assert.equal(resolved.verifierModelId, 'claude');
  assert.equal(resolved.team.verification.verifierRole, 'software_architect');
  assert.equal(resolved.team.verification.repairRole, 'debugging_specialist');
  assert.equal(resolved.repairModelId, 'qwen');
  assert.equal(resolved.integrationModelId, 'gemini');
  assert.equal(CategoryTeamRegistry.resolveVerifierModelId('game_application'), 'claude');
  assert.equal(CategoryTeamRegistry.resolveVerifierModelId(undefined), 'claude');
  assert.equal(CategoryTeamRegistry.resolveVerifierModelId('not-a-real-category'), 'claude',
    'unknown project types normalize to the custom team, whose verifier is still claude');
});

// ---------------------------------------------------------------------------
// (b) Team selection: one representative request per target category
// ---------------------------------------------------------------------------
const SELECTION_CASES: Array<{ request: string; category: string; profileId: string; displayName: string }> = [
  { request: 'Build a 2D platformer game with levels and score tracking', category: 'game_application', profileId: 'game_creative_application', displayName: 'Game Development Team' },
  { request: 'Create a generative art canvas app with brushes', category: 'creative_application', profileId: 'game_creative_application', displayName: 'Creative Software Team' },
  { request: 'Build a web application for team notes and sharing', category: 'web_application', profileId: 'website_and_web_app', displayName: 'Web Development Team' },
  { request: 'Build a multi-tenant SaaS dashboard with KPI metrics and audit logs', category: 'saas', profileId: 'saas_platform', displayName: 'Web Development Team — SaaS Platform' },
  { request: 'Create an e-commerce store with product catalog and checkout', category: 'ecommerce', profileId: 'ecommerce_app', displayName: 'Web Development Team — E-Commerce' },
  { request: 'Build an Android mobile app with Kotlin and Jetpack Compose', category: 'android_application', profileId: 'android_mobile_application', displayName: 'Mobile Development Team — Android' },
  { request: 'Build a cross-platform desktop app with Electron and local files', category: 'cross_platform_desktop', profileId: 'desktop_application', displayName: 'Desktop Software Team — Cross-Platform' },
  { request: 'Build a REST API backend service with Express endpoints', category: 'api_service', profileId: 'rest_api_backend', displayName: 'Backend Engineering Team — API Service' },
  { request: 'Build a CLI tool for parsing log files', category: 'cli_tool', profileId: 'cli_tool_developer_utility', displayName: 'Developer Tools Team — CLI' },
  { request: 'Build an automation bot that scrapes prices on a cron schedule', category: 'automation_tool', profileId: 'automation_software', displayName: 'Automation Team' },
  { request: 'Build a data processing ETL pipeline for CSV files', category: 'data_application', profileId: 'data_processing_application', displayName: 'Data Engineering Team' },
  { request: 'Create a video editor with timeline and filters', category: 'multimedia_application', profileId: 'multimedia_application', displayName: 'Creative Software Team — Multimedia' },
  { request: 'Build a landing page with hero section and waitlist', category: 'landing_page', profileId: 'website_and_web_app', displayName: 'Web Development Team — Landing Page' }
];

test('F5 selection: representative requests select the expected team and generation profile', () => {
  for (const c of SELECTION_CASES) {
    const team = CategoryTeamRegistry.selectForRequest(c.request);
    assert.equal(team.category, c.category, `"${c.request}" must select category ${c.category}, got ${team.category}`);
    assert.equal(team.profileId, c.profileId, `"${c.request}" must select profile ${c.profileId}, got ${team.profileId}`);
    assert.equal(team.displayName, c.displayName);
    // Convergence evidence: on these representative requests the Phase 9
    // engine's keyword profile matcher picks the same profile the team
    // data assigns to the classified category.
    assert.equal(GenerationProfileRegistry.matchProfileForRequest(c.request).id, c.profileId,
      `"${c.request}" profile matcher must agree with the team profile`);
  }
});

test('F5 selection: the landing-page team is the reduced graph team (no backend/database/fullstack members)', () => {
  const team = CategoryTeamRegistry.selectForCategory('landing_page');
  assert.deepEqual(team.members.map(m => m.role),
    ['software_architect', 'frontend_developer', 'qa_testing_specialist', 'security_specialist', 'devops_release_specialist']);
  assert.deepEqual(team.assignableRoles,
    ['software_architect', 'frontend_developer', 'qa_testing_specialist', 'security_specialist', 'devops_release_specialist', 'debugging_specialist']);
  // Every other category assembles the connected-application team today.
  const connected = CategoryTeamRegistry.selectForCategory('fullstack');
  assert.deepEqual(connected.members.map(m => m.role),
    ['devops_release_specialist', 'software_architect', 'database_specialist', 'backend_developer', 'security_specialist', 'frontend_developer', 'fullstack_developer', 'qa_testing_specialist']);
  assert.deepEqual(connected.assignableRoles,
    ['software_architect', 'backend_developer', 'frontend_developer', 'fullstack_developer', 'database_specialist', 'qa_testing_specialist', 'security_specialist', 'devops_release_specialist', 'debugging_specialist'],
    'the standard team assignable list must equal the pre-F5 hardcoded planner list, in order');
});

// ---------------------------------------------------------------------------
// (d) Loud failure on bad team data — never a silent fallback
// ---------------------------------------------------------------------------
test('F5 resolution: unknown roles, unknown profiles, and duplicate roles fail loudly by name', () => {
  assert.throws(
    () => CategoryTeamRegistry.resolveRoleModel('wizard' as AgentRole),
    (err: any) => err instanceof CategoryTeamResolutionError && /unknown agent role "wizard"/.test(err.message),
    'an unknown role must throw a named CategoryTeamResolutionError'
  );

  const original = CategoryTeamRegistry.selectForCategory('custom');
  try {
    const badProfile: CategoryTeamDefinition = { ...original, profileId: 'no_such_profile' as any };
    CategoryTeamRegistry.register(badProfile);
    assert.throws(
      () => CategoryTeamRegistry.resolveForCategory('custom'),
      (err: any) => err instanceof CategoryTeamResolutionError && /unknown generation profile "no_such_profile"/.test(err.message),
      'an unknown profile reference must throw naming the profile'
    );

    const badRole: CategoryTeamDefinition = {
      ...original,
      members: [{ role: 'wizard' as AgentRole, stage: 'backend' }]
    };
    CategoryTeamRegistry.register(badRole);
    assert.throws(
      () => CategoryTeamRegistry.resolveForCategory('custom'),
      (err: any) => err instanceof CategoryTeamResolutionError && /unknown agent role "wizard"/.test(err.message),
      'a team member with an unknown role must throw naming the role'
    );

    const duplicate: CategoryTeamDefinition = {
      ...original,
      members: [...original.members, original.members[0]]
    };
    CategoryTeamRegistry.register(duplicate);
    assert.throws(
      () => CategoryTeamRegistry.resolveForCategory('custom'),
      (err: any) => err instanceof CategoryTeamResolutionError && /more than once/.test(err.message),
      'a duplicated member role must throw'
    );

    // Positive control: an alias role in team data resolves through its
    // canonical specialist (qa_engineer -> qa_testing_specialist -> deepseek).
    const aliasTeam: CategoryTeamDefinition = {
      ...original,
      members: [{ role: 'qa_engineer', stage: 'verification' }]
    };
    CategoryTeamRegistry.register(aliasTeam);
    const resolved = CategoryTeamRegistry.resolveForCategory('custom');
    assert.equal(resolved.members[0].modelId, 'deepseek');
  } finally {
    CategoryTeamRegistry.register(original);
  }
  // Registry restored: the real custom team resolves again.
  assert.equal(CategoryTeamRegistry.resolveForCategory('custom').verifierModelId, 'claude');
});

// ---------------------------------------------------------------------------
// (e) Behaviour preservation: the standard fixture's planned graph
// ---------------------------------------------------------------------------
const FIXTURE_IDEA = 'Build a habit tracker application with streaks and reminders';

const EXPECTED_PLAN_TASKS = [
  { title: 'Initialize Project Configuration & Environment', role: 'devops_release_specialist', tier: 0, priority: 2, dependencies: [] as string[], filePaths: ['.env.example', 'package.json', 'tsconfig.json'] },
  { title: 'Architect Domain Contracts & API Interfaces', role: 'software_architect', tier: 1, priority: 2, dependencies: ['task_tier_0'], filePaths: ['src/types/domain.ts'] },
  { title: 'Build Database Schema, Migrations & Store Repository', role: 'database_specialist', tier: 2, priority: 2, dependencies: ['task_tier_1'], filePaths: ['server/db/schema.ts', 'server/db/migrations/001_initial_schema.ts', 'server/db/migrationRunner.ts', 'server/db/store.ts'] },
  { title: 'Implement Backend Services, Auth Middleware & REST Endpoints', role: 'backend_developer', tier: 3, priority: 2, dependencies: ['task_tier_2'], filePaths: ['server/services/appService.ts', 'server/routes/api.ts', 'server.ts'] },
  { title: 'Implement Frontend Typed API Client & Data Fetching Hooks', role: 'frontend_developer', tier: 4, priority: 3, dependencies: ['task_tier_3'], filePaths: ['src/api/client.ts', 'src/hooks/useApi.ts'] },
  { title: 'Build Reusable Responsive UI Components & Interactive Views', role: 'frontend_developer', tier: 5, priority: 3, dependencies: ['task_tier_4'], filePaths: ['src/components/ui/Button.tsx', 'src/components/ui/Card.tsx', 'src/components/ui/FormField.tsx', 'src/components/ui/Modal.tsx', 'src/components/Navbar.tsx', 'src/components/ItemListView.tsx', 'src/components/ItemFormModal.tsx', 'src/App.tsx'] },
  { title: 'Automated Full-Stack Integration & End-to-End Test Suite', role: 'qa_testing_specialist', tier: 6, priority: 3, dependencies: ['task_tier_5'], filePaths: ['tests/connected_application.test.ts'] }
];

test('F5 preservation: the standard fixture plans the pre-F5 task graph', () => {
  const plan = ConnectedApplicationPlanner.planApplication({
    buildId: 'bld_f5_pin',
    userRequest: FIXTURE_IDEA,
    existingFiles: [],
    category: 'fullstack'
  });
  assert.equal(plan.category, 'fullstack');
  assert.deepEqual(
    plan.tasks.map(t => ({ title: t.title, role: t.role, tier: t.tier, priority: t.priority, dependencies: t.dependencies, filePaths: t.filePaths })),
    EXPECTED_PLAN_TASKS,
    'the ConnectedApplicationPlanner graph for the standard fixture must be unchanged by F5'
  );
});

test('F5 swap (resolution level): reassigning a member role in registry data changes the resolved team model', () => {
  // qa_testing_specialist is a member of every connected-application
  // team. Reassigning it in AGENT_SPECS data — and nothing else — must
  // change what team resolution returns.
  const original = AGENT_SPECS.qa_testing_specialist.assignedModelId;
  assert.equal(original, 'deepseek');
  AGENT_SPECS.qa_testing_specialist.assignedModelId = 'qwen';
  try {
    const resolved = CategoryTeamRegistry.resolveForCategory('game_application');
    assert.equal(resolved.members.find(m => m.role === 'qa_testing_specialist')?.modelId, 'qwen',
      'the resolved team must follow the swapped registry data');
  } finally {
    AGENT_SPECS.qa_testing_specialist.assignedModelId = original;
  }
  assert.equal(
    CategoryTeamRegistry.resolveForCategory('game_application').members.find(m => m.role === 'qa_testing_specialist')?.modelId,
    'deepseek', 'registry data restored after the swap');
});

// ---------------------------------------------------------------------------
// (c) + (e): registry swap in a full swarm run (F2 stub pattern)
// ---------------------------------------------------------------------------
function contentFor(path: string): string {
  if (path === 'Dockerfile') return 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "dist/index.js"]\n';
  if (path.includes('.github/workflows/')) return 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  if (path.endsWith('package.json')) return JSON.stringify({ name: 'habit-tracker', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
  if (path.endsWith('tsconfig.json')) return JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true }, include: ['src', 'tests', 'server'] }, null, 2) + '\n';
  if (path.endsWith('.json')) return '{}\n';
  if (path.includes('.test.') || path.startsWith('tests/')) {
    return [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      '',
      "test('engine adds numbers', () => {",
      '  assert.equal(1 + 1, 2);',
      '});',
      ''
    ].join('\n');
  }
  if (path.endsWith('domain.ts')) {
    return [
      'export interface Habit { id: string; name: string; streak: number; }',
      'export interface HabitState { habits: Habit[]; }',
      'export const EMPTY_STATE: HabitState = { habits: [] };',
      ''
    ].join('\n');
  }
  if (path.endsWith('.tsx')) {
    let name = path.split('/').pop()!.replace(/\.tsx$/, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!name || /^[0-9]/.test(name)) name = `mod${name}`;
    return `export default function ${name}(): string {\n  return '${name} rendered';\n}\n`;
  }
  if (path.endsWith('.ts')) {
    let name = path.split('/').pop()!.replace(/\.ts$/, '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!name || /^[0-9]/.test(name)) name = `mod${name}`;
    return `export function ${name}Main(): string {\n  return '${name} ready';\n}\nexport const ${name}Version = 1;\n`;
  }
  return `// ${path}\nexport const ready = true;\n`;
}

const EXPECTED_SEEDED_GRAPH = [
  { title: 'Initialize Project Configuration & Environment', role: 'devops_release_specialist', milestone: 'ms_1_foundation', priority: 2, filePaths: ['.env.example', 'package.json', 'tsconfig.json'], deps: [] as string[] },
  { title: 'Architect Domain Contracts & API Interfaces', role: 'software_architect', milestone: 'ms_1_foundation', priority: 2, filePaths: ['src/types/domain.ts'], deps: ['Initialize Project Configuration & Environment'] },
  { title: 'Build Database Schema, Migrations & Store Repository', role: 'database_specialist', milestone: 'ms_2_core', priority: 2, filePaths: ['server/db/schema.ts', 'server/db/migrations/001_initial_schema.ts', 'server/db/migrationRunner.ts', 'server/db/store.ts'], deps: ['Architect Domain Contracts & API Interfaces'] },
  { title: 'Implement Backend Services, Auth Middleware & REST Endpoints', role: 'backend_developer', milestone: 'ms_2_core', priority: 2, filePaths: ['server/services/appService.ts', 'server/routes/api.ts', 'server.ts'], deps: ['Build Database Schema, Migrations & Store Repository'] },
  { title: 'Implement Frontend Typed API Client & Data Fetching Hooks', role: 'frontend_developer', milestone: 'ms_2_core', priority: 3, filePaths: ['src/api/client.ts', 'src/hooks/useApi.ts'], deps: ['Implement Backend Services, Auth Middleware & REST Endpoints'] },
  { title: 'Build Reusable Responsive UI Components & Interactive Views', role: 'frontend_developer', milestone: 'ms_2_core', priority: 3, filePaths: ['src/components/ui/Button.tsx', 'src/components/ui/Card.tsx', 'src/components/ui/FormField.tsx', 'src/components/ui/Modal.tsx', 'src/components/Navbar.tsx', 'src/components/ItemListView.tsx', 'src/components/ItemFormModal.tsx', 'src/App.tsx'], deps: ['Implement Frontend Typed API Client & Data Fetching Hooks'] },
  { title: 'Automated Full-Stack Integration & End-to-End Test Suite', role: 'qa_testing_specialist', milestone: 'ms_3_qa_security', priority: 3, filePaths: ['tests/connected_application.test.ts'], deps: ['Build Reusable Responsive UI Components & Interactive Views'] },
  { title: 'Prepare Dockerfile & GitHub Actions CI Workflow', role: 'devops_release_specialist', milestone: 'ms_4_release', priority: 4, filePaths: ['Dockerfile', '.github/workflows/ci.yml'], deps: [] as string[] }
];

const EXPECTED_PLANNER_ROLES_LINE =
  'software_architect, backend_developer, frontend_developer, fullstack_developer, database_specialist, qa_testing_specialist, security_specialist, devops_release_specialist, debugging_specialist.';

test('F5 swap: changing the architect role\'s assignedModelId in registry data changes the orchestrator\'s verifier model — and nothing else', { timeout: 300_000 }, async (t) => {
  const userId = `usr_f5_swap_${Date.now()}`;
  db.createUser({
    id: userId, email: `${userId}@f5.test`, name: userId, githubConnected: false,
    costLimitPerBuild: 25, enabledModelIds: ['gemini', 'claude', 'deepseek'], createdAt: Date.now()
  } as any);
  const buildId = `bld_f5_swap_${Date.now()}`;
  db.saveBuild({
    id: buildId, userId, idea: FIXTURE_IDEA, status: 'planning',
    createdAt: Date.now(), updatedAt: Date.now(),
    selectedModels: ['gemini', 'claude', 'deepseek'], autoPushGithub: false,
    totalTokens: 0, totalCost: 0, costLimit: 25, maxDurationSeconds: 600, patchesAppliedCount: 0
  } as any);

  const verifierModelIds: string[] = [];
  let plannerRolesLine = '';

  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';
    const ok = (parsedResponse: any, rawText = '') => ({
      success: true, rawText, parsedResponse, tokensUsed: 10, modelId,
      actualModelUsed: modelId, providerUsed: 'stub-transport', isFallback: false, latencyMs: 1
    });
    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      plannerRolesLine = prompt.match(/Available Agent Roles: ([^\n]+)/)?.[1] || '';
      return ok({ thinking: 'plan', actions: [] });
    }
    if (prompt.includes('VERIFY SOFTWARE COMPLETION')) {
      verifierModelIds.push(modelId);
      return ok(null, JSON.stringify({ approved: true, summary: 'All requirements verified against specification', missingRequirements: [] }));
    }
    const task = params.task;
    const actions = (task?.filePaths || []).map((p: string) => {
      if (task?.isFixTask) {
        const existing = db.getFile(buildId, p);
        if (existing) return { action: 'patch_file', path: p, edits: [{ find: existing.content, replace: contentFor(p) }], commitMessage: `Repair ${p}` };
      }
      return { action: 'create_file', path: p, content: contentFor(p), commitMessage: `Implement ${task?.title}` };
    });
    return ok({ thinking: 'work', actions });
  });

  const pump = setInterval(async () => {
    try {
      for (const req of db.getApprovalRequests(buildId, 'pending')) {
        const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: req.id, approved: true });
        if (decided.success && decided.request) await SwarmOrchestrator.resolveHeldTask(decided.request);
      }
    } catch { /* the pump must never take the test down with it */ }
  }, 150);

  // THE SWAP: one data value in the registry — the software_architect
  // role (the fullstack team's verifier role) now binds to gpt-4o.
  // No code changes; AGENT_SPECS is restored in the finally block.
  const originalAssigned = AGENT_SPECS.software_architect.assignedModelId;
  assert.equal(originalAssigned, 'claude');
  AGENT_SPECS.software_architect.assignedModelId = 'gpt-4o';
  try {
    assert.equal(CategoryTeamRegistry.resolveVerifierModelId('fullstack'), 'gpt-4o',
      'team resolution must follow the swapped registry data');
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    clearInterval(pump);
    AGENT_SPECS.software_architect.assignedModelId = originalAssigned;
  }
  assert.equal(CategoryTeamRegistry.resolveVerifierModelId('fullstack'), 'claude',
    'registry data restored after the swap test');

  const build = db.getBuild(buildId);
  assert.equal(build?.status, 'completed', `build must complete under the swapped verifier, got ${build?.status}: ${build?.error || build?.failureReason || ''}`);

  // The orchestrator's completion chain called the SWAPPED model.
  assert.ok(verifierModelIds.length >= 1, 'the verifier must have been called');
  assert.ok(verifierModelIds.every(id => id === 'gpt-4o'),
    `every verifier call must use the swapped model gpt-4o, got ${verifierModelIds.join(', ')}`);

  // The planner prompt's role list is the team data, byte-identical to
  // the pre-F5 hardcoded list for the standard team.
  assert.equal(plannerRolesLine, EXPECTED_PLANNER_ROLES_LINE);

  // And the seeded task graph is exactly the pre-F5 shape.
  const tasks = db.getTasks(buildId).filter(task => !task.isFixTask);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const graph = tasks.map(task => ({
    title: task.title,
    role: task.assignedRole,
    milestone: task.milestone,
    priority: task.priority,
    filePaths: task.filePaths,
    deps: (task.dependencies || []).map(d => byId.get(d)?.title || d)
  }));
  const sortByTitle = (a: any, b: any) => a.title.localeCompare(b.title);
  assert.deepEqual([...graph].sort(sortByTitle), [...EXPECTED_SEEDED_GRAPH].sort(sortByTitle),
    'the seeded graph under the swap must equal the pre-F5 graph');
});
