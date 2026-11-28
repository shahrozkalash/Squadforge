/**
 * Factory Phase F4 — Verification and failure-recovery gauntlet.
 *
 * These tests drive the REAL SwarmOrchestrator completion chain
 * (SandboxRunner integrity gate -> verifier model -> IntegrationAgent
 * contract gate -> HonestVerificationService requirements gate) over
 * the F2/F3 stub transport, with ONE defect class injected per build:
 *
 *   1. syntax-broken file          6. runtime crash at import time
 *   2. TypeScript type error       7. broken import graph
 *   3. hardcoded secret            8. IntegrationAgent direct probe
 *   4. dangerous eval()            9. malformed worker output
 *   5. failing generated test     10. verifier-bait (omitted file)
 *                                 11. unrepairable defect (repair exhaustion)
 *
 * The stub verifier APPROVES EVERYTHING. That is deliberate: it is the
 * worst case for false completions — a lenient verifier model — so any
 * fault that still cannot reach `completed` was stopped by the
 * platform's deterministic gates, not by model judgement. For every
 * repairable class the asserted honest outcome is: defect detected ->
 * targeted fix task -> worker repairs -> the gate RE-VERIFIES the
 * repaired tree -> completed. For the unrepairable classes it is:
 * bounded attempts (counts asserted) -> build `failed` with the defect
 * named. No build with an unrepaired defect is ever marked complete.
 *
 * The stub is a transport fixture (Factory Phase F1: no live provider
 * exists in this environment). It proves verification/repair mechanics,
 * not live generation quality.
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { IntegrationAgent } from '../server/swarm/integrationAgent.js';

// ---------------------------------------------------------------------------
// Deterministic fixture content (F2 pattern). The generated test file
// imports the store module, so test execution genuinely exercises it.
// ---------------------------------------------------------------------------
function ident(path: string): string {
  let name = path.split('/').pop()!.replace(/\.(ts|tsx|js|jsx)$/, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!name || /^[0-9]/.test(name)) name = `mod${name}`;
  return name;
}

function cleanTestContent(): string {
  return [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { MemoryStore } from '../server/db/store';",
    '',
    "test('engine adds numbers', () => {",
    '  assert.equal(1 + 1, 2);',
    '});',
    '',
    "test('engine multiplies numbers', () => {",
    '  assert.equal(2 * 3, 6);',
    '});',
    '',
    "test('store round-trips values', () => {",
    "  const s = new MemoryStore<string>();",
    "  s.set('a', 'b');",
    "  assert.equal(s.get('a'), 'b');",
    '});',
    ''
  ].join('\n');
}

function contentFor(path: string): string {
  if (path === 'Dockerfile') return 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "dist/index.js"]\n';
  if (path.includes('.github/workflows/')) return 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  if (path.endsWith('package.json')) return JSON.stringify({ name: 'habit-tracker', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n';
  if (path.endsWith('tsconfig.json')) return JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true }, include: ['src', 'tests', 'server'] }, null, 2) + '\n';
  if (path.endsWith('.json')) return '{}\n';
  if (path.includes('.test.') || path.startsWith('tests/')) return cleanTestContent();
  if (path.endsWith('nonexistent.ts')) return 'export const missingHelper = 42;\n';
  if (path.endsWith('domain.ts')) {
    return [
      'export interface Habit { id: string; name: string; streak: number; }',
      'export interface HabitState { habits: Habit[]; }',
      'export const EMPTY_STATE: HabitState = { habits: [] };',
      ''
    ].join('\n');
  }
  if (path.endsWith('store.ts')) {
    return [
      'export class MemoryStore<T> {',
      '  private items = new Map<string, T>();',
      '  set(key: string, value: T): void { this.items.set(key, value); }',
      '  get(key: string): T | undefined { return this.items.get(key); }',
      '  all(): T[] { return [...this.items.values()]; }',
      '}',
      ''
    ].join('\n');
  }
  if (path.endsWith('.tsx')) {
    const name = ident(path);
    return `export default function ${name}(): string {\n  return '${name} rendered';\n}\n`;
  }
  if (path.endsWith('.ts')) {
    const name = ident(path);
    return `export function ${name}Main(): string {\n  return '${name} ready';\n}\nexport const ${name}Version = 1;\n`;
  }
  return `// ${path}\nexport const ready = true;\n`;
}

// ---------------------------------------------------------------------------
// Injected fault contents (each is the clean content plus one defect)
// ---------------------------------------------------------------------------
const STORE_PATH = 'server/db/store.ts';
const APP_SERVICE_PATH = 'server/services/appService.ts';
const CLIENT_PATH = 'src/api/client.ts';
const USE_API_PATH = 'src/hooks/useApi.ts';
const TEST_PATH = 'tests/connected_application.test.ts';

function syntaxBrokenStore(): string {
  const clean = contentFor(STORE_PATH);
  return clean.slice(0, clean.lastIndexOf('}')) + '\n'; // class body never closed
}
function typeErrorStore(): string {
  return contentFor(STORE_PATH) + "export const storeVersion: number = 'one';\n";
}
function crashingStore(): string {
  return "throw new Error('store module exploded at import time');\n" + contentFor(STORE_PATH);
}
function secretService(): string {
  return contentFor(APP_SERVICE_PATH) + "export const LEAKED_KEY = 'sk-1234567890abcdefghijklmnopqrstuv';\n";
}
function evalClient(): string {
  return contentFor(CLIENT_PATH) + 'export function runDynamic(code: string): unknown {\n  return eval(code);\n}\n';
}
function brokenImportUseApi(): string {
  return "import { missingHelper } from './nonexistent';\n" + contentFor(USE_API_PATH) + 'export const helperResult = missingHelper;\n';
}
function failingTestContent(): string {
  return cleanTestContent().replace('assert.equal(2 * 3, 6);', 'assert.equal(2 * 3, 7);');
}

// ---------------------------------------------------------------------------
// Build / user fixtures (F2 pattern)
// ---------------------------------------------------------------------------
let counter = 0;

function makeBuild(prefix: string): { buildId: string; userId: string } {
  const userId = `usr_f4_${prefix}_${Date.now()}_${++counter}`;
  db.createUser({
    id: userId,
    email: `${userId}@f4.test`,
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: Date.now()
  } as any);

  const buildId = `bld_f4_${prefix}_${Date.now()}_${++counter}`;
  db.saveBuild({
    id: buildId,
    userId,
    idea: 'Build a habit tracker application with streaks and reminders',
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: ['gemini', 'claude', 'deepseek'],
    autoPushGithub: false,
    totalTokens: 0,
    totalCost: 0,
    costLimit: 25,
    maxDurationSeconds: 600,
    patchesAppliedCount: 0
  } as any);
  return { buildId, userId };
}

function startApprovalPump(buildId: string, userId: string): () => void {
  const timer = setInterval(async () => {
    try {
      for (const req of db.getApprovalRequests(buildId, 'pending')) {
        const decided = ApprovalGateService.respondToApproval(buildId, userId, { requestId: req.id, approved: true });
        if (decided.success && decided.request) {
          await SwarmOrchestrator.resolveHeldTask(decided.request);
        }
      }
    } catch {
      // The pump must never take the test down with it.
    }
  }, 150);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Scripted stub transport with a per-scenario fault/worker script
// ---------------------------------------------------------------------------
interface Scenario {
  /** Content override for files a planned (non-fix) task creates. */
  faulty?: (path: string) => string | undefined;
  /** Paths a fix task repairs (defaults to the fix task's own filePaths). */
  repairPaths?: (task: any) => string[];
  /** Short-circuit a worker call entirely (malformed output, bait). */
  onWorkerCall?: (params: any) => Promise<any> | any;
}

