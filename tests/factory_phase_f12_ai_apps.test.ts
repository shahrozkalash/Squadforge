/**
 * Factory Phase F12 — AI Applications workflow.
 *
 * A described AI application — an application that itself calls AI
 * models at runtime — flows through the factory machinery as a
 * single workflow:
 *
 *   description → F5 team by data (AiWorkflow.plan; the
 *                 ai_application category, its generation profile,
 *                 and its team are data registered by this phase —
 *                 none existed before F12)
 *               → swarm build (the real SwarmOrchestrator chain —
 *                 planner → tasks → parallel workers → sandbox gate →
 *                 verifier → integration → honest verification — over
 *                 a stub transport, the F2–F4 seam)
 *               → F6 environment cycle (AiWorkflow.runEnvironmentCycle:
 *                 the built project opened through the one
 *                 FactoryEnvironment contract, web adapter; build /
 *                 test / preview / export via contract operations
 *                 only)
 *               → AI gate (probeAiAppBehaviour: the delivered
 *                 application is started for real and probed over
 *                 HTTP in three runs — (1) no provider configured:
 *                 the non-AI surface works and the AI endpoint fails
 *                 loudly with the router's named NO_PROVIDER error,
 *                 never a fabricated answer; (2)+(3) provider
 *                 transport stubbed through the Phase 33 seam
 *                 (OPENROUTER_BASE_URL + a dummy key): the AI
 *                 endpoint completes a real round trip through the
 *                 application's own code path and the platform's
 *                 real gateway/router code, once per configured
 *                 model id — gpt-4o, then deepseek — proving the
 *                 provider changes with configuration alone)
 *
 * The delivered application (DocuChat, a document Q&A chat app)
 * calls the platform gateway through its bridge module
 * (server/platformAi.ts): the host injects the gateway module path
 * (SQUADFORGE_GATEWAY_MODULE) and provider configuration into the
 * application process; the application holds no provider key and no
 * provider SDK. The stub transport stands in for the provider's
 * HTTP endpoint only — the router, registry, and gateway code that
 * execute are the platform's real ones. No live model exists in
 * this environment (F1 verdict); this suite proves the workflow
 * machinery, the application's honest failure, and its wiring
 * against the real router — and labels the fixture content as a
 * test fixture, not live model output.
 *
 * Generated fixture files are this repository's own trusted test
 * content, so the execution adapter may run them on the host.
 */
process.env.SQUADFORGE_TRUSTED_HOST_TESTS = '1';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { db } from '../server/store.js';
import { smartRouter } from '../server/smartRouter.js';
import { SwarmOrchestrator } from '../server/swarm/swarmOrchestrator.js';
import { ApprovalGateService } from '../server/swarm/approvalGateService.js';
import { CategoryTeamRegistry } from '../server/swarm/categoryTeams.js';
import { GenerationProfileRegistry } from '../server/swarm/generationProfiles.js';
import { SoftwareRequirementsAnalyzer } from '../server/architecture/requirementsAnalyzer.js';
import { modelRegistry } from '../server/modelRegistry.js';
import { CANONICAL_PROJECT_TYPES, normalizeProjectType } from '../server/types.js';
import { AiWorkflow, platformGatewayModulePath } from '../server/application/aiWorkflow.js';
import { probeAiAppBehaviour, type AiAppContract } from '../server/application/aiAppGate.js';

const AI_DESCRIPTION =
  'Build an AI chat application for team documents: a chat page where users ask questions and an AI model answers from the document set, with a JSON API for documents and chat';

/** The stub transport's answer; the round trip must return it verbatim. */
const STUB_ANSWER = 'The refund window is 30 days from purchase. [stub transport answer]';

// ---------------------------------------------------------------------------
// Stub provider transport (the Phase 33 seam): a local HTTP server
// standing in for the OpenRouter endpoint. The platform router's real
// fetch transport is pointed at it by configuration
// (OPENROUTER_BASE_URL); every request is recorded so the suite can
// assert which upstream model the router actually called.
// ---------------------------------------------------------------------------
const stubSeen: Array<{ url: string; model: string; hasAuth: boolean }> = [];
const stubServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf-8'); });
  req.on('end', () => {
    let model = '';
    try { model = JSON.parse(raw || '{}')?.model || ''; } catch { /* recorded as empty */ }
    stubSeen.push({ url: req.url || '', model, hasAuth: typeof req.headers.authorization === 'string' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ report: { answer: STUB_ANSWER } }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    }));
  });
});
let stubBaseUrl = '';

