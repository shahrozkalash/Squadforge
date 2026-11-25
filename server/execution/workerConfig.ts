import fs from 'node:fs';

/**
 * Phase 32: worker connection and capability decisions.
 *
 * Everything in this module is pure configuration logic: it decides how
 * SquadForge may talk to the Docker worker and what the worker can
 * enforce, before any daemon is contacted. The rules fail closed:
 *
 * - A remote (tcp) DOCKER_HOST is only ever used over TLS with a CA and
 *   a client certificate/key pair. Plaintext remote endpoints, partial
 *   TLS settings, unreadable certificate files and transports we cannot
 *   verify (ssh) are configuration errors, never a silent fallback.
 * - A local unix socket / named pipe needs no TLS: it never leaves the
 *   worker host's own access control.
 */

export type DockerConnectionResolution =
  | { ok: true; mode: 'socket'; endpoint: string; socketPath?: string }
  | {
      ok: true;
      mode: 'tls';
      endpoint: string;
      host: string;
      port: number;
      caPath: string;
      certPath: string;
      keyPath: string;
    }
  | { ok: false; mode: 'invalid'; endpoint?: string; errors: string[] };

const TLS_VARS = ['DOCKER_TLS_CA', 'DOCKER_TLS_CERT', 'DOCKER_TLS_KEY'] as const;

function certFileProblem(name: string, path: string): string | null {
  try {
    if (!fs.statSync(path).isFile()) return `${name} (${path}) is not a file`;
    fs.accessSync(path, fs.constants.R_OK);
    return null;
  } catch {
    return `${name} (${path}) does not exist or is not readable`;
  }
}

export function resolveDockerConnection(env: NodeJS.ProcessEnv = process.env): DockerConnectionResolution {
  const host = (env.DOCKER_HOST || '').trim();

  if (!host) {
    return { ok: true, mode: 'socket', endpoint: 'unix:///var/run/docker.sock', socketPath: '/var/run/docker.sock' };
  }
  if (host.startsWith('unix://')) {
    const socketPath = host.slice('unix://'.length) || '/var/run/docker.sock';
    return { ok: true, mode: 'socket', endpoint: host, socketPath };
  }
  if (host.startsWith('npipe://')) {
    return { ok: true, mode: 'socket', endpoint: host };
  }
  if (host.startsWith('ssh://')) {
    return {
      ok: false,
      mode: 'invalid',
      endpoint: host,
      errors: [
        `DOCKER_HOST=${host} uses ssh://, which SquadForge does not verify. ` +
          'Use a local unix socket or a tcp:// endpoint with TLS client certificates (DOCKER_TLS_CA, DOCKER_TLS_CERT, DOCKER_TLS_KEY).'
      ]
    };
  }
  if (host.startsWith('tcp://') || host.startsWith('https://')) {
    const errors: string[] = [];
    const missing = TLS_VARS.filter(name => !env[name]);
    if (missing.length > 0) {
      errors.push(
        `DOCKER_HOST=${host} is a remote endpoint, so TLS is required, but ${missing.join(', ')} ` +
          'is not set. SquadForge refuses plaintext remote Docker connections.'
      );
    } else {
      for (const name of TLS_VARS) {
        const problem = certFileProblem(name, env[name]!);
        if (problem) errors.push(problem);
      }
    }
    if (errors.length > 0) return { ok: false, mode: 'invalid', endpoint: host, errors };

    const url = new URL(host.replace(/^tcp:/, 'https:'));
    return {
      ok: true,
      mode: 'tls',
      endpoint: host,
      host: url.hostname,
      port: Number(url.port || 2376),
      caPath: env.DOCKER_TLS_CA!,
      certPath: env.DOCKER_TLS_CERT!,
      keyPath: env.DOCKER_TLS_KEY!
    };
  }
  if (host.startsWith('http://')) {
    return {
      ok: false,
      mode: 'invalid',
      endpoint: host,
      errors: [
        `DOCKER_HOST=${host} is plaintext HTTP. SquadForge refuses remote Docker connections without TLS client certificates.`
      ]
    };
  }
  return {
    ok: false,
    mode: 'invalid',
    endpoint: host,
    errors: [`DOCKER_HOST=${host} is not a recognised Docker endpoint (expected unix://, npipe:// or tcp:// with TLS).`]
  };
}

