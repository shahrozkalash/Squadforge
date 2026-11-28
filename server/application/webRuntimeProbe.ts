import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionAdapter } from '../swarm/executionAdapter.js';

/**
 * Factory Phase F9 — live runtime probe for generated web/SaaS/API
 * applications.
 *
 * Before F9, the platform's runtime verification was static:
 * BrowserRuntimeVerifier inspects the preview HTML's structure, and
 * PreviewGenerator compiles in-process with a self-labelled mode —
 * neither one serves the generated application's real HTTP responses.
 * (The Docker preview sessions that would are unavailable in this
 * environment; the configured execution backend is the disabled,
 * fail-closed one.) This module is the web workflow's runtime gate,
 * in the same lineage as F7's playability checker: it takes a built
 * project's files and returns a verdict from actually executing the
 * delivered application — the server is started on an ephemeral
 * loopback port and its declared routes are probed over real HTTP.
 *
 * How it runs the app: the project's files are materialized into a
 * fresh temporary directory (paths sanitized by the platform's own
 * ExecutionAdapter.sanitizeFilePath), and the entry point
 * (server.ts / server.js / index.js / src/server.*) is spawned the
 * way the platform itself runs TypeScript — the repository's own
 * tsx binary for .ts entries, plain node for .js entries — with a
 * scrubbed environment in the ExecutionAdapter test gate's pattern
 * (PATH, NODE_ENV, HOME/TEMP/TMP pointed at the temp dir, plus the
 * allocated PORT; no application secrets are passed). The child is
 * always terminated (SIGTERM, then SIGKILL) and the directory is
 * always removed. Readiness is the contract's health route answering
 * 200; every probe asserts status and, where declared, a JSON subset
 * or a body substring — a route that throws, a missing route, or a
 * wrong error shape fails its probe by name.
 *
 * Scope honesty: this is a verification harness for applications the
 * platform itself built, run briefly on loopback — it is not a
 * hosting environment. Production hosting of user applications
 * remains the ExecutionBackend / preview-session path.
 */

export type WebAppFileInput =
  | Record<string, string>
  | Array<{ path: string; content: string }>;

export interface WebRouteProbe {
  /** Human-readable probe name, used in the report and failures. */
  name: string;
  method: string;
  path: string;
  /** JSON-serializable request body (sent as application/json). */
  body?: unknown;
  /** Verbatim request body (e.g. malformed JSON), sent as-is. */
  rawBody?: string;
  headers?: Record<string, string>;
  expectStatus: number;
  /** Recursive subset the parsed JSON body must contain. */
  expectJsonSubset?: Record<string, unknown>;
  /** Substring the raw response body must contain. */
  expectTextIncludes?: string;
}

export interface WebAppContract {
  /** Readiness route polled until it answers 200. Default '/api/health'. */
  healthPath?: string;
  probes: WebRouteProbe[];
  /**
   * Extra environment variables the hosting environment injects into
   * the application process (Factory Phase F12: platform bindings and
   * provider configuration). Merged over the scrubbed base
   * environment; the allocated PORT always wins.
   */
  extraEnv?: Record<string, string>;
}

export interface WebRouteProbeResult {
  name: string;
  passed: boolean;
  expectedStatus: number;
  actualStatus?: number;
  detail: string;
  /** Raw response body (truncated), when a response was received. */
  body?: string;
}

export interface WebRuntimeProbeReport {
  /** True only when the server started and every probe passed. */
  passed: boolean;
  started: boolean;
  entryPoint?: string;
  port?: number;
  baseUrl?: string;
  probes: WebRouteProbeResult[];
  /** Captured child stdout+stderr (truncated), for the record. */
  serverOutput: string;
  errors: string[];
}

const ENTRY_CANDIDATES = ['server.ts', 'server.js', 'index.js', 'src/server.ts', 'src/server.js'];
const READINESS_DEADLINE_MS = 20_000;
const READINESS_POLL_MS = 100;
const PROBE_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 3_000;
const MAX_OUTPUT_CHARS = 8_000;

function toFileMap(input: WebAppFileInput): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(input)) {
    for (const f of input) map.set(f.path, f.content);
  } else {
    for (const [p, content] of Object.entries(input)) map.set(p, content);
  }
  return map;
}

