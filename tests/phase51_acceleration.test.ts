import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  addLayer,
  createPixelImage,
  getPixel,
  fillRect,
  setLayerBlendMode,
  setLayerOpacity,
  setLayerClipped,
  createGroup,
  setLayerGroup,
  setGroupOpacity,
  setGroupBlendMode,
  createLayerMask,
  getLayerMask,
  composite,
  compositeRows,
  applyFilterToImage
} from '../server/imageEditor/imageCore.js';
import {
  PARALLEL_MIN_PIXELS,
  computeBands,
  detectAccelerationCapabilities,
  registerComputeProvider,
  unregisterComputeProvider,
  getComputeProvider,
  listComputeProviders,
  resolveExecutionPlan,
  compositeProjectAsync,
  applyFilterAsync,
  hostCoreCount
} from '../server/imageEditor/acceleration.js';
import type { ComputeProvider } from '../server/imageEditor/acceleration.js';
import type { ImageProject, PixelImage, RgbaColor } from '../server/imageEditor/types.js';

/**
 * Phase 51: GPU Acceleration and Performance — the honest edition.
 *
 * There is no GPU in this environment and none is faked: the
 * capability test asserts detection reports GPU unavailable. What is
 * real and pinned here: the provider registry, the execution-plan
 * policy (including every fallback rule and the exact size
 * threshold), the band-split arithmetic, and byte-exact consistency
 * between the worker_threads parallel provider and the serial
 * engine — for compositing (blend modes, masks, groups, clipping)
 * and for the band-separable blurs, on sizes whose heights do not
 * divide evenly across workers, with blur footprints straddling
 * band boundaries.
 */

function assertImagesEqual(actual: PixelImage, expected: PixelImage, what: string): void {
  assert.equal(actual.width, expected.width, `${what}: width`);
  assert.equal(actual.height, expected.height, `${what}: height`);
  assert.deepEqual(actual.data, expected.data, `${what}: pixels must be byte-identical`);
}

/** Deterministic non-trivial RGBA pattern (all channels vary with x and y). */
function patternInto(img: PixelImage, seed: number, alphaMode: 'opaque' | 'varied'): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = (x * 7 + y * 13 + seed * 31) % 256;
      img.data[i + 1] = (x * 3 + y * 29 + seed * 57) % 256;
      img.data[i + 2] = (x * 11 + y * 5 + seed * 91) % 256;
      img.data[i + 3] = alphaMode === 'opaque' ? 255 : 96 + ((x + y * 3 + seed) % 160);
    }
  }
}

/**
 * A project exercising the compositing features whose math must
 * survive banding: blend modes, opacity, a per-row gradient mask,
 * an isolated group (opacity + blend mode) with a clipped member,
 * and a hidden layer that must contribute nothing.
 */
function richProject(width: number, height: number): ImageProject {
  const p = createProject(width, height);
  patternInto(p.layers[0].image, 0, 'opaque');

  const multiply = addLayer(p, 'Multiply');
  patternInto(multiply.image, 1, 'varied');
  setLayerBlendMode(p, multiply.id, 'multiply');
  setLayerOpacity(p, multiply.id, 0.8);

  const screen = addLayer(p, 'Screen + mask');
  patternInto(screen.image, 2, 'varied');
  setLayerBlendMode(p, screen.id, 'screen');
  createLayerMask(p, screen.id, 255);
  const mask = getLayerMask(p, screen.id)!;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) mask.data[y * width + x] = (y * 255) / Math.max(1, height - 1);
  }

  const group = createGroup(p, 'Group');
  setGroupOpacity(p, group.id, 0.9);
  setGroupBlendMode(p, group.id, 'overlay');
  const gBase = addLayer(p, 'Group base');
  patternInto(gBase.image, 3, 'varied');
  setLayerGroup(p, gBase.id, group.id);
  const gClip = addLayer(p, 'Group clipped');
  patternInto(gClip.image, 4, 'varied');
  setLayerGroup(p, gClip.id, group.id);
  setLayerClipped(p, gClip.id, true);

  const hidden = addLayer(p, 'Hidden');
  fillRect(p, hidden.id, { x: 0, y: 0, width, height }, { r: 255, g: 0, b: 255, a: 255 });
  hidden.visible = false;
  return p;
}

