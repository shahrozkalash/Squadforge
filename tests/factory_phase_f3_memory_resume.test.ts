/**
 * Factory Phase F3 — Shared context & project memory hardening.
 *
 * Proves the restart-recovery path of the swarm's shared state:
 *
 *  1. KILL-AND-RESUME: a real build (stub transport, the Factory F2
 *     pattern) is hard-killed mid-run — after a checkpoint has been
 *     recorded by the platform's own SandboxRunner integrity check —
 *     the orchestrator's in-memory control is abandoned with NO
 *     persisted side effects (no build_stopped event, build row left
 *     'running', in-flight tasks left claimed under their leases,
 *     in-flight model calls never settle) — then the store's in-memory
 *     caches are discarded and reloaded purely from the persisted
 *     store, exactly as a fresh process start does. The build is
 *     resumed through the platform's own `resumeSwarm` path and must
 *     complete with: no completed task re-executed, no file duplicated
 *     or lost, in-flight tasks recovered through the lease mechanisms,
 *     project memory (facts / ADRs) intact exactly once, and a final
 *     tree identical to an uninterrupted control run of the same
 *     fixture. (Environment note: under the test runner the store's
 *     SQL layer is the harness's in-memory SQLite — see
 *     DatabaseManager's argv-based test detection — so "persisted
 *     store" here is that SQL store, reloaded through the real
 *     loadFromSqlite path after every cache is discarded.)
 *  2. CONFLICTS: contradictory facts/decisions from two workers are
 *     recorded in the build record, never silently stored or dropped.
 *  3. BUDGET: context assembly respects its char budget on a
 *     large-project fixture while retaining the pinned confirmed facts.
 *  4. PARALLEL WRITERS: concurrent memory writes from many workers
 *     lose nothing, duplicate nothing, and leave the persisted store
 *     valid.
 *  5. PRUNING: fact-list pruning (recordFact / recordRevision) never
 *     drops a confirmed fact.
 *
 * Stub-transport honesty: the stub proves recovery, memory and
 * context mechanics. It is NOT a model and proves nothing about live
 * generation quality (Factory Phase F1 closed as a documented
 * negative — no provider keys exist in this environment).
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
import { TaskManager } from '../server/swarm/taskManager.js';
import { ProjectMemoryService } from '../server/swarm/projectMemory.js';
import { SandboxRunner } from '../server/swarm/sandboxRunner.js';

// ---------------------------------------------------------------------------
// Deterministic fixture content (shared with the F2 gauntlet): the stub
// "model" writes exactly this, so final trees can be hash-compared.
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
  const userId = `usr_f3_${prefix}_${Date.now()}_${++counter}`;
  db.createUser({
    id: userId,
    email: `${userId}@f3.test`,
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: Date.now()
  } as any);

  const buildId = `bld_f3_${prefix}_${Date.now()}_${++counter}`;
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
    maxDurationSeconds: 900,
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
// Scripted stub transport (F2 seam). `gate.hangWhen(buildId)` is consulted
// at worker-call entry: once it holds, worker calls never settle — the
// in-process equivalent of a process dying mid-call.
// ---------------------------------------------------------------------------
interface StubTracker {
  workerCalls: Array<{ modelId: string; taskId: string; taskTitle: string; prompt: string }>;
  hungCalls: number;
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

function installStub(t: any, tracker: StubTracker, gate: { hangWhen?: (buildId: string) => boolean }): void {
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';

    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
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
    tracker.workerCalls.push({ modelId, taskId: task?.id, taskTitle: task?.title, prompt });
    if (gate.hangWhen && params.buildId && gate.hangWhen(params.buildId)) {
      tracker.hungCalls++;
      // Never settles, holds no timer: the calling worker loop is
      // suspended forever, exactly like a call in a dead process.
      return new Promise(() => {});
    }
    return okResult(modelId, { thinking: 'work', actions: workerActions(params.buildId, task) });
  });
}

function treeOf(buildId: string): Array<[string, { content: string; version: number }]> {
  return db.getAllFiles(buildId).map(f => [f.path, { content: f.content, version: f.version || 1 }] as [string, { content: string; version: number }])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function treeHash(entries: Array<[string, string]>): string {
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Discards every in-memory entity cache of the singleton store and
 * reloads purely from SQLite — the state a freshly started process
 * would see. (loadFromSqlite assumes empty caches, as at process
 * start; it also runs the startup expired-lease cleanup.)
 */
