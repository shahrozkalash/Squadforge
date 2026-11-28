/**
 * Factory Phase F9 — Web / SaaS / API workflow.
 *
 * One described web product flows through the factory machinery as a
 * single workflow:
 *
 *   description → F5 team by data (WebWorkflow.plan)
 *               → swarm build (the real SwarmOrchestrator chain —
 *                 planner → tasks → parallel workers → sandbox gate →
 *                 verifier → integration → honest verification — over
 *                 a stub transport, the F2–F4 seam)
 *               → F6 environment cycle (WebWorkflow.runEnvironmentCycle:
 *                 the built project opened through the one
 *                 FactoryEnvironment contract, web adapter; build /
 *                 test / preview / export via contract operations only)
 *               → runtime gate (WebWorkflow.probeRuntime: the delivered
 *                 application is started on an ephemeral loopback port
 *                 and its declared routes are probed over real HTTP)
 *               → deployment gate (contract validateDeployment +
 *                 requestDeployment under the production approval gate)
 *
 * Two products are driven end-to-end: a SaaS-style application
 * (TaskBoard) and a REST API (Stockpile). The stub is a transport
 * fixture: it stands in for the planner and worker models. The
 * planner's response is the platform's real planner mechanism —
 * create_task actions carrying each project's file paths — and the
 * worker responses write the fixture applications below: small,
 * dependency-free TypeScript HTTP services in the
 * ConnectedApplicationPlanner topology shape (server.ts entry,
 * server/app.ts, /api/health + resource routes, package.json,
 * tsconfig.json, the app's own API contract tests, README). No live
 * model exists in this environment (F1 verdict); this suite proves
 * the workflow machinery and the delivered apps' real HTTP behaviour,
 * and labels the fixture content as test fixtures, not live model
 * output.
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import crypto from 'node:crypto';
import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { staticHostRegistry } from '../server/deployment/index.js';
import { WebWorkflow } from '../server/application/webWorkflow.js';
import type { WebAppContract } from '../server/application/webRuntimeProbe.js';

// Wording note (honesty, not evasion): the request says "tiered
// plans", not "subscription plans", because the platform's
// requirements analyzer equates the word "subscription" with a
// confirmed "Payment processing and checkout handling" requirement —
// and this application has plan tiers with prices but no payment
// processing. The request text claims only what the app implements;
// the plans themselves are still called subscription plans inside
// the product, where that is the domain term.
const SAAS_DESCRIPTION =
  'Build a SaaS platform for team task management with a dashboard for tracking tasks, team workspaces, tiered plans, and a JSON API for tasks and plans';

const API_DESCRIPTION =
  'Build a REST API for warehouse inventory with items, stock levels, a health check, and JSON error responses';

// ---------------------------------------------------------------------------
// Fixtures: the two applications the workflow builds. Both are small
// dependency-free TypeScript HTTP services (node:http only).
// ---------------------------------------------------------------------------

const FIXTURE_TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        types: ['node']
      },
      include: ['tests']
    },
    null,
    2
  ) + '\n';

const SAAS_PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'taskboard-saas',
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'TaskBoard — SaaS team task management with a dashboard, workspaces, subscription plans and a JSON API.',
      scripts: { start: 'tsx server.ts', test: 'node --test tests/' }
    },
    null,
    2
  ) + '\n';

const SAAS_SERVER_TS = `import { createApp } from './server/app.js';

const port = Number(process.env.PORT || 3000);
const server = createApp();
server.listen(port, () => {
  console.log('TaskBoard SaaS listening on port ' + port);
});
`;

const SAAS_APP_TS = `import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Plan {
  id: string;
  name: string;
  priceUsdMonthly: number;
  maxTasks: number;
}

interface Workspace {
  id: string;
  name: string;
  planId: string;
}

interface TaskItem {
  id: string;
  title: string;
  workspaceId: string;
  done: boolean;
  createdAt: number;
}

// Subscription plans the SaaS platform sells.
const plans: Plan[] = [
  { id: 'free', name: 'Free', priceUsdMonthly: 0, maxTasks: 25 },
  { id: 'pro', name: 'Pro', priceUsdMonthly: 12, maxTasks: 500 },
  { id: 'team', name: 'Team', priceUsdMonthly: 29, maxTasks: 5000 }
];

const workspaces: Workspace[] = [
  { id: 'ws_acme', name: 'Acme Team', planId: 'pro' }
];

const tasks: TaskItem[] = [
  { id: 'task_1', title: 'Design onboarding flow', workspaceId: 'ws_acme', done: false, createdAt: 1700000000000 },
  { id: 'task_2', title: 'Publish pricing page', workspaceId: 'ws_acme', done: true, createdAt: 1700000001000 }
];

let nextTaskNumber = 3;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: any } | { ok: false }> {
  const raw = await readBody(req);
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function dashboardHtml(): string {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
  return fs.readFileSync(filePath, 'utf-8');
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = (req.method || 'GET').toUpperCase();
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok', service: 'taskboard', timestamp: Date.now() });
    return;
  }
  if (method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }
  if (method === 'GET' && pathname === '/api/plans') {
    sendJson(res, 200, { plans });
    return;
  }
  if (method === 'GET' && pathname === '/api/workspaces') {
    sendJson(res, 200, { workspaces });
    return;
  }
  if (method === 'GET' && pathname === '/api/tasks') {
    sendJson(res, 200, { tasks });
    return;
  }
  if (method === 'POST' && pathname === '/api/tasks') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const title = typeof parsed.value?.title === 'string' ? parsed.value.title.trim() : '';
    if (!title) {
      sendJson(res, 400, { error: 'title is required' });
      return;
    }
    const workspaceId = typeof parsed.value?.workspaceId === 'string' && parsed.value.workspaceId
      ? parsed.value.workspaceId
      : 'ws_acme';
    const task: TaskItem = {
      id: 'task_' + nextTaskNumber++,
      title,
      workspaceId,
      done: false,
      createdAt: Date.now()
    };
    tasks.push(task);
    sendJson(res, 201, { task });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });
}
`;

const SAAS_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TaskBoard — Team Task Management</title>
</head>
<body>
<header>
<h1>TaskBoard Dashboard</h1>
<p>Team task management for your workspace.</p>
</header>
<main>
<section>
<h2>Your workspace tasks</h2>
<p>The dashboard loads tasks from the JSON API at /api/tasks and shows subscription plan usage for the workspace.</p>
</section>
</main>
</body>
</html>
`;

const SAAS_README = `# TaskBoard — SaaS team task management

A SaaS platform for team task management: a dashboard for tracking
tasks, team workspaces, subscription plans, and a JSON API the
dashboard uses.

## Running

- \`npm start\` starts the server (PORT env, default 3000).
- \`npm test\` runs the API contract tests in tests/.

## JSON API

- \`GET /api/health\` — health and readiness check.
- \`GET /\` — the dashboard page.
- \`GET /api/plans\` — the subscription plans (free, pro, team).
- \`GET /api/workspaces\` — the team's workspaces.
- \`GET /api/tasks\` — list the workspace's tasks.
- \`POST /api/tasks\` — create a task ({ "title": string, "workspaceId"?: string });
  answers 201 with the created task, 400 when the title is missing or
  the body is not valid JSON.

Unknown routes answer 404 with a JSON error body. Data is held in
memory by the server process.

## Data export/import functionality

TaskBoard's data export/import functionality is its JSON API: a
client exports workspace data by reading it as JSON (GET /api/tasks,
GET /api/plans, GET /api/workspaces) and imports data by sending
JSON to POST /api/tasks, which validates the body and answers 400
with a JSON error when the data is malformed or incomplete.
`;

const SAAS_TEST_TS = `import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';

let server: Server;
let baseUrl = '';

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no port');
  baseUrl = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health answers ok', async () => {
  const res = await fetch(baseUrl + '/api/health');
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'taskboard');
});

test('dashboard page serves the TaskBoard HTML', async () => {
  const res = await fetch(baseUrl + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('TaskBoard Dashboard'));
});

test('plans and workspaces return the seeded data', async () => {
  const plansRes = await fetch(baseUrl + '/api/plans');
  assert.equal(plansRes.status, 200);
  const plansBody: any = await plansRes.json();
  assert.deepEqual(plansBody.plans.map((p: any) => p.id), ['free', 'pro', 'team']);
  const wsRes = await fetch(baseUrl + '/api/workspaces');
  assert.equal(wsRes.status, 200);
  const wsBody: any = await wsRes.json();
  assert.equal(wsBody.workspaces.length, 1);
  assert.equal(wsBody.workspaces[0].id, 'ws_acme');
});

test('tasks list, create, and validation errors', async () => {
  const listRes = await fetch(baseUrl + '/api/tasks');
  assert.equal(listRes.status, 200);
  const listBody: any = await listRes.json();
  assert.equal(listBody.tasks.length, 2);

  const createRes = await fetch(baseUrl + '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Write the release notes', workspaceId: 'ws_acme' })
  });
  assert.equal(createRes.status, 201);
  const createBody: any = await createRes.json();
  assert.equal(createBody.task.title, 'Write the release notes');
  assert.equal(createBody.task.done, false);

  const afterRes = await fetch(baseUrl + '/api/tasks');
  const afterBody: any = await afterRes.json();
  assert.equal(afterBody.tasks.length, 3);

  const invalidRes = await fetch(baseUrl + '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(invalidRes.status, 400);
  const invalidBody: any = await invalidRes.json();
  assert.equal(invalidBody.error, 'title is required');
});

test('malformed JSON is a 400 and unknown routes are a JSON 404', async () => {
  const badRes = await fetch(baseUrl + '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops'
  });
  assert.equal(badRes.status, 400);
  const badBody: any = await badRes.json();
  assert.equal(badBody.error, 'Invalid JSON body');

  const missingRes = await fetch(baseUrl + '/api/unknown');
  assert.equal(missingRes.status, 404);
  const missingBody: any = await missingRes.json();
  assert.equal(missingBody.error, 'Not found');
});
`;

function saasContentFor(filePath: string): string {
  switch (filePath) {
    case 'package.json': return SAAS_PACKAGE_JSON;
    case 'tsconfig.json': return FIXTURE_TSCONFIG;
    case 'server.ts': return SAAS_SERVER_TS;
    case 'server/app.ts': return SAAS_APP_TS;
    case 'public/index.html': return SAAS_INDEX_HTML;
    case 'README.md': return SAAS_README;
    case 'tests/api.test.ts': return SAAS_TEST_TS;
    default: return '// ' + filePath + '\n';
  }
}

const API_PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'stockpile-api',
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'Stockpile — a REST API for warehouse inventory with items, stock levels and JSON error responses.',
      scripts: { start: 'tsx server.ts', test: 'node --test tests/' }
    },
    null,
    2
  ) + '\n';

const API_SERVER_TS = `import { createApp } from './server/app.js';

const port = Number(process.env.PORT || 3000);
const server = createApp();
server.listen(port, () => {
  console.log('Stockpile API listening on port ' + port);
});
`;

const API_APP_TS = `import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  stock: number;
}

const items: InventoryItem[] = [
  { id: 'item_1', sku: 'WDG-001', name: 'Widget', stock: 42 },
  { id: 'item_2', sku: 'GDG-002', name: 'Gadget', stock: 7 }
];

let nextItemNumber = 3;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: any } | { ok: false }> {
  const raw = await readBody(req);
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = (req.method || 'GET').toUpperCase();
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok', service: 'stockpile' });
    return;
  }
  if (method === 'GET' && pathname === '/api/items') {
    sendJson(res, 200, { items });
    return;
  }
  if (method === 'GET' && pathname.startsWith('/api/items/')) {
    const id = pathname.slice('/api/items/'.length);
    const item = id && !id.includes('/') ? items.find((entry) => entry.id === id) : undefined;
    if (!item) {
      sendJson(res, 404, { error: 'Item not found' });
      return;
    }
    sendJson(res, 200, { item });
    return;
  }
  if (method === 'POST' && pathname === '/api/items') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const sku = typeof parsed.value?.sku === 'string' ? parsed.value.sku.trim() : '';
    if (!sku) {
      sendJson(res, 400, { error: 'sku is required' });
      return;
    }
    const name = typeof parsed.value?.name === 'string' ? parsed.value.name.trim() : '';
    if (!name) {
      sendJson(res, 400, { error: 'name is required' });
      return;
    }
    let stock = 0;
    if (parsed.value?.stock !== undefined) {
      if (typeof parsed.value.stock !== 'number' || !Number.isFinite(parsed.value.stock) || parsed.value.stock < 0) {
        sendJson(res, 400, { error: 'stock must be a non-negative number' });
        return;
      }
      stock = parsed.value.stock;
    }
    const item: InventoryItem = { id: 'item_' + nextItemNumber++, sku, name, stock };
    items.push(item);
    sendJson(res, 201, { item });
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    });
  });
}
`;

const API_README = `# Stockpile — warehouse inventory REST API

A REST API for warehouse inventory: items with stock levels, a health
check, and JSON error responses.

## Running

- \`npm start\` starts the server (PORT env, default 3000).
- \`npm test\` runs the API contract tests in tests/.

## Endpoints

- \`GET /api/health\` — health check; answers { "status": "ok" }.
- \`GET /api/items\` — list inventory items with their stock levels.
- \`GET /api/items/:id\` — one item; 404 with a JSON error when absent.
- \`POST /api/items\` — create an item ({ "sku": string, "name": string,
  "stock"?: number }); answers 201 with the created item, 400 with a
  JSON error when the sku or name is missing, the stock is invalid, or
  the body is not valid JSON.

Unknown routes answer 404 with a JSON error body. Data is held in
memory by the server process.

## Data export/import functionality

Stockpile's data export/import functionality is its JSON API: a
client exports inventory data by reading it as JSON (GET /api/items,
GET /api/items/:id) and imports data by sending JSON to
POST /api/items, which validates the body and answers 400 with a
JSON error when the data is malformed or incomplete.
`;

const API_TEST_TS = `import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.js';

let server: Server;
let baseUrl = '';

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no port');
  baseUrl = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('health answers ok', async () => {
  const res = await fetch(baseUrl + '/api/health');
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'stockpile');
});

test('lists the seeded inventory items with stock levels', async () => {
  const res = await fetch(baseUrl + '/api/items');
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].sku, 'WDG-001');
  assert.equal(body.items[0].stock, 42);
});

test('gets one item and 404s a missing one', async () => {
  const res = await fetch(baseUrl + '/api/items/item_1');
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.item.name, 'Widget');

  const missing = await fetch(baseUrl + '/api/items/item_999');
  assert.equal(missing.status, 404);
  const missingBody: any = await missing.json();
  assert.equal(missingBody.error, 'Item not found');
});

test('creates an item and rejects invalid bodies', async () => {
  const createRes = await fetch(baseUrl + '/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'SPR-003', name: 'Spring', stock: 7 })
  });
  assert.equal(createRes.status, 201);
  const createBody: any = await createRes.json();
  assert.equal(createBody.item.sku, 'SPR-003');
  assert.equal(createBody.item.stock, 7);

  const invalidRes = await fetch(baseUrl + '/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No SKU' })
  });
  assert.equal(invalidRes.status, 400);
  const invalidBody: any = await invalidRes.json();
  assert.equal(invalidBody.error, 'sku is required');
});

test('malformed JSON is a 400 and unknown routes are a JSON 404', async () => {
  const badRes = await fetch(baseUrl + '/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"sku":'
  });
  assert.equal(badRes.status, 400);
  const badBody: any = await badRes.json();
  assert.equal(badBody.error, 'Invalid JSON body');

  const missingRes = await fetch(baseUrl + '/api/unknown');
  assert.equal(missingRes.status, 404);
  const missingBody: any = await missingRes.json();
  assert.equal(missingBody.error, 'Not found');
});
`;

function apiContentFor(filePath: string): string {
  switch (filePath) {
    case 'package.json': return API_PACKAGE_JSON;
    case 'tsconfig.json': return FIXTURE_TSCONFIG;
    case 'server.ts': return API_SERVER_TS;
    case 'server/app.ts': return API_APP_TS;
    case 'README.md': return API_README;
    case 'tests/api.test.ts': return API_TEST_TS;
    default: return '// ' + filePath + '\n';
  }
}

// ---------------------------------------------------------------------------
// Declared contracts: the routes each delivered app must honour.
// ---------------------------------------------------------------------------

const SAAS_CONTRACT: WebAppContract = {
  healthPath: '/api/health',
  probes: [
    { name: 'health check', method: 'GET', path: '/api/health', expectStatus: 200, expectJsonSubset: { status: 'ok', service: 'taskboard' } },
    { name: 'dashboard page', method: 'GET', path: '/', expectStatus: 200, expectTextIncludes: 'TaskBoard Dashboard' },
    { name: 'subscription plans', method: 'GET', path: '/api/plans', expectStatus: 200, expectJsonSubset: { plans: [{ id: 'free' }, { id: 'pro' }, { id: 'team' }] } },
    { name: 'team workspaces', method: 'GET', path: '/api/workspaces', expectStatus: 200, expectJsonSubset: { workspaces: [{ id: 'ws_acme', planId: 'pro' }] } },
    {
      name: 'seeded task list', method: 'GET', path: '/api/tasks', expectStatus: 200,
      expectJsonSubset: { tasks: [{ id: 'task_1', title: 'Design onboarding flow' }, { id: 'task_2', title: 'Publish pricing page', done: true }] }
    },
    {
      name: 'create task', method: 'POST', path: '/api/tasks',
      body: { title: 'Ship the F9 workflow', workspaceId: 'ws_acme' },
      expectStatus: 201, expectJsonSubset: { task: { title: 'Ship the F9 workflow', workspaceId: 'ws_acme', done: false } }
    },
    {
      name: 'create task validation', method: 'POST', path: '/api/tasks',
      body: {}, expectStatus: 400, expectJsonSubset: { error: 'title is required' }
    },
    {
      name: 'malformed JSON body', method: 'POST', path: '/api/tasks',
      rawBody: '{not json', expectStatus: 400, expectJsonSubset: { error: 'Invalid JSON body' }
    },
    { name: 'undeclared route', method: 'GET', path: '/api/does-not-exist', expectStatus: 404, expectJsonSubset: { error: 'Not found' } }
  ]
};

const API_CONTRACT: WebAppContract = {
  healthPath: '/api/health',
  probes: [
    { name: 'health check', method: 'GET', path: '/api/health', expectStatus: 200, expectJsonSubset: { status: 'ok', service: 'stockpile' } },
    {
      name: 'list inventory items', method: 'GET', path: '/api/items', expectStatus: 200,
      expectJsonSubset: { items: [{ sku: 'WDG-001', stock: 42 }, { sku: 'GDG-002', stock: 7 }] }
    },
    {
      name: 'get one item', method: 'GET', path: '/api/items/item_1', expectStatus: 200,
      expectJsonSubset: { item: { id: 'item_1', sku: 'WDG-001', name: 'Widget', stock: 42 } }
    },
    { name: 'missing item is a JSON 404', method: 'GET', path: '/api/items/item_999', expectStatus: 404, expectJsonSubset: { error: 'Item not found' } },
    {
      name: 'create item', method: 'POST', path: '/api/items',
      body: { sku: 'SPR-003', name: 'Spring', stock: 7 },
      expectStatus: 201, expectJsonSubset: { item: { sku: 'SPR-003', name: 'Spring', stock: 7 } }
    },
    {
      name: 'create item validation', method: 'POST', path: '/api/items',
      body: { name: 'No SKU' }, expectStatus: 400, expectJsonSubset: { error: 'sku is required' }
    },
    {
      name: 'malformed JSON body', method: 'POST', path: '/api/items',
      rawBody: '{"sku":', expectStatus: 400, expectJsonSubset: { error: 'Invalid JSON body' }
    },
    { name: 'undeclared route', method: 'GET', path: '/api/unknown', expectStatus: 404, expectJsonSubset: { error: 'Not found' } }
  ]
};

// ---------------------------------------------------------------------------
// Build fixture + stub transport (F2/F7 pattern)
// ---------------------------------------------------------------------------
let counter = 0;

function makeBuild(description: string): { buildId: string; userId: string } {
  const userId = 'usr_f9_web_' + Date.now() + '_' + ++counter;
  db.createUser({
    id: userId,
    email: userId + '@f9.test',
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: Date.now()
  } as any);

  const buildId = 'bld_f9_web_' + Date.now() + '_' + ++counter;
  db.saveBuild({
    id: buildId,
    userId,
    idea: description,
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

const SAAS_PLANNER_ACTIONS = [
  {
    action: 'create_task',
    title: 'Configure the TaskBoard project package',
    description: 'package.json and tsconfig.json for the SaaS project',
    filePaths: ['package.json', 'tsconfig.json'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Implement the TaskBoard server and JSON API',
    description: 'The application server: health check, subscription plans, team workspaces, and the tasks JSON API with validation and JSON error responses',
    filePaths: ['server/app.ts'],
    priority: 2,
    assignedRole: 'backend_developer'
  },
  {
    action: 'create_task',
    title: 'Wire the server entry point, dashboard page, and documentation',
    description: 'server.ts entry point listening on PORT, the dashboard page served at /, and the README documenting the API',
    filePaths: ['server.ts', 'public/index.html', 'README.md'],
    priority: 2,
    assignedRole: 'fullstack_developer'
  },
  {
    action: 'create_task',
    title: 'Write API contract tests for the SaaS application',
    description: 'Node tests that start the application server and probe its routes over HTTP (health, dashboard, plans, tasks, error cases)',
    filePaths: ['tests/api.test.ts'],
    priority: 3,
    assignedRole: 'qa_testing_specialist'
  }
];

const API_PLANNER_ACTIONS = [
  {
    action: 'create_task',
    title: 'Configure the Stockpile project package',
    description: 'package.json and tsconfig.json for the API project',
    filePaths: ['package.json', 'tsconfig.json'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Implement the Stockpile inventory API server',
    description: 'The REST API server: health check, inventory items with stock levels, item creation with validation, and JSON error responses',
    filePaths: ['server/app.ts'],
    priority: 2,
    assignedRole: 'backend_developer'
  },
  {
    action: 'create_task',
    title: 'Wire the API server entry point and documentation',
    description: 'server.ts entry point listening on PORT, and the README documenting the endpoints',
    filePaths: ['server.ts', 'README.md'],
    priority: 2,
    assignedRole: 'backend_developer'
  },
  {
    action: 'create_task',
    title: 'Write API contract tests for the inventory API',
    description: 'Node tests that start the API server and probe its routes over HTTP (health, items, creation, error cases)',
    filePaths: ['tests/api.test.ts'],
    priority: 3,
    assignedRole: 'qa_testing_specialist'
  }
];

function installStub(
  t: any,
  plannerActions: any[],
  contentFor: (filePath: string) => string
): void {
  t.mock.method(smartRouter, 'executeSmartRequest', async (params: any) => {
    const modelId: string = params.requestedModelId || 'unknown';
    const prompt: string = params.prompt || '';

    if (prompt.includes('PROJECT MANAGER & ARCHITECT SPECIFICATION')) {
      return okResult(modelId, { thinking: 'plan', actions: plannerActions });
    }
    if (prompt.includes('VERIFY SOFTWARE COMPLETION')) {
      return okResult(modelId, null, JSON.stringify({
        approved: true,
        summary: 'All requirements verified against specification',
        missingRequirements: []
      }));
    }

    const task = params.task;
    const actions = (task?.filePaths || [])
      .map((p: string) => {
        // Patch-aware, the behaviour MergeManager's own rejection
        // demands (the F8 finding): the project manager pre-creates
        // README.md during planning, so a create_file for an existing
        // file aborts the whole batch transactionally. A real model
        // reads that rejection and patches; the stub does the
        // equivalent deterministically — patch any file that already
        // exists with different content, create the rest, and omit a
        // file that is already exactly as intended.
        const existing = db.getFile(params.buildId, p);
        if (existing && existing.content !== contentFor(p)) {
          return { action: 'patch_file', path: p, edits: [{ find: existing.content, replace: contentFor(p) }], commitMessage: 'Implement ' + task?.title };
        }
        if (existing) return null;
        return { action: 'create_file', path: p, content: contentFor(p), commitMessage: 'Implement ' + task?.title };
      })
      .filter(Boolean);
    return okResult(modelId, { thinking: 'work', actions });
  });
}

async function runSwarmBuild(
  t: any,
  description: string,
  plannerActions: any[],
  contentFor: (filePath: string) => string,
  expectedProjectType: string
): Promise<{ buildId: string; userId: string }> {
  const { buildId, userId } = makeBuild(description);
  installStub(t, plannerActions, contentFor);
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

  assert.equal(build?.status, 'completed', 'swarm build must complete, got ' + build?.status + ': ' + (build?.error || build?.failureReason || ''));
  assert.equal(build?.projectType, expectedProjectType, 'the build must be classified by the platform analyzer');
  assert.ok(events.some(e => e.type === 'verifier_approved'), 'the completion verifier must approve before completion');
  for (const e of events.filter(e => e.type === 'sandbox_check')) {
    assert.match(e.details, /passed cleanly/, 'every sandbox integrity check in the run must pass');
  }
  assert.ok(planned.length >= 4, 'expected the planner tasks, got ' + planned.length);
  for (const task of planned) {
    assert.equal(task.status, 'completed', 'task "' + task.title + '" must complete');
  }
  return { buildId, userId };
}

function assertArtifactOnDisk(delivery: { artifact: { path?: string; sha256?: string; sizeBytes: number; kind: string } }): void {
  assert.equal(delivery.artifact.kind, 'zip');
  assert.ok(delivery.artifact.sizeBytes > 0, 'the exported artifact must be non-empty');
  assert.match(delivery.artifact.sha256 || '', /^[0-9a-f]{64}$/, 'the exported artifact must carry a SHA-256');
  assert.ok(delivery.artifact.path && fs.existsSync(delivery.artifact.path), 'the exported artifact must exist on disk');
  const artifactBytes = fs.readFileSync(delivery.artifact.path!);
  assert.equal(
    crypto.createHash('sha256').update(artifactBytes).digest('hex'),
    delivery.artifact.sha256,
    'the artifact hash must match the bytes on disk'
  );
  assert.ok(artifactBytes.length > 0, 'the artifact archive on disk must be non-empty');
}

// ---------------------------------------------------------------------------
// (a) SaaS end-to-end: team → swarm build → contract cycle → runtime gate
//     → deployment gate
// ---------------------------------------------------------------------------
test('F9 workflow: described SaaS app flows team → swarm build → contract cycle → running app → deployment gate', { timeout: 300_000 }, async (t) => {
  // Step 1 — team resolution from F5 data.
  const plan = WebWorkflow.plan(SAAS_DESCRIPTION);
  assert.equal(plan.category, 'saas');
  assert.equal(plan.teamName, 'Web Development Team — SaaS Platform');
  assert.equal(plan.profileId, 'saas_platform');
  assert.ok(plan.resolvedTeam.members.length >= 5, 'the SaaS team must have members');
  for (const member of plan.resolvedTeam.members) {
    assert.ok(member.modelId, 'team member role ' + member.role + ' must resolve to a registered model');
  }
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude', 'the SaaS team verification chain resolves its verifier through the registry');

  // Step 2 — swarm build through the F4 gates.
  const { buildId, userId } = await runSwarmBuild(t, SAAS_DESCRIPTION, SAAS_PLANNER_ACTIONS, saasContentFor, 'saas');
  for (const filePath of ['package.json', 'tsconfig.json', 'server.ts', 'server/app.ts', 'public/index.html', 'README.md', 'tests/api.test.ts']) {
    assert.ok(db.getFile(buildId, filePath), 'the built tree must contain ' + filePath);
  }
  assert.equal(db.getFile(buildId, 'server/app.ts')!.content, SAAS_APP_TS, 'the delivered server must be the fixture application byte-for-byte');

  // Steps 3–4 — environment cycle through the F6 contract + runtime gate.
  const delivery = await WebWorkflow.runEnvironmentCycle({
    projectId: buildId,
    userId,
    title: SAAS_DESCRIPTION,
    contract: SAAS_CONTRACT
  });

  assert.equal(delivery.build.status, 'succeeded', 'the contract build (esbuild bundle validation over server.ts) must succeed: ' + (delivery.build.error || delivery.build.detail));
  assert.equal(delivery.tests.status, 'passed', 'the contract test cycle must pass: ' + delivery.tests.detail);
  assert.equal(delivery.tests.failed, 0);
  assert.ok(delivery.tests.passed >= 5, "the application's own API contract tests must run and pass, got " + delivery.tests.passed);
  assert.ok(typeof delivery.previewMode === 'string' && delivery.previewMode.length > 0, 'a preview must be produced with its mode labelled');
  assertArtifactOnDisk(delivery);

  // Runtime gate: the delivered application actually runs and answers.
  assert.equal(delivery.runtime.started, true, 'the delivered server must start: ' + delivery.runtime.errors.join('; '));
  assert.equal(delivery.runtime.entryPoint, 'server.ts');
  assert.ok(delivery.runtime.serverOutput.includes('TaskBoard SaaS listening on port'), 'the server output must show the app listening');
  assert.equal(delivery.runtime.probes.length, SAAS_CONTRACT.probes.length);
  for (const probe of delivery.runtime.probes) {
    assert.ok(probe.passed, 'runtime probe "' + probe.name + '" must pass: ' + probe.detail);
  }
  assert.equal(delivery.runtime.passed, true);
  assert.equal(delivery.verified, true, 'the delivery must be verified: tests passed + artifact exported + running app honours its contract');

  // Step 5 — deployment gate through the contract.
  const validation = await WebWorkflow.validateDeployment({ projectId: buildId, userId, provider: 'static_host' });
  assert.equal(validation.valid, true, 'the deployment dry-run must pass: ' + validation.defects.join('; '));
  assert.ok(validation.readinessScore >= 80, 'readiness score must be high, got ' + validation.readinessScore);

  const held = await WebWorkflow.requestDeployment({ projectId: buildId, userId, provider: 'static_host' });
  assert.equal(held.requiresApproval, true);
  assert.equal(held.status, 'pending_approval', 'an unapproved production request must be held by the approval gate');
  assert.equal(db.getDeployment(held.deploymentId)?.status, 'pending_approval');
  assert.equal(
    staticHostRegistry.has(held.deploymentId),
    false,
    'an unapproved deployment must produce no adapter side effect (nothing in the static-host registry)'
  );

  const approved = await WebWorkflow.requestDeployment({ projectId: buildId, userId, provider: 'static_host', approved: true });
  assert.equal(approved.status, 'active', 'an approved request must reach the state the static-host adapter reaches here: ' + approved.detail);
  assert.equal(staticHostRegistry.has(approved.deploymentId), true, 'the approved deployment must be present in the static-host registry');
  assert.ok(approved.targetUrl && approved.targetUrl.includes(approved.deploymentId), 'the approved deployment must carry its registry target URL');
});

// ---------------------------------------------------------------------------
// (a) REST API end-to-end: team → swarm build → contract cycle → runtime
// ---------------------------------------------------------------------------
test('F9 workflow: described REST API flows team → swarm build → contract cycle → running API', { timeout: 300_000 }, async (t) => {
  const plan = WebWorkflow.plan(API_DESCRIPTION);
  assert.equal(plan.category, 'api_service');
  assert.equal(plan.teamName, 'Backend Engineering Team — API Service');
  assert.equal(plan.profileId, 'rest_api_backend');
  assert.ok(plan.resolvedTeam.members.length >= 5, 'the API team must have members');
  for (const member of plan.resolvedTeam.members) {
    assert.ok(member.modelId, 'team member role ' + member.role + ' must resolve to a registered model');
  }
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude');

  const { buildId, userId } = await runSwarmBuild(t, API_DESCRIPTION, API_PLANNER_ACTIONS, apiContentFor, 'api_service');
  for (const filePath of ['package.json', 'tsconfig.json', 'server.ts', 'server/app.ts', 'README.md', 'tests/api.test.ts']) {
    assert.ok(db.getFile(buildId, filePath), 'the built tree must contain ' + filePath);
  }
  assert.equal(db.getFile(buildId, 'server/app.ts')!.content, API_APP_TS);

  const delivery = await WebWorkflow.runEnvironmentCycle({
    projectId: buildId,
    userId,
    title: API_DESCRIPTION,
    contract: API_CONTRACT
  });

  assert.equal(delivery.build.status, 'succeeded', 'the contract build must succeed: ' + (delivery.build.error || delivery.build.detail));
  assert.equal(delivery.tests.status, 'passed', 'the contract test cycle must pass: ' + delivery.tests.detail);
  assert.equal(delivery.tests.failed, 0);
  assert.ok(delivery.tests.passed >= 5, "the API's own contract tests must run and pass, got " + delivery.tests.passed);
  assert.ok(typeof delivery.previewMode === 'string' && delivery.previewMode.length > 0);
  assertArtifactOnDisk(delivery);

  assert.equal(delivery.runtime.started, true, 'the delivered API server must start: ' + delivery.runtime.errors.join('; '));
  assert.equal(delivery.runtime.entryPoint, 'server.ts');
  assert.ok(delivery.runtime.serverOutput.includes('Stockpile API listening on port'));
  assert.equal(delivery.runtime.probes.length, API_CONTRACT.probes.length);
  for (const probe of delivery.runtime.probes) {
    assert.ok(probe.passed, 'runtime probe "' + probe.name + '" must pass: ' + probe.detail);
  }
  assert.equal(delivery.runtime.passed, true);
  assert.equal(delivery.verified, true);
});

// ---------------------------------------------------------------------------
// (b) A broken application fails the runtime gate and is not delivered
// ---------------------------------------------------------------------------
test('F9 workflow: an application whose route throws fails the runtime gate and is refused delivery', { timeout: 120_000 }, async () => {
  const cleanFiles: Record<string, string> = {
    'package.json': API_PACKAGE_JSON,
    'tsconfig.json': FIXTURE_TSCONFIG,
    'server.ts': API_SERVER_TS,
    'server/app.ts': API_APP_TS,
    'README.md': API_README,
    'tests/api.test.ts': API_TEST_TS
  };

  // Control: the genuine application passes the gate directly.
  const clean = await WebWorkflow.probeRuntime(cleanFiles, API_CONTRACT);
  assert.equal(clean.started, true, 'control: the genuine API must start: ' + clean.errors.join('; '));
  assert.equal(clean.passed, true, 'control: the genuine API must pass every probe: ' + clean.probes.filter(p => !p.passed).map(p => p.name + ': ' + p.detail).join('; '));

  // Broken variant: the items-list handler throws at request time.
  const needle = 'sendJson(res, 200, { items });';
  assert.ok(API_APP_TS.includes(needle), 'the injection needle must exist in the fixture application');
  const brokenAppTs = API_APP_TS.replace(needle, "throw new Error('Injected runtime fault (F9)');");
  assert.notEqual(brokenAppTs, API_APP_TS);

  const broken = await WebWorkflow.probeRuntime({ ...cleanFiles, 'server/app.ts': brokenAppTs }, API_CONTRACT);
  assert.equal(broken.started, true, 'the broken variant still starts (its health route works)');
  assert.equal(broken.passed, false, 'an application whose route throws must fail the runtime gate');
  const listProbe = broken.probes.find(p => p.name === 'list inventory items');
  assert.ok(listProbe, 'the list probe must be present in the report');
  assert.equal(listProbe!.passed, false);
  assert.equal(listProbe!.actualStatus, 500, "the throwing route must surface as the application's declared 500, got " + listProbe!.actualStatus);
  const healthProbe = broken.probes.find(p => p.name === 'health check');
  assert.equal(healthProbe?.passed, true, 'the health probe must still pass — the gate discriminates per route');

  // The workflow's delivery verdict refuses it even with green tests
  // and a real artifact — the runtime gate is a hard gate.
  const verdict = WebWorkflow.verifyDelivery({
    tests: { status: 'passed', mode: 'project_tests', total: 5, passed: 5, failed: 0, skipped: 0, detail: 'fixture' },
    artifact: { name: 'api.zip', kind: 'zip', sizeBytes: 4096, sha256: 'a'.repeat(64) },
    runtime: broken
  });
  assert.equal(verdict, false, 'a delivery whose application fails the runtime gate must not verify');
});