/** Vertical step edge plus fine pattern in the other channels. */
function stepImage(width: number, height: number): PixelImage {
  const img = createPixelImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = x < width / 2 ? 0 : 200;
      img.data[i + 1] = (x * 5 + y * 17) % 256;
      img.data[i + 2] = (255 - x * 2 - y) % 256;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Black field with white impulses placed to straddle band boundaries of a 257-row image split 4 ways (bands end at rows 65, 129, 193). */
function impulseImage(width: number, height: number): PixelImage {
  const img = createPixelImage(width, height, { r: 0, g: 0, b: 0, a: 255 });
  const dot = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
  };
  dot(128, 64); // last row of band 0 — footprint crosses into band 1
  dot(10, 129); // first row of band 2 — footprint crosses into band 1
  dot(200, 200); // interior of band 3
  return img;
}

describe('1. Capability detection (honest)', () => {
  test('1.1 CPU is available; GPU is reported unavailable in this environment', () => {
    const caps = detectAccelerationCapabilities();
    assert.equal(caps.cpu.available, true);
    assert.equal(caps.cpu.cores, hostCoreCount());
    assert.ok(caps.cpu.cores >= 1);
    // The hard environment fact, asserted — not just documented:
    // no GPU provider is registered and Node here has no WebGPU.
    assert.equal(caps.gpu.available, false);
    assert.equal(caps.gpu.webGpuRuntimePresent, false);
    assert.match(caps.gpu.reason, /No GPU compute provider is registered/);
  });

  test('1.2 Parallel CPU is available with a sane worker bound; built-in providers are listed', () => {
    const caps = detectAccelerationCapabilities();
    assert.equal(caps.parallelCpu.available, true);
    assert.ok(caps.parallelCpu.maxWorkers >= 1 && caps.parallelCpu.maxWorkers <= 8);
    assert.equal(caps.parallelCpu.reason, null);
    const ids = caps.providers.map((p) => p.id);
    assert.ok(ids.includes('cpu-serial'));
    assert.ok(ids.includes('cpu-parallel'));
  });
});

describe('2. Provider registry', () => {
  test('2.1 Built-ins resolve by id; unknown ids throw naming what is registered', () => {
    assert.equal(getComputeProvider('cpu-serial').kind, 'cpu-serial');
    assert.equal(getComputeProvider('cpu-parallel').kind, 'cpu-parallel');
    assert.throws(() => getComputeProvider('gpu-magic'), /Unknown compute provider: gpu-magic/);
    const kinds = new Map(listComputeProviders().map((p) => [p.id, p.kind]));
    assert.equal(kinds.get('cpu-serial'), 'cpu-serial');
    assert.equal(kinds.get('cpu-parallel'), 'cpu-parallel');
  });

  test('2.2 A custom provider registers, dispatches by name, and unregisters', async () => {
    const marker: RgbaColor = { r: 1, g: 2, b: 3, a: 255 };
    const custom: ComputeProvider = {
      id: 'test-marker-provider',
      kind: 'cpu-serial',
      description: 'Test double proving registry dispatch (not an acceleration claim).',
      async composite(project: ImageProject): Promise<PixelImage> {
        return createPixelImage(project.width, project.height, marker);
      },
      async applyFilter(image: PixelImage): Promise<PixelImage> {
        return createPixelImage(image.width, image.height, marker);
      }
    };
    try {
      registerComputeProvider(custom);
      assert.equal(getComputeProvider('test-marker-provider'), custom);
      const out = await compositeProjectAsync(createProject(8, 8), { provider: 'test-marker-provider' });
      assert.deepEqual(getPixel(out, 0, 0), marker);
      const plan = resolveExecutionPlan({ width: 8, height: 8 }, { provider: 'test-marker-provider' });
      assert.equal(plan.providerId, 'test-marker-provider');
      assert.equal(plan.kind, 'cpu-serial');
    } finally {
      assert.equal(unregisterComputeProvider('test-marker-provider'), true);
    }
    assert.equal(unregisterComputeProvider('test-marker-provider'), false);
    assert.throws(() => getComputeProvider('test-marker-provider'), /Unknown compute provider/);
  });

  test('2.3 Registration validates the provider shape', () => {
    assert.throws(() => registerComputeProvider({ id: '', kind: 'cpu-serial' } as ComputeProvider), /non-empty string id/);
    assert.throws(
      () => registerComputeProvider({ id: 'x', kind: 'quantum' } as unknown as ComputeProvider),
      /Unknown compute provider kind/
    );
    assert.throws(
      () => registerComputeProvider({ id: 'x', kind: 'gpu', description: 'no methods' } as unknown as ComputeProvider),
      /must implement composite\(\) and applyFilter\(\)/
    );
  });
});

