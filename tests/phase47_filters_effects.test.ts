import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  createPixelImage,
  clonePixelImage,
  getPixel,
  setPixel,
  getLayer,
  createSelection,
  createLayerMask,
  getLayerMask,
  adjustBrightnessContrast,
  adjustSaturation,
  grayscale,
  listFilters,
  getFilterDescriptor,
  resolveFilterParams,
  applyFilterToImage,
  applyFilter,
  previewFilter,
  previewFilterRegion
} from '../server/imageEditor/imageCore.js';
import type { PixelImage, RgbaColor } from '../server/imageEditor/types.js';

/**
 * Phase 47: Professional Filters and Effects.
 *
 * Expected values are computed from the documented filter models, not
 * copied from the implementation's output: box blur divides by the
 * kernel area, the Gaussian kernel is exp(-i²/2σ²) normalized, sharpen
 * is the [[0,-a,0],[-a,1+4a,-a],[0,-a,0]] kernel, Sobel gradients of a
 * step of height h are 4h, sepia is the standard matrix, posterize
 * quantizes to levels-1 steps, hue rotation is done in HSL space.
 */

function grayImage(width: number, height: number, values: number[], alpha = 255): PixelImage {
  const img = createPixelImage(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = values[i];
    img.data[i * 4 + 1] = values[i];
    img.data[i * 4 + 2] = values[i];
    img.data[i * 4 + 3] = alpha;
  }
  return img;
}

function solidImage(width: number, height: number, c: RgbaColor): PixelImage {
  return createPixelImage(width, height, c);
}

function projectWith(img: PixelImage) {
  const project = createProject(img.width, img.height);
  project.layers[0].image = clonePixelImage(img);
  return { project, layerId: project.layers[0].id };
}

function bytes(img: PixelImage): number[] {
  return [...img.data];
}