async function ensureStubProvider(): Promise<{ baseUrl: string; apiKey: string }> {
  if (!stubBaseUrl) {
    const port = await new Promise<number>((resolve) => {
      stubServer.listen(0, '127.0.0.1', () => resolve((stubServer.address() as AddressInfo).port));
    });
    stubBaseUrl = `http://127.0.0.1:${port}/v1`;
  }
  return { baseUrl: stubBaseUrl, apiKey: 'f12-stub-provider-key' };
}

after(() => {
  (stubServer as any)?.closeAllConnections?.();
  stubServer.close();
});

// ---------------------------------------------------------------------------
// Fixture: DocuChat — a document Q&A AI application. A small
// dependency-free TypeScript HTTP service (node:http only) in the
// ConnectedApplicationPlanner topology shape, whose AI endpoint
// calls the platform gateway through its bridge module.
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

const AI_PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'docuchat-ai',
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'DocuChat — an AI chat application that answers questions about team documents through the SquadForge platform AI gateway.',
      scripts: { start: 'tsx server.ts', test: 'node --test tests/' }
    },
    null,
    2
  ) + '\n';

const AI_SERVER_TS = `import { createApp } from './server/app.js';

const port = Number(process.env.PORT || 3000);
const server = createApp();
server.listen(port, () => {
  console.log('DocuChat AI listening on port ' + port);
});
`;

const AI_PLATFORM_TS = `import { pathToFileURL } from 'node:url';

/**
 * DocuChat's bridge to the SquadForge platform AI gateway.
 *
 * The application holds no provider key and no provider SDK. The
 * hosting platform injects its gateway module through the
 * SQUADFORGE_GATEWAY_MODULE environment variable; this bridge loads
 * that module and calls callUnifiedGateway, so the model is chosen
 * by configuration (AI_MODEL_ID) and routed by the platform's
 * registry and smart router. Provider failures come back as the
 * router's named errors and are surfaced to the caller unchanged —
 * this bridge never invents an answer.
 */
export interface AiAnswer {
  ok: true;
  answer: string;
  model: string;
  provider: string;
}

export interface AiFailure {
  ok: false;
  error: string;
  errorCode: string;
  model: string;
}

export type AiResult = AiAnswer | AiFailure;

let gatewayPromise: Promise<any> | null = null;

function loadGateway(): Promise<any> {
  const modulePath = process.env.SQUADFORGE_GATEWAY_MODULE;
  if (!modulePath) {
    const err: any = new Error(
      'SQUADFORGE_GATEWAY_MODULE is not set: the hosting platform has not provided its AI gateway module to this application.'
    );
    err.errorCode = 'GATEWAY_NOT_CONFIGURED';
    return Promise.reject(err);
  }
  if (!gatewayPromise) {
    gatewayPromise = import(pathToFileURL(modulePath).href);
  }
  return gatewayPromise;
}

// Warm the gateway module at startup when the host provided it, so
// the first chat request does not pay the platform import cost. A
// load failure is not fatal here: askAi surfaces it by name.
if (process.env.SQUADFORGE_GATEWAY_MODULE) {
  loadGateway().catch(() => undefined);
}

export async function askAi(question: string, context: string): Promise<AiResult> {
  const modelId = process.env.AI_MODEL_ID || 'gpt-4o';
  let gateway: any;
  try {
    gateway = await loadGateway();
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
      errorCode: err?.errorCode || 'GATEWAY_NOT_CONFIGURED',
      model: modelId
    };
  }

  const result = await gateway.callUnifiedGateway({
    modelId,
    systemInstruction:
      'You are DocuChat, an assistant that answers questions strictly from the provided documents. ' +
      'Answer only as JSON in the form {"report": {"answer": "<answer>"}}. ' +
      'If the documents do not contain the answer, say so plainly in the answer.',
    prompt:
      'Documents:\\n' + context + '\\n\\nQuestion: ' + question +
      '\\n\\nAnswer as JSON in the form {"report": {"answer": "<answer>"}}.',
    allowFallback: false,
    allowReportOnly: true,
    bypassCache: true,
    taskComplexity: 'standard',
    maxTokens: 1024
  });

  if (!result.success) {
    return {
      ok: false,
      error: result.error || 'The AI provider call failed.',
      errorCode: result.errorCode || 'PROVIDER_ERROR',
      model: modelId
    };
  }
  const answer = result.parsedResponse?.report?.answer;
  if (typeof answer !== 'string' || !answer.trim()) {
    return {
      ok: false,
      error: 'The AI provider returned no usable answer.',
      errorCode: 'MALFORMED_OUTPUT',
      model: modelId
    };
  }
  return { ok: true, answer, model: result.actualModelUsed, provider: result.providerUsed };
}
`;