function simulateProcessRestart(): void {
  db.users.clear();
  db.usersByEmail.clear();
  db.sessions.clear();
  db.passwordResetTokens.clear();
  db.passwordResetCodes.clear();
  db.passwordResetAuths.clear();
  db.encryptedGithubTokens.clear();
  db.builds.clear();
  db.tasks.clear();
  db.files.clear();
  db.events.clear();
  db.modelRuns.clear();
  db.checkpoints.clear();
  db.usageLogs = [];
  db.projectMemories.clear();
  db.generationRuns.clear();
  db.initialize();
}

const FACT_MARKER = 'F3 PINNED FACT: streak reminders must fire in local device time';
const ADR_MARKER = 'F3 PINNED DECISION: persist streaks in the domain store module';

// ---------------------------------------------------------------------------
// Test 1: kill-and-resume
// ---------------------------------------------------------------------------
test('F3 kill-and-resume: a build hard-killed mid-run resumes from persisted state and completes identically', { timeout: 900_000 }, async (t) => {
  // ---- Control run: the same fixture, uninterrupted ----------------------
  const control = makeBuild('control');
  const controlTracker: StubTracker = { workerCalls: [], hungCalls: 0 };
  installStub(t, controlTracker, {});
  const stopControlPump = startApprovalPump(control.buildId, control.userId);
  try {
    await SwarmOrchestrator.startSwarm(control.buildId);
  } finally {
    stopControlPump();
  }
  const controlBuild = db.getBuild(control.buildId);
  assert.equal(controlBuild?.status, 'completed', `control build must complete, got ${controlBuild?.status}: ${controlBuild?.error || ''}`);
  const controlTree = treeOf(control.buildId);
  const controlTitles = db.getTasks(control.buildId).filter(x => !x.isFixTask).map(x => x.title).sort();
  assert.ok(controlTree.length >= 6, 'control build must produce a real file tree');
  t.mock.restoreAll();

  // ---- Killed build -------------------------------------------------------
  const { buildId, userId } = makeBuild('killed');

  // Pre-kill project memory, as the planner/architect would have written
  // it before the crash: one pinned confirmed fact and one accepted ADR.
  ProjectMemoryService.getOrInitializeMemory(buildId, userId);
  assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
    category: 'constraint', statement: FACT_MARKER, confidence: 'confirmed', source: 'user_prompt'
  }), true);
  assert.equal(ProjectMemoryService.recordDecision(buildId, userId, {
    id: 'ADR-F3-PIN', title: 'F3 pinned decision', status: 'accepted',
    context: 'F3 kill-and-resume fixture', decision: ADR_MARKER, timestamp: Date.now()
  } as any), true);

  const tracker: StubTracker = { workerCalls: [], hungCalls: 0 };
  const gate: { hangWhen?: (id: string) => boolean } = {
    hangWhen: (id: string) =>
      db.getCheckpoints(id).length >= 1 &&
      db.getTasks(id).filter(x => x.status === 'completed').length >= 2
  };
  // The hang gate is armed only after the mid-run checkpoint exists
  // (below); before that the stub serves every call normally.
  const armed = { value: false };
  const originalHangWhen = gate.hangWhen!;
  gate.hangWhen = (id: string) => armed.value && originalHangWhen(id);
  installStub(t, tracker, gate);
  const stopPump = startApprovalPump(buildId, userId);
  t.after(() => stopPump()); // never leak the pump interval, even on a failed assertion
  const running = SwarmOrchestrator.startSwarm(buildId);
  running.catch(() => {}); // never settles after the kill; guard only

  // Establish the mid-run checkpoint through the platform's own
  // integrity check — the same SandboxRunner call the orchestrator
  // makes at its completion gate (and at its patch-count cadence,
  // which a create-only stretch never triggers: patchesAppliedCount
  // counts patch operations only, so no automatic checkpoint arises
  // mid-build here). The check must pass on the fixture tree so far.
  await waitFor(
    () => db.getTasks(buildId).filter(x => x.status === 'completed').length >= 2,
    180_000,
    'two tasks completed before the mid-run checkpoint'
  );
  const midCheck = SandboxRunner.runIntegrityCheck(buildId);
  assert.equal(midCheck.passed, true, `the mid-run integrity check must pass: ${midCheck.summary}`);
  assert.ok(db.getCheckpoints(buildId).length >= 1, 'the mid-run integrity check must record a checkpoint');
  armed.value = true; // from here on, worker calls hang — the build is about to die mid-run

  // Wait for a frozen mid-run state: snapshots of the persisted build
  // state stop changing while at least one worker call is hung and at
  // least one task is in flight. Stability across ~2.4 s (longer than
  // any worker poll/sleep cycle) proves nothing is still writing.
  const snapshot = () => JSON.stringify({
    tasks: db.getTasks(buildId).map(x => [x.id, x.status, x.claimedBy, x.retryCount || 0]),
    files: db.getAllFiles(buildId).map(f => [f.path, f.version || 1]),
    events: db.getEvents(buildId).length,
    checkpoints: db.getCheckpoints(buildId).length
  });
  let lastSnapshot = '';
  let stablePolls = 0;
  const freezeDeadline = Date.now() + 300_000;
  while (true) {
    const snap = snapshot();
    const tasksNow = db.getTasks(buildId);
    const frozen =
      snap === lastSnapshot &&
      tracker.hungCalls >= 1 &&
      tasksNow.some(x => x.status === 'in_progress') &&
      tasksNow.filter(x => x.status === 'completed').length >= 2 &&
      db.getCheckpoints(buildId).length >= 1 &&
      db.getApprovalRequests(buildId, 'pending').length === 0 &&
      tasksNow.every(x => !x.isPaused);
    stablePolls = frozen ? stablePolls + 1 : 0;
    lastSnapshot = snap;
    if (stablePolls >= 6) break;
    if (Date.now() > freezeDeadline) {
      throw new Error(`Build never froze mid-run (hung=${tracker.hungCalls}, tasks=${JSON.stringify(tasksNow.map(x => x.status))}, checkpoints=${db.getCheckpoints(buildId).length})`);
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // ---- THE KILL: abandon the orchestrator's in-memory state only.
  // No stopSwarm (that would persist 'stopped' + an event — a graceful
  // stop, not a crash). Nothing below writes to the persisted record.
  const controlEntry = (SwarmOrchestrator as any).activeSwarms.get(buildId);
  assert.ok(controlEntry, 'the swarm must be active at the kill point');
  controlEntry.stopRequested = true; // lets non-suspended loops exit without touching task state
  (SwarmOrchestrator as any).activeSwarms.delete(buildId);
  stopPump();

  // Quiescence: let exiting loops drain (they write model-run status
  // only); the state snapshot must be unchanged afterwards.
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(snapshot(), lastSnapshot, 'persisted build state must not change after the kill');

  // ---- Kill-point state (the "before" picture) ----------------------------
  const preTasks = db.getTasks(buildId);
  const prePlanned = preTasks.filter(x => !x.isFixTask);
  const preCompletedIds = prePlanned.filter(x => x.status === 'completed').map(x => x.id);
  const preInFlight = prePlanned.filter(x => x.status === 'in_progress');
  const preTree = treeOf(buildId);
  const preMemory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  const preFactStatements = preMemory.facts.map(f => f.statement).sort();
  const preAdrIds = preMemory.architectureDecisions.map(d => d.id).sort();
  const preCheckpointCount = db.getCheckpoints(buildId).length;
  const preEvents = db.getEvents(buildId);

  assert.equal(db.getBuild(buildId)?.status, 'running', 'a crash leaves the build row running');
  assert.ok(!preEvents.some(e => e.type === 'build_stopped' || e.type === 'build_completed'), 'a crash writes no stop/completion event');
  assert.ok(preCompletedIds.length >= 2, 'at least two tasks completed before the kill');
  assert.ok(preInFlight.length >= 1, 'at least one task must be in flight at the kill');
  assert.ok(preCheckpointCount >= 1, 'the kill happens after at least one checkpoint');
  assert.equal(preFactStatements.filter(s => s === FACT_MARKER).length, 1, 'marker fact present once pre-kill');
  assert.ok(preAdrIds.includes('ADR-F3-PIN'), 'marker ADR present pre-kill');

  // One in-flight task's lease lapses during the downtime (the standard
  // crash case: the process is gone longer than the 90 s lease). Written
  // straight to the persisted row, as elapsed time would leave it.
  const lapsedTask = preInFlight[0];
  db.dbManager.db.prepare('UPDATE tasks SET lease_expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, lapsedTask.id);
  const stillLeased = preInFlight.slice(1);

  // ---- RESTART: discard all in-memory caches, reload from SQLite --------
  simulateProcessRestart();

  const postBuild = db.getBuild(buildId);
  assert.equal(postBuild?.status, 'running', 'build reloads as running (crash state), ready to resume');
  const postTasks = db.getTasks(buildId);
  assert.equal(postTasks.length, preTasks.length, 'no task lost or duplicated across the restart');
  for (const id of preCompletedIds) {
    assert.equal(postTasks.find(x => x.id === id)?.status, 'completed', `completed task ${id} must stay completed`);
  }
  const lapsedAfter = postTasks.find(x => x.id === lapsedTask.id);
  assert.equal(lapsedAfter?.status, 'pending', 'the lapsed-lease task is returned to the board by the startup cleanup');
  assert.equal(lapsedAfter?.claimedBy, null, 'the lapsed-lease task has no claimant after the restart');
  for (const task of stillLeased) {
    const reloaded = postTasks.find(x => x.id === task.id);
    assert.equal(reloaded?.status, 'in_progress', `task ${task.id} under a valid lease stays in flight`);
    assert.ok(reloaded?.claimedBy, 'a valid lease keeps its claimant across the restart');
    // The atomic claim gate itself refuses to hand a validly-leased task
    // to another worker.
    assert.equal(db.claimTaskAtomic(buildId, task.id, 'claude', Date.now() + 90_000), null,
      'a task under a valid lease must not be claimable by another worker');
  }
  // The lapsed task is claimable again through the same atomic gate.
  const reclaimed = db.claimTaskAtomic(buildId, lapsedTask.id, 'claude', Date.now() + 90_000);
  assert.ok(reclaimed, 'the lapsed-lease task must be claimable after the restart');
  TaskManager.retryTask(buildId, lapsedTask.id); // hand it back to the board for the resumed swarm

  // Files: nothing lost, nothing duplicated, versions untouched.
  assert.deepEqual(treeOf(buildId), preTree, 'the file tree must survive the restart byte- and version-identical');

  // Memory: facts and ADRs intact, exactly once each.
  const postMemory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  assert.deepEqual(postMemory.facts.map(f => f.statement).sort(), preFactStatements, 'facts must survive the restart exactly once');
  assert.deepEqual(postMemory.architectureDecisions.map(d => d.id).sort(), preAdrIds, 'ADRs must survive the restart exactly once');
  assert.equal(db.getCheckpoints(buildId).length, preCheckpointCount, 'checkpoints survive the restart');

  // The context a resumed worker will receive (the exact API and budget
  // executeTaskWork uses) contains the pre-kill fact and decision,
  // asserted on content.
  const contextTask: any = {
    id: lapsedTask.id, buildId, title: lapsedTask.title, description: lapsedTask.description,
    filePaths: lapsedTask.filePaths, priority: lapsedTask.priority, status: 'pending',
    claimedBy: null, leaseExpiresAt: null, createdAt: lapsedTask.createdAt
  };
  const resumedContext = ProjectMemoryService.retrieveTaskContext(buildId, userId, contextTask, 1600);
  assert.ok(resumedContext.includes(FACT_MARKER), 'resumed context must contain the pre-kill pinned fact');
  assert.ok(resumedContext.includes(ADR_MARKER), 'resumed context must contain the pre-kill pinned decision');

  // The remaining in-flight leases now lapse too (downtime passing),
  // through the store's own persisted update path.
  for (const task of stillLeased) {
    db.updateTask(buildId, task.id, { leaseExpiresAt: Date.now() - 1000 });
  }

  // ---- RESUME through the platform's own resume path ----------------------
  // The hang gate was the kill mechanism of the dead process; the new
  // process serves model calls normally again.
  armed.value = false;
  const resumeCallIndex = tracker.workerCalls.length;
  const stopPump2 = startApprovalPump(buildId, userId);
  try {
    assert.equal(await SwarmOrchestrator.resumeSwarm(buildId), true, 'resumeSwarm must accept the crashed build');
    await waitFor(() => db.getBuild(buildId)?.status === 'completed', 300_000, 'resumed build completion');
    await waitFor(() => !(SwarmOrchestrator as any).activeSwarms.has(buildId), 60_000, 'resumed swarm drain');
  } finally {
    stopPump2();
    // Test hygiene only (assertions are done with this build either
    // way): never leave worker loops running past the test.
    const leftover = db.getBuild(buildId);
    if (leftover && leftover.status !== 'completed') SwarmOrchestrator.stopSwarm(buildId);
  }

  // ---- Final assertions -----------------------------------------------------
  const finalTasks = db.getTasks(buildId);
  const finalPlanned = finalTasks.filter(x => !x.isFixTask);
  const finalEvents = db.getEvents(buildId);
  assert.ok(finalEvents.some(e => e.type === 'verifier_approved'), 'the resumed build passes the chain verification gate');
  assert.ok(finalEvents.some(e => e.type === 'build_completed'), 'the resumed build records completion');
  assert.deepEqual(finalPlanned.map(x => x.title).sort(), controlTitles, 'the resumed build has the same task graph as the control run');
  for (const task of finalPlanned) {
    assert.equal(task.status, 'completed', `task "${task.title}" must complete after resume`);
    assert.equal(
      finalEvents.filter(e => e.type === 'task_completed' && e.taskId === task.id).length, 1,
      `task "${task.title}" must have exactly one completion event (no duplicate execution)`
    );
  }

  const postResumeCalls = tracker.workerCalls.slice(resumeCallIndex);
  for (const id of preCompletedIds) {
    assert.ok(!postResumeCalls.some(c => c.taskId === id), `pre-kill completed task ${id} must never be re-executed`);
  }
  for (const task of preInFlight) {
    assert.ok(postResumeCalls.some(c => c.taskId === task.id), `in-flight task "${task.title}" must be recovered and executed after resume`);
  }

  // Final tree: identical to the uninterrupted control run (paths,
  // contents, versions) and to the expected merge of its own task list.
  assert.deepEqual(treeOf(buildId), controlTree, 'the resumed build’s final tree must equal the uninterrupted control tree');
  const expected = new Map<string, string>();
  for (const task of finalPlanned) {
    for (const p of task.filePaths) expected.set(p, contentFor(p));
  }
  const actual = new Map<string, string>();
  for (const p of expected.keys()) {
    const file = db.getFile(buildId, p);
    assert.ok(file, `expected file ${p} to exist in the final tree`);
    actual.set(p, file!.content);
  }
  assert.equal(treeHash([...actual]), treeHash([...expected]), 'final tree must hash-match the expected merge');

  // Memory after completion: markers intact exactly once, no duplicated
  // initial facts, module graph rebuilt by the resumed workers.
  const finalMemory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  assert.equal(finalMemory.facts.filter(f => f.statement === FACT_MARKER).length, 1, 'marker fact still present exactly once');
  assert.equal(finalMemory.facts.filter(f => f.statement.startsWith('User core goal')).length, 1, 'initial facts are not duplicated by the restart');
  assert.equal(finalMemory.architectureDecisions.filter(d => d.id === 'ADR-F3-PIN').length, 1, 'marker ADR still present exactly once');
  assert.ok(finalMemory.moduleRelationships.length > 0, 'resumed workers rebuilt the module relationship graph');
  assert.ok(db.getCheckpoints(buildId).length >= preCheckpointCount, 'checkpoints are not lost across kill/resume');

  // Content-level proof: at least one post-resume worker prompt carried
  // the pre-kill fact and the pre-kill decision in its memory context.
  assert.ok(postResumeCalls.some(c => c.prompt.includes(FACT_MARKER)), 'a resumed worker’s prompt must contain the pre-kill pinned fact');
  assert.ok(postResumeCalls.some(c => c.prompt.includes(ADR_MARKER)), 'a resumed worker’s prompt must contain the pre-kill pinned decision');
});

// ---------------------------------------------------------------------------
// Test 2: contradictory facts/decisions produce a recorded conflict
// ---------------------------------------------------------------------------
test('F3 conflicts: contradictory worker facts are recorded in the build record, never silently stored or dropped', () => {
  const { buildId, userId } = makeBuild('conflict');
  ProjectMemoryService.getOrInitializeMemory(buildId, userId);

  // ADR conflicts (pre-existing behaviour, pinned): two accepted
  // decisions that contradict each other record a conflict event.
  ProjectMemoryService.recordDecision(buildId, userId, {
    id: 'ADR-F3-A', title: 'Use SQLite storage', status: 'accepted', context: 'fixture',
    decision: 'Use SQLite embedded database for all persistence', timestamp: Date.now()
  } as any);
  const eventsBeforeAdr = db.getEvents(buildId).length;
  ProjectMemoryService.recordDecision(buildId, userId, {
    id: 'ADR-F3-B', title: 'Use PostgreSQL storage', status: 'accepted', context: 'fixture',
    decision: 'Use PostgreSQL client server database for all persistence', timestamp: Date.now()
  } as any);
  const adrEvents = db.getEvents(buildId).slice(eventsBeforeAdr).filter(e => e.type === 'architectural_conflict');
  assert.equal(adrEvents.length, 1, 'a contradictory ADR must record exactly one conflict event');
  assert.ok(adrEvents[0].details.includes('ADR-F3-A') && adrEvents[0].details.includes('ADR-F3-B'),
    'the ADR conflict event must name both decisions');

  // Fact conflicts: worker A establishes a confirmed fact.
  assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
    category: 'architecture', statement: 'Caching is enabled for session data',
    confidence: 'confirmed', source: 'user_prompt'
  }), true);

  // Worker B's assumption contradicting it is refused AND recorded.
  let eventsBefore = db.getEvents(buildId).length;
  assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
    category: 'architecture', statement: 'Caching is not enabled for session data',
    confidence: 'assumption', source: 'architect_agent'
  }), false, 'a contradicting assumption must be refused');
  let newConflicts = db.getEvents(buildId).slice(eventsBefore).filter(e => e.type === 'fact_conflict');
  assert.equal(newConflicts.length, 1, 'the refused assumption must leave a conflict in the build record');
  assert.ok(newConflicts[0].details.includes('Caching is not enabled for session data'),
    'the conflict event must name the incoming statement');
  assert.ok(newConflicts[0].details.includes('Caching is enabled for session data'),
    'the conflict event must name the established statement');

  // Worker C's *confirmed* contradiction is also refused AND recorded —
  // memory must never hold two contradictory confirmed facts.
  eventsBefore = db.getEvents(buildId).length;
  assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
    category: 'architecture', statement: 'Caching is not enabled for session data',
    confidence: 'confirmed', source: 'architect_agent'
  }), false, 'a contradicting confirmed fact must be refused');
  newConflicts = db.getEvents(buildId).slice(eventsBefore).filter(e => e.type === 'fact_conflict');
  assert.equal(newConflicts.length, 1, 'the refused confirmed fact must leave a conflict in the build record');

  const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  const caching = memory.facts.filter(f => f.statement.toLowerCase().includes('caching is'));
  assert.equal(caching.length, 1, 'exactly one caching fact may exist in memory');
  assert.equal(caching[0].statement, 'Caching is enabled for session data');
  assert.equal(caching[0].confidence, 'confirmed');

  // A non-contradictory fact in the same category still records cleanly.
  eventsBefore = db.getEvents(buildId).length;
  assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
    category: 'architecture', statement: 'Session data is encrypted at rest',
    confidence: 'confirmed', source: 'architect_agent'
  }), true);
  assert.equal(db.getEvents(buildId).slice(eventsBefore).filter(e => e.type === 'fact_conflict').length, 0,
    'a compatible fact must not raise a conflict');
});

