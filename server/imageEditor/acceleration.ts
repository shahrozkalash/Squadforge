import * as os from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  applyFilterToImage,
  composite,
  createPixelImage,
  isBandedFilter,
  resolveFilterParams
} from './imageCore.js';
import type { ImageProject, PixelImage } from './types.js';

/**
 * Phase 51: acceleration architecture for the image editor.
 *
 * What genuinely exists here:
 *
 * - A compute-provider interface (`ComputeProvider`) with a registry.
 *   The two built-in providers are `cpu-serial` (the engine's original
 *   calling-thread execution — still the default everywhere) and
 *   `cpu-parallel` (row bands computed in `node:worker_threads`
 *   workers and assembled; byte-identical output, pinned by tests).
 * - Honest capability detection (`detectAccelerationCapabilities`):
 *   CPU is always available; parallel CPU is available when
 *   worker_threads is; **GPU is reported unavailable in this
 *   runtime** — no GPU provider is registered, Node here exposes no
 *   WebGPU (`navigator.gpu` is absent), and no GPU kernel exists in
 *   this codebase. Nothing in this module pretends otherwise.
 * - A policy function (`resolveExecutionPlan`) that decides, per
 *   call, between serial and parallel execution and records WHY:
 *   parallel is used only for band-separable work on images of at
 *   least `PARALLEL_MIN_PIXELS` pixels with at least two bands.
 *   Below that, execution falls back to serial — the plan says so,
 *   it is never a silent switch of implementation.
 * - Additive async entry points (`compositeProjectAsync`,
 *   `applyFilterAsync`). The synchronous `composite()` /
 *   `applyFilterToImage()` defaults are untouched; callers opt in.
 *
 * What a future GPU provider must do to register: implement
 * `ComputeProvider` with `kind: 'gpu'` — a `composite(project)` and
 * an `applyFilter(image, filterId, params)` that run the engine's
 * operations on the device and return the same `PixelImage` results
 * (byte-identical to `cpu-serial`, which is the acceptance bar every
 * provider here is held to) — then call `registerComputeProvider`.
 * Detection reports GPU as available only while such a provider is
 * registered. No GPU provider ships in this phase because this
 * environment has no GPU to implement or verify one against.
 */

/** Images smaller than this run serially even when parallel is requested: worker startup costs more than the split saves. */
export const PARALLEL_MIN_PIXELS = 65_536; // 256 × 256

/** Default worker count is the host's parallelism capped at this; an explicit `workers` option may go up to 64. */
export const MAX_DEFAULT_WORKERS = 8;

export type ComputeProviderKind = 'cpu-serial' | 'cpu-parallel' | 'gpu';

/**
 * A compute backend for the editor's heavy operations. Every
 * provider is held to the same contract: results byte-identical to
 * the serial engine functions.
 */
export interface ComputeProvider {
  readonly id: string;
  readonly kind: ComputeProviderKind;
  readonly description: string;
  composite(project: ImageProject): Promise<PixelImage>;
  applyFilter(image: PixelImage, filterId: string, params?: Record<string, number>): Promise<PixelImage>;
}

export interface AccelerationOptions {
  /** Provider id to use (must be registered). Parallel providers are still subject to the size/banding fallback policy. */
  provider?: string;
  /** Worker count for the parallel provider (positive integer, ≤ 64). Defaults to the host parallelism, capped at MAX_DEFAULT_WORKERS. */
  workers?: number;
}

/** The decision `resolveExecutionPlan` returns: which provider runs, in how many bands, and why. */
export interface ExecutionPlan {
  providerId: string;
  kind: ComputeProviderKind;
  /** Row bands the work splits into (1 = no split). */
  bandCount: number;
  /** Workers that will be spawned (0 when nothing is spawned). */
  workers: number;
  /** Why this plan was chosen — including every fallback. */
  reason: string;
}

export interface AccelerationCapabilities {
  cpu: { available: true; cores: number };
  parallelCpu: { available: boolean; maxWorkers: number; reason: string | null };
  gpu: { available: boolean; webGpuRuntimePresent: boolean; reason: string };
  providers: Array<{ id: string; kind: ComputeProviderKind; description: string }>;
}

/** The one-shot band protocol between acceleration.ts and accelerationWorker.ts. */
export type BandJob =
  | { kind: 'composite'; project: ImageProject; y0: number; y1: number }
  | { kind: 'filter'; image: PixelImage; filterId: string; params?: Record<string, number>; y0: number; y1: number };