const AI_APP_TS = `import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askAi } from './platformAi.js';

interface DocRecord {
  id: string;
  title: string;
  text: string;
}

const documents: DocRecord[] = [
  {
    id: 'doc_1',
    title: 'Refund Policy',
    text: 'Customers can request a full refund within 30 days of purchase. Refunds are issued to the original payment method within 5 business days.'
  },
  {
    id: 'doc_2',
    title: 'Support Hours',
    text: 'The support team is available Monday to Friday, 9:00 to 17:00 Pakistan Time. Urgent outages are handled around the clock.'
  }
];

let nextDocNumber = 3;

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

function chatPageHtml(): string {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
  return fs.readFileSync(filePath, 'utf-8');
}

function documentContext(): string {
  return documents.map((d) => '## ' + d.title + '\\n' + d.text).join('\\n\\n');
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = (req.method || 'GET').toUpperCase();
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok', service: 'docuchat', timestamp: Date.now() });
    return;
  }
  if (method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(chatPageHtml());
    return;
  }
  if (method === 'GET' && pathname === '/api/documents') {
    sendJson(res, 200, { documents });
    return;
  }
  if (method === 'GET' && pathname.startsWith('/api/documents/')) {
    const id = pathname.slice('/api/documents/'.length);
    const document = id && !id.includes('/') ? documents.find((entry) => entry.id === id) : undefined;
    if (!document) {
      sendJson(res, 404, { error: 'Document not found' });
      return;
    }
    sendJson(res, 200, { document });
    return;
  }
  if (method === 'POST' && pathname === '/api/documents') {
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
    const text = typeof parsed.value?.text === 'string' ? parsed.value.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'text is required' });
      return;
    }
    const document: DocRecord = { id: 'doc_' + nextDocNumber++, title, text };
    documents.push(document);
    sendJson(res, 201, { document });
    return;
  }
  if (method === 'POST' && pathname === '/api/chat') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const question = typeof parsed.value?.question === 'string' ? parsed.value.question.trim() : '';
    if (!question) {
      sendJson(res, 400, { error: 'question is required' });
      return;
    }
    const ai = await askAi(question, documentContext());
    if (!ai.ok) {
      // The provider layer's named failure, surfaced unchanged. The
      // application never substitutes a canned answer.
      sendJson(res, 503, { error: ai.error, errorCode: ai.errorCode, model: ai.model });
      return;
    }
    sendJson(res, 200, { answer: ai.answer, model: ai.model, provider: ai.provider });
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

const AI_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DocuChat — Ask your documents</title>
</head>
<body>
<header>
<h1>DocuChat</h1>
<p>Ask questions about your team documents and get answers from the AI, grounded in the document set.</p>
</header>
<main>
<section>
<h2>Chat</h2>
<form id="chat-form">
<label for="question">Your question</label>
<input id="question" name="question" type="text" placeholder="What is the refund window?" />
<button type="submit">Ask</button>
</form>
<p id="answer"></p>
</section>
<section>
<h2>Documents</h2>
<p>The document set is served as JSON at /api/documents; answers are grounded in those documents.</p>
</section>
</main>
<script>
document.getElementById('chat-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = document.getElementById('question').value;
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question })
  });
  const body = await res.json();
  document.getElementById('answer').textContent = res.ok ? body.answer : ('Error: ' + body.error);
});
</script>
</body>
</html>
`;