// ---------------------------------------------------------------------------
// Test 3: context budget retains pinned facts on a large project
// ---------------------------------------------------------------------------
test('F3 budget: context assembly respects its budget on a large project while retaining pinned facts', () => {
  const { buildId, userId } = makeBuild('budget');
  const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;

  // Large-project fixture: many accepted ADRs, requirements and defects
  // whose sections would consume the whole budget on their own.
  for (let i = 0; i < 10; i++) {
    memory.architectureDecisions.push({
      id: `ADR-BIG-${i}`, title: `Big decision ${i}`, status: 'accepted', context: 'ctx',
      decision: `Decision ${i}: ` + 'enforce strict layering with repository pattern and dependency inversion across all modules '.repeat(2),
      timestamp: Date.now()
    } as any);
  }
  for (let i = 0; i < 12; i++) {
    memory.requirements.push({
      id: `req_big_${i}`, title: `Requirement ${i} about habit tracking`,
      description: 'The system must render habit streaks and reminders with full offline support and sync '.repeat(2),
      category: 'frontend', priority: 'must_have', satisfied: false, status: 'pending'
    } as any);
  }
  for (let i = 0; i < 4; i++) {
    memory.knownDefects.push({
      id: `def_big_${i}`, description: `Defect ${i}: streak counter overflows when reminders fire across daylight saving boundaries`,
      filePaths: ['src/domain.ts'], severity: 'high', resolved: false, discoveredAt: Date.now()
    } as any);
  }
  db.saveProjectMemory(memory);

  // The pinned fact is recorded last, as a late-arriving user fact would be.
  assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
    category: 'constraint', statement: 'PINNED-MARKER-FACT: reminders must use local device time',
    confidence: 'confirmed', source: 'user_prompt'
  }), true);

  const task: any = {
    id: 'tsk_budget', buildId, title: 'Implement habit domain', description: 'habit streaks reminders',
    filePaths: ['src/domain.ts'], priority: 2, status: 'pending', claimedBy: null, leaseExpiresAt: null, createdAt: Date.now()
  };
  for (const budget of [1800, 1600, 1200]) {
    const context = ProjectMemoryService.retrieveTaskContext(buildId, userId, task, budget);
    assert.ok(context.length <= budget, `context must respect the ${budget}-char budget, got ${context.length}`);
    assert.ok(context.includes('PINNED-MARKER-FACT'), `the pinned confirmed fact must survive the ${budget}-char budget`);
    assert.ok(context.includes('PROJECT CONTEXT'), 'the context header must be present');
  }
});