describe('3. Band splitting', () => {
  test('3.1 Bands cover the height exactly, in order, sizes differing by at most one', () => {
    assert.deepEqual(computeBands(10, 3), [
      { y0: 0, y1: 4 },
      { y0: 4, y1: 7 },
      { y0: 7, y1: 10 }
    ]);
    assert.deepEqual(
      computeBands(61, 4).map((b) => b.y1 - b.y0),
      [16, 15, 15, 15]
    );
    assert.deepEqual(
      computeBands(5, 5).map((b) => b.y1 - b.y0),
      [1, 1, 1, 1, 1]
    );
    assert.deepEqual(computeBands(7, 1), [{ y0: 0, y1: 7 }]);
    for (const [h, n] of [
      [257, 4],
      [257, 3],
      [100, 7]
    ] as const) {
      const bands = computeBands(h, n);
      assert.equal(bands.length, n);
      assert.equal(bands[0].y0, 0);
      assert.equal(bands[n - 1].y1, h);
      for (let i = 1; i < n; i++) assert.equal(bands[i].y0, bands[i - 1].y1);
    }
  });

  test('3.2 Invalid splits throw', () => {
    assert.throws(() => computeBands(0, 1), /positive integer height/);
    assert.throws(() => computeBands(10, 0), /Band count must be an integer in 1\.\.10/);
    assert.throws(() => computeBands(10, 11), /Band count must be an integer in 1\.\.10/);
    assert.throws(() => computeBands(10, 2.5), /Band count must be an integer in 1\.\.10/);
  });
});

