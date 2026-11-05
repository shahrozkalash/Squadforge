import http from 'node:http';
import net from 'node:net';
import { HttpProbeResult } from '../types.js';

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  maxRuntimeSeconds: number;
  tmpfsMb: number;
  workspaceMb: number;
}

export type SandboxNetwork = 'isolated' | 'registry';

export interface EnvironmentSpec {
  sessionId: string;
  buildId: string;
  userId: string;
}

export interface ProcessSpec {
  argv: string[];
  env?: Record<string, string>;
  network: SandboxNetwork;
  limits: SandboxLimits;
  /** Install processes also mount the per-project dependency cache. */
  mountDependencyCache?: boolean;
}

export interface ProcessExit {
  exitCode: number;
  oomKilled: boolean;
}

export interface ProcessHandle {
  id: string;
  wait(): Promise<ProcessExit>;
  stop(): Promise<void>;
}

export interface BackendCapabilities {
  available: boolean;
  backend: string;
  reason?: string;
  runtime?: string;
}

export interface ResourceUsage {
  memoryBytes: number;
  memoryLimitBytes: number;
  cpuPercent: number;
  pids: number;
  workspaceBytes: number;
}

export interface PreviewEndpoint {
  host: string;
  port: number;
  /** Proves to the relay that a connection came from SquadForge. Never send it to a browser. */
  token?: string;
}

export interface EnvironmentRecord {
  sessionId: string;
  buildId: string;
}

export type OutputListener = (stream: 'stdout' | 'stderr', text: string) => void;

/**
 * Runs untrusted project code. Implementations must provide real isolation.
 * Never add a backend that runs project code as a plain host process.
 */
export interface ExecutionBackend {
  readonly name: string;
  capabilities(): Promise<BackendCapabilities>;
  createEnvironment(spec: EnvironmentSpec): Promise<void>;
  uploadWorkspace(sessionId: string, tar: Buffer): Promise<void>;
  readWorkspaceFile(sessionId: string, relativePath: string): Promise<Buffer | null>;
  startProcess(sessionId: string, spec: ProcessSpec, onOutput: OutputListener): Promise<ProcessHandle>;
  listeningPorts(processId: string): Promise<number[]>;
  usage(processId: string): Promise<ResourceUsage | null>;
  openPreview(sessionId: string, processId: string, port: number): Promise<PreviewEndpoint>;
  closePreview(sessionId: string): Promise<void>;
  destroyEnvironment(sessionId: string): Promise<void>;
  removeDependencyCache(buildId: string): Promise<void>;
  listEnvironments(): Promise<EnvironmentRecord[]>;
}

const RELAY_REQUEST_TIMEOUT_MS = 3000;

/** One GET through a relay. With a wait, it retries until the relay and project answer. */
export async function relayGet(endpoint: PreviewEndpoint, path: string, waitMs: number): Promise<HttpProbeResult> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await new Promise<HttpProbeResult>(resolve => {
      const req = http.get({
        path,
        timeout: RELAY_REQUEST_TIMEOUT_MS,
        headers: { Host: 'localhost', Connection: 'close' },
        createConnection: () => {
          const socket = net.connect(endpoint.port, endpoint.host);
          if (endpoint.token) socket.write(`SF-RELAY ${endpoint.token}\n`);
          return socket;
        }
      }, res => {
        res.resume();
        resolve({ path, status: res.statusCode });
      });
      req.on('timeout', () => req.destroy(new Error('The request timed out')));
      req.on('error', err => resolve({ path, error: err.message }));
    });
    if (result.status !== undefined || Date.now() >= deadline) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const IPV6_LOOPBACK = '00000000000000000000000001000000';

/**
 * Parses reachable listening TCP ports from /proc/net/tcp and /proc/net/tcp6.
 * Loopback listeners are skipped: the relay cannot reach them, and Docker's
 * embedded DNS server appears here on 127.0.0.11.
 */
export function parseListeningPorts(procNetTcp: string): number[] {
  const ports = new Set<number>();
  for (const line of procNetTcp.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== '0A') continue;
    const [addressHex, portHex] = fields[1].split(':');
    const isIpv4Loopback = addressHex?.length === 8 && addressHex.endsWith('7F');
    if (isIpv4Loopback || addressHex === IPV6_LOOPBACK) continue;
    const port = Number.parseInt(portHex || '', 16);
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return Array.from(ports).sort((a, b) => a - b);
}