// ---------------------------------------------------------------------------
// Test 4: parallel writers storm
// ---------------------------------------------------------------------------
test('F3 parallel writers: concurrent memory writes from many workers lose nothing and leave the store valid', { timeout: 120_000 }, async () => {
  const { buildId, userId } = makeBuild('storm');
  ProjectMemoryService.getOrInitializeMemory(buildId, userId);

  const N = 24;
  const defectIds: Array<string | null> = [];
  const contextTask: any = {
    id: 'tsk_storm', buildId, title: 'Storm task', description: 'storm',
    filePaths: ['src/domain.ts'], priority: 2, status: 'pending', claimedBy: null, leaseExpiresAt: null, createdAt: Date.now()
  };

  await Promise.all(Array.from({ length: N }, (_, i) => (async () => {
    // Stagger the workers so their writes genuinely interleave.
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 5)));
    assert.equal(ProjectMemoryService.recordFact(buildId, userId, {
      category: 'convention', statement: `Storm fact ${i}: cache shard ${i} owns its keyspace`,
      confidence: 'confirmed', source: 'architect_agent'
    }), true);
    assert.equal(ProjectMemoryService.recordDecision(buildId, userId, {
      id: `ADR-STORM-${i}`, title: `Storm decision ${i}`, status: 'accepted', context: 'storm fixture',
      decision: `Module ${i} owns shard ${i} rendering pipeline`, timestamp: Date.now()
    } as any), true);
    defectIds.push(ProjectMemoryService.recordDefect(buildId, userId, {
      description: `Storm defect ${i}: shard ${i} counter drift`, filePaths: [`src/shard${i}.ts`], severity: 'medium'
    }));
    const knowledge = ProjectMemoryService.recordKnowledgeItem(buildId, userId, {
      sourceAgent: `storm-worker-${i}`, sourceRole: 'backend_developer',
      category: 'implementation_discovery', title: `Storm knowledge ${i}`,
      content: `Shard ${i} renders through its own pipeline`, relevantFiles: [`src/shard${i}.ts`]
    });
    assert.equal(knowledge.success, true, `knowledge write ${i} must succeed: ${knowledge.error || ''}`);
    // Interleave context reads with the writes; assembly must never throw
    // or exceed its budget while memory is being mutated around it.
    const context = ProjectMemoryService.retrieveTaskContext(buildId, userId, contextTask, 1600);
    assert.ok(context.length <= 1600, 'context assembly must respect its budget during the storm');
  })()));

  const memory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  for (let i = 0; i < N; i++) {
    assert.equal(
      memory.facts.filter(f => f.statement === `Storm fact ${i}: cache shard ${i} owns its keyspace`).length, 1,
      `storm fact ${i} must be present exactly once`
    );
    assert.equal(
      memory.architectureDecisions.filter(d => d.id === `ADR-STORM-${i}`).length, 1,
      `storm ADR ${i} must be present exactly once`
    );
    assert.ok(defectIds[i], `storm defect ${i} must have been recorded`);
    assert.equal(
      memory.knownDefects.filter(d => d.id === defectIds[i]).length, 1,
      `storm defect ${i} must be present exactly once`
    );
  }
  const knowledgeItems = ProjectMemoryService.searchKnowledge(buildId, userId, { search: 'Storm knowledge' });
  assert.equal(knowledgeItems.length, N, 'every storm knowledge item must be stored exactly once');
  assert.equal(db.getEvents(buildId).filter(e => e.type === 'fact_conflict').length, 0,
    'non-contradictory parallel writes must not raise conflicts');

  // The persisted store is valid and complete: evict the cache and let
  // the store re-parse the memory blob from SQLite.
  db.projectMemories.delete(buildId);
  const reloaded = db.getProjectMemory(buildId);
  assert.ok(reloaded, 'persisted memory must reload after the storm');
  assert.equal(reloaded!.facts.filter(f => f.statement.startsWith('Storm fact')).length, N,
    'all storm facts must be in the persisted record');
  assert.equal(reloaded!.architectureDecisions.filter(d => d.id.startsWith('ADR-STORM-')).length, N,
    'all storm ADRs must be in the persisted record');
  const raw = db.dbManager.db.prepare('SELECT memory_data FROM project_memories WHERE project_id = ?')
    .get(buildId) as { memory_data: string };
  const parsed = JSON.parse(raw.memory_data); // throws if the blob is torn/corrupt
  assert.equal(parsed.projectId, buildId, 'the persisted memory blob must parse and belong to this build');
});

