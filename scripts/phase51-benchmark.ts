/**
 * Phase 51 benchmark: serial vs parallel CPU execution for the
 * image editor's two heavy operations — project compositing and the
 * band-separable box blur — at 1024×1024 and 2048×2048.
 *
 * Honest measurement rules:
 *  - Times are wall-clock `performance.now()` around the real calls,
 *    on this machine, whatever it happens to be (the environment is
 *    printed first). Parallel times are end-to-end: they include
 *    worker spawn, structured-clone transfer of the inputs, band
 *    computation and assembly — no part of the parallel cost is
 *    hidden.
 *  - Every parallel result is verified byte-identical to the serial
 *    result; a mismatch fails the script (exit 1).
 *  - There is no GPU number: this environment has no GPU and the
 *    engine has no GPU provider (see
 *    server/imageEditor/acceleration.ts). Nothing is estimated.
 *
 * Usage: tsx scripts/phase51-benchmark.ts
 * Exit code: 0 only when every parallel result matched serial.
 */
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import {
  createProject,
  addLayer,
  createPixelImage,
  setLayerBlendMode,
  setLayerOpacity,
  createGroup,
  setLayerGroup,
  setGroupOpacity,
  createLayerMask,
  getLayerMask,
  composite,
  applyFilterToImage
} from '../server/imageEditor/imageCore.js';
import { compositeProjectAsync, applyFilterAsync, hostCoreCount } from '../server/imageEditor/acceleration.js';
import type { ImageProject, PixelImage } from '../server/imageEditor/types.js';

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

function benchProject(size: number): ImageProject {
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
    for (let x = 0; x < size; x++) mask.data[y * size + x] = (y * 255) / Math.max(1, size - 1);
  }
  const group = createGroup(p, 'Group');
  setGroupOpacity(p, group.id, 0.9);
  const g1 = addLayer(p, 'Group member 1');
  patternInto(g1.image, 3, true);
  setLayerGroup(p, g1.id, group.id);
  const g2 = addLayer(p, 'Group member 2');
  patternInto(g2.image, 4, true);
  setLayerGroup(p, g2.id, group.id);
  return p;
}

function benchImage(size: number): PixelImage {
  const img = createPixelImage(size, size);
  patternInto(img, 5, false);
  return img;
}

function equal(a: PixelImage, b: PixelImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

async function timed<T>(label: string, fn: () => T | Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(28)} ${ms.toFixed(1).padStart(10)} ms`);
  return { ms, value };
}

async function main(): Promise<void> {
  const cpus = os.cpus();
  console.log('Phase 51 benchmark — serial vs parallel CPU (worker_threads)');
  console.log(
    `Environment: node ${process.version}, ${os.platform()} ${os.arch()}, ` +
      `${cpus.length} logical CPUs (${cpus[0]?.model ?? 'unknown'}), availableParallelism=${hostCoreCount()}`
  );
  console.log('GPU: none present and no GPU provider registered — no GPU figures exist to report.');
  let allEqual = true;

  for (const size of [1024, 2048]) {
    console.log(`\nCanvas ${size}x${size} (${((size * size) / 1_000_000).toFixed(1)} MP)`);
    const project = benchProject(size);
    // Warmup (JIT) at the smaller size only, on the serial path.
    if (size === 1024) composite(project);
    const serialComp = await timed('composite serial', () => composite(project));
    const parallelComp = await timed('composite parallel (4 workers)', () =>
      compositeProjectAsync(project, { workers: 4 })
    );
    const compEqual = equal(serialComp.value, parallelComp.value);
    allEqual &&= compEqual;
    console.log(
      `  composite: parallel is ${(serialComp.ms / parallelComp.ms).toFixed(2)}x the serial speed; byte-identical: ${compEqual}`
    );

    const img = benchImage(size);
    if (size === 1024) applyFilterToImage(img, 'box-blur', { radius: 6 });
    const serialBlur = await timed('box-blur r=6 serial', () => applyFilterToImage(img, 'box-blur', { radius: 6 }));
    const parallelBlur = await timed('box-blur r=6 parallel (4 workers)', () =>
      applyFilterAsync(img, 'box-blur', { radius: 6 }, { workers: 4 })
    );
    const blurEqual = equal(serialBlur.value, parallelBlur.value);
    allEqual &&= blurEqual;
    console.log(
      `  box-blur: parallel is ${(serialBlur.ms / parallelBlur.ms).toFixed(2)}x the serial speed; byte-identical: ${blurEqual}`
    );
  }

  console.log(`\nAll parallel results byte-identical to serial: ${allEqual}`);
  if (!allEqual) process.exit(1);
}

void main();
