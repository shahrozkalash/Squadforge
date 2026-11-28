/**
 * Factory Phase F2 — Delegation and parallel execution gauntlet.
 *
 * These tests drive the REAL SwarmOrchestrator end-to-end (startSwarm →
 * planner → dependency-ordered task board → parallel per-model worker
 * loops → approval gate → merge → completion verification) over a stub
 * transport: `smartRouter.executeSmartRequest` is replaced per test,
 * the same seam the Phase 9 suites use (the gateway delegates to the
 * router, so planner, worker and verifier calls all pass through it).
 *
 * The stub is a transport fixture. It proves delegation, dependency
 * ordering, parallelism, cancellation and failure-recovery MECHANICS
 * of the orchestration chain. It is NOT a model: no claim about live
 * generation quality is made from it (live proof is Factory Phase F1,
 * closed as a documented negative — no provider keys exist here).
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { ExecutionAdapter } from '../server/swarm/executionAdapter.js';

// ---------------------------------------------------------------------------
// Deterministic fixture content: the stub "model" writes exactly this, so
// the final tree can be hash-compared against the expected merge.
// ---------------------------------------------------------------------------
function ident(path: string): string {
  let name = path.split('/').pop()!.replace(/\.(ts|tsx|js|jsx)$/, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!name || /^[0-9]/.test(name)) name = `mod${name}`;
  return name;
}

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
      '',
      "test('engine multiplies numbers', () => {",
      '  assert.equal(2 * 3, 6);',
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
  if (path.endsWith('security.ts')) {
    return [
      'export function sanitizeInput(value: string): string {',
      "  return value.replace(/[<>&\"']/g, '');",
      '}',
      'export function isNonEmpty(value: string): boolean {',
      '  return value.trim().length > 0;',
      '}',
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
// Build / user fixtures
// ---------------------------------------------------------------------------
let counter = 0;

function makeBuild(prefix: string): { buildId: string; userId: string } {
  const userId = `usr_f2_${prefix}_${Date.now()}_${++counter}`;
  db.createUser({
    id: userId,
    email: `${userId}@f2.test`,
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: Date.now()
  } as any);

  const buildId = `bld_f2_${prefix}_${Date.now()}_${++counter}`;
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

/** Approves held (sensitive-file) tasks as the owner would, until stopped. */
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

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// Scripted stub transport
// ---------------------------------------------------------------------------
interface StubTracker {
  workerCalls: Array<{ modelId: string; taskId: string; taskTitle: string }>;
  inFlight: number;
  maxInFlight: number;
  barrierMetByConcurrency: boolean;
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

function workerActions(buildId: string, task: any): any[] {
  return (task?.filePaths || []).map((p: string) => {
    if (task?.isFixTask) {
      const existing = db.getFile(buildId, p);
      if (existing) {
        return { action: 'patch_file', path: p, edits: [{ find: existing.content, replace: contentFor(p) }], commitMessage: `Repair ${p}` };
      }
    }
    return { action: 'create_file', path: p, content: contentFor(p), commitMessage: `Implement ${task?.title}` };
  });
}

/**
 * Installs the stub router. `onWorkerCall` may return a result to
 * short-circuit the default worker behaviour (used by the failure and
 * cancellation tests), or undefined to fall through to it.
 */
function installStub(
  t: any,
  tracker: StubTracker,
  onWorkerCall?: (params: any, tracker: StubTracker) => Promise<any> | any
): void {
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';

    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      // Planner: no file/task actions of its own — the orchestrator's
      // deterministic dependency-aware seeding builds the task graph.
      return okResult(modelId, { thinking: 'plan', actions: [] });
    }
    if (prompt.includes('VERIFY SOFTWARE COMPLETION')) {
      return okResult(modelId, null, JSON.stringify({
        approved: true,
        summary: 'All requirements verified against specification',
        missingRequirements: []
      }));
    }

    const task = params.task;
    tracker.workerCalls.push({ modelId, taskId: task?.id, taskTitle: task?.title });
    tracker.inFlight++;
    tracker.maxInFlight = Math.max(tracker.maxInFlight, tracker.inFlight);
    try {
      if (onWorkerCall) {
        const custom = await onWorkerCall(params, tracker);
        if (custom !== undefined) return custom;
      }
      return okResult(modelId, { thinking: 'work', actions: workerActions(params.buildId, task) });
    } finally {
      tracker.inFlight--;
    }
  });
}