export type BandResult =
  | { ok: true; width: number; height: number; data: Uint8ClampedArray }
  | { ok: false; error: string };

// ---------------------------------------------------------------- host capabilities

/** Host CPU parallelism as Node reports it (cgroup-aware on Linux). */
export function hostCoreCount(): number {
  const n = os.availableParallelism();
  return Number.isInteger(n) && n > 0 ? n : Math.max(1, os.cpus().length);
}

function defaultWorkerCount(): number {
  return Math.max(1, Math.min(hostCoreCount(), MAX_DEFAULT_WORKERS));
}

function workerThreadsAvailable(): boolean {
  return typeof Worker === 'function';
}

// ---------------------------------------------------------------- band splitting

/**
 * Split `height` rows into `bandCount` contiguous bands whose sizes
 * differ by at most one row; earlier bands take the extra rows.
 * Bands cover [0, height) exactly, in order.
 */
export function computeBands(height: number, bandCount: number): Array<{ y0: number; y1: number }> {
  if (!Number.isInteger(height) || height < 1) throw new Error(`Band split needs a positive integer height, got ${height}`);
  if (!Number.isInteger(bandCount) || bandCount < 1 || bandCount > height) {
    throw new Error(`Band count must be an integer in 1..${height}, got ${bandCount}`);
  }
  const base = Math.floor(height / bandCount);
  const extra = height % bandCount;
  const bands: Array<{ y0: number; y1: number }> = [];
  let y = 0;
  for (let i = 0; i < bandCount; i++) {
    const size = base + (i < extra ? 1 : 0);
    bands.push({ y0: y, y1: y + size });
    y += size;
  }
  return bands;
}

// ---------------------------------------------------------------- worker execution

/** Run one band job in a fresh one-shot worker. Any worker failure rejects — band errors are never masked. */
function runBandJob(job: BandJob): Promise<PixelImage> {
  return new Promise<PixelImage>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./accelerationWorker.ts', import.meta.url));
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      complete();
    };
    worker.once('message', (result: BandResult) => {
      // NB: `=== false`, not `!result.ok` — this repo's tsconfig does
      // not enable strict mode, under which truthiness checks do not
      // narrow a boolean discriminated union.
      if (result.ok === false) {
        const error = result.error;
        settle(() => reject(new Error(`Parallel worker failed: ${error}`)));
        return;
      }
      const { width, height, data } = result;
      settle(() => resolve({ width, height, data }));
    });
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code) => {
      settle(() => reject(new Error(`Parallel worker exited (code ${code}) without producing a result`)));
    });
    worker.postMessage(job);
  });
}

async function compositeBanded(project: ImageProject, bandCount: number): Promise<PixelImage> {
  const bands = computeBands(project.height, bandCount);
  const parts = await Promise.all(
    bands.map((b) => runBandJob({ kind: 'composite', project, y0: b.y0, y1: b.y1 }))
  );
  const out = createPixelImage(project.width, project.height);
  parts.forEach((part, i) => {
    out.data.set(part.data, bands[i].y0 * project.width * 4);
  });
  return out;
}

async function filterBanded(
  image: PixelImage,
  filterId: string,
  params: Record<string, number>,
  bandCount: number
): Promise<PixelImage> {
  const bands = computeBands(image.height, bandCount);
  const parts = await Promise.all(
    bands.map((b) => runBandJob({ kind: 'filter', image, filterId, params, y0: b.y0, y1: b.y1 }))
  );
  const out = createPixelImage(image.width, image.height);
  parts.forEach((part, i) => {
    out.data.set(part.data, bands[i].y0 * image.width * 4);
  });
  return out;
}

// ---------------------------------------------------------------- built-in providers

const serialProvider: ComputeProvider = {
  id: 'cpu-serial',
  kind: 'cpu-serial',
  description: 'Serial CPU execution on the calling thread — the engine default since Phase 19.',
  async composite(project: ImageProject): Promise<PixelImage> {
    return composite(project);
  },
  async applyFilter(image: PixelImage, filterId: string, params?: Record<string, number>): Promise<PixelImage> {
    return applyFilterToImage(image, filterId, params);
  }
};