function okResult(modelId: string, parsedResponse: any, rawText = ''): any {
  return {
    success: true,
    rawText,
    parsedResponse,
    tokensUsed: 10,
    modelId,
    actualModelUsed: modelId,
    providerUsed: 'stub-transport',
    isFallback: false,
    latencyMs: 1
  };
}

function malformedResult(modelId: string): any {
  // What the gateway hands the orchestrator when a model returns prose
  // instead of the required JSON action document: success-shaped
  // transport, no parsed response.
  return {
    success: true,
    rawText: 'Here is the file you asked for:\n```ts\nexport const x = 1;\n```\nHope this helps!',
    parsedResponse: null,
    tokensUsed: 0,
    modelId,
    actualModelUsed: modelId,
    providerUsed: 'stub-transport',
    isFallback: false,
    latencyMs: 1
  };
}

function workerActions(buildId: string, task: any, scenario: Scenario): any[] {
  if (task?.isFixTask) {
    // A competent repair worker: rewrite each target file with correct
    // content (patch when it exists, create when the defect is that it
    // does not).
    const paths = scenario.repairPaths ? scenario.repairPaths(task) : (task.filePaths || []);
    return paths.map((p: string) => {
      const existing = db.getFile(buildId, p);
      if (existing) {
        return { action: 'patch_file', path: p, edits: [{ find: existing.content, replace: contentFor(p) }], commitMessage: `Repair ${p}` };
      }
      return { action: 'create_file', path: p, content: contentFor(p), commitMessage: `Create missing ${p}` };
    });
  }
  return (task?.filePaths || []).map((p: string) => {
    const fault = scenario.faulty ? scenario.faulty(p) : undefined;
    return { action: 'create_file', path: p, content: fault !== undefined ? fault : contentFor(p), commitMessage: `Implement ${task?.title}` };
  });
}