function newTracker(): StubTracker {
  return { workerCalls: [], inFlight: 0, maxInFlight: 0, barrierMetByConcurrency: false };
}

function treeHash(entries: Array<[string, string]>): string {
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// ---------------------------------------------------------------------------
// Gauntlet 1: the whole chain — ordering, parallelism, merge, verification
// ---------------------------------------------------------------------------
test('F2 gauntlet: dependency-ordered parallel build completes through the full verification chain', { timeout: 300_000 }, async (t) => {
  const { buildId, userId } = makeBuild('gauntlet');
  const tracker = newTracker();

  // Rendezvous barrier: the first worker call waits until a second worker
  // call is concurrently in flight. A serial executor can never satisfy
  // it — the first call would sit out the full timeout alone — so a met
  // barrier is deterministic proof of parallel execution, not a timing
  // coincidence.
  let arrivals = 0;
  let releaseBarrier: () => void = () => {};
  const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
  installStub(t, tracker, async () => {
    if (arrivals < 2) {
      arrivals++;
      if (arrivals === 2) {
        tracker.barrierMetByConcurrency = true;
        releaseBarrier();
      } else {
        let timer: NodeJS.Timeout;
        await Promise.race([
          barrier,
          new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })
        ]).finally(() => clearTimeout(timer));
      }
    }
    return undefined;
  });

  const stopPump = startApprovalPump(buildId, userId);
  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const planned = tasks.filter(task => !task.isFixTask);
  const events = db.getEvents(buildId);

  // (e) The chain's own verification stage approved the merged output.
  assert.equal(build?.status, 'completed', `build must complete, got ${build?.status}: ${build?.error || build?.failureReason || ''}`);
  assert.ok(events.some(e => e.type === 'verifier_approved'), 'verifier must approve before completion');
  assert.ok(events.some(e => e.type === 'build_completed'), 'build_completed event must be recorded');
  assert.ok(db.getCheckpoints(buildId).length >= 1, 'a passed sandbox check must save a checkpoint');
  for (const e of events.filter(e => e.type === 'sandbox_check')) {
    assert.match(e.details, /passed cleanly/, 'every sandbox integrity check in the run must pass');
  }
  assert.equal(tasks.filter(task => task.isFixTask).length, 0, 'no sandbox fix tasks should be needed for a clean fixture tree');
  assert.equal(planned.filter(task => task.status === 'failed').length, 0, 'no planned task may fail');
  assert.ok(planned.length >= 6, `expected a multi-task project, got ${planned.length} tasks`);
  for (const task of planned) {
    assert.equal(task.status, 'completed', `task "${task.title}" must complete`);
  }

  // (a) Dependency ordering, asserted from the task log (db events are
  // append-ordered): a task's first genuine claim never precedes the
  // completion of any of its dependencies. Note: the 'task_claimed'
  // event type is overloaded in TaskManager — createNewTask and
  // resumeTask also emit it (with no modelId) when a task is added to or
  // returned to the board. A genuine worker claim is the one carrying a
  // modelId ("… atomically claimed task …"), and that is what ordering
  // is asserted on.
  const firstIndex = (type: string, taskId: string) => events.findIndex(
    e => e.type === type && e.taskId === taskId && (type !== 'task_claimed' || !!e.modelId)
  );
  let dependencyEdges = 0;
  for (const task of planned) {
    for (const depId of task.dependencies || []) {
      dependencyEdges++;
      const claimIdx = firstIndex('task_claimed', task.id);
      const depDoneIdx = firstIndex('task_completed', depId);
      assert.ok(depDoneIdx >= 0, `dependency ${depId} of "${task.title}" must have a completion event`);
      assert.ok(claimIdx > depDoneIdx, `"${task.title}" was claimed (event ${claimIdx}) before its dependency completed (event ${depDoneIdx})`);
    }
  }
  assert.ok(dependencyEdges >= 5, `expected a real dependency graph, got ${dependencyEdges} edges`);

  // (b) Parallelism: the rendezvous barrier was met by a second in-flight
  // call, and the work was distributed over at least two model workers.
  assert.equal(tracker.barrierMetByConcurrency, true, 'first two worker calls must overlap (rendezvous barrier)');
  assert.ok(tracker.maxInFlight >= 2, `at least two model calls must be in flight at once, saw ${tracker.maxInFlight}`);
  const completers = new Set(events.filter(e => e.type === 'task_completed').map(e => e.modelId));
  assert.ok(completers.size >= 2, `tasks must be completed by ≥2 distinct models, got ${[...completers].join(', ')}`);

  // Merge integrity: the final tree hash-matches the expected merge of
  // every task's files — parallel writes never corrupted each other.
  const expected = new Map<string, string>();
  for (const task of planned) {
    for (const p of task.filePaths) expected.set(p, contentFor(p));
  }
  const actual = new Map<string, string>();
  for (const p of expected.keys()) {
    const file = db.getFile(buildId, p);
    assert.ok(file, `expected file ${p} to exist in the final tree`);
    actual.set(p, file!.content);
  }
  assert.equal(treeHash([...actual]), treeHash([...expected]), 'final tree must hash-match the expected merge');
});

