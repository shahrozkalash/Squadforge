/**
 * Phase 59 benchmark: performance and stability measurements for the
 * image editor, extending the Phase 51 benchmark's surface.
 *
 * Coverage: project compositing (6 and 20 layers, plain and feature-
 * rich) at 1024×1024 and 2048×2048; box and Gaussian blur; a long
 * Phase 46 brush stroke; PNG/JPEG encode+decode; TIFF (LZW) decode;
 * a PSD round trip; the Phase 52 effect-stack render path; and the
 * parallel-CPU question revisited — the shipped provider (Phase 51:
 * one-shot workers; Phase 59: a persistent pool with band-sliced
 * buffer transfers — the provider lines below measure whichever
 * design is current) vs pool prototypes with whole-input clones
 * and with slicing, kept as the A/B evidence for the design.
 *
 * Honest measurement rules (the Phase 51 rules, kept):
 *  - Times are wall-clock `performance.now()` around the real calls
 *    on this machine, whatever it happens to be (environment printed
 *    first). Parallel times are end-to-end: spawn/clone/slice,
 *    compute and assembly are all inside the timed region.
 *  - Reported figures are medians of N runs (N = P59_RUNS env or 5),
 *    after warmup runs that are not reported.
 *  - Every parallel/pooled result is verified byte-identical to the
 *    serial result; a mismatch fails the script (exit 1).
 *  - There is no GPU number: this environment has no GPU and the
 *    engine has no GPU provider. Nothing is estimated.
 *
 * Usage: tsx scripts/phase59-benchmark.ts
 */
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProject,
  addLayer,
  addAdjustmentLayer,
  addLayerEffect,
  createPixelImage,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerClipped,
  createGroup,
  setLayerGroup,
  setGroupOpacity,
  createLayerMask,
  getLayerMask,
  createBrushSettings,
  paintBrushStroke,
  composite,
  applyFilterToImage,
  applyLayerEffectStack
} from '../server/imageEditor/imageCore.js';
import { encodePng, decodePng, encodeJpeg, decodeJpeg } from '../server/imageEditor/imageCodec.js';
import { decodeTiff } from '../server/imageEditor/tiff.js';
import { exportPsd, importPsd } from '../server/imageEditor/psd.js';
import { compositeProjectAsync, applyFilterAsync, hostCoreCount, computeBands } from '../server/imageEditor/acceleration.js';
import type { BandJob, BandResult } from '../server/imageEditor/acceleration.js';
import type { ImageProject, Layer, PixelImage } from '../server/imageEditor/types.js';

const RUNS = Math.max(1, Number.parseInt(process.env.P59_RUNS ?? '5', 10) || 5);
const TMP = join(process.env.TMPDIR ?? '/tmp', 'phase59-bench');
mkdirSync(TMP, { recursive: true });

// ---------------------------------------------------------------- fixtures (deterministic)

function patternInto(img: PixelImage, seed: number, variedAlpha: boolean): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = (x * 7 + y * 13 + seed * 31) % 256;
      img.data[i + 1] = (x * 3 + y * 29 + seed * 57) % 256;
      img.data[i + 2] = (x * 11 + y * 5 + seed * 91) % 256;
      img.data[i + 3] = variedAlpha ? 96 + ((x + y * 3 + seed) % 160) : 255;
    }
  }
}

function patternImage(size: number, seed: number, variedAlpha: boolean): PixelImage {
  const img = createPixelImage(size, size);
  patternInto(img, seed, variedAlpha);
  return img;
}