function installStub(t: any, scenario: Scenario): void {
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';

    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      return okResult(modelId, { thinking: 'plan', actions: [] });
    }
    if (prompt.includes('VERIFY SOFTWARE COMPLETION')) {
      // The lenient verifier: approves everything, unconditionally.
      // Deterministic gates — not this model — must stop bad builds.
      return okResult(modelId, null, JSON.stringify({
        approved: true,
        summary: 'All requirements verified against specification',
        missingRequirements: []
      }));
    }

    if (scenario.onWorkerCall) {
      const custom = await scenario.onWorkerCall(params);
      if (custom !== undefined) return custom;
    }
    return okResult(modelId, { thinking: 'work', actions: workerActions(params.buildId, params.task, scenario) });
  });
}

async function runBuild(t: any, prefix: string, scenario: Scenario): Promise<{ buildId: string; userId: string }> {
  const { buildId, userId } = makeBuild(prefix);
  installStub(t, scenario);
  const stopPump = startApprovalPump(buildId, userId);
  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }
  return { buildId, userId };
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------
function sandboxTrail(buildId: string): { firstFailure: number; lastPass: number } {
  const events = db.getEvents(buildId);
  let firstFailure = -1;
  let lastPass = -1;
  events.forEach((e, i) => {
    if (e.type !== 'sandbox_check') return;
    if (/detected \d+ issue|Integrity check failed/.test(e.details) && firstFailure === -1) firstFailure = i;
    if (/passed cleanly/.test(e.details)) lastPass = i;
  });
  return { firstFailure, lastPass };
}