describe('SquadForge Phase 47: Professional Filters and Effects Test Suite', () => {
  describe('1. Filter registry and parameter validation', () => {
    test('1.1 The registry lists exactly the implemented filters, each with a sane schema', () => {
      const ids = listFilters().map((f) => f.id);
      assert.deepStrictEqual(ids, [
        'box-blur',
        'gaussian-blur',
        'sharpen',
        'noise',
        'edge-detect',
        'emboss',
        'wave',
        'swirl',
        'brightness-contrast',
        'saturation',
        'hue-rotate',
        'invert',
        'grayscale',
        'sepia',
        'posterize',
        'threshold'
      ]);
      for (const f of listFilters()) {
        assert.ok(f.name.length > 0, `${f.id} has a display name`);
        for (const p of f.params) {
          assert.ok(p.min <= p.defaultValue && p.defaultValue <= p.max, `${f.id}.${p.name} default inside range`);
        }
      }
    });

    test('1.2 Descriptors are defensive copies', () => {
      const list = listFilters();
      list[0].params[0].min = -999;
      list[0].id = 'tampered';
      const fresh = getFilterDescriptor('box-blur');
      assert.strictEqual(fresh.id, 'box-blur');
      assert.strictEqual(fresh.params[0].min, 0);
    });

    test('1.3 Unknown filter ids are rejected everywhere', () => {
      const img = solidImage(2, 2, { r: 0, g: 0, b: 0, a: 255 });
      assert.throws(() => getFilterDescriptor('median'), /Unknown filter/);
      assert.throws(() => resolveFilterParams('median'), /Unknown filter/);
      assert.throws(() => applyFilterToImage(img, 'median'), /Unknown filter/);
      const { project, layerId } = projectWith(img);
      assert.throws(() => applyFilter(project, layerId, 'median'), /Unknown filter/);
      assert.throws(() => previewFilter(project, layerId, 'median'), /Unknown filter/);
    });

    test('1.4 Unknown parameter names and out-of-range values are rejected, not clamped', () => {
      assert.throws(() => resolveFilterParams('box-blur', { radus: 1 }), /Unknown parameter 'radus'/);
      assert.throws(() => resolveFilterParams('box-blur', { radius: 51 }), /out of range/);
      assert.throws(() => resolveFilterParams('box-blur', { radius: -1 }), /out of range/);
      assert.throws(() => resolveFilterParams('posterize', { levels: 1 }), /out of range/);
      assert.throws(() => resolveFilterParams('noise', { amount: Number.NaN }), /finite number/);
      assert.throws(() => resolveFilterParams('swirl', { angle: 721 }), /out of range/);
    });

    test('1.5 Missing parameters resolve to the schema defaults', () => {
      assert.deepStrictEqual(resolveFilterParams('gaussian-blur'), { sigma: 1, radius: 0 });
      assert.deepStrictEqual(resolveFilterParams('gaussian-blur', { sigma: 2 }), { sigma: 2, radius: 0 });
      assert.deepStrictEqual(resolveFilterParams('invert'), {});
      assert.deepStrictEqual(resolveFilterParams('noise', { seed: 7 }), { amount: 25, seed: 7 });
    });

    test('1.6 Applying with omitted params equals applying with explicit defaults', () => {
      const img = grayImage(4, 4, [0, 40, 80, 120, 160, 200, 255, 30, 60, 90, 110, 140, 170, 190, 210, 230]);
      const a = applyFilterToImage(img, 'gaussian-blur');
      const b = applyFilterToImage(img, 'gaussian-blur', { sigma: 1, radius: 0 });
      assert.deepStrictEqual(bytes(a), bytes(b));
    });

    test('1.7 applyFilterToImage never mutates its input', () => {
      const img = grayImage(5, 5, new Array(25).fill(0).map((_, i) => (i * 37) % 256));
      const before = bytes(img);
      applyFilterToImage(img, 'box-blur', { radius: 2 });
      applyFilterToImage(img, 'sepia', { amount: 1 });
      applyFilterToImage(img, 'wave', { amplitude: 3 });
      assert.deepStrictEqual(bytes(img), before);
    });
  });

  describe('2. Box blur', () => {
    test('2.1 A uniform image is unchanged, including alpha', () => {
      const img = solidImage(4, 3, { r: 10, g: 20, b: 30, a: 200 });
      const out = applyFilterToImage(img, 'box-blur', { radius: 2 });
      assert.deepStrictEqual(bytes(out), bytes(img));
    });

    test('2.2 Impulse: the 3x3 neighborhood gets 255/9 = 28, everything else 0', () => {
      const values = new Array(25).fill(0);
      values[12] = 255;
      const out = applyFilterToImage(grayImage(5, 5, values), 'box-blur', { radius: 1 });
      for (const [x, y] of [[2, 2], [1, 1], [3, 3], [2, 1], [1, 3]] as const) {
        assert.strictEqual(getPixel(out, x, y).r, 28, `(${x},${y})`);
      }
      assert.strictEqual(getPixel(out, 0, 0).r, 0);
      assert.strictEqual(getPixel(out, 2, 0).r, 0);
      assert.strictEqual(getPixel(out, 4, 4).r, 0);
    });

    test('2.3 Alpha is convolved too: a lone opaque pixel spreads to 28 alpha', () => {
      const img = createPixelImage(5, 5);
      setPixel(img, 2, 2, { r: 0, g: 0, b: 0, a: 255 });
      const out = applyFilterToImage(img, 'box-blur', { radius: 1 });
      assert.strictEqual(getPixel(out, 2, 2).a, 28);
      assert.strictEqual(getPixel(out, 0, 0).a, 0);
    });

    test('2.4 Step edge: exact thirds at the boundary (85 and 170)', () => {
      const row = [0, 0, 0, 255, 255, 255];
      const img = grayImage(6, 4, [...row, ...row, ...row, ...row]);
      const out = applyFilterToImage(img, 'box-blur', { radius: 1 });
      assert.strictEqual(getPixel(out, 0, 0).r, 0);
      assert.strictEqual(getPixel(out, 2, 1).r, 85);
      assert.strictEqual(getPixel(out, 3, 2).r, 170);
      assert.strictEqual(getPixel(out, 5, 3).r, 255);
    });

    test('2.5 Radius 0 is the identity', () => {
      const img = grayImage(3, 3, [5, 15, 25, 35, 45, 55, 65, 75, 85]);
      assert.deepStrictEqual(bytes(applyFilterToImage(img, 'box-blur', { radius: 0 })), bytes(img));
    });
  });

  describe('3. Gaussian blur', () => {
    test('3.1 A uniform image is unchanged (kernel is normalized)', () => {
      const img = solidImage(5, 5, { r: 77, g: 88, b: 99, a: 123 });
      const out = applyFilterToImage(img, 'gaussian-blur', { sigma: 2 });
      assert.deepStrictEqual(bytes(out), bytes(img));
    });

    test('3.2 Impulse response matches the normalized exp(-i²/2σ²) kernel', () => {
      const values = new Array(81).fill(0);
      values[40] = 255;
      const img = grayImage(9, 9, values);
      const out = applyFilterToImage(img, 'gaussian-blur', { sigma: 1 });
      const sigma = 1;
      const R = Math.ceil(3 * sigma);
      const raw: number[] = [];
      let sum = 0;
      for (let i = -R; i <= R; i++) {
        const w = Math.exp(-(i * i) / (2 * sigma * sigma));
        raw.push(w);
        sum += w;
      }
      const w0 = raw[R] / sum;
      const w1 = raw[R + 1] / sum;
      const near = (actual: number, expected: number) =>
        assert.ok(Math.abs(actual - expected) <= 1, `${actual} within 1 of ${expected}`);
      near(getPixel(out, 4, 4).r, Math.round(255 * w0 * w0)); // ≈ 41
      near(getPixel(out, 5, 4).r, Math.round(255 * w0 * w1)); // ≈ 25
      near(getPixel(out, 5, 5).r, Math.round(255 * w1 * w1)); // ≈ 15
      assert.strictEqual(getPixel(out, 0, 0).r, 0);
    });

    test('3.3 Sigma 0 is the identity; a larger sigma spreads the impulse further', () => {
      const values = new Array(81).fill(0);
      values[40] = 255;
      const img = grayImage(9, 9, values);
      assert.deepStrictEqual(bytes(applyFilterToImage(img, 'gaussian-blur', { sigma: 0 })), bytes(img));
      const tight = applyFilterToImage(img, 'gaussian-blur', { sigma: 0.5 });
      const wide = applyFilterToImage(img, 'gaussian-blur', { sigma: 2 });
      assert.ok(getPixel(wide, 4, 4).r < getPixel(tight, 4, 4).r, 'wider sigma lowers the centre');
      assert.ok(getPixel(wide, 6, 4).r > getPixel(tight, 6, 4).r, 'wider sigma reaches further out');
    });

    test('3.4 An explicit radius truncates the kernel (less spread, higher centre)', () => {
      const values = new Array(81).fill(0);
      values[40] = 255;
      const img = grayImage(9, 9, values);
      const auto = applyFilterToImage(img, 'gaussian-blur', { sigma: 1, radius: 0 });
      const truncated = applyFilterToImage(img, 'gaussian-blur', { sigma: 1, radius: 1 });
      assert.ok(getPixel(truncated, 4, 4).r > getPixel(auto, 4, 4).r);
    });
  });

  describe('4. Sharpen', () => {
    const step = () => {
      const row = [100, 100, 100, 155, 155, 155];
      return grayImage(6, 4, [...row, ...row, ...row, ...row]);
    };

    test('4.1 A step edge gains exactly the kernel contrast (100/155 -> 45/210 at amount 1)', () => {
      const out = applyFilterToImage(step(), 'sharpen', { amount: 1 });
      assert.strictEqual(getPixel(out, 2, 0).r, 45); // 5*100 - (100+155+100+100)
      assert.strictEqual(getPixel(out, 3, 0).r, 210); // 5*155 - (155+100+155+155)
      assert.strictEqual(getPixel(out, 0, 0).r, 100); // flat area untouched
      assert.strictEqual(getPixel(out, 5, 0).r, 155);
    });

    test('4.2 Amount 0 is the identity; a flat image is unchanged at any amount', () => {
      assert.deepStrictEqual(bytes(applyFilterToImage(step(), 'sharpen', { amount: 0 })), bytes(step()));
      const flat = solidImage(4, 4, { r: 90, g: 80, b: 70, a: 60 });
      const out = applyFilterToImage(flat, 'sharpen', { amount: 3 });
      assert.deepStrictEqual(bytes(out), bytes(flat)); // alpha preserved too
    });
  });

  describe('5. Noise', () => {
    test('5.1 The same seed reproduces byte-identical output', () => {
      const img = solidImage(8, 8, { r: 128, g: 128, b: 128, a: 255 });
      const a = applyFilterToImage(img, 'noise', { amount: 40, seed: 42 });
      const b = applyFilterToImage(img, 'noise', { amount: 40, seed: 42 });
      assert.deepStrictEqual(bytes(a), bytes(b));
    });

    test('5.2 A different seed gives different output; amount 0 is the identity', () => {
      const img = solidImage(8, 8, { r: 128, g: 128, b: 128, a: 255 });
      const a = applyFilterToImage(img, 'noise', { amount: 40, seed: 42 });
      const b = applyFilterToImage(img, 'noise', { amount: 40, seed: 43 });
      assert.notDeepStrictEqual(bytes(a), bytes(b));
      assert.deepStrictEqual(bytes(applyFilterToImage(img, 'noise', { amount: 0, seed: 42 })), bytes(img));
    });

    test('5.3 Every channel stays within ±amount, alpha is untouched, values genuinely vary', () => {
      const img = solidImage(16, 16, { r: 128, g: 128, b: 128, a: 200 });
      const out = applyFilterToImage(img, 'noise', { amount: 30, seed: 7 });
      const seen = new Set<number>();
      for (let i = 0; i < out.data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const v = out.data[i + c];
          assert.ok(v >= 98 && v <= 158, `channel within ±30 of 128, got ${v}`);
          seen.add(v);
        }
        assert.strictEqual(out.data[i + 3], 200);
      }
      assert.ok(seen.size > 10, `noise produced ${seen.size} distinct values`);
    });
  });

  describe('6. Edge detection (Sobel)', () => {
    test('6.1 A flat image has no edges; alpha is preserved', () => {
      const img = solidImage(5, 5, { r: 200, g: 100, b: 50, a: 77 });
      const out = applyFilterToImage(img, 'edge-detect', { strength: 1 });
      for (let i = 0; i < out.data.length; i += 4) {
        assert.strictEqual(out.data[i], 0);
        assert.strictEqual(out.data[i + 3], 77);
      }
    });

    test('6.2 A vertical step of 100 gives Sobel magnitude 400, scaled by strength', () => {
      const row = [0, 0, 0, 100, 100, 100];
      const img = grayImage(6, 4, [...row, ...row, ...row, ...row]);
      const out = applyFilterToImage(img, 'edge-detect', { strength: 0.5, threshold: 0 });
      assert.strictEqual(getPixel(out, 2, 1).r, 200); // 4*100 * 0.5
      assert.strictEqual(getPixel(out, 3, 1).r, 200);
      assert.strictEqual(getPixel(out, 0, 1).r, 0);
      assert.strictEqual(getPixel(out, 5, 1).r, 0);
      assert.strictEqual(getPixel(out, 2, 1).g, 200); // grayscale output
    });

    test('6.3 The threshold suppresses weaker responses (boundary is inclusive)', () => {
      const row = [0, 0, 0, 100, 100, 100];
      const img = grayImage(6, 4, [...row, ...row, ...row, ...row]);
      const kept = applyFilterToImage(img, 'edge-detect', { strength: 0.5, threshold: 200 });
      assert.strictEqual(getPixel(kept, 2, 1).r, 200);
      const suppressed = applyFilterToImage(img, 'edge-detect', { strength: 0.5, threshold: 201 });
      assert.strictEqual(getPixel(suppressed, 2, 1).r, 0);
    });

    test('6.4 Strength 0 yields a black image', () => {
      const row = [0, 0, 0, 100, 100, 100];
      const img = grayImage(6, 2, [...row, ...row]);
      const out = applyFilterToImage(img, 'edge-detect', { strength: 0 });
      assert.ok(bytes(out).every((v, i) => i % 4 === 3 || v === 0));
    });
  });

  describe('7. Emboss', () => {
    test('7.1 A flat image embosses to uniform mid-gray (128), alpha preserved', () => {
      const img = solidImage(5, 5, { r: 90, g: 30, b: 200, a: 66 });
      const out = applyFilterToImage(img, 'emboss', { strength: 2, angle: 135 });
      for (let i = 0; i < out.data.length; i += 4) {
        assert.strictEqual(out.data[i], 128);
        assert.strictEqual(out.data[i + 1], 128);
        assert.strictEqual(out.data[i + 2], 128);
        assert.strictEqual(out.data[i + 3], 66);
      }
    });

    test('7.2 A vertical step embosses along +x at angle 0 (128 + gradient)', () => {
      const row = [0, 0, 0, 64, 64, 64];
      const img = grayImage(6, 4, [...row, ...row, ...row, ...row]);
      const out = applyFilterToImage(img, 'emboss', { strength: 1, angle: 0 });
      assert.strictEqual(getPixel(out, 2, 1).r, 192); // gx = 64 - 0
      assert.strictEqual(getPixel(out, 3, 1).r, 192);
      assert.strictEqual(getPixel(out, 0, 1).r, 128);
      assert.strictEqual(getPixel(out, 5, 1).r, 128);
    });

    test('7.3 A horizontal step embosses along +y at angle 90', () => {
      const img = grayImage(4, 6, [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64
      ]);
      const out = applyFilterToImage(img, 'emboss', { strength: 1, angle: 90 });
      assert.strictEqual(getPixel(out, 1, 2).r, 192); // gy = 64 - 0
      assert.strictEqual(getPixel(out, 1, 3).r, 192);
      assert.strictEqual(getPixel(out, 1, 0).r, 128);
      assert.strictEqual(getPixel(out, 1, 5).r, 128);
    });
  });

  describe('8. Wave distortion', () => {
    const marker = () => {
      const img = solidImage(8, 8, { r: 0, g: 0, b: 0, a: 255 });
      setPixel(img, 2, 5, { r: 255, g: 255, b: 255, a: 255 });
      return img;
    };

    test('8.1 Amplitude 0 is the identity', () => {
      const img = marker();
      assert.deepStrictEqual(bytes(applyFilterToImage(img, 'wave', { amplitude: 0, wavelength: 8 })), bytes(img));
    });

    test('8.2 The wave moves a marker pixel by amplitude*sin(2πx/wavelength), exactly', () => {
      const out = applyFilterToImage(marker(), 'wave', { amplitude: 2, wavelength: 8, phase: 0 });
      // At x=2: shift = 2*sin(π/2) = +2, so output (2,3) samples source (2,5).
      assert.deepStrictEqual(getPixel(out, 2, 3), { r: 255, g: 255, b: 255, a: 255 });
      assert.deepStrictEqual(getPixel(out, 2, 5), { r: 0, g: 0, b: 0, a: 255 });
      let whites = 0;
      for (let i = 0; i < out.data.length; i += 4) if (out.data[i] === 255) whites++;
      assert.strictEqual(whites, 1);
    });

    test('8.3 Phase 180 flips the shift sign', () => {
      const out = applyFilterToImage(marker(), 'wave', { amplitude: 2, wavelength: 8, phase: 180 });
      // At x=2: shift = 2*sin(π/2 + π) = -2, so output (2,7) samples source (2,5).
      assert.deepStrictEqual(getPixel(out, 2, 7), { r: 255, g: 255, b: 255, a: 255 });
      assert.deepStrictEqual(getPixel(out, 2, 3), { r: 0, g: 0, b: 0, a: 255 });
    });
  });

  describe('9. Swirl distortion', () => {
    const scene = () => {
      const img = solidImage(9, 9, { r: 0, g: 0, b: 0, a: 255 });
      setPixel(img, 4, 4, { r: 255, g: 0, b: 0, a: 255 }); // centre: red
      setPixel(img, 6, 4, { r: 255, g: 255, b: 255, a: 255 }); // r=2 right of centre: white
      setPixel(img, 8, 4, { r: 0, g: 0, b: 255, a: 255 }); // r=4 (rim): blue
      return img;
    };

    test('9.1 Angle 0 is the identity', () => {
      const img = scene();
      assert.deepStrictEqual(bytes(applyFilterToImage(img, 'swirl', { angle: 0, radius: 4 })), bytes(img));
    });

    test('9.2 At r = R/2 with angle 720 the local rotation is exactly 180 degrees', () => {
      const out = applyFilterToImage(scene(), 'swirl', { angle: 720, radius: 4 });
      // factor (1 - 2/4)^2 = 0.25; 720 * 0.25 = 180: white lands opposite the centre.
      assert.deepStrictEqual(getPixel(out, 2, 4), { r: 255, g: 255, b: 255, a: 255 });
      assert.deepStrictEqual(getPixel(out, 6, 4), { r: 0, g: 0, b: 0, a: 255 });
      // The centre never moves; outside the radius nothing moves.
      assert.deepStrictEqual(getPixel(out, 4, 4), { r: 255, g: 0, b: 0, a: 255 });
      assert.deepStrictEqual(getPixel(out, 8, 4), { r: 0, g: 0, b: 255, a: 255 });
    });

    test('9.3 Direction: at r = R/2 with angle 360 the local rotation is +90 (engine convention)', () => {
      const out = applyFilterToImage(scene(), 'swirl', { angle: 360, radius: 4 });
      // +90 in the engine's rotation convention moves right-of-centre content below centre.
      assert.deepStrictEqual(getPixel(out, 4, 6), { r: 255, g: 255, b: 255, a: 255 });
      assert.deepStrictEqual(getPixel(out, 6, 4), { r: 0, g: 0, b: 0, a: 255 });
    });
  });

  describe('10. Color effects', () => {
    test('10.1 Hue rotate in HSL: red +120 = green, +240 = blue, gray is unmoved', () => {
      const red = solidImage(1, 1, { r: 255, g: 0, b: 0, a: 200 });
      assert.deepStrictEqual(getPixel(applyFilterToImage(red, 'hue-rotate', { degrees: 120 }), 0, 0), { r: 0, g: 255, b: 0, a: 200 });
      assert.deepStrictEqual(getPixel(applyFilterToImage(red, 'hue-rotate', { degrees: 240 }), 0, 0), { r: 0, g: 0, b: 255, a: 200 });
      assert.deepStrictEqual(getPixel(applyFilterToImage(red, 'hue-rotate', { degrees: -120 }), 0, 0), { r: 0, g: 0, b: 255, a: 200 });
      const gray = solidImage(1, 1, { r: 100, g: 100, b: 100, a: 255 });
      assert.deepStrictEqual(getPixel(applyFilterToImage(gray, 'hue-rotate', { degrees: 120 }), 0, 0), { r: 100, g: 100, b: 100, a: 255 });
      assert.deepStrictEqual(bytes(applyFilterToImage(red, 'hue-rotate', { degrees: 360 })), bytes(red));
    });

    test('10.2 Sepia matches the standard matrix, and blends by amount', () => {
      const white = solidImage(1, 1, { r: 255, g: 255, b: 255, a: 255 });
      // b: 255 * (0.272+0.534+0.131) = 238.9 -> 239; r/g saturate.
      assert.deepStrictEqual(getPixel(applyFilterToImage(white, 'sepia', { amount: 1 }), 0, 0), { r: 255, g: 255, b: 239, a: 255 });
      const color = solidImage(1, 1, { r: 120, g: 60, b: 30, a: 255 });
      // matrix: (98.97, 88.08, 68.61) -> (99, 88, 69)
      assert.deepStrictEqual(getPixel(applyFilterToImage(color, 'sepia', { amount: 1 }), 0, 0), { r: 99, g: 88, b: 69, a: 255 });
      // amount 0.5: midpoint (109.485, 74.04, 49.305) -> (109, 74, 49)
      assert.deepStrictEqual(getPixel(applyFilterToImage(color, 'sepia', { amount: 0.5 }), 0, 0), { r: 109, g: 74, b: 49, a: 255 });
      assert.deepStrictEqual(bytes(applyFilterToImage(color, 'sepia', { amount: 0 })), bytes(color));
    });

    test('10.3 Posterize quantizes to exactly levels-1 steps', () => {
      const img = grayImage(4, 1, [40, 100, 200, 255]);
      const out4 = applyFilterToImage(img, 'posterize', { levels: 4 });
      assert.deepStrictEqual([0, 1, 2, 3].map((x) => getPixel(out4, x, 0).r), [0, 85, 170, 255]);
      const img2 = grayImage(2, 1, [127, 128]);
      const out2 = applyFilterToImage(img2, 'posterize', { levels: 2 });
      assert.deepStrictEqual([getPixel(out2, 0, 0).r, getPixel(out2, 1, 0).r], [0, 255]);
    });

    test('10.4 Threshold splits on luminance at the level', () => {
      // Gray 127 and 129 straddle level 128 with margin (a gray pixel's
      // float luminance is v * (0.299+0.587+0.114), which is a hair under
      // v in floating point, so the exact-boundary gray is not used here;
      // the red case below has a 0.245 margin and pins the boundary rule).
      const img = grayImage(2, 1, [127, 129]);
      const out = applyFilterToImage(img, 'threshold', { level: 128 });
      assert.strictEqual(getPixel(out, 0, 0).r, 0);
      assert.strictEqual(getPixel(out, 1, 0).r, 255);
      const red = solidImage(1, 1, { r: 255, g: 0, b: 0, a: 90 }); // luminance 76.245
      assert.strictEqual(getPixel(applyFilterToImage(red, 'threshold', { level: 76 }), 0, 0).r, 255);
      const dark = applyFilterToImage(red, 'threshold', { level: 77 });
      assert.strictEqual(getPixel(dark, 0, 0).r, 0);
      assert.strictEqual(getPixel(dark, 0, 0).a, 90); // alpha preserved
    });

    test('10.5 Invert through the registry is exact and preserves alpha', () => {
      const img = solidImage(1, 1, { r: 10, g: 200, b: 130, a: 90 });
      assert.deepStrictEqual(getPixel(applyFilterToImage(img, 'invert'), 0, 0), { r: 245, g: 55, b: 125, a: 90 });
    });

    test('10.6 Grayscale through the registry: pure red becomes its luminance (76)', () => {
      const img = solidImage(1, 1, { r: 255, g: 0, b: 0, a: 255 });
      assert.deepStrictEqual(getPixel(applyFilterToImage(img, 'grayscale'), 0, 0), { r: 76, g: 76, b: 76, a: 255 });
    });

    test('10.7 Registry brightness-contrast is the Phase 19 adjustment itself (byte-equal)', () => {
      const img = grayImage(4, 2, [10, 60, 110, 160, 210, 250, 90, 140]);
      const viaFilter = applyFilterToImage(img, 'brightness-contrast', { brightness: 40, contrast: 20 });
      const { project, layerId } = projectWith(img);
      adjustBrightnessContrast(project, layerId, 40, 20);
      assert.deepStrictEqual(bytes(viaFilter), bytes(getLayer(project, layerId).image));
    });

    test('10.8 Registry saturation and grayscale are the Phase 19 adjustments themselves (byte-equal)', () => {
      const img = createPixelImage(3, 1);
      setPixel(img, 0, 0, { r: 200, g: 40, b: 90, a: 255 });
      setPixel(img, 1, 0, { r: 20, g: 180, b: 60, a: 128 });
      setPixel(img, 2, 0, { r: 0, g: 0, b: 255, a: 255 });
      const viaFilter = applyFilterToImage(img, 'saturation', { amount: 0.5 });
      const a = projectWith(img);
      adjustSaturation(a.project, a.layerId, 0.5);
      assert.deepStrictEqual(bytes(viaFilter), bytes(getLayer(a.project, a.layerId).image));
      const viaGray = applyFilterToImage(img, 'grayscale');
      const b = projectWith(img);
      grayscale(b.project, b.layerId);
      assert.deepStrictEqual(bytes(viaGray), bytes(getLayer(b.project, b.layerId).image));
    });
  });

  describe('11. Previews', () => {
    test('11.1 previewFilter leaves the project byte-identical and matches applyFilter', () => {
      const img = grayImage(6, 4, new Array(24).fill(0).map((_, i) => (i * 53) % 256));
      const { project, layerId } = projectWith(img);
      const before = bytes(getLayer(project, layerId).image);
      const preview = previewFilter(project, layerId, 'box-blur', { radius: 1 });
      assert.deepStrictEqual(bytes(getLayer(project, layerId).image), before);
      const other = projectWith(img);
      applyFilter(other.project, other.layerId, 'box-blur', { radius: 1 });
      assert.deepStrictEqual(bytes(preview), bytes(getLayer(other.project, other.layerId).image));
      assert.notDeepStrictEqual(bytes(preview), before); // the preview is genuinely filtered
    });

    test('11.2 previewFilterRegion returns the region crop of the full preview, project untouched', () => {
      const row = [0, 0, 0, 255, 255, 255];
      const img = grayImage(6, 4, [...row, ...row, ...row, ...row]);
      const { project, layerId } = projectWith(img);
      const before = bytes(getLayer(project, layerId).image);
      const region = previewFilterRegion(project, layerId, { x: 2, y: 1, width: 2, height: 2 }, 'box-blur', { radius: 1 });
      assert.strictEqual(region.width, 2);
      assert.strictEqual(region.height, 2);
      // From the full step-edge blur: (2,1) = 85, (3,1) = 170 — computed with
      // the whole layer as context, not from the crop alone.
      assert.strictEqual(getPixel(region, 0, 0).r, 85);
      assert.strictEqual(getPixel(region, 1, 0).r, 170);
      assert.deepStrictEqual(bytes(getLayer(project, layerId).image), before);
    });

    test('11.3 Invalid preview regions are rejected', () => {
      const { project, layerId } = projectWith(solidImage(4, 4, { r: 0, g: 0, b: 0, a: 255 }));
      assert.throws(() => previewFilterRegion(project, layerId, { x: 3, y: 0, width: 2, height: 2 }, 'invert'), /inside the layer/);
      assert.throws(() => previewFilterRegion(project, layerId, { x: 0, y: 0, width: 0, height: 2 }, 'invert'), /positive size/);
      assert.throws(() => previewFilterRegion(project, layerId, { x: 0, y: 0, width: 2, height: 2 }, 'median'), /Unknown filter/);
    });
  });

  describe('12. Scoping and model integration', () => {
    test('12.1 A raster selection weights the filter per pixel (128 = half blend)', () => {
      const img = solidImage(3, 1, { r: 100, g: 100, b: 100, a: 255 });
      const { project, layerId } = projectWith(img);
      const sel = createSelection(3, 1, 0);
      sel.data[0] = 0;
      sel.data[1] = 128;
      sel.data[2] = 255;
      applyFilter(project, layerId, 'invert', {}, { selectionMask: sel });
      const layer = getLayer(project, layerId).image;
      assert.strictEqual(getPixel(layer, 0, 0).r, 100); // unselected: untouched
      assert.strictEqual(getPixel(layer, 1, 0).r, 128); // round(100*(127/255) + 155*(128/255)) = round(127.6)
      assert.strictEqual(getPixel(layer, 2, 0).r, 155); // fully selected: fully filtered
    });

    test('12.2 The Phase 19 rect scope limits the filter to the rect', () => {
      const img = solidImage(4, 1, { r: 100, g: 100, b: 100, a: 255 });
      const { project, layerId } = projectWith(img);
      applyFilter(project, layerId, 'invert', {}, { selection: { x: 0, y: 0, width: 2, height: 1 } });
      const layer = getLayer(project, layerId).image;
      assert.strictEqual(getPixel(layer, 0, 0).r, 155);
      assert.strictEqual(getPixel(layer, 1, 0).r, 155);
      assert.strictEqual(getPixel(layer, 2, 0).r, 100);
      assert.strictEqual(getPixel(layer, 3, 0).r, 100);
    });

    test('12.3 Rect and raster scopes combine (rect outside wins over a full mask value)', () => {
      const img = solidImage(2, 1, { r: 100, g: 100, b: 100, a: 255 });
      const { project, layerId } = projectWith(img);
      const sel = createSelection(2, 1, 255);
      applyFilter(project, layerId, 'invert', {}, { selection: { x: 0, y: 0, width: 1, height: 1 }, selectionMask: sel });
      const layer = getLayer(project, layerId).image;
      assert.strictEqual(getPixel(layer, 0, 0).r, 155);
      assert.strictEqual(getPixel(layer, 1, 0).r, 100);
    });

    test('12.4 A selection of the wrong size is rejected', () => {
      const { project, layerId } = projectWith(solidImage(4, 4, { r: 0, g: 0, b: 0, a: 255 }));
      const sel = createSelection(2, 2, 255);
      assert.throws(() => applyFilter(project, layerId, 'invert', {}, { selectionMask: sel }), /does not match layer size/);
    });

    test("12.5 The layer's Phase 44 mask is preserved untouched by filtering", () => {
      const img = grayImage(5, 5, new Array(25).fill(0).map((_, i) => (i * 41) % 256));
      const { project, layerId } = projectWith(img);
      createLayerMask(project, layerId, 255);
      const mask = getLayerMask(project, layerId)!;
      mask.data[0] = 0;
      mask.data[12] = 128;
      const maskBefore = [...mask.data];
      const imageBefore = bytes(getLayer(project, layerId).image);
      applyFilter(project, layerId, 'box-blur', { radius: 1 });
      const after = getLayer(project, layerId);
      assert.ok(after.mask !== null);
      assert.deepStrictEqual([...after.mask!.data], maskBefore);
      assert.notDeepStrictEqual(bytes(after.image), imageBefore); // the filter genuinely ran
    });

    test('12.6 Missing layers are rejected', () => {
      const { project } = projectWith(solidImage(2, 2, { r: 0, g: 0, b: 0, a: 255 }));
      assert.throws(() => applyFilter(project, 'no-such-layer', 'invert'), /Layer not found/);
      assert.throws(() => previewFilter(project, 'no-such-layer', 'invert'), /Layer not found/);
    });
  });
});