const AI_README = `# DocuChat — AI chat over team documents

An AI chat application: users ask questions on the chat page and an
AI model answers from the document set, through a JSON API for
documents and chat.

## Running

- \`npm start\` starts the server (PORT env, default 3000).
- \`npm test\` runs the API contract tests in tests/.

## JSON API

- \`GET /api/health\` — health and readiness check.
- \`GET /\` — the chat page.
- \`GET /api/documents\` — list the documents in the set.
- \`GET /api/documents/:id\` — one document; 404 with a JSON error when absent.
- \`POST /api/documents\` — add a document ({ "title": string, "text": string });
  answers 201 with the created document, 400 when the title or text
  is missing or the body is not valid JSON.
- \`POST /api/chat\` — ask a question ({ "question": string }); answers
  200 with { "answer", "model", "provider" } from the AI provider,
  400 when the question is missing, and 503 with the provider's
  named error when no AI provider is available.

Unknown routes answer 404 with a JSON error body. Data is held in
memory by the server process.

## Data export/import functionality

DocuChat's data export/import functionality is its JSON API: a
client exports the document set by reading it as JSON
(GET /api/documents, GET /api/documents/:id) and imports documents
by sending JSON to POST /api/documents, which validates the body
and answers 400 with a JSON error when the data is malformed or
incomplete.

## AI provider behaviour

DocuChat holds no provider key and no provider SDK. Its AI answers
come from the SquadForge platform gateway (server/platformAi.ts):
the hosting platform injects its gateway module, the model is
configuration (AI_MODEL_ID, default gpt-4o), and the platform's
registry and smart router choose the provider. When no provider
key is configured in the host environment, the chat endpoint
answers 503 with the router's named error (for example, that the
model requires OPENROUTER_API_KEY) — the application never
fabricates or caches a canned answer in place of the AI.
`;

const AI_TEST_TS = `import { test, before, after } from 'node:test';
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
  assert.equal(body.service, 'docuchat');
});

test('chat page serves the DocuChat HTML', async () => {
  const res = await fetch(baseUrl + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('DocuChat'));
});

test('documents list, get, and missing-document 404', async () => {
  const listRes = await fetch(baseUrl + '/api/documents');
  assert.equal(listRes.status, 200);
  const listBody: any = await listRes.json();
  assert.equal(listBody.documents.length, 2);
  assert.equal(listBody.documents[0].title, 'Refund Policy');

  const oneRes = await fetch(baseUrl + '/api/documents/doc_2');
  assert.equal(oneRes.status, 200);
  const oneBody: any = await oneRes.json();
  assert.equal(oneBody.document.title, 'Support Hours');

  const missingRes = await fetch(baseUrl + '/api/documents/doc_999');
  assert.equal(missingRes.status, 404);
  const missingBody: any = await missingRes.json();
  assert.equal(missingBody.error, 'Document not found');
});

test('adds a document and rejects invalid bodies', async () => {
  const createRes = await fetch(baseUrl + '/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Holiday Schedule', text: 'The office closes on public holidays.' })
  });
  assert.equal(createRes.status, 201);
  const createBody: any = await createRes.json();
  assert.equal(createBody.document.title, 'Holiday Schedule');

  const invalidRes = await fetch(baseUrl + '/api/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'No title' })
  });
  assert.equal(invalidRes.status, 400);
  const invalidBody: any = await invalidRes.json();
  assert.equal(invalidBody.error, 'title is required');
});

test('chat requires a question', async () => {
  const res = await fetch(baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(res.status, 400);
  const body: any = await res.json();
  assert.equal(body.error, 'question is required');
});

test('chat with no AI provider configured fails loudly and fabricates nothing', async () => {
  // The application's own honesty contract: with no provider
  // available, the chat endpoint must answer 503 with a named
  // error and must not present any canned text as an AI answer.
  const res = await fetch(baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is the refund window?' })
  });
  assert.equal(res.status, 503);
  const body: any = await res.json();
  assert.equal(body.answer, undefined, 'no answer may be presented when the provider is unavailable');
  assert.ok(typeof body.errorCode === 'string' && body.errorCode.length > 0, 'the failure must carry a named error code');
  assert.ok(typeof body.error === 'string' && body.error.length > 0, 'the failure must carry a named error message');
});

test('unknown routes are a JSON 404', async () => {
  const res = await fetch(baseUrl + '/api/unknown');
  assert.equal(res.status, 404);
  const body: any = await res.json();
  assert.equal(body.error, 'Not found');
});
`;