function assertRepairedAndCompleted(buildId: string, faultyPath: string): any {
  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const events = db.getEvents(buildId);

  assert.equal(build?.status, 'completed', `build must complete after genuine repair, got ${build?.status}: ${build?.failureReason || build?.error || ''}`);
  assert.ok(events.some(e => e.type === 'build_completed'), 'build_completed event must be recorded');
  assert.ok(events.some(e => e.type === 'verifier_approved'), 'completion must pass through the verifier gate');

  // Detection happened (a failed sandbox check) before the final pass.
  const { firstFailure, lastPass } = sandboxTrail(buildId);
  assert.ok(firstFailure >= 0, 'a failed sandbox_check event must record the detection');
  assert.ok(lastPass > firstFailure, 'a later sandbox check must pass cleanly on the repaired tree');

  // A targeted fix task for the defective file did the repair and completed.
  const fixTasks = tasks.filter(task => task.isFixTask && (task.filePaths || []).includes(faultyPath));
  assert.ok(fixTasks.length >= 1, `a fix task must target ${faultyPath}; tasks: ${tasks.map(x => `${x.title} ${JSON.stringify(x.filePaths)}`).join(' | ')}`);
  assert.ok(fixTasks.every(task => task.status === 'completed'), 'the repair task(s) must complete');

  // The defect is genuinely gone from the final tree.
  const file = db.getFile(buildId, faultyPath);
  assert.ok(file, `${faultyPath} must exist in the final tree`);
  assert.equal(file!.content, contentFor(faultyPath), `${faultyPath} must hold the repaired (clean) content`);
  return build;
}

// ---------------------------------------------------------------------------
// Gauntlet 1: syntax-broken file — detected, repaired, re-verified
// ---------------------------------------------------------------------------
test('F4 gauntlet: syntax-broken file is repaired and the build completes', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'syntax', {
    faulty: (p) => (p === STORE_PATH ? syntaxBrokenStore() : undefined)
  });
  assertRepairedAndCompleted(buildId, STORE_PATH);
});

// ---------------------------------------------------------------------------
// Gauntlet 2: TypeScript type error — the F4 defect. Before the fix, the
// sandbox never consumed the adapter's type report, tests were deferred
// (failed === 0), and this exact build was marked COMPLETED with a
// TS2322 in the tree (probe-verified). Now the type error fails the
// sandbox, spawns a targeted fix task, and completion requires the
// repaired tree to typecheck.
// ---------------------------------------------------------------------------
test('F4 gauntlet: TypeScript type error blocks completion until repaired', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'typeerr', {
    faulty: (p) => (p === STORE_PATH ? typeErrorStore() : undefined)
  });
  const build = assertRepairedAndCompleted(buildId, STORE_PATH);

  const fixTask = db.getTasks(buildId).find(task => task.isFixTask && (task.filePaths || []).includes(STORE_PATH));
  assert.match(fixTask!.description, /TS2322/, 'the fix task must name the compiler diagnostic that caused it');
  assert.ok(build, 'build record returned');
});

// ---------------------------------------------------------------------------
// Gauntlet 3: hardcoded secret — security audit repair loop
// ---------------------------------------------------------------------------
test('F4 gauntlet: hardcoded secret is removed by the repair loop', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'secret', {
    faulty: (p) => (p === APP_SERVICE_PATH ? secretService() : undefined)
  });
  const build = assertRepairedAndCompleted(buildId, APP_SERVICE_PATH);

  for (const f of db.getAllFiles(buildId)) {
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(f.content), `no secret may remain in ${f.path}`);
  }
  assert.equal(build?.securityAudit?.passed, true, 'the final recorded security audit must pass');
});

// ---------------------------------------------------------------------------
// Gauntlet 4: dangerous eval() — security audit repair loop
// ---------------------------------------------------------------------------
test('F4 gauntlet: dangerous eval() is removed by the repair loop', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'eval', {
    faulty: (p) => (p === CLIENT_PATH ? evalClient() : undefined)
  });
  assertRepairedAndCompleted(buildId, CLIENT_PATH);

  for (const f of db.getAllFiles(buildId)) {
    assert.ok(!/\beval\s*\(/.test(f.content), `no eval() may remain in ${f.path}`);
  }
});