const parallelProvider: ComputeProvider = {
  id: 'cpu-parallel',
  kind: 'cpu-parallel',
  description:
    'Parallel CPU execution: row bands computed in node:worker_threads workers (accelerationWorker.ts) and assembled. Byte-identical to cpu-serial.',
  async composite(project: ImageProject): Promise<PixelImage> {
    const bandCount = Math.min(defaultWorkerCount(), project.height);
    // A one-row-tall canvas cannot split; the serial call IS the band computation there.
    if (bandCount < 2) return composite(project);
    return compositeBanded(project, bandCount);
  },
  async applyFilter(image: PixelImage, filterId: string, params?: Record<string, number>): Promise<PixelImage> {
    const resolved = resolveFilterParams(filterId, params); // unknown ids / bad params fail exactly as serial
    if (!isBandedFilter(filterId)) {
      throw new Error(
        `The cpu-parallel provider cannot run filter '${filterId}': it is not band-separable. Use cpu-serial (applyFilterAsync falls back to it by policy).`
      );
    }
    const bandCount = Math.min(defaultWorkerCount(), image.height);
    if (bandCount < 2) return applyFilterToImage(image, filterId, resolved);
    return filterBanded(image, filterId, resolved, bandCount);
  }
};

// ---------------------------------------------------------------- provider registry

const providerRegistry = new Map<string, ComputeProvider>();

/**
 * Register a compute provider (built-ins are registered at module
 * load). A GPU backend registers here with kind 'gpu' — see the
 * module header for what it must implement. Re-registering an id
 * replaces the previous provider.
 */
export function registerComputeProvider(provider: ComputeProvider): void {
  if (!provider || typeof provider.id !== 'string' || provider.id.length === 0) {
    throw new Error('A compute provider must have a non-empty string id');
  }
  if (provider.kind !== 'cpu-serial' && provider.kind !== 'cpu-parallel' && provider.kind !== 'gpu') {
    throw new Error(`Unknown compute provider kind: ${String(provider.kind)}`);
  }
  if (typeof provider.composite !== 'function' || typeof provider.applyFilter !== 'function') {
    throw new Error(`Compute provider '${provider.id}' must implement composite() and applyFilter()`);
  }
  providerRegistry.set(provider.id, provider);
}

/** Remove a provider from the registry. Returns whether one was registered under that id. */
export function unregisterComputeProvider(id: string): boolean {
  return providerRegistry.delete(id);
}

/** Look a provider up by id. Throws on an unknown id, listing what is registered. */
export function getComputeProvider(id: string): ComputeProvider {
  const provider = providerRegistry.get(id);
  if (!provider) {
    throw new Error(`Unknown compute provider: ${id} (registered: ${[...providerRegistry.keys()].join(', ')})`);
  }
  return provider;
}

/** The registered providers' public descriptors (copies). */
export function listComputeProviders(): Array<{ id: string; kind: ComputeProviderKind; description: string }> {
  return [...providerRegistry.values()].map((p) => ({ id: p.id, kind: p.kind, description: p.description }));
}

registerComputeProvider(serialProvider);
registerComputeProvider(parallelProvider);

// ---------------------------------------------------------------- capability detection

/**
 * What this runtime can actually execute, reported honestly: CPU is
 * always available; parallel CPU needs worker_threads; GPU is
 * available only while a genuine GPU provider is registered — in
 * this environment none is, and detection says so (asserted by the
 * Phase 51 tests, not just documented).
 */