/** Periodic worker health-check interval. Never faster than every 5 seconds. */
export function workerHealthIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.EXECUTION_HEALTH_INTERVAL_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 5 ? seconds : 30) * 1000;
}

export type StorageQuotaMode = 'hard' | 'conditional' | 'soft';

export interface StorageQuotaDecision {
  mode: StorageQuotaMode;
  driver: string;
  backingFilesystem?: string;
  reason: string;
}

/** The `Backing Filesystem` entry of a daemon's DriverStatus pairs, if reported. */
export function backingFilesystemOf(info: { DriverStatus?: unknown }): string | undefined {
  const pairs = info.DriverStatus;
  if (!Array.isArray(pairs)) return undefined;
  for (const pair of pairs) {
    if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'backing filesystem') {
      return String(pair[1]).toLowerCase();
    }
  }
  return undefined;
}

/**
 * Decides whether the daemon can enforce a per-container size limit via
 * the `size` storage option, from documented Docker behaviour:
 *
 * - btrfs and zfs accept `size` directly: hard quota.
 * - overlay2 accepts `size` only when its backing filesystem is XFS
 *   mounted with project quotas (pquota). The daemon reports the
 *   backing filesystem but not whether pquota is on, so this is
 *   'conditional': SquadForge passes the option and the daemon either
 *   enforces it or rejects container creation — it never silently
 *   degrades to no limit at this layer.
 * - Everything else (overlay2 on ext4, vfs, fuse-overlayfs, unknown):
 *   no storage-opt size support, so the container layer is unlimited
 *   and only the soft polled workspace limit applies.
 *
 * Note the workspace itself lives on a named volume, and the Docker API
 * offers no per-volume size quota on any storage driver; the workspace
 * limit therefore stays the polled soft limit in every mode (see
 * DEPLOYMENT.md). This decision covers the container's own writable
 * layer only.
 */
export function storageQuotaDecision(info: {
  Driver?: string;
  DriverStatus?: unknown;
}): StorageQuotaDecision {
  const driver = (info.Driver || '').toLowerCase();
  const backing = backingFilesystemOf(info);
  if (driver === 'btrfs') {
    return { mode: 'hard', driver, backingFilesystem: backing, reason: 'btrfs enforces the size storage option per container.' };
  }
  if (driver === 'zfs') {
    return { mode: 'hard', driver, backingFilesystem: backing, reason: 'zfs enforces the size storage option per container.' };
  }
  if (driver === 'overlay2' && backing !== undefined && backing.includes('xfs')) {
    return {
      mode: 'conditional',
      driver,
      backingFilesystem: backing,
      reason:
        'overlay2 on XFS supports the size storage option only with project quotas (pquota) mounted; ' +
        'the daemon does not report pquota, so the option is passed and the daemon enforces or rejects it.'
    };
  }
  if (driver === 'overlay2') {
    return {
      mode: 'soft',
      driver,
      backingFilesystem: backing,
      reason: `overlay2 on ${backing || 'an unknown backing filesystem'} does not support the size storage option (XFS with pquota is required).`
    };
  }
  return {
    mode: 'soft',
    driver: driver || 'unknown',
    backingFilesystem: backing,
    reason: `The ${driver || 'unknown'} storage driver does not support the size storage option.`
  };
}

/** True when the daemon is expected to honour a `size` storage option. */
export function storageOptEnforced(decision: StorageQuotaDecision): boolean {
  return decision.mode === 'hard' || decision.mode === 'conditional';
}

/** Byte value passed as the `size` storage option for a workspace limit. */
export function storageOptSizeBytes(workspaceMb: number): number {
  return Math.round(workspaceMb) * 1024 * 1024;
}