// ---------------------------------------------------------------------------
// Gauntlet 5: failing generated test — the attribution defect. Before the
// fix, the repair task targeted the hardcoded 'tests/engine.test.ts',
// which does not exist in this project, so the failing test could never
// be repaired. Now the task targets the real test file.
// ---------------------------------------------------------------------------
test('F4 gauntlet: failing test is repaired in the file that actually failed', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'failingtest', {
    faulty: (p) => (p === TEST_PATH ? failingTestContent() : undefined)
  });
  assertRepairedAndCompleted(buildId, TEST_PATH);

  const phantom = db.getTasks(buildId).filter(task => task.isFixTask && (task.filePaths || []).includes('tests/engine.test.ts'));
  assert.equal(phantom.length, 0, 'no repair task may target the phantom tests/engine.test.ts in this project');
});

// ---------------------------------------------------------------------------
// Gauntlet 6: runtime crash — a module that throws at import time fails
// its test suite at execution; the repair worker fixes the root-cause
// module and the re-run is green.
// ---------------------------------------------------------------------------
test('F4 gauntlet: runtime crash at import is repaired at the root cause', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'crash', {
    faulty: (p) => (p === STORE_PATH ? crashingStore() : undefined),
    // The sandbox attributes the failure to the test file (that is what
    // the runner reports); a competent repair worker fixes the module
    // whose import crashed the suite.
    repairPaths: () => [STORE_PATH]
  });

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  assert.equal(build?.status, 'completed', `build must complete after the crash is repaired, got ${build?.status}: ${build?.failureReason || build?.error || ''}`);

  const { firstFailure, lastPass } = sandboxTrail(buildId);
  assert.ok(firstFailure >= 0, 'the crash must be detected by a failed sandbox check (test execution)');
  assert.ok(lastPass > firstFailure, 'the repaired tree must pass a later sandbox check');

  const fixTasks = tasks.filter(task => task.isFixTask);
  assert.ok(fixTasks.length >= 1, 'a fix task must be spawned for the crashed suite');
  assert.ok(fixTasks.every(task => task.status === 'completed'), 'the repair task(s) must complete');

  const store = db.getFile(buildId, STORE_PATH);
  assert.equal(store?.content, contentFor(STORE_PATH), 'the crashing module must hold repaired content');
  const testFile = db.getFile(buildId, TEST_PATH);
  assert.equal(testFile?.content, cleanTestContent(), 'the test file itself was never the defect and stays intact');
});

// ---------------------------------------------------------------------------
// Gauntlet 7: broken import graph — import of a file that does not exist.
// The gate must not complete the build while the import dangles; the
// repair (either gate may drive it) leaves a resolvable tree.
// ---------------------------------------------------------------------------
test('F4 gauntlet: broken import graph is repaired before completion', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'brokenimport', {
    faulty: (p) => (p === USE_API_PATH ? brokenImportUseApi() : undefined)
  });

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  assert.equal(build?.status, 'completed', `build must complete after the import graph is repaired, got ${build?.status}: ${build?.failureReason || build?.error || ''}`);

  const { firstFailure } = sandboxTrail(buildId);
  const integrationEvent = db.getEvents(buildId).some(e => e.type === 'patch_rejected' && /Integration Specialist/.test(e.details));
  assert.ok(firstFailure >= 0 || integrationEvent, 'the dangling import must be detected by the sandbox gate or the integration gate');

  const fixTasks = tasks.filter(task => task.isFixTask && (task.filePaths || []).includes(USE_API_PATH));
  assert.ok(fixTasks.length >= 1, 'a fix task must target the importing file');
  assert.ok(fixTasks.every(task => task.status === 'completed'), 'the repair task(s) must complete');

  // No dangling import remains, verified by the platform's own contract
  // analyzer over the final tree (not by string matching).
  const report = IntegrationAgent.analyzeProjectContracts(buildId);
  assert.equal(report.passed, true, `final tree must pass contract analysis: ${JSON.stringify(report.issues.filter(i => i.severity === 'error'))}`);
});