// ---------------------------------------------------------------------------
// Gauntlet 2: cancellation stops in-flight model calls
// ---------------------------------------------------------------------------
test('F2 gauntlet: cancelling a build aborts in-flight model calls and ends stopped, not successful', { timeout: 180_000 }, async (t) => {
  const { buildId } = makeBuild('cancel');
  const tracker = newTracker();
  let abortObserved = false;

  installStub(t, tracker, async (params: any) => {
    const signal: AbortSignal | undefined = params.signal;
    // Block until the orchestrator aborts the call (owner Stop) — the
    // safety timeout only exists so a regression can never hang the suite.
    await new Promise<void>(resolve => {
      if (signal?.aborted) { abortObserved = true; resolve(); return; }
      const timer = setTimeout(resolve, 25_000);
      signal?.addEventListener('abort', () => { abortObserved = true; clearTimeout(timer); resolve(); }, { once: true });
    });
    return { success: false, error: 'Model call aborted by owner stop', rawText: '', parsedResponse: null, tokensUsed: 0, modelId: params.requestedModelId, actualModelUsed: 'none', providerUsed: 'stub-transport', isFallback: false, latencyMs: 1 };
  });

  const running = SwarmOrchestrator.startSwarm(buildId);
  await waitFor(() => tracker.workerCalls.length >= 1, 30_000, 'first worker call in flight');
  SwarmOrchestrator.stopSwarm(buildId);
  await running;

  const build = db.getBuild(buildId);
  const tasks = db.getTasks(buildId);
  const events = db.getEvents(buildId);

  assert.equal(build?.status, 'stopped', `cancelled build must end stopped, got ${build?.status}`);
  assert.equal(abortObserved, true, 'the in-flight stub transport must observe the abort signal');
  assert.ok(!events.some(e => e.type === 'build_completed'), 'a cancelled build must not record completion');
  assert.equal(tasks.filter(task => task.status === 'completed').length, 0, 'no task may complete once the build is cancelled');
  const stoppedIdx = events.findIndex(e => e.type === 'build_stopped');
  assert.ok(stoppedIdx >= 0, 'a build_stopped event must be recorded');
  assert.ok(!events.some((e, i) => e.type === 'task_completed' && i > stoppedIdx), 'no task may complete after the cancel point in the log');
});

// ---------------------------------------------------------------------------
// Gauntlet 3: worker transport failure is released, retried/reassigned,
// and the build still completes with the failure on record
// ---------------------------------------------------------------------------
test('F2 gauntlet: a worker whose transport fails is released and the build recovers', { timeout: 300_000 }, async (t) => {
  const { buildId, userId } = makeBuild('failure');
  const tracker = newTracker();
  const failure = { taskId: '', modelId: '', count: 0 };

  installStub(t, tracker, async (params: any) => {
    const task = params.task;
    if (!task) return undefined;
    if (!failure.taskId) {
      failure.taskId = task.id;
      failure.modelId = params.requestedModelId;
    }
    if (task.id === failure.taskId && failure.count < 3) {
      failure.count++;
      return {
        success: false,
        error: 'Injected transport failure (F2 gauntlet)',
        rawText: '', parsedResponse: null, tokensUsed: 0,
        modelId: params.requestedModelId, actualModelUsed: 'none',
        providerUsed: 'stub-transport', isFallback: false, latencyMs: 1
      };
    }
    return undefined;
  });

  const stopPump = startApprovalPump(buildId, userId);
  try {
    await SwarmOrchestrator.startSwarm(buildId);
  } finally {
    stopPump();
  }

  const build = db.getBuild(buildId);
  const events = db.getEvents(buildId);
  const failedTask = db.getTask(buildId, failure.taskId);

  assert.equal(build?.status, 'completed', `build must recover and complete, got ${build?.status}: ${build?.error || build?.failureReason || ''}`);
  assert.equal(failure.count, 3, 'the failing worker must exhaust its in-task attempts before release');

  // The failure is on record: a task_released event from the failing
  // model naming the injected error, and a retry count on the task.
  const release = events.find(e => e.type === 'task_released' && e.taskId === failure.taskId);
  assert.ok(release, 'the failed task must be released back to the board');
  assert.equal(release!.modelId, failure.modelId, 'the release must be attributed to the failing model');
  assert.match(release!.details, /Injected transport failure/, 'the release must record the failure');
  assert.ok((failedTask?.retryCount || 0) >= 1, 'the task must carry a retry count from the failure');
  assert.equal(failedTask?.status, 'completed', 'the released task must eventually complete');

  // Recovery path: retried by the same worker after release, or
  // reassigned to another model — either is the orchestrator's policy.
  // What the log must show either way: the release precedes the eventual
  // completion of the same task.
  const completion = events.find(e => e.type === 'task_completed' && e.taskId === failure.taskId);
  assert.ok(completion, 'the recovered task must have a completion event');
  assert.ok(
    events.indexOf(completion!) > events.indexOf(release!),
    'the task must complete only after its failure release'
  );
  assert.equal(db.getTasks(buildId).filter(task => task.status === 'failed').length, 0, 'no task may end failed');
});