export function detectAccelerationCapabilities(): AccelerationCapabilities {
  const workersOk = workerThreadsAvailable();
  const gpuProvider = [...providerRegistry.values()].find((p) => p.kind === 'gpu');
  const webGpuRuntimePresent =
    typeof (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu !== 'undefined';
  return {
    cpu: { available: true, cores: hostCoreCount() },
    parallelCpu: {
      available: workersOk,
      maxWorkers: workersOk ? defaultWorkerCount() : 0,
      reason: workersOk ? null : 'node:worker_threads is not available in this runtime'
    },
    gpu: {
      available: gpuProvider !== undefined,
      webGpuRuntimePresent,
      reason: gpuProvider
        ? `Provided by the registered '${gpuProvider.id}' provider`
        : 'No GPU compute provider is registered' +
          (webGpuRuntimePresent
            ? '; a WebGPU runtime object is present, but no backend has been implemented or verified against it'
            : '; this runtime exposes no WebGPU (navigator.gpu is absent)') +
          ', so GPU execution is unavailable'
    },
    providers: listComputeProviders()
  };
}

// ---------------------------------------------------------------- execution policy

/**
 * Decide how an operation runs. Policy, in order:
 *
 * 1. An explicitly named provider wins, subject to the same
 *    qualification rules (a named GPU provider runs as-is; a named
 *    serial provider runs serially).
 * 2. Parallel execution requires: worker_threads available, the
 *    operation band-separable (`banded` not false), at least
 *    PARALLEL_MIN_PIXELS pixels, and at least two bands from the
 *    worker count and the image height.
 * 3. Anything else falls back to `cpu-serial`, and the returned
 *    plan's `reason` says exactly which rule fell back.
 */
export function resolveExecutionPlan(
  task: { width: number; height: number; banded?: boolean },
  options?: AccelerationOptions
): ExecutionPlan {
  if (!Number.isInteger(task.width) || !Number.isInteger(task.height) || task.width < 1 || task.height < 1) {
    throw new Error(`Task size must be positive integers, got ${task.width}x${task.height}`);
  }
  const requestedWorkers = options?.workers ?? defaultWorkerCount();
  if (!Number.isInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > 64) {
    throw new Error(`Worker count must be an integer in 1..64, got ${options?.workers}`);
  }
  const serial = (reason: string, providerId: string = serialProvider.id): ExecutionPlan => ({
    providerId,
    kind: 'cpu-serial',
    bandCount: 1,
    workers: 0,
    reason
  });

  let parallelId = parallelProvider.id;
  let explicit = false;
  if (options?.provider !== undefined) {
    const provider = getComputeProvider(options.provider); // throws on unknown id
    explicit = true;
    if (provider.kind === 'gpu') {
      return { providerId: provider.id, kind: 'gpu', bandCount: 1, workers: 0, reason: `Explicit provider '${provider.id}'` };
    }
    if (provider.kind === 'cpu-serial') return serial(`Explicit provider '${provider.id}'`, provider.id);
    parallelId = provider.id;
  }

  if (!workerThreadsAvailable()) return serial('worker_threads is unavailable in this runtime — serial fallback');
  if (task.banded === false) return serial('Operation cannot be split into row bands — serial fallback');
  const pixels = task.width * task.height;
  if (pixels < PARALLEL_MIN_PIXELS) {
    return serial(`Image has ${pixels} pixels, below the parallel threshold of ${PARALLEL_MIN_PIXELS} — serial fallback`);
  }
  const bandCount = Math.min(requestedWorkers, task.height);
  if (bandCount < 2) return serial('Fewer than two row bands (worker count or image height is 1) — serial fallback');
  return {
    providerId: parallelId,
    kind: 'cpu-parallel',
    bandCount,
    workers: bandCount,
    reason: explicit
      ? `Explicit provider '${parallelId}'`
      : `Image meets the parallel threshold (${pixels} ≥ ${PARALLEL_MIN_PIXELS} pixels); split into ${bandCount} row bands`
  };
}

// ---------------------------------------------------------------- async entry points (opt-in; the sync defaults are unchanged)

/**
 * Composite a project, optionally on an accelerated provider.
 * With no options, the execution plan policy decides (parallel for
 * large canvases, serial otherwise); the result is byte-identical
 * to `composite()` either way.
 */
export async function compositeProjectAsync(project: ImageProject, options?: AccelerationOptions): Promise<PixelImage> {
  const plan = resolveExecutionPlan({ width: project.width, height: project.height }, options);
  if (plan.kind === 'cpu-parallel' && plan.providerId === parallelProvider.id) {
    return compositeBanded(project, plan.bandCount);
  }
  return getComputeProvider(plan.providerId).composite(project);
}

/**
 * Apply a Phase 47 filter to a whole image, optionally accelerated.
 * Parameters are validated exactly as in `applyFilterToImage` before
 * anything spawns. Band-separable filters (box-blur, gaussian-blur)
 * may run on the parallel provider per the execution plan; every
 * other filter falls back to serial by policy. The result is
 * byte-identical to `applyFilterToImage()` either way.
 */
export async function applyFilterAsync(
  image: PixelImage,
  filterId: string,
  params?: Record<string, number>,
  options?: AccelerationOptions
): Promise<PixelImage> {
  const resolved = resolveFilterParams(filterId, params); // unknown ids / bad params fail here, as serial
  const plan = resolveExecutionPlan(
    { width: image.width, height: image.height, banded: isBandedFilter(filterId) },
    options
  );
  if (plan.kind === 'cpu-parallel' && plan.providerId === parallelProvider.id) {
    return filterBanded(image, filterId, resolved, plan.bandCount);
  }
  return getComputeProvider(plan.providerId).applyFilter(image, filterId, resolved);
}