// ---------------------------------------------------------------------------
// Gauntlet 8: IntegrationAgent itself — detects a missing imported file
// as an error and spawns a bounded repair task naming both files.
// ---------------------------------------------------------------------------
test('F4 gauntlet: IntegrationAgent detects a missing imported file and spawns a bounded fix task', { timeout: 120_000 }, async (t) => {
  const { buildId } = makeBuild('integration');
  db.setFile(buildId, { path: 'package.json', content: contentFor('package.json'), version: 1, history: [] } as any);
  db.setFile(buildId, { path: USE_API_PATH, content: brokenImportUseApi(), version: 1, history: [] } as any);
  db.setFile(buildId, { path: STORE_PATH, content: contentFor(STORE_PATH), version: 1, history: [] } as any);

  const report = IntegrationAgent.analyzeProjectContracts(buildId);
  assert.equal(report.passed, false, 'a missing imported file must fail contract analysis');
  const issue = report.issues.find(i => i.type === 'missing_imported_file');
  assert.ok(issue, `a missing_imported_file issue must be reported: ${JSON.stringify(report.issues)}`);
  assert.equal(issue!.sourceFile, USE_API_PATH);
  assert.match(issue!.message, /nonexistent/, 'the issue must name the missing target');

  const fixTasks = db.getTasks(buildId).filter(task => task.isFixTask && task.title.startsWith('[Integration Fix]'));
  assert.equal(fixTasks.length, 1, 'exactly one bounded integration fix task must be spawned');
  assert.ok((fixTasks[0].filePaths || []).includes(USE_API_PATH), 'the fix task must include the importing file');
  assert.ok((fixTasks[0].filePaths || []).some(p => p.endsWith('nonexistent')), 'the fix task must include the missing target (the resolved extensionless path the analyzer reports)');

  // Boundedness: re-analysis must not spawn a duplicate while one is active.
  IntegrationAgent.analyzeProjectContracts(buildId);
  const after = db.getTasks(buildId).filter(task => task.isFixTask && task.title.startsWith('[Integration Fix]'));
  assert.equal(after.length, 1, 're-analysis must not duplicate the active integration fix task');
  assert.ok(t, 'test context');
});

// ---------------------------------------------------------------------------
// Gauntlet 9: malformed worker output — the worker never produces a
// parseable action document. Attempts are bounded (3 in-task attempts x
// 3 claims = 9 calls, per TaskManager retry policy) and exhaustion ends
// in an honest build failure naming the task. Zero false completions.
// ---------------------------------------------------------------------------
test('F4 gauntlet: malformed worker output exhausts bounded retries and fails honestly', { timeout: 300_000 }, async (t) => {
  let malformedCalls = 0;
  const { buildId } = await runBuild(t, 'malformed', {
    onWorkerCall: (params: any) => {
      const task = params.task;
      if (task && !task.isFixTask && (task.filePaths || []).includes(TEST_PATH)) {
        malformedCalls++;
        return malformedResult(params.requestedModelId || 'unknown');
      }
      return undefined;
    }
  });

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const events = db.getEvents(buildId);
  const victim = tasks.find(task => (task.filePaths || []).includes(TEST_PATH));

  assert.equal(malformedCalls, 9, `the failing task must be attempted exactly 3x3 times before exhaustion, saw ${malformedCalls}`);
  assert.equal(victim?.status, 'failed', 'the task whose worker never produced valid output must fail');
  assert.match(victim?.error || '', /Exhausted retries \(3\/3\)/, 'the task must record retry exhaustion');
  assert.equal(build?.status, 'failed', `the build must fail honestly, got ${build?.status}`);
  assert.match(build?.failureReason || '', /task\(s\) failed during execution/, 'the failure reason must name the failed-task gate');
  assert.match(build?.failureReason || '', /Test Suite/, 'the failure reason must name the failed task');
  assert.ok(!events.some(e => e.type === 'build_completed'), 'a build with an unrepaired defect must never record completion');
});