function aiContentFor(filePath: string): string {
  switch (filePath) {
    case 'package.json': return AI_PACKAGE_JSON;
    case 'tsconfig.json': return FIXTURE_TSCONFIG;
    case 'server.ts': return AI_SERVER_TS;
    case 'server/app.ts': return AI_APP_TS;
    case 'server/platformAi.ts': return AI_PLATFORM_TS;
    case 'public/index.html': return AI_INDEX_HTML;
    case 'README.md': return AI_README;
    case 'tests/api.test.ts': return AI_TEST_TS;
    default: return '// ' + filePath + '\n';
  }
}

const AI_FILES: Record<string, string> = {
  'package.json': AI_PACKAGE_JSON,
  'tsconfig.json': FIXTURE_TSCONFIG,
  'server.ts': AI_SERVER_TS,
  'server/app.ts': AI_APP_TS,
  'server/platformAi.ts': AI_PLATFORM_TS,
  'public/index.html': AI_INDEX_HTML,
  'README.md': AI_README,
  'tests/api.test.ts': AI_TEST_TS
};

// ---------------------------------------------------------------------------
// Declared contract: the surface and AI behaviour the gate asserts.
// ---------------------------------------------------------------------------

const AI_CONTRACT: AiAppContract = {
  healthPath: '/api/health',
  surfaceProbes: [
    { name: 'health check', method: 'GET', path: '/api/health', expectStatus: 200, expectJsonSubset: { status: 'ok', service: 'docuchat' } },
    { name: 'chat page', method: 'GET', path: '/', expectStatus: 200, expectTextIncludes: 'DocuChat' },
    {
      name: 'document list', method: 'GET', path: '/api/documents', expectStatus: 200,
      expectJsonSubset: { documents: [{ id: 'doc_1', title: 'Refund Policy' }, { id: 'doc_2', title: 'Support Hours' }] }
    },
    {
      name: 'get one document', method: 'GET', path: '/api/documents/doc_1', expectStatus: 200,
      expectJsonSubset: { document: { id: 'doc_1', title: 'Refund Policy' } }
    },
    { name: 'missing document is a JSON 404', method: 'GET', path: '/api/documents/doc_999', expectStatus: 404, expectJsonSubset: { error: 'Document not found' } },
    {
      name: 'add a document', method: 'POST', path: '/api/documents',
      body: { title: 'Holiday Schedule', text: 'The office closes on public holidays.' },
      expectStatus: 201, expectJsonSubset: { document: { title: 'Holiday Schedule' } }
    },
    {
      name: 'chat validation', method: 'POST', path: '/api/chat',
      body: {}, expectStatus: 400, expectJsonSubset: { error: 'question is required' }
    },
    { name: 'undeclared route', method: 'GET', path: '/api/does-not-exist', expectStatus: 404, expectJsonSubset: { error: 'Not found' } }
  ],
  chatPath: '/api/chat',
  chatBody: { question: 'What is the refund window for purchases?' },
  chatProbeName: 'AI chat endpoint',
  noProviderErrorIncludes: 'OPENROUTER_API_KEY'
};

// ---------------------------------------------------------------------------
// Build fixture + stub transport for the swarm build (F2/F9 pattern)
// ---------------------------------------------------------------------------
let counter = 0;