/** Finds the platform's own tsx binary the way ExecutionAdapter does. */
function locateTsx(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules/.bin/tsx'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsx')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Allocates a currently-free loopback port for the child server. */
async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not allocate a loopback port for the runtime probe.'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Recursive subset match: every expected key must be present and
 * match; arrays must have equal length and match element-wise (the
 * fixture data the contract is written against is deterministic);
 * primitives must be strictly equal. Returns a description of the
 * first mismatch, or null when the subset holds.
 */
function subsetMismatch(expected: unknown, actual: unknown, at: string): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at}: expected an array, got ${typeof actual}`;
    if (actual.length !== expected.length) {
      return `${at}: expected ${expected.length} element(s), got ${actual.length}`;
    }
    for (let i = 0; i < expected.length; i++) {
      const mismatch = subsetMismatch(expected[i], actual[i], `${at}[${i}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') {
      return `${at}: expected an object, got ${actual === null ? 'null' : typeof actual}`;
    }
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (!(key in (actual as Record<string, unknown>))) return `${at}.${key}: missing`;
      const mismatch = subsetMismatch(value, (actual as Record<string, unknown>)[key], `${at}.${key}`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  return expected === actual ? null : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

async function runProbe(baseUrl: string, probe: WebRouteProbe): Promise<WebRouteProbeResult> {
  const headers: Record<string, string> = { ...(probe.headers ?? {}) };
  let body: string | undefined;
  if (probe.rawBody !== undefined) {
    body = probe.rawBody;
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  } else if (probe.body !== undefined) {
    body = JSON.stringify(probe.body);
    if (!headers['content-type']) headers['content-type'] = 'application/json';
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl}${probe.path}`, {
      method: probe.method,
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    text = await response.text();
  } catch (err: any) {
    return {
      name: probe.name,
      passed: false,
      expectedStatus: probe.expectStatus,
      detail: `request failed before a response was received: ${err?.message || String(err)}`
    };
  }

  const responseBody = text.slice(0, 2_000);
  if (response.status !== probe.expectStatus) {
    return {
      name: probe.name,
      passed: false,
      expectedStatus: probe.expectStatus,
      actualStatus: response.status,
      detail: `${probe.method} ${probe.path} answered ${response.status}, expected ${probe.expectStatus}. Body: ${text.slice(0, 300)}`,
      body: responseBody
    };
  }
  if (probe.expectTextIncludes !== undefined && !text.includes(probe.expectTextIncludes)) {
    return {
      name: probe.name,
      passed: false,
      expectedStatus: probe.expectStatus,
      actualStatus: response.status,
      detail: `${probe.method} ${probe.path} answered ${response.status} but the body does not contain ${JSON.stringify(probe.expectTextIncludes)}. Body: ${text.slice(0, 300)}`,
      body: responseBody
    };
  }
  if (probe.expectJsonSubset !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        name: probe.name,
        passed: false,
        expectedStatus: probe.expectStatus,
        actualStatus: response.status,
        detail: `${probe.method} ${probe.path} answered ${response.status} but the body is not valid JSON. Body: ${text.slice(0, 300)}`,
        body: responseBody
      };
    }
    const mismatch = subsetMismatch(probe.expectJsonSubset, parsed, '$');
    if (mismatch) {
      return {
        name: probe.name,
        passed: false,
        expectedStatus: probe.expectStatus,
        actualStatus: response.status,
        detail: `${probe.method} ${probe.path} answered ${response.status} but the JSON contract failed: ${mismatch}. Body: ${text.slice(0, 300)}`,
        body: responseBody
      };
    }
  }
  return {
    name: probe.name,
    passed: true,
    expectedStatus: probe.expectStatus,
    actualStatus: response.status,
    detail: `${probe.method} ${probe.path} answered ${response.status} as declared.`,
    body: responseBody
  };
}

/**
 * Starts the delivered application and probes its declared contract.
 * Never throws for application faults — every failure lands in the
 * report (errors, or a failed probe naming what happened).
 */
export async function probeWebAppRuntime(
  input: WebAppFileInput,
  contract: WebAppContract
): Promise<WebRuntimeProbeReport> {
  const files = toFileMap(input);
  const errors: string[] = [];
  const probes: WebRouteProbeResult[] = [];
  let serverOutput = '';
  let child: ChildProcess | undefined;
  let tempDir: string | undefined;
  let started = false;
  let entryPoint: string | undefined;
  let port: number | undefined;
  let baseUrl: string | undefined;

  const notRun = (detail: string): WebRouteProbeResult[] =>
    contract.probes.map(p => ({ name: p.name, passed: false, expectedStatus: p.expectStatus, detail }));

  try {
    entryPoint = ENTRY_CANDIDATES.find(candidate => files.has(candidate));
    if (!entryPoint) {
      errors.push(
        `No runnable server entry point found (looked for ${ENTRY_CANDIDATES.join(', ')}); the application cannot be started, so no route can be probed.`
      );
      return { passed: false, started: false, probes: notRun('not run: no runnable entry point'), serverOutput, errors };
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadforge_f9_runtime_'));
    for (const [filePath, content] of files) {
      const { valid, cleanPath } = ExecutionAdapter.sanitizeFilePath(filePath);
      if (!valid) continue;
      const target = path.join(tempDir, cleanPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf-8');
    }

    port = await allocatePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const tsxPath = entryPoint.endsWith('.ts') ? locateTsx() : null;
    if (entryPoint.endsWith('.ts') && !tsxPath) {
      errors.push(
        `Entry point "${entryPoint}" is TypeScript but the platform's tsx runner was not found (node_modules/.bin/tsx); the application was not started.`
      );
      return { passed: false, started: false, entryPoint, port, baseUrl, probes: notRun('not run: TypeScript runner unavailable'), serverOutput, errors };
    }

    const localBinDir = path.resolve(process.cwd(), 'node_modules/.bin');
    const augmentedPath = fs.existsSync(localBinDir)
      ? `${localBinDir}${path.delimiter}${process.env.PATH || ''}`
      : process.env.PATH || '';
    const env: NodeJS.ProcessEnv = {
      PATH: augmentedPath,
      NODE_ENV: 'test',
      HOME: tempDir,
      TEMP: tempDir,
      TMP: tempDir,
      ...(contract.extraEnv ?? {}),
      PORT: String(port)
    };

    const entryDiskPath = path.join(tempDir, entryPoint);
    child = tsxPath
      ? spawn(tsxPath, [entryDiskPath], { cwd: tempDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(process.execPath, [entryDiskPath], { cwd: tempDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let exitInfo: { code: number | null; signal: string | null } | undefined;
    const exitPromise = new Promise<void>(resolve => {
      child!.once('exit', (code, signal) => {
        exitInfo = { code, signal };
        resolve();
      });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (serverOutput.length < MAX_OUTPUT_CHARS) serverOutput += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (serverOutput.length < MAX_OUTPUT_CHARS) serverOutput += chunk.toString('utf-8');
    });
    child.once('error', err => {
      errors.push(`The server process failed to spawn: ${err.message}`);
    });

    // Readiness: the declared health route answering 200, or the
    // child exiting first — either outcome is reported, never hidden.
    const healthPath = contract.healthPath ?? '/api/health';
    const deadline = Date.now() + READINESS_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (exitInfo) break;
      try {
        const res = await fetch(`${baseUrl}${healthPath}`, { signal: AbortSignal.timeout(1_000) });
        await res.text().catch(() => undefined);
        if (res.status === 200) {
          started = true;
          break;
        }
      } catch {
        // Not up yet — keep polling until the deadline.
      }
      await new Promise(resolve => setTimeout(resolve, READINESS_POLL_MS));
    }

    if (!started) {
      errors.push(
        exitInfo
          ? `The server process exited before becoming ready (code ${exitInfo.code}, signal ${exitInfo.signal}). Output: ${serverOutput.slice(-1_000)}`
          : `The server did not answer 200 on ${healthPath} within ${READINESS_DEADLINE_MS} ms. Output: ${serverOutput.slice(-1_000)}`
      );
      probes.push(...notRun('not run: the server never became ready'));
    } else {
      for (const probe of contract.probes) {
        probes.push(await runProbe(baseUrl, probe));
      }
    }

    // Always terminate the child, gracefully first.
    if (child && !exitInfo) {
      child.kill('SIGTERM');
      const grace = new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS));
      await Promise.race([exitPromise, grace]);
      if (!exitInfo) {
        child.kill('SIGKILL');
        await exitPromise;
      }
    }
  } catch (err: any) {
    errors.push(`Runtime probe failed: ${err?.message || String(err)}`);
    if (probes.length === 0) probes.push(...notRun('not run: the probe harness failed'));
    if (child && !child.killed) child.kill('SIGKILL');
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; the verdict never depends on it.
      }
    }
  }

  return {
    passed: started && errors.length === 0 && probes.every(p => p.passed),
    started,
    entryPoint,
    port,
    baseUrl,
    probes,
    serverOutput: serverOutput.slice(0, MAX_OUTPUT_CHARS),
    errors
  };
}