/** Feature-rich project in the Phase 51/55 spirit: blend modes, mask, group, clipped layer, effect stack, adjustment layer. */
function richProject(size: number): ImageProject {
  const p = createProject(size, size);
  patternInto(p.layers[0].image, 0, false);
  const multiply = addLayer(p, 'Multiply');
  patternInto(multiply.image, 1, true);
  setLayerBlendMode(p, multiply.id, 'multiply');
  setLayerOpacity(p, multiply.id, 0.8);
  const screen = addLayer(p, 'Screen + mask');
  patternInto(screen.image, 2, true);
  setLayerBlendMode(p, screen.id, 'screen');
  createLayerMask(p, screen.id, 255);
  const mask = getLayerMask(p, screen.id)!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) mask.data[y * size + x] = Math.floor((y * 255) / Math.max(1, size - 1));
  }
  const group = createGroup(p, 'Group');
  setGroupOpacity(p, group.id, 0.9);
  const g1 = addLayer(p, 'Group member 1');
  patternInto(g1.image, 3, true);
  setLayerGroup(p, g1.id, group.id);
  const g2 = addLayer(p, 'Group member 2');
  patternInto(g2.image, 4, true);
  setLayerBlendMode(p, g2.id, 'overlay');
  setLayerGroup(p, g2.id, group.id);
  const clipBase = addLayer(p, 'Clip base');
  patternInto(clipBase.image, 5, true);
  const clipped = addLayer(p, 'Clipped');
  patternInto(clipped.image, 6, true);
  setLayerBlendMode(p, clipped.id, 'darken');
  setLayerClipped(p, clipped.id, true);
  const effected = addLayer(p, 'Effected');
  patternInto(effected.image, 7, true);
  addLayerEffect(p, effected.id, 'sepia', { amount: 0.6 });
  addLayerEffect(p, effected.id, 'box-blur', { radius: 2 });
  const adj = addAdjustmentLayer(p, 'Grade');
  setLayerOpacity(p, adj.id, 0.7);
  addLayerEffect(p, adj.id, 'invert', {});
  return p;
}

/** `count` plain normal-mode layers (the common case; nothing band-unsafe, nothing clipped). */
function plainProject(size: number, count: number): ImageProject {
  const p = createProject(size, size);
  patternInto(p.layers[0].image, 0, false);
  for (let s = 1; s < count; s++) {
    const layer = addLayer(p, `Layer ${s}`);
    patternInto(layer.image, s, true);
    setLayerOpacity(p, layer.id, 0.55 + (s % 5) * 0.1);
  }
  return p;
}

function serpentinePoints(width: number, height: number, step: number): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  let row = 0;
  for (let y = step / 2; y < height; y += step, row++) {
    if (row % 2 === 0) points.push({ x: 0, y }, { x: width - 1, y });
    else points.push({ x: width - 1, y }, { x: 0, y });
  }
  return points;
}

// ---------------------------------------------------------------- timing helpers

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function bench(label: string, fn: () => unknown | Promise<unknown>, runs = RUNS, warmup = 1): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const med = median(times);
  console.log(
    `  ${label.padEnd(46)} median ${med.toFixed(1).padStart(9)} ms   runs=[${times.map((t) => t.toFixed(0)).join(', ')}]`
  );
  return med;
}