// ---------------------------------------------------------------------------
// Gauntlet 10: verifier-bait — the worker's actions APPLY successfully
// (a decoy file is created, patches land, the lenient verifier model
// approves the tree) but the task's required file is never created.
// Task-level completion verification must refuse the task, and the
// build must fail with the missing file named — not complete.
// ---------------------------------------------------------------------------
test('F4 gauntlet: verifier-bait (required file omitted, decoy applied) fails honestly', { timeout: 300_000 }, async (t) => {
  const { buildId } = await runBuild(t, 'bait', {
    onWorkerCall: (params: any) => {
      const task = params.task;
      if (task && !task.isFixTask && (task.filePaths || []).includes(TEST_PATH)) {
        return okResult(params.requestedModelId || 'unknown', {
          thinking: 'work',
          actions: [{ action: 'create_file', path: 'src/decoy.ts', content: contentFor('src/decoy.ts'), commitMessage: 'Implement test suite (bait)' }]
        });
      }
      return undefined;
    }
  });

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const events = db.getEvents(buildId);
  const victim = tasks.find(task => (task.filePaths || []).includes(TEST_PATH));

  assert.ok(db.getFile(buildId, 'src/decoy.ts'), 'the bait action must have applied (the trap is that everything LOOKS applied)');
  assert.equal(db.getFile(buildId, TEST_PATH), undefined, 'the required file was never created');
  assert.equal(victim?.status, 'failed', 'task completion verification must refuse a task whose target file is missing');
  assert.match(victim?.error || '', /tests\/connected_application\.test\.ts.*not found/, 'the refusal must name the missing file');
  assert.equal(build?.status, 'failed', `the build must fail honestly, got ${build?.status}`);
  assert.ok(!events.some(e => e.type === 'build_completed'), 'the baited build must never record completion');
  assert.ok(!events.some(e => e.type === 'verifier_approved'), 'the baited build must never reach verifier approval');
});

// ---------------------------------------------------------------------------
// Gauntlet 11: unrepairable defect — the defect is real (syntax-broken
// store) and the repair worker never produces a valid fix. The repair
// loop is bounded by the same retry policy; exhaustion fails the build
// with the fix task named, and the defective file is left visibly
// defective in a failed build — never laundered into a completion.
// ---------------------------------------------------------------------------
test('F4 gauntlet: unrepairable defect exhausts the repair loop and fails honestly', { timeout: 300_000 }, async (t) => {
  let fixCalls = 0;
  const { buildId } = await runBuild(t, 'unrepairable', {
    faulty: (p) => (p === STORE_PATH ? syntaxBrokenStore() : undefined),
    onWorkerCall: (params: any) => {
      if (params.task?.isFixTask) {
        fixCalls++;
        return malformedResult(params.requestedModelId || 'unknown');
      }
      return undefined;
    }
  });

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const events = db.getEvents(buildId);
  const fixTasks = tasks.filter(task => task.isFixTask && (task.filePaths || []).includes(STORE_PATH));

  assert.ok(fixTasks.length >= 1, 'the sandbox must spawn a repair task for the defect');
  assert.ok(fixTasks.every(task => task.status === 'failed'), 'every repair task must end failed when no valid fix is ever produced');
  assert.ok(fixTasks.some(task => /Exhausted retries/.test(task.error || '')), 'repair exhaustion must be recorded on the task');
  assert.ok(fixCalls >= 9, `repair attempts must be bounded by the retry policy (saw ${fixCalls} calls)`);
  assert.equal(build?.status, 'failed', `the build must fail honestly, got ${build?.status}`);
  assert.match(build?.failureReason || '', /Fix Error in server\/db\/store\.ts/, 'the failure reason must name the failed repair task');
  assert.ok(!events.some(e => e.type === 'build_completed'), 'an unrepaired defect must never record completion');

  const store = db.getFile(buildId, STORE_PATH);
  assert.equal(store?.content, syntaxBrokenStore(), 'the defective file remains visibly defective in the failed build');
});