describe('4. Execution plan policy', () => {
  test('4.1 Small images fall back to serial with the reason recorded', () => {
    const plan = resolveExecutionPlan({ width: 64, height: 64 });
    assert.equal(plan.providerId, 'cpu-serial');
    assert.equal(plan.bandCount, 1);
    assert.equal(plan.workers, 0);
    assert.match(plan.reason, /below the parallel threshold/);
  });

  test('4.2 The size threshold is exact: 65,535 pixels serial, 65,536 parallel', () => {
    assert.equal(PARALLEL_MIN_PIXELS, 65_536);
    assert.equal(resolveExecutionPlan({ width: 255, height: 257 }).providerId, 'cpu-serial'); // 65,535 px
    const plan = resolveExecutionPlan({ width: 256, height: 256 }); // exactly 65,536 px
    assert.equal(plan.providerId, 'cpu-parallel');
    assert.ok(plan.bandCount >= 2);
    assert.equal(plan.workers, plan.bandCount);
  });

  test('4.3 Explicit providers: serial stays serial; parallel on a small image falls back with reason', () => {
    const serial = resolveExecutionPlan({ width: 512, height: 512 }, { provider: 'cpu-serial' });
    assert.equal(serial.providerId, 'cpu-serial');
    assert.match(serial.reason, /Explicit provider 'cpu-serial'/);
    const fallback = resolveExecutionPlan({ width: 64, height: 64 }, { provider: 'cpu-parallel' });
    assert.equal(fallback.providerId, 'cpu-serial');
    assert.match(fallback.reason, /below the parallel threshold/);
    const parallel = resolveExecutionPlan({ width: 512, height: 512 }, { provider: 'cpu-parallel', workers: 2 });
    assert.equal(parallel.providerId, 'cpu-parallel');
    assert.equal(parallel.bandCount, 2);
  });

  test('4.4 Worker count shapes the split; one worker is a serial fallback', () => {
    assert.equal(resolveExecutionPlan({ width: 512, height: 512 }, { workers: 3 }).bandCount, 3);
    const one = resolveExecutionPlan({ width: 512, height: 512 }, { workers: 1 });
    assert.equal(one.providerId, 'cpu-serial');
    assert.match(one.reason, /Fewer than two row bands/);
    // Bands never exceed the image height.
    assert.equal(resolveExecutionPlan({ width: 100_000, height: 2 }, { workers: 8 }).bandCount, 2);
  });

  test('4.5 Non-bandable work falls back to serial; bad options throw', () => {
    const plan = resolveExecutionPlan({ width: 512, height: 512, banded: false });
    assert.equal(plan.providerId, 'cpu-serial');
    assert.match(plan.reason, /cannot be split into row bands/);
    assert.throws(() => resolveExecutionPlan({ width: 512, height: 512 }, { provider: 'nope' }), /Unknown compute provider/);
    assert.throws(() => resolveExecutionPlan({ width: 512, height: 512 }, { workers: 0 }), /Worker count must be an integer in 1\.\.64/);
    assert.throws(() => resolveExecutionPlan({ width: 512, height: 512 }, { workers: 2.5 }), /Worker count must be an integer in 1\.\.64/);
    assert.throws(() => resolveExecutionPlan({ width: 0, height: 512 }), /Task size must be positive integers/);
  });
});

describe('5. Parallel composite consistency', () => {
  test('5.1 compositeRows bands reassemble into exactly composite()', () => {
    const p = richProject(40, 61);
    const full = composite(p);
    for (const bandCount of [2, 3, 4, 7]) {
      const bands = computeBands(61, bandCount);
      const reassembled = createPixelImage(40, 61);
      for (const b of bands) {
        const band = compositeRows(p, b.y0, b.y1);
        assert.equal(band.height, b.y1 - b.y0);
        reassembled.data.set(band.data, b.y0 * 40 * 4);
      }
      assertImagesEqual(reassembled, full, `compositeRows x${bandCount}`);
    }
    assert.throws(() => compositeRows(p, 60, 60), /Invalid composite row band/);
    assert.throws(() => compositeRows(p, 0, 62), /Invalid composite row band/);
  });

  test('5.2 The cpu-parallel provider composites a small rich project byte-identically (workers below the policy threshold)', async () => {
    const p = richProject(40, 61);
    const out = await getComputeProvider('cpu-parallel').composite(p);
    assertImagesEqual(out, composite(p), 'cpu-parallel provider composite');
  });

  test('5.3 compositeProjectAsync (default policy, 2, 3 and 4 workers, explicit parallel) matches composite() on a 256x257 rich project', async () => {
    const p = richProject(256, 257);
    const expected = composite(p);
    assertImagesEqual(await compositeProjectAsync(p), expected, 'default policy');
    assertImagesEqual(await compositeProjectAsync(p, { workers: 2 }), expected, 'workers=2');
    assertImagesEqual(await compositeProjectAsync(p, { workers: 3 }), expected, 'workers=3');
    assertImagesEqual(await compositeProjectAsync(p, { provider: 'cpu-parallel', workers: 4 }), expected, 'explicit parallel');
    assertImagesEqual(await compositeProjectAsync(p, { provider: 'cpu-serial' }), expected, 'explicit serial');
  });

  test('5.4 compositeProjectAsync on a small project (serial fallback) still matches composite()', async () => {
    const p = richProject(40, 61);
    assertImagesEqual(await compositeProjectAsync(p, { provider: 'cpu-parallel' }), composite(p), 'small explicit parallel');
  });

  test('5.5 The cpu-serial provider is the serial engine', async () => {
    const p = richProject(24, 30);
    assertImagesEqual(await getComputeProvider('cpu-serial').composite(p), composite(p), 'cpu-serial provider');
  });
});

