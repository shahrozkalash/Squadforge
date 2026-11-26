/**
 * Phase 33 — AI reliability and production security.
 *
 * Transport tests run the REAL provider adapters (smartRouter's
 * OpenRouter fetch path, the Gemini SDK client, the local-model
 * client) over real HTTP against an in-process stub server. The stub
 * is a transport fixture: it proves timeouts, cancellation, retries
 * and fallback behaviour of the adapter code — it is NOT a model and
 * no claim about model output quality is made from it. Genuine cloud
 * provider verification is gated on LIVE_PROVIDER_TEST=1 with a real
 * GEMINI_API_KEY in the environment (see the last test).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Stub provider server (transport fixture)
// ---------------------------------------------------------------------------
type StubMode = 'ok' | 'hang' | 'unauthorized' | 'flaky' | 'error500';
let orMode: StubMode = 'ok';
let orFlaky = 0;
let orHits = 0;
let gemMode: StubMode = 'ok';
let gemFlaky = 0;
let gemHits = 0;
const disconnects: string[] = [];
const disconnectWaiters: Array<{ tag: string; resolve: () => void }> = [];

function noteDisconnect(tag: string): void {
  disconnects.push(tag);
  for (let i = disconnectWaiters.length - 1; i >= 0; i--) {
    if (disconnectWaiters[i].tag === tag) {
      disconnectWaiters[i].resolve();
      disconnectWaiters.splice(i, 1);
    }
  }
}

function waitForDisconnect(tag: string, timeoutMs: number): Promise<boolean> {
  if (disconnects.includes(tag)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(disconnects.includes(tag)), timeoutMs);
    disconnectWaiters.push({ tag, resolve: () => { clearTimeout(timer); resolve(true); } });
  });
}

const stub = http.createServer((req, res) => {
  const url = req.url || '';
  const isGemini = url.includes(':generateContent');
  const isChat = url.includes('/chat/completions');
  if (!isGemini && !isChat) {
    res.writeHead(404).end('{}');
    return;
  }
  const tag = isGemini ? 'gemini' : 'openrouter';
  const mode = isGemini ? gemMode : orMode;
  if (isGemini) gemHits++; else orHits++;

  if (mode === 'hang') {
    // Never respond; record when the client actually disconnects.
    res.on('close', () => noteDisconnect(tag));
    return;
  }
  if (mode === 'unauthorized') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
    return;
  }
  if (mode === 'error500') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'internal' } }));
    return;
  }
  if (mode === 'flaky') {
    const remaining = isGemini ? gemFlaky : orFlaky;
    if (remaining > 0) {
      if (isGemini) gemFlaky--; else orFlaky--;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isGemini
        ? { error: { code: 429, message: 'rate limited', status: 'RESOURCE_EXHAUSTED' } }
        : { error: { message: 'rate limited' } }));
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (isGemini) {
    res.end(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '{"actions":[{"action":"create_task","title":"Diagnose","description":"stub transport diagnosis"}]}' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6, totalTokenCount: 18 }
    }));
  } else {
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"actions":[{"action":"create_task","title":"Diagnose","description":"stub transport diagnosis"}]}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
    }));
  }
});

let smartRouter: any;
let quotaManager: any;
let localLLMService: any;
let providerReliability: any;
let auditLogModule: any;
let savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

before(async () => {
  const port = await new Promise<number>((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as AddressInfo).port));
  });
  savedEnv = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    PROVIDER_TIMEOUT_MS: process.env.PROVIDER_TIMEOUT_MS,
    PROVIDER_MAX_RETRIES: process.env.PROVIDER_MAX_RETRIES,
    AUDIT_LOG_PATH: process.env.AUDIT_LOG_PATH
  };
  setEnv({
    OPENROUTER_API_KEY: 'phase33-test-openrouter-key',
    GEMINI_API_KEY: 'phase33-test-gemini-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
    GEMINI_BASE_URL: `http://127.0.0.1:${port}`,
    PROVIDER_TIMEOUT_MS: '30000',
    PROVIDER_MAX_RETRIES: '2',
    AUDIT_LOG_PATH: undefined
  });
  ({ smartRouter } = await import('../server/smartRouter.js'));
  ({ quotaManager } = await import('../server/quotaManager.js'));
  ({ localLLMService } = await import('../server/localLLM.js'));
  providerReliability = await import('../server/providerReliability.js');
  auditLogModule = await import('../server/auditLog.js');
});

after(() => {
  stub.close();
  setEnv(savedEnv);
});

function resetProviders(): void {
  quotaManager.resetProvider('openrouter');
  quotaManager.resetProvider('gemini');
  orMode = 'ok'; gemMode = 'ok'; orFlaky = 0; gemFlaky = 0;
}

function nonce(): string {
  return `phase33-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Reliability policy
// ---------------------------------------------------------------------------
test('timeout and retry policy: sane defaults, env override, clamping', () => {
  const t = providerReliability.providerTimeoutMs;
  const r = providerReliability.providerMaxRetries;
  const oldT = process.env.PROVIDER_TIMEOUT_MS;
  const oldR = process.env.PROVIDER_MAX_RETRIES;
  try {
    delete process.env.PROVIDER_TIMEOUT_MS;
    assert.equal(t(), 120_000, 'default timeout must be 120 s, not the old 8 s');
    process.env.PROVIDER_TIMEOUT_MS = '50';
    assert.equal(t(), 1_000, 'timeout clamps to >= 1 s');
    process.env.PROVIDER_TIMEOUT_MS = '99999999';
    assert.equal(t(), 600_000, 'timeout clamps to <= 600 s');
    delete process.env.PROVIDER_MAX_RETRIES;
    assert.equal(r(), 2);
    process.env.PROVIDER_MAX_RETRIES = '99';
    assert.equal(r(), 5);
  } finally {
    setEnv({ PROVIDER_TIMEOUT_MS: oldT, PROVIDER_MAX_RETRIES: oldR });
  }
  assert.equal(providerReliability.isRetryableStatus(429), true);
  assert.equal(providerReliability.isRetryableStatus(503), true);
  assert.equal(providerReliability.isRetryableStatus(401), false);
  assert.equal(providerReliability.isRetryableErrorCode('RATE_LIMITED'), true);
  assert.equal(providerReliability.isRetryableErrorCode('INVALID_API_KEY'), false);
  assert.equal(providerReliability.isRetryableErrorCode('CANCELLED'), false);
});

test('backoffSleep keeps the event loop alive until the awaited sleep resolves', async () => {
  // Regression: backoffSleep's timer was unref'd, so in a process with
  // nothing else pending the event loop drained mid-sleep and the
  // awaited promise never resolved (node --test cancelled such tests
  // in CI with "Promise resolution is still pending but the event
  // loop has already resolved"). This must be exercised in a child
  // process: this suite's own stub servers would keep the loop alive
  // and mask the bug in-process.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase33-backoff-'));
  const modulePath = path.resolve(process.cwd(), 'server/providerReliability.ts');
  const driver = path.join(dir, 'driver.ts');
  fs.writeFileSync(driver, [
    `import { backoffSleep } from ${JSON.stringify(modulePath)};`,
    'async function main(): Promise<void> {',
    '  const ok = await backoffSleep(0, undefined);',
    '  console.log(`RESOLVED ok=${ok}`);',
    '}',
    'void main();',
    ''
  ].join('\n'));
  try {
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const { stdout } = await execFileAsync(tsxBin, [driver], { timeout: 30_000 });
    assert.match(stdout, /RESOLVED ok=true/, 'the awaited backoff sleep must resolve before the child process exits');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// OpenRouter transport (real fetch, stub server)
// ---------------------------------------------------------------------------
test('OpenRouter: real HTTP call succeeds and parses the response', async () => {
  resetProviders();
  const before = orHits;
  const result = await smartRouter.executeSmartRequest({
    requestedModelId: 'gpt-4o', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
  });
  assert.equal(result.success, true, result.error);
  assert.equal(result.providerUsed, 'openrouter');
  assert.ok(result.parsedResponse);
  assert.equal(orHits, before + 1);
});

test('OpenRouter: 429 responses are retried with backoff until success', async () => {
  resetProviders();
  orMode = 'flaky'; orFlaky = 2;
  const before = orHits;
  const result = await smartRouter.executeSmartRequest({
    requestedModelId: 'gpt-4o', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
  });
  assert.equal(result.success, true, result.error);
  assert.equal(orHits, before + 3, 'two 429s then one success = 3 attempts');
});

test('OpenRouter: 401 is never retried and never silently succeeds', async () => {
  resetProviders();
  const geminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY; // no fallback available: pure primary failure
  try {
    orMode = 'unauthorized';
    const before = orHits;
    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gpt-4o', prompt: nonce(), taskComplexity: 'standard', bypassCache: true, allowFallback: false
    });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'INVALID_API_KEY');
    assert.equal(orHits, before + 1, 'an auth failure must not be retried');
  } finally {
    process.env.GEMINI_API_KEY = geminiKey;
    resetProviders();
  }
});

test('cancellation aborts the actual in-flight provider request', async () => {
  resetProviders();
  orMode = 'hang';
  const controller = new AbortController();
  const started = Date.now();
  const pending = smartRouter.executeSmartRequest({
    requestedModelId: 'gpt-4o', prompt: nonce(), taskComplexity: 'standard',
    bypassCache: true, signal: controller.signal, allowFallback: false
  });
  setTimeout(() => controller.abort(), 400);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.equal(result.errorCode, 'CANCELLED', JSON.stringify(result));
  assert.ok(elapsed < 5_000, `cancellation took ${elapsed} ms`);
  assert.equal(await waitForDisconnect('openrouter', 3_000), true,
    'the stub must observe the client disconnect — the request itself stopped');
  resetProviders();
});

test('timeout aborts the request and falls back to Gemini without losing the result', async () => {
  resetProviders();
  orMode = 'hang';
  process.env.PROVIDER_TIMEOUT_MS = '1000';
  process.env.PROVIDER_MAX_RETRIES = '0';
  try {
    const started = Date.now();
    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gpt-4o', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
    });
    const elapsed = Date.now() - started;
    assert.equal(result.success, true, result.error);
    assert.equal(result.providerUsed, 'gemini');
    assert.equal(result.isFallback, true);
    assert.ok(result.parsedResponse, 'fallback returns the parsed payload for the original request');
    assert.ok(elapsed < 20_000, `timeout+fallback took ${elapsed} ms`);
    assert.equal(await waitForDisconnect('openrouter', 3_000), true,
      'the timed-out OpenRouter request must be aborted, not left running');
  } finally {
    process.env.PROVIDER_TIMEOUT_MS = '30000';
    process.env.PROVIDER_MAX_RETRIES = '2';
    resetProviders();
  }
});

// ---------------------------------------------------------------------------
// Gemini transport (real SDK client, stub server via GEMINI_BASE_URL)
// ---------------------------------------------------------------------------
test('Gemini: direct call succeeds through the real SDK client', async () => {
  resetProviders();
  const result = await smartRouter.executeSmartRequest({
    requestedModelId: 'gemini-fullstack', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
  });
  assert.equal(result.success, true, result.error);
  assert.equal(result.providerUsed, 'gemini');
  assert.ok(result.parsedResponse);
});

test('Gemini: 429 responses are retried until success', async () => {
  resetProviders();
  gemMode = 'flaky'; gemFlaky = 2;
  const before = gemHits;
  const result = await smartRouter.executeSmartRequest({
    requestedModelId: 'gemini-fullstack', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
  });
  assert.equal(result.success, true, result.error);
  assert.equal(gemHits, before + 3, 'two 429s then one success = 3 attempts');
});

test('Gemini: timeout genuinely aborts the SDK request', async () => {
  resetProviders();
  gemMode = 'hang';
  process.env.PROVIDER_TIMEOUT_MS = '1000';
  process.env.PROVIDER_MAX_RETRIES = '0';
  try {
    const started = Date.now();
    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gemini-fullstack', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
    });
    const elapsed = Date.now() - started;
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'NETWORK_ERROR', JSON.stringify(result));
    assert.match(result.error || '', /timeout/i);
    assert.ok(elapsed < 15_000, `timeout took ${elapsed} ms`);
    assert.equal(await waitForDisconnect('gemini', 3_000), true,
      'the stub must observe the SDK request being aborted on timeout');
  } finally {
    process.env.PROVIDER_TIMEOUT_MS = '30000';
    process.env.PROVIDER_MAX_RETRIES = '2';
    resetProviders();
  }
});

test('local provider: cancellation aborts the in-flight request', async () => {
  const port = (stub.address() as AddressInfo).port;
  orMode = 'hang';
  localLLMService.updateConfig({
    enabled: true, endpointUrl: `http://127.0.0.1:${port}/v1`, modelName: 'stub-model', timeoutMs: 60_000
  });
  const controller = new AbortController();
  const started = Date.now();
  const pending = localLLMService.callLocalModel({ prompt: nonce(), signal: controller.signal });
  setTimeout(() => controller.abort(), 400);
  const result = await pending;
  const elapsed = Date.now() - started;
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'CANCELLED', JSON.stringify(result));
  assert.ok(elapsed < 5_000, `local cancellation took ${elapsed} ms`);
  assert.equal(await waitForDisconnect('openrouter', 3_000), true);
  orMode = 'ok';
  localLLMService.updateConfig({ enabled: false, endpointUrl: 'http://localhost:11434/v1', timeoutMs: 15_000 });
});

test('no provider configured: honest NO_PROVIDER failure, never a fake success', async () => {
  const orKey = process.env.OPENROUTER_API_KEY;
  const gemKey = process.env.GEMINI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gemini-fullstack', prompt: nonce(), taskComplexity: 'standard', bypassCache: true
    });
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'NO_PROVIDER');
  } finally {
    process.env.OPENROUTER_API_KEY = orKey;
    process.env.GEMINI_API_KEY = gemKey;
    resetProviders();
  }
});

// ---------------------------------------------------------------------------
// Security: deployment approval gate cannot be skipped from the client
// ---------------------------------------------------------------------------
test('deployment route: skipApprovalGate in the request body no longer bypasses the gate', async () => {
  const express = (await import('express')).default;
  const { db } = await import('../server/store.js');
  const { createDeploymentRouter } = await import('../server/deployment/deploymentRoutes.js');

  const owner: any = {
    id: `p33-owner-${randomUUID()}`, username: 'p33owner', email: 'p33@example.com',
    githubConnected: false, costLimitPerBuild: 5.0, enabledModelIds: [], createdAt: Date.now()
  };
  const foreigner: any = { ...owner, id: `p33-foreign-${randomUUID()}`, username: 'p33foreign' };
  db.saveUser(owner);
  db.saveUser(foreigner);
  const build: any = {
    id: `p33-build-${randomUUID()}`, userId: owner.id, idea: 'Phase 33 gate test', status: 'completed',
    createdAt: Date.now(), updatedAt: Date.now(), selectedModels: [], autoPushGithub: false,
    totalTokens: 0, totalCost: 0, costLimit: 5, maxDurationSeconds: 300, patchesAppliedCount: 0
  };
  db.saveBuild(build);
  // Same seed set the Phase 15 deployment tests use, so the real
  // pre-deployment validator passes and the gate is what is tested.
  const seedFiles: any[] = [
    { path: 'index.html', content: '<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>' },
    { path: 'src/main.tsx', content: "import React from 'react';\nconsole.log('App loaded', import.meta.env.VITE_API_ENDPOINT);" },
    { path: 'src/index.css', content: 'body { background-color: #0f172a; color: #f8fafc; }' },
    { path: 'package.json', content: JSON.stringify({ name: 'test-production-app', version: '1.0.0', scripts: { build: 'vite build', start: 'node server.js' }, dependencies: { react: '^19.0.0' } }, null, 2) },
    { path: 'README.md', content: '# Test App\nProduction test application.' }
  ];
  for (const f of seedFiles) {
    db.setFile(build.id, { ...f, version: 1, createdAt: Date.now(), updatedAt: Date.now(), history: [] } as any);
  }

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = req.headers['x-test-user'] === 'foreign' ? foreigner : owner;
    next();
  });
  app.use(createDeploymentRouter(((req: any, _res: any, next: any) => next()) as any));

  const server = http.createServer(app);
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/builds/${build.id}/deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'static_host', environment: 'production', skipApprovalGate: true })
    });
    const body: any = await res.json();
    assert.equal(res.status, 202, JSON.stringify(body));
    assert.equal(body.status, 'pending_approval', 'production deploy must wait for approval even when the client asks to skip the gate');

    const foreign = await fetch(`http://127.0.0.1:${port}/api/builds/${build.id}/deployments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'foreign' },
      body: JSON.stringify({ provider: 'static_host', environment: 'production' })
    });
    assert.ok(foreign.status === 403 || foreign.status === 404, `foreign user got ${foreign.status}`);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Security: structured audit log redaction
// ---------------------------------------------------------------------------
test('audit log records structured events and redacts secrets at any depth', async () => {
  const { auditLog, recentAuditEvents, clearAuditEventsForTests } = auditLogModule;
  clearAuditEventsForTests();
  const tmpFile = path.join(os.tmpdir(), `phase33-audit-${randomUUID()}.log`);
  process.env.AUDIT_LOG_PATH = tmpFile;
  try {
    auditLog('approval.respond', {
      actorId: 'user-1', buildId: 'build-1', outcome: 'approved',
      details: {
        approvalId: 'req-9',
        apiKey: 'sk-phase33-must-not-appear',
        nested: { accessToken: 'ghp_must_not_appear', note: 'Bearer must-not-appear' },
        list: [{ password: 'must-not-appear' }]
      }
    });
    const events = recentAuditEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'approval.respond');
    assert.equal(events[0].actorId, 'user-1');
    const serialized = JSON.stringify(events) + fs.readFileSync(tmpFile, 'utf8');
    for (const secret of ['sk-phase33-must-not-appear', 'ghp_must_not_appear', 'Bearer must-not-appear', 'must-not-appear']) {
      assert.ok(!serialized.includes(secret), `audit output leaked: ${secret}`);
    }
    assert.ok(serialized.includes('[REDACTED]'));
    assert.ok(serialized.includes('req-9'), 'non-secret ids stay visible');
  } finally {
    delete process.env.AUDIT_LOG_PATH;
    fs.rmSync(tmpFile, { force: true });
    clearAuditEventsForTests();
  }
});

// ---------------------------------------------------------------------------
// Genuine cloud provider verification (gated — never faked)
// ---------------------------------------------------------------------------
test('live cloud provider: debugging-style Gemini call (gated on LIVE_PROVIDER_TEST=1)', async (t) => {
  if (process.env.LIVE_PROVIDER_TEST !== '1' || !savedEnv.GEMINI_API_KEY) {
    t.skip('Set LIVE_PROVIDER_TEST=1 with a real GEMINI_API_KEY to run the genuine cloud check');
    return;
  }
  // Restore the real key and the real endpoint for this one call.
  setEnv({
    GEMINI_API_KEY: savedEnv.GEMINI_API_KEY,
    GEMINI_BASE_URL: undefined,
    OPENROUTER_API_KEY: undefined,
    PROVIDER_TIMEOUT_MS: '120000'
  });
  try {
    const result = await smartRouter.executeSmartRequest({
      requestedModelId: 'gemini-fullstack',
      prompt: 'Diagnose this failure and propose a fix as JSON: file app.ts line 3 `const total = price * qty;` throws "qty is not defined". Respond with {"report":{"summary":"..."}}',
      taskComplexity: 'standard',
      bypassCache: true
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.providerUsed, 'gemini');
    assert.ok(result.parsedResponse, 'real provider returned parseable JSON');
  } finally {
    setEnv({
      GEMINI_API_KEY: 'phase33-test-gemini-key',
      GEMINI_BASE_URL: process.env.GEMINI_BASE_URL
    });
  }
});