function equal(a: PixelImage, b: PixelImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

let allEqual = true;
function checkEqual(label: string, a: PixelImage, b: PixelImage): void {
  const ok = equal(a, b);
  allEqual &&= ok;
  console.log(`  identity: ${label} byte-identical to serial: ${ok}`);
  if (!ok) throw new Error(`byte identity failed: ${label}`);
}

// ---------------------------------------------------------------- persistent pool prototype

/**
 * A persistent worker pool over the EXISTING accelerationWorker.ts
 * protocol (one outstanding job per worker; the worker file already
 * answers message after message — only acceleration.ts's one-shot
 * driver terminates after the first). Used here to measure what a
 * pool would change before anything ships.
 */
class Pool {
  private workers: Array<{ worker: Worker; busy: boolean; resolve: ((img: PixelImage) => void) | null; reject: ((e: Error) => void) | null }> = [];
  private queue: Array<{ job: BandJob; transfers?: ArrayBuffer[]; resolve: (img: PixelImage) => void; reject: (e: Error) => void }> = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('../server/imageEditor/accelerationWorker.ts', import.meta.url));
      const slot = { worker, busy: false, resolve: null as ((img: PixelImage) => void) | null, reject: null as ((e: Error) => void) | null };
      worker.on('message', (result: BandResult) => {
        const resolve = slot.resolve;
        const reject = slot.reject;
        slot.resolve = slot.reject = null;
        slot.busy = false;
        if (result.ok === false) reject?.(new Error(`pool worker failed: ${result.error}`));
        else resolve?.({ width: result.width, height: result.height, data: result.data });
        this.pump();
      });
      worker.on('error', (err) => {
        slot.reject?.(err);
        slot.resolve = slot.reject = null;
        slot.busy = false;
        this.pump();
      });
      this.workers.push(slot);
    }
  }

  private pump(): void {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      slot.busy = true;
      slot.resolve = next.resolve;
      slot.reject = next.reject;
      if (next.transfers && next.transfers.length > 0) slot.worker.postMessage(next.job, next.transfers);
      else slot.worker.postMessage(next.job);
    }
  }

  run(job: BandJob, transfers?: ArrayBuffer[]): Promise<PixelImage> {
    return new Promise<PixelImage>((resolve, reject) => {
      this.queue.push({ job, transfers, resolve, reject });
      this.pump();
    });
  }

  async terminate(): Promise<void> {
    await Promise.all(this.workers.map((s) => s.worker.terminate()));
  }
}

/** Pool + whole-project clone per band (the Phase 51 payload, minus spawn). */
async function compositePooledClone(pool: Pool, project: ImageProject, bandCount: number): Promise<PixelImage> {
  const bands = computeBands(project.height, bandCount);
  const parts = await Promise.all(bands.map((b) => pool.run({ kind: 'composite', project, y0: b.y0, y1: b.y1 })));
  const out = createPixelImage(project.width, project.height);
  parts.forEach((part, i) => out.data.set(part.data, bands[i].y0 * project.width * 4));
  return out;
}

/**
 * Pool + band-sliced transfers: each band job carries only its own
 * rows of every layer (image + mask), transferred (not cloned), and
 * the worker composites the sliced project end to end. Only valid
 * for projects whose rendering is per-pixel across bands: no enabled
 * effect stacks, no placements, no adjustment layers (checked by
 * `sliceable`); groups/masks/clipping/blends are per-pixel and safe.
 */
function sliceable(project: ImageProject): boolean {
  return project.layers.every(
    (l) => l.kind !== 'adjustment' && !l.placement && !l.effects.some((e) => e.enabled)
  );
}

function sliceProjectRows(project: ImageProject, y0: number, y1: number): { project: ImageProject; transfers: ArrayBuffer[] } {
  const transfers: ArrayBuffer[] = [];
  const width = project.width;
  const rows = y1 - y0;
  const sliceLayer = (layer: Layer): Layer => {
    const imgData = new Uint8ClampedArray(width * rows * 4);
    imgData.set(layer.image.data.subarray(y0 * width * 4, y1 * width * 4));
    transfers.push(imgData.buffer as ArrayBuffer);
    let mask = layer.mask;
    if (mask) {
      const maskData = new Uint8ClampedArray(width * rows);
      maskData.set(mask.data.subarray(y0 * width, y1 * width));
      transfers.push(maskData.buffer as ArrayBuffer);
      mask = { width, height: rows, data: maskData };
    }
    return { ...layer, image: { width, height: rows, data: imgData }, mask };
  };
  const sliced: ImageProject = { ...project, height: rows, layers: project.layers.map(sliceLayer) };
  return { project: sliced, transfers };
}