describe('6. Parallel filter consistency', () => {
  test('6.1 Box blur over a step image: async (default, 4 workers, 3 workers) is byte-identical to serial', async () => {
    const img = stepImage(256, 257);
    const expected = applyFilterToImage(img, 'box-blur', { radius: 3 });
    assertImagesEqual(await applyFilterAsync(img, 'box-blur', { radius: 3 }), expected, 'default policy');
    assertImagesEqual(await applyFilterAsync(img, 'box-blur', { radius: 3 }, { workers: 4 }), expected, 'workers=4');
    assertImagesEqual(await applyFilterAsync(img, 'box-blur', { radius: 3 }, { workers: 3 }), expected, 'workers=3');
    // The input is never mutated by either path.
    assertImagesEqual(img, stepImage(256, 257), 'input untouched');
  });

  test('6.2 Gaussian blur over boundary-straddling impulses: halo rows are exact across bands', async () => {
    const img = impulseImage(256, 257);
    const expected = applyFilterToImage(img, 'gaussian-blur', { sigma: 1.5 });
    assertImagesEqual(await applyFilterAsync(img, 'gaussian-blur', { sigma: 1.5 }, { workers: 4 }), expected, 'gaussian workers=4');
    const expectedBox = applyFilterToImage(img, 'box-blur', { radius: 2 });
    assertImagesEqual(await applyFilterAsync(img, 'box-blur', { radius: 2 }, { workers: 4 }), expectedBox, 'box workers=4');
  });

  test('6.3 The cpu-parallel provider runs banded filters directly; identity parameters stay exact', async () => {
    const img = stepImage(64, 61);
    const provider = getComputeProvider('cpu-parallel');
    assertImagesEqual(
      await provider.applyFilter(img, 'box-blur', { radius: 2 }),
      applyFilterToImage(img, 'box-blur', { radius: 2 }),
      'provider box blur'
    );
    assertImagesEqual(await provider.applyFilter(img, 'box-blur', { radius: 0 }), img, 'provider radius-0 identity');
    assertImagesEqual(
      await applyFilterAsync(img, 'gaussian-blur', { sigma: 0 }),
      img,
      'async sigma-0 identity (serial fallback size, identity params)'
    );
  });

  test('6.4 Non-bandable filters fall back to serial through applyFilterAsync and are refused by the parallel provider', async () => {
    const img = stepImage(256, 257);
    assertImagesEqual(await applyFilterAsync(img, 'invert'), applyFilterToImage(img, 'invert'), 'invert via async fallback');
    assertImagesEqual(
      await applyFilterAsync(img, 'sharpen', { amount: 1 }),
      applyFilterToImage(img, 'sharpen', { amount: 1 }),
      'sharpen via async fallback'
    );
    await assert.rejects(() => getComputeProvider('cpu-parallel').applyFilter(img, 'invert'), /not band-separable/);
  });

  test('6.5 Filter validation matches serial exactly: unknown ids and bad params fail before any worker runs', async () => {
    const img = stepImage(256, 257);
    await assert.rejects(() => applyFilterAsync(img, 'no-such-filter'), /Unknown filter/);
    await assert.rejects(() => applyFilterAsync(img, 'box-blur', { radius: 999 }), /out of range/);
    await assert.rejects(() => applyFilterAsync(img, 'box-blur', { bogus: 1 }), /Unknown parameter 'bogus'/);
    await assert.rejects(() => getComputeProvider('cpu-parallel').applyFilter(img, 'no-such-filter'), /Unknown filter/);
  });
});