function makeBuild(description: string): { buildId: string; userId: string } {
  const userId = 'usr_f12_ai_' + Date.now() + '_' + ++counter;
  db.createUser({
    id: userId,
    email: userId + '@f12.test',
    name: userId,
    githubConnected: false,
    costLimitPerBuild: 25,
    enabledModelIds: ['gemini', 'claude', 'deepseek'],
    createdAt: Date.now()
  } as any);

  const buildId = 'bld_f12_ai_' + Date.now() + '_' + ++counter;
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

const AI_PLANNER_ACTIONS = [
  {
    action: 'create_task',
    title: 'Configure the DocuChat project package',
    description: 'package.json and tsconfig.json for the AI application project',
    filePaths: ['package.json', 'tsconfig.json'],
    priority: 3,
    assignedRole: 'devops_release_specialist'
  },
  {
    action: 'create_task',
    title: 'Implement the DocuChat server, document store, and platform AI gateway bridge',
    description: 'The application server: health check, chat page data, the documents JSON API, the chat endpoint, and the bridge that calls the platform AI gateway for answers',
    filePaths: ['server/app.ts', 'server/platformAi.ts'],
    priority: 2,
    assignedRole: 'backend_developer'
  },
  {
    action: 'create_task',
    title: 'Wire the server entry point, chat page, and documentation',
    description: 'server.ts entry point listening on PORT, the chat page served at /, and the README documenting the API and the AI provider behaviour',
    filePaths: ['server.ts', 'public/index.html', 'README.md'],
    priority: 2,
    assignedRole: 'fullstack_developer'
  },
  {
    action: 'create_task',
    title: 'Write API contract tests for the AI application',
    description: 'Node tests that start the application server and probe its routes over HTTP (health, documents, chat validation, and the no-provider chat failure)',
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
        // demands (the F8/F9 finding): the project manager pre-creates
        // README.md during planning, so a create_file for an existing
        // file aborts the whole batch transactionally.
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
// (0) The category, profile, and team are data (registered by F12)
// ---------------------------------------------------------------------------
test('F12 data: the ai_application category, generation profile, and team resolve from data', () => {
  // The canonical category exists and normalizes to itself.
  assert.ok(CANONICAL_PROJECT_TYPES.includes('ai_application'), 'ai_application must be a canonical project type');
  assert.equal(normalizeProjectType('ai_application'), 'ai_application');
  assert.equal(CANONICAL_PROJECT_TYPES.length, 25, 'the canonical list grew by exactly the one F12 category');

  // Exactly one team per canonical category still holds (F5 invariant).
  assert.equal(CategoryTeamRegistry.getAll().length, CANONICAL_PROJECT_TYPES.length,
    'exactly one team per canonical category');

  // The generation profile is registered data.
  const profile = GenerationProfileRegistry.getAll().find(p => p.id === 'ai_application');
  assert.ok(profile, 'the ai_application generation profile must be registered');
  assert.equal(profile!.category, 'AI');

  // Classification: the analyzer and the profile matcher agree.
  assert.equal(SoftwareRequirementsAnalyzer.detectCategory(AI_DESCRIPTION.toLowerCase()), 'ai_application');
  assert.equal(GenerationProfileRegistry.matchProfileForRequest(AI_DESCRIPTION).id, 'ai_application');

  // The workflow plan resolves the AI team from data.
  const plan = AiWorkflow.plan(AI_DESCRIPTION);
  assert.equal(plan.category, 'ai_application');
  assert.equal(plan.teamName, 'AI Application Team');
  assert.equal(plan.profileId, 'ai_application');
  assert.ok(plan.resolvedTeam.members.length >= 5, 'the AI team must have members');
  for (const member of plan.resolvedTeam.members) {
    assert.ok(member.modelId, 'team member role ' + member.role + ' must resolve to a registered model');
  }
  assert.equal(plan.resolvedTeam.verifierModelId, 'claude', 'the AI team verification chain resolves its verifier through the registry');

  // The two swap models are registered with distinct upstream ids.
  assert.equal(modelRegistry.getById('gpt-4o')?.providerModel, 'openai/gpt-4o');
  assert.equal(modelRegistry.getById('deepseek')?.providerModel, 'deepseek/deepseek-chat');
});

// ---------------------------------------------------------------------------
// (a)+(b)+(c) End-to-end: team → swarm build → contract cycle → AI gate
// ---------------------------------------------------------------------------
test('F12 workflow: described AI app flows team → swarm build → contract cycle → honest AI gate with stub round trips', { timeout: 600_000 }, async (t) => {
  const stubProvider = await ensureStubProvider();
  const seenBefore = stubSeen.length;

  // Step 1 — team resolution from F5 data.
  const plan = AiWorkflow.plan(AI_DESCRIPTION);
  assert.equal(plan.category, 'ai_application');
  assert.equal(plan.teamName, 'AI Application Team');
  assert.equal(plan.profileId, 'ai_application');

  // Step 2 — swarm build through the F4 gates.
  const { buildId, userId } = await runSwarmBuild(t, AI_DESCRIPTION, AI_PLANNER_ACTIONS, aiContentFor, 'ai_application');
  for (const filePath of ['package.json', 'tsconfig.json', 'server.ts', 'server/app.ts', 'server/platformAi.ts', 'public/index.html', 'README.md', 'tests/api.test.ts']) {
    assert.ok(db.getFile(buildId, filePath), 'the built tree must contain ' + filePath);
  }
  assert.equal(db.getFile(buildId, 'server/app.ts')!.content, AI_APP_TS, 'the delivered server must be the fixture application byte-for-byte');
  assert.equal(db.getFile(buildId, 'server/platformAi.ts')!.content, AI_PLATFORM_TS, 'the delivered bridge must be the fixture bridge byte-for-byte');

  // Steps 3–4 — environment cycle through the F6 contract + AI gate,
  // with a stub round trip per configured model id.
  const delivery = await AiWorkflow.runEnvironmentCycle({
    projectId: buildId,
    userId,
    title: AI_DESCRIPTION,
    contract: AI_CONTRACT,
    stubProvider,
    modelIds: ['gpt-4o', 'deepseek']
  });

  assert.equal(delivery.build.status, 'succeeded', 'the contract build (esbuild bundle validation over server.ts) must succeed: ' + (delivery.build.error || delivery.build.detail));
  assert.equal(delivery.tests.status, 'passed', 'the contract test cycle must pass: ' + delivery.tests.detail);
  assert.equal(delivery.tests.failed, 0);
  assert.ok(delivery.tests.passed >= 6, "the application's own API contract tests must run and pass, got " + delivery.tests.passed);
  assert.ok(typeof delivery.previewMode === 'string' && delivery.previewMode.length > 0, 'a preview must be produced with its mode labelled');
  assertArtifactOnDisk(delivery);

  // AI gate, run 1 — no provider configured.
  const gate = delivery.aiGate;
  assert.equal(gate.noProviderRun.started, true, 'the delivered app must start: ' + gate.noProviderRun.errors.join('; '));
  assert.equal(gate.noProviderRun.entryPoint, 'server.ts');
  assert.ok(gate.noProviderRun.serverOutput.includes('DocuChat AI listening on port'), 'the server output must show the app listening');
  for (const probe of gate.noProviderRun.probes) {
    assert.ok(probe.passed, 'no-provider probe "' + probe.name + '" must pass: ' + probe.detail);
  }
  assert.equal(gate.noProvider.status, 503, 'the AI endpoint must answer 503 with no provider configured');
  assert.equal(gate.noProvider.errorCode, 'NO_PROVIDER', "the failure must carry the router's NO_PROVIDER error code");
  assert.ok(gate.noProvider.error?.includes('OPENROUTER_API_KEY'), 'the failure must name the missing key, got: ' + gate.noProvider.error);
  assert.ok(gate.noProvider.error?.includes('GPT-4o (Project Manager)'), 'the failure must name the configured model, got: ' + gate.noProvider.error);
  assert.equal(gate.noProvider.fabricatedAnswer, false, 'no answer may be fabricated in the no-provider run');
  assert.equal(gate.noProvider.passed, true, gate.noProvider.detail);

  // AI gate, runs 2–3 — stub round trips, one per configured model.
  assert.equal(gate.stubRuns.length, 2);
  const [gptRun, deepseekRun] = gate.stubRuns;
  assert.equal(gptRun.modelId, 'gpt-4o');
  assert.equal(gptRun.passed, true, gptRun.detail);
  assert.equal(gptRun.status, 200);
  assert.equal(gptRun.answer, STUB_ANSWER, 'the round trip must return the transport answer verbatim');
  assert.equal(gptRun.actualModelUsed, 'openai/gpt-4o', 'the app must report the registry upstream id for gpt-4o');
  assert.equal(gptRun.providerUsed, 'openrouter');
  assert.equal(deepseekRun.modelId, 'deepseek');
  assert.equal(deepseekRun.passed, true, deepseekRun.detail);
  assert.equal(deepseekRun.answer, STUB_ANSWER);
  assert.equal(deepseekRun.actualModelUsed, 'deepseek/deepseek-chat', 'changing AI_MODEL_ID alone must change the upstream model');

  // The stub transport itself recorded the swap: same delivered
  // files, two different upstream model ids, both authenticated
  // with the injected dummy key.
  const roundTripCalls = stubSeen.slice(seenBefore);
  assert.deepEqual(roundTripCalls.map(c => c.model), ['openai/gpt-4o', 'deepseek/deepseek-chat'],
    'the stub transport must have been called once per configured model, in order');
  for (const call of roundTripCalls) {
    assert.equal(call.url, '/v1/chat/completions');
    assert.equal(call.hasAuth, true, 'the router must send the injected key to the transport');
  }

  assert.equal(gate.passed, true, 'the AI gate must pass: ' + gate.errors.join('; '));
  assert.equal(delivery.verified, true, 'the delivery must be verified: tests passed + artifact exported + AI gate passed');
});

// ---------------------------------------------------------------------------
// Negative: an AI endpoint that fabricates a canned answer fails the
// gate — the absence of the named error is itself the failure.
// ---------------------------------------------------------------------------
test('F12 gate: an application that fabricates a canned AI answer fails the gate and is refused delivery', { timeout: 300_000 }, async () => {
  const stubProvider = await ensureStubProvider();

  // Control: the genuine application passes the gate directly.
  const clean = await probeAiAppBehaviour(AI_FILES, AI_CONTRACT, {
    gatewayModulePath: platformGatewayModulePath(),
    stubProvider,
    modelIds: ['gpt-4o']
  });
  assert.equal(clean.passed, true, 'control: the genuine application must pass the gate: ' +
    clean.errors.join('; ') + ' | ' + clean.noProvider.detail + ' | ' + clean.stubRuns.map(r => r.detail).join('; '));

  // Fabricating variant: the chat handler never calls the gateway;
  // it returns a hardcoded answer as if the AI had responded.
  const needle = 'const ai = await askAi(question, documentContext());';
  assert.ok(AI_APP_TS.includes(needle), 'the injection needle must exist in the fixture application');
  const fabricatingAppTs = AI_APP_TS.replace(
    needle,
    "const ai: any = { ok: true, answer: 'The refund window is 30 days from purchase.', model: 'canned-local', provider: 'canned' };"
  );
  assert.notEqual(fabricatingAppTs, AI_APP_TS);

  const gate = await probeAiAppBehaviour(
    { ...AI_FILES, 'server/app.ts': fabricatingAppTs },
    AI_CONTRACT,
    { gatewayModulePath: platformGatewayModulePath(), stubProvider, modelIds: ['gpt-4o'] }
  );

  assert.equal(gate.noProvider.status, 200, 'the fabricating variant answers 200 even with no provider configured');
  assert.equal(gate.noProvider.fabricatedAnswer, true, 'the gate must identify the canned text as a fabricated answer');
  assert.equal(gate.noProvider.passed, false, 'the no-provider run must fail: the named error is absent');
  assert.equal(gate.passed, false, 'a fabricating application must fail the AI gate');

  // The workflow's delivery verdict refuses it even with green tests
  // and a real artifact — the AI gate is a hard gate.
  const verdict = AiWorkflow.verifyDelivery({
    tests: { status: 'passed', mode: 'project_tests', total: 7, passed: 7, failed: 0, skipped: 0, detail: 'fixture' },
    artifact: { name: 'ai.zip', kind: 'zip', sizeBytes: 4096, sha256: 'a'.repeat(64) },
    aiGate: gate
  });
  assert.equal(verdict, false, 'a delivery whose application fabricates AI output must not verify');
});