// ---------------------------------------------------------------------------
// Test 5: fact pruning never drops a confirmed fact (recordRevision path)
// ---------------------------------------------------------------------------
test('F3 pruning: recording a revision at the fact cap prunes assumptions, never confirmed facts', () => {
  const { buildId, userId } = makeBuild('prune');
  ProjectMemoryService.getOrInitializeMemory(buildId, userId);

  // Fill memory to the cap: 12 assumptions, then 28 confirmed facts on
  // top of the 2 initial confirmed facts derived from the build itself.
  for (let i = 0; i < 12; i++) {
    ProjectMemoryService.recordFact(buildId, userId, {
      category: 'convention', statement: `Prune probe assumption number ${i} about palette`,
      confidence: 'assumption', source: 'architect_agent'
    });
  }
  for (let i = 0; i < 28; i++) {
    ProjectMemoryService.recordFact(buildId, userId, {
      category: 'convention', statement: `Prune probe confirmed fact number ${i}`,
      confidence: 'confirmed', source: 'architect_agent'
    });
  }
  let memory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  assert.equal(memory.facts.length, 40, 'memory must be at the fact cap before the revision');
  assert.equal(memory.facts.filter(f => f.confidence === 'confirmed').length, 30, '30 confirmed facts at the cap');
  assert.ok(memory.facts.some(f => f.statement.includes('User core goal')), 'initial goal fact present before revision');
  assert.ok(memory.facts.some(f => f.statement.includes('Project classification')), 'initial classification fact present before revision');

  assert.equal(ProjectMemoryService.recordRevision(buildId, userId, {
    id: 'rev_prune_1', revisionNumber: 1, prompt: 'Change the accent color to amber',
    createdAt: Date.now(), status: 'in_progress', summary: 'color', tasksGenerated: []
  } as any), true);

  memory = ProjectMemoryService.getOrInitializeMemory(buildId, userId)!;
  assert.equal(memory.facts.length, 40, 'the fact cap still holds after the revision');
  assert.equal(memory.facts.filter(f => f.confidence === 'confirmed').length, 31,
    'every confirmed fact (30 + the revision fact) must be retained');
  assert.equal(memory.facts.filter(f => f.confidence !== 'confirmed').length, 9,
    'assumptions absorb the pruning, oldest first');
  assert.ok(memory.facts.some(f => f.statement.includes('User core goal')),
    'the initial user-goal fact must survive revision pruning');
  assert.ok(memory.facts.some(f => f.statement.includes('Project classification')),
    'the initial classification fact must survive revision pruning');
  assert.ok(memory.facts.some(f => f.source === 'user_revision'), 'the revision fact itself must be recorded');
});