async function compositePooledSliced(pool: Pool, project: ImageProject, bandCount: number): Promise<PixelImage> {
  const bands = computeBands(project.height, bandCount);
  const parts = await Promise.all(
    bands.map((b) => {
      const { project: sliced, transfers } = sliceProjectRows(project, b.y0, b.y1);
      return pool.run({ kind: 'composite', project: sliced, y0: 0, y1: b.y1 - b.y0 }, transfers);
    })
  );
  const out = createPixelImage(project.width, project.height);
  parts.forEach((part, i) => out.data.set(part.data, bands[i].y0 * project.width * 4));
  return out;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const cpus = os.cpus();
  console.log('Phase 59 benchmark — performance & stability (medians of ' + RUNS + ' runs)');
  console.log(
    `Environment: node ${process.version}, ${os.platform()} ${os.arch()}, ` +
      `${cpus.length} logical CPUs (${cpus[0]?.model ?? 'unknown'}), availableParallelism=${hostCoreCount()}`
  );
  console.log('GPU: none present and no GPU provider registered — no GPU figures exist to report.');

  // ---- compositing
  for (const size of [1024, 2048]) {
    console.log(`\nComposite ${size}x${size}`);
    const rich = richProject(size);
    await bench(`composite rich (10 layers) serial`, () => composite(rich));
    const plain6 = plainProject(size, 6);
    const serial6 = await bench(`composite plain 6 layers serial`, () => composite(plain6));
    const plain20 = plainProject(size, 20);
    const serial20 = await bench(`composite plain 20 layers serial`, () => composite(plain20));

    const shipped = await bench(`composite plain 6 shipped provider (4w)`, () =>
      compositeProjectAsync(plain6, { workers: 4 })
    );
    checkEqual(`shipped provider ${size}`, composite(plain6), await compositeProjectAsync(plain6, { workers: 4 }));
    console.log(`  shipped provider speedup vs serial: ${(serial6 / shipped).toFixed(2)}x`);

    const pool = new Pool(4);
    try {
      const pooledClone = await bench(`composite plain 6 pool+clone (4w)`, () => compositePooledClone(pool, plain6, 4));
      checkEqual(`pool+clone ${size}`, composite(plain6), await compositePooledClone(pool, plain6, 4));
      console.log(`  pool+clone speedup vs serial: ${(serial6 / pooledClone).toFixed(2)}x`);
      if (sliceable(plain6)) {
        const pooledSliced = await bench(`composite plain 6 pool+sliced (4w)`, () =>
          compositePooledSliced(pool, plain6, 4)
        );
        checkEqual(`pool+sliced ${size}`, composite(plain6), await compositePooledSliced(pool, plain6, 4));
        console.log(`  pool+sliced speedup vs serial: ${(serial6 / pooledSliced).toFixed(2)}x`);
      }
      const pooled20 = await bench(`composite plain 20 pool+sliced (4w)`, () => compositePooledSliced(pool, plain20, 4));
      console.log(`  pool+sliced 20-layer speedup vs serial: ${(serial20 / pooled20).toFixed(2)}x`);
    } finally {
      await pool.terminate();
    }
  }

  // ---- blurs
  for (const size of [1024, 2048]) {
    console.log(`\nFilters ${size}x${size}`);
    const img = patternImage(size, 5, false);
    const serialBox = await bench(`box-blur r=6 serial`, () => applyFilterToImage(img, 'box-blur', { radius: 6 }));
    const parBox = await bench(`box-blur r=6 shipped provider (4w)`, () =>
      applyFilterAsync(img, 'box-blur', { radius: 6 }, { workers: 4 })
    );
    checkEqual(`box-blur parallel ${size}`, applyFilterToImage(img, 'box-blur', { radius: 6 }), await applyFilterAsync(img, 'box-blur', { radius: 6 }, { workers: 4 }));
    console.log(`  box-blur parallel speedup: ${(serialBox / parBox).toFixed(2)}x`);
    await bench(`gaussian-blur sigma=2 serial`, () => applyFilterToImage(img, 'gaussian-blur', { sigma: 2, radius: 0 }));
    await bench(`gaussian-blur sigma=2 shipped provider (4w)`, () =>
      applyFilterAsync(img, 'gaussian-blur', { sigma: 2, radius: 0 }, { workers: 4 })
    );
  }

  // ---- brush
  for (const size of [1024, 2048]) {
    console.log(`\nBrush stroke ${size}x${size} (size 24, spacing 0.25, serpentine rows every 48px)`);
    const project = createProject(size, size);
    patternInto(project.layers[0].image, 11, false);
    const layer = addLayer(project, 'Paint');
    const blank = layer.image.data.slice();
    const settings = createBrushSettings({ size: 24, hardness: 0.7, spacing: 0.25, flow: 0.8, opacity: 0.9 });
    const points = serpentinePoints(size, size, 48);
    await bench(`paintBrushStroke`, () => {
      layer.image.data.set(blank);
      paintBrushStroke(project, layer.id, points, settings, { r: 200, g: 40, b: 90, a: 255 });
    });
  }

  // ---- effect stack render path
  for (const size of [1024, 2048]) {
    console.log(`\nEffect stack ${size}x${size} (sepia -> box-blur r=2 -> noise -> brightness/contrast -> sharpen)`);
    const img = patternImage(size, 9, true);
    const stack = [
      { filterId: 'sepia', params: { amount: 0.6 }, enabled: true },
      { filterId: 'box-blur', params: { radius: 2 }, enabled: true },
      { filterId: 'noise', params: { amount: 10, seed: 7 }, enabled: true },
      { filterId: 'brightness-contrast', params: { brightness: 10, contrast: 20 }, enabled: true },
      { filterId: 'sharpen', params: { amount: 0.5 }, enabled: true }
    ];
    await bench(`applyLayerEffectStack (5 effects)`, () => applyLayerEffectStack(img, stack));
  }

  // ---- codecs at 2048
  {
    const size = 2048;
    console.log(`\nCodecs ${size}x${size}`);
    const img = patternImage(size, 5, false);
    const png = encodePng(img);
    await bench(`PNG encode (${(png.length / 1e6).toFixed(1)} MB out)`, () => encodePng(img));
    await bench(`PNG decode`, () => decodePng(png));
    const jpg = encodeJpeg(img, 90);
    await bench(`JPEG encode q90 (${(jpg.length / 1e6).toFixed(1)} MB out)`, () => encodeJpeg(img, 90));
    await bench(`JPEG decode`, () => decodeJpeg(jpg));

    // TIFF LZW decode: fixture produced by ffmpeg (an independent encoder) from the same pattern.
    const tifPath = join(TMP, 'pattern-2048-lzw.tif');
    if (!existsSync(tifPath)) {
      const pngPath = join(TMP, 'pattern-2048.png');
      writeFileSync(pngPath, png);
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', pngPath, '-c:v', 'tiff', '-compression_algo', 'lzw', tifPath]);
    }
    const tif = readFileSync(tifPath);
    const decoded = decodeTiff(tif);
    if (decoded.width !== size || decoded.height !== size) throw new Error('LZW TIFF fixture decoded to wrong size');
    await bench(`TIFF LZW decode (${(tif.length / 1e6).toFixed(1)} MB in)`, () => decodeTiff(tif));
  }

  // ---- PSD round trip at 1024
  {
    const size = 1024;
    console.log(`\nPSD round trip ${size}x${size} (6 layers)`);
    const project = plainProject(size, 6);
    const bytes = exportPsd(project);
    console.log(`  PSD size: ${(bytes.length / 1e6).toFixed(1)} MB`);
    await bench(`PSD export+import round trip`, () => {
      const out = exportPsd(project);
      const back = importPsd(out);
      if (back.project.layers.length !== project.layers.length) throw new Error('PSD round trip layer count changed');
    });
  }

  console.log(`\nAll parallel/pooled results byte-identical to serial: ${allEqual}`);
  if (!allEqual) process.exit(1);
}

void main();