// ---------------------------------------------------------------------------
// Regression: test-output parsing (defect found by this gauntlet).
// ExecutionAdapter.parseTestOutput only understood TAP output; on Node
// versions whose test runner emits the spec reporter (✔/✖ lines), a
// fully passing run produced no TAP lines and the no-evidence fallback
// marked every test failed because a passing summary prints 'fail 0'.
// SandboxRunner then spawned endless "Fix Error in tests/..." tasks and
// no build with tests could ever complete.
// ---------------------------------------------------------------------------
const passingTestContent = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  '',
  "test('engine adds numbers', () => {",
  '  assert.equal(1 + 1, 2);',
  '});',
  '',
  "test('engine multiplies numbers', () => {",
  '  assert.equal(2 * 3, 6);',
  '});',
  ''
].join('\n');

function makeAdapterFixture(prefix: string, files: Array<{ path: string; content: string }>): string {
  const buildId = `bld_f2_parse_${prefix}_${Date.now()}_${++counter}`;
  db.saveBuild({
    id: buildId, userId: 'usr_f2_parse', idea: 'parser fixture', status: 'running',
    createdAt: Date.now(), updatedAt: Date.now(), selectedModels: ['gemini'],
    autoPushGithub: false, totalTokens: 0, totalCost: 0, costLimit: 25,
    maxDurationSeconds: 600, patchesAppliedCount: 0
  } as any);
  for (const f of files) {
    db.setFile(buildId, { path: f.path, content: f.content, version: 1, history: [] } as any);
  }
  return buildId;
}

test('F2 regression: a fully passing generated test run is reported as passed', { timeout: 120_000 }, async () => {
  const buildId = makeAdapterFixture('passing', [
    { path: 'package.json', content: JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n' },
    { path: 'tests/engine.test.ts', content: passingTestContent },
    { path: 'tests/connected_application.test.ts', content: passingTestContent }
  ]);
  const report = ExecutionAdapter.runIsolatedTests(buildId, db.getAllFiles(buildId) as any);
  assert.equal(report.failed, 0, `no test may be reported failed on a green run: ${JSON.stringify(report.details)}`);
  assert.equal(report.passed, 4, 'all four fixture tests must be reported passed');
  assert.equal(report.status, 'passed');
});

test('F2 regression: a genuinely failing generated test is still reported as failed', { timeout: 120_000 }, async () => {
  const failingContent = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('engine adds numbers', () => {",
    '  assert.equal(1 + 1, 3);',
    '});',
    '',
    "test('engine multiplies numbers', () => {",
    '  assert.equal(2 * 3, 6);',
    '});',
    ''
  ].join('\n');
  const buildId = makeAdapterFixture('failing', [
    { path: 'package.json', content: JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n' },
    { path: 'tests/engine.test.ts', content: failingContent }
  ]);
  const report = ExecutionAdapter.runIsolatedTests(buildId, db.getAllFiles(buildId) as any);
  assert.equal(report.status, 'failed', 'a red run must stay red');
  assert.ok(report.failed >= 1, 'the failing test must be reported failed');
  assert.ok(report.passed >= 1, 'the passing test in the same file must still be reported passed');
});
