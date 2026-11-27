/**
 * Phase 59: performance and stability.
 *
 * What this suite pins:
 * - BYTE-IDENTITY of every optimized path. The fixture builders in
 *   the first section are copied verbatim from the capture script
 *   that hashed the engine's outputs BEFORE any Phase 59
 *   optimization, and the SHA-256 pins are those pre-optimization
 *   hashes. If an "optimization" ever changes a rendered or encoded
 *   byte, these tests fail — that is the phase's hard gate.
 * - The persistent-pool / sliced-transfer parallel transport:
 *   byte-identical composites and filters through BOTH the sliced
 *   path (per-pixel work) and the whole-input path (effects,
 *   placements, adjustment layers), pool reuse and respawn.
 * - Dimension guards: absurd dimensions in engine calls and in
 *   untrusted file headers (PNG/JPEG/BMP/project JSON) fail with
 *   named errors, not OOM kills, hangs or silent corruption.
 * - Stress: a 4096×4096 composite, a very long brush stroke, a
 *   10-effect stack, a 50-layer project through save/load and PSD,
 *   a 25-file batch, and a bounded-RSS repetition loop (a leak
 *   smoke test with a generous documented threshold — not a
 *   precise memory measurement).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'zlib';
import {
  addAdjustmentLayer,
  addLayer,
  addLayerEffect,
  applyFilterToImage,
  applyLayerEffectStack,
  bakeLayerEffects,
  composite,
  createBrushSettings,
  createGroup,
  createLayerMask,
  createPixelImage,
  createProject,
  createSelection,
  deserializeProject,
  getLayerMask,
  paintBrushStroke,
  resizeImage,
  serializeProject,
  setGroupOpacity,
  setLayerBlendMode,
  setLayerClipped,
  setLayerGroup,
  setLayerOpacity
} from '../server/imageEditor/imageCore.js';
import type { ImageProject, PixelImage } from '../server/imageEditor/types.js';
import {
  decodeBmp,
  decodeJpeg,
  decodePng,
  decodePng16,
  encodeBmp,
  encodeJpeg,
  encodePng
} from '../server/imageEditor/imageCodec.js';
import { encodeTiff } from '../server/imageEditor/tiff.js';
import { exportPsd, importPsd } from '../server/imageEditor/psd.js';
import {
  applyFilterAsync,
  bandedFilterRadius,
  compositeProjectAsync,
  shutdownAccelerationWorkers
} from '../server/imageEditor/index.js';
import { defineAction, startBatch } from '../server/imageEditor/actions.js';

function sha256(bytes: Uint8ClampedArray | Uint8Array | Buffer): string {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
}

// ---------------------------------------------------------- deterministic fixtures
// Copied verbatim from the Phase 59 pre-optimization capture
// builders (only the import paths differ). If a builder changes,
// the pinned hashes below must be regenerated and the change
// justified — that is the point of the pin.

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

function patternImage(width: number, height: number, seed: number, variedAlpha: boolean): PixelImage {
  const img = createPixelImage(width, height);
  patternInto(img, seed, variedAlpha);
  return img;
}

function gradientMaskInto(project: ImageProject, layerId: string, width: number, height: number): void {
  createLayerMask(project, layerId, 255);
  const mask = getLayerMask(project, layerId)!;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) mask.data[y * width + x] = Math.floor((y * 255) / Math.max(1, height - 1));
  }
}

function richProject(width: number, height: number): ImageProject {
  const p = createProject(width, height);
  patternInto(p.layers[0].image, 0, false);
  const multiply = addLayer(p, 'Multiply');
  patternInto(multiply.image, 1, true);
  setLayerBlendMode(p, multiply.id, 'multiply');
  setLayerOpacity(p, multiply.id, 0.8);
  const screen = addLayer(p, 'Screen + mask');
  patternInto(screen.image, 2, true);
  setLayerBlendMode(p, screen.id, 'screen');
  gradientMaskInto(p, screen.id, width, height);
  const group = createGroup(p, 'Group');
  setGroupOpacity(p, group.id, 0.9);
  const g1 = addLayer(p, 'Group member 1');
  patternInto(g1.image, 3, true);
  setLayerGroup(p, g1.id, group.id);
  const g2 = addLayer(p, 'Group member 2');
  patternInto(g2.image, 4, true);
  setLayerBlendMode(p, g2.id, 'overlay');
  setLayerGroup(p, g2.id, group.id);
  const clipBaseLayer = addLayer(p, 'Clip base');
  patternInto(clipBaseLayer.image, 5, true);
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

function plainProject(width: number, height: number, count: number): ImageProject {
  const p = createProject(width, height);
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

function brushFixtureProject(width: number, height: number): ImageProject {
  const p = createProject(width, height);
  patternInto(p.layers[0].image, 11, false);
  const layer = addLayer(p, 'Paint');
  const settings = createBrushSettings({ size: 24, hardness: 0.7, spacing: 0.25, flow: 0.8, opacity: 0.9 });
  paintBrushStroke(p, layer.id, serpentinePoints(width, height, 48), settings, { r: 200, g: 40, b: 90, a: 255 });
  return p;
}

// ---------------------------------------------------------- 59.1 byte-identity pins (pre-optimization hashes)

describe('Phase 59.1 — optimized paths stay byte-identical (pre-optimization hash pins)', () => {
  test('composites of the rich and plain fixtures hash exactly as before optimization', () => {
    assert.equal(sha256(composite(richProject(300, 257)).data), 'bc4fa210bbdb208a08d195acb33737f55a07cb274104798787a8601509c76c61');
    assert.equal(sha256(composite(plainProject(257, 193, 6)).data), '3a98b4125682d95edac8ebc62091e70c891475b83131fa805d2dac9bc9b2bb63');
  });

  test('convolutions hash exactly as before (restructured separable passes)', () => {
    const img = patternImage(300, 257, 5, false);
    assert.equal(sha256(applyFilterToImage(img, 'box-blur', { radius: 6 }).data), 'da84e589e80439adf7caee53c8a3d0ffbff84044d51a39e49df76d52c44e8b19');
    assert.equal(sha256(applyFilterToImage(img, 'gaussian-blur', { sigma: 2, radius: 0 }).data), '3a310019743c556a23ca528847448c4a7951ea998aca9a3b556935e1760a603b');
    assert.equal(sha256(applyFilterToImage(img, 'sharpen', { amount: 0.8 }).data), '0ba2e2fb7c6b66369d8f85ce7475588901ce60a568493f2d52d6712115581454');
  });

  test('noise and sepia hash exactly as before (direct loops)', () => {
    const img = patternImage(300, 257, 5, false);
    assert.equal(sha256(applyFilterToImage(img, 'noise', { amount: 25, seed: 42 }).data), 'a0ad76c09784e4ae7a79b06519ad15d83358cace7003b326d7cf14906ad7c23c');
    assert.equal(sha256(applyFilterToImage(img, 'sepia', { amount: 0.7 }).data), 'ccd1635db49cfdd355c9c3f5b29cece1d91d92318d7943d6e0b28863e41ceb9e');
  });

  test('effect-stack render hashes exactly as before', () => {
    const stackImg = patternImage(300, 257, 9, true);
    const out = applyLayerEffectStack(stackImg, [
      { filterId: 'sepia', params: { amount: 0.6 }, enabled: true },
      { filterId: 'box-blur', params: { radius: 2 }, enabled: true },
      { filterId: 'noise', params: { amount: 10, seed: 7 }, enabled: true },
      { filterId: 'invert', params: {}, enabled: false },
      { filterId: 'brightness-contrast', params: { brightness: 10, contrast: 20 }, enabled: true }
    ]);
    assert.equal(sha256(out.data), '9fc173a84b117fcdfd9b81a2f74724a8598dc440987c70f44f010b6a63b0891e');
  });

  test('brush stroke hashes exactly as before (bounded stroke application)', () => {
    const project = brushFixtureProject(512, 384);
    assert.equal(sha256(project.layers[1].image.data), 'c9d37c4e0af50eaf01d4ffe06f84e2c31f30f30c01d26b3764e62609d1d66fc8');
  });

  test('codec outputs hash exactly as before (PNG/BMP/JPEG/TIFF/PSD)', () => {
    const img = patternImage(300, 257, 5, false);
    assert.equal(sha256(encodePng(img)), 'fa6fad323260c081aa78f99534884c0b05dbb969db770199905edde1ff3e3afb');
    assert.equal(sha256(encodeBmp(img)), 'd23d27f64d0bd1d988993e6c6931013b811493260662959e2373f9ea166d9623');
    assert.equal(sha256(encodeJpeg(img, 90)), '76e0bcd6d1f610d7e7a16dceb6e2cea29d6aaf1bc5e4d6bccc246c5aa4aaba9b');
    assert.equal(sha256(encodeTiff(img)), '899dd1759ec52e01c729c9713afb917750a46843d2c6b4de6daa35b83b092828');
    assert.equal(sha256(exportPsd(plainProject(257, 193, 4))), 'c3efa2eca3c94a2fa3e833b49f0567ef11a2e653c4db46a06680bfcb9c9d238f');
  });

  test('PNG decode is unchanged (double-buffered unfilter)', () => {
    const img = patternImage(64, 48, 5, false);
    const back = decodePng(encodePng(img));
    assert.equal(sha256(back.data), sha256(img.data));
    const raw = Buffer.alloc((64 * 4 + 1) * 48);
    for (let y = 0; y < 48; y++) {
      raw[y * (64 * 4 + 1)] = 0;
      raw.set(img.data.subarray(y * 64 * 4, y * 64 * 4 + 64 * 4), y * (64 * 4 + 1) + 1);
    }
    const manual = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngTestChunk('IHDR', ihdrBytes(64, 48, 8, 6)),
      pngTestChunk('IDAT', zlib.deflateSync(raw)),
      pngTestChunk('IEND', Buffer.alloc(0))
    ]);
    const decoded = decodePng(manual);
    assert.equal(sha256(decoded.data), sha256(img.data));
  });
});

// ---------------------------------------------------------- helpers for crafted files

function pngTestChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function ihdrBytes(width: number, height: number, bitDepth: number, colorType: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return ihdr;
}

function pngWithIhdr(width: number, height: number, bitDepth: number, colorType: number, idatPayload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngTestChunk('IHDR', ihdrBytes(width, height, bitDepth, colorType)),
    pngTestChunk('IDAT', idatPayload),
    pngTestChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------- 59.2 dimension guards

describe('Phase 59.2 — absurd dimensions fail with named errors, not OOM/hang/corruption', () => {
  test('engine entry points reject non-integer, non-positive and over-cap dimensions', () => {
    assert.throws(() => createPixelImage(0, 10), /Invalid image size 0x10: dimensions must be positive integers/);
    assert.throws(() => createPixelImage(-4, 10), /Invalid image size -4x10/);
    assert.throws(() => createPixelImage(10.5, 10), /Invalid image size 10\.5x10/);
    assert.throws(() => createPixelImage(20000, 20000), /Invalid image size 20000x20000: 400000000 pixels exceeds the engine limit of 268435456/);
    assert.throws(() => createProject(0, 100), /positive integers/);
    assert.throws(() => createProject(100.25, 100), /positive integers/);
    assert.throws(() => createSelection(7.5, 7), /Invalid selection size/);
    const img = createPixelImage(8, 8);
    assert.throws(() => resizeImage(img, 0, 8), /Invalid resize target 0x8/);
    assert.throws(() => resizeImage(img, 8.5, 8), /Invalid image size 8\.5x8: dimensions must be positive integers/);
    // Sane sizes still work.
    assert.equal(createPixelImage(3, 2).data.length, 24);
  });

  test('a crafted PNG header declaring 20000x20000 is refused by name before any giant allocation', () => {
    const png = pngWithIhdr(20000, 20000, 8, 6, zlib.deflateSync(Buffer.alloc(16)));
    const t0 = Date.now();
    assert.throws(() => decodePng(png), /PNG dimensions 20000x20000 exceed the engine limit of 268435456 pixels/);
    assert.ok(Date.now() - t0 < 5000, 'the refusal must be immediate, not after an allocation attempt');
    const png16 = pngWithIhdr(20000, 20000, 16, 6, zlib.deflateSync(Buffer.alloc(16)));
    assert.throws(() => decodePng16(png16), /PNG dimensions 20000x20000 exceed the engine limit/);
  });

  test('a PNG whose IDAT inflates past its declared scanlines is refused by name (zip-bomb guard)', () => {
    // 4x4 RGBA expects (16+1)*4 = 68 scanline bytes; feed it far more.
    const png = pngWithIhdr(4, 4, 8, 6, zlib.deflateSync(Buffer.alloc(4096)));
    assert.throws(() => decodePng(png), /Corrupt PNG: image data decompresses beyond the expected 68 scanline bytes/);
  });

  test('a PNG whose IDAT is truncated fails with a named error instead of decoding short rows as black', () => {
    const png = pngWithIhdr(4, 4, 8, 6, zlib.deflateSync(Buffer.alloc(10)));
    assert.throws(() => decodePng(png), /Corrupt PNG: image data is truncated \(10 of 68 scanline bytes\)/);
  });

  test('BMP headers: negative width, absurd size and truncated pixel data are named errors', () => {
    const good = encodeBmp(patternImage(10, 6, 1, false));
    const negative = Buffer.from(good);
    negative.writeInt32LE(-5, 18);
    assert.throws(() => decodeBmp(negative), /Invalid BMP dimensions: -5x6/);
    const huge = Buffer.from(good);
    huge.writeInt32LE(30000, 18);
    huge.writeInt32LE(30000, 22);
    assert.throws(() => decodeBmp(huge), /BMP dimensions 30000x30000 exceed the engine limit/);
    const truncated = good.subarray(0, good.length - 20);
    assert.throws(() => decodeBmp(truncated), /Corrupt BMP: pixel data is truncated/);
    // The untouched file still decodes.
    assert.equal(decodeBmp(good).width, 10);
  });

  test('a JPEG frame header declaring 60000x60000 is refused by name before decoding', () => {
    // SOI + SOF0 segment only — enough for the header parser, and the
    // guard must fire before the decoder is ever invoked.
    const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1 + 9);
    sof[0] = 0xff;
    sof[1] = 0xc0;
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(60000, 5);
    sof.writeUInt16BE(60000, 7);
    sof[9] = 3;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), sof]);
    assert.throws(() => decodeJpeg(jpeg), /JPEG dimensions 60000x60000 exceed the engine limit of 268435456 pixels/);
  });

  test('corrupt project dimensions in saved data are rejected on load', () => {
    const project = plainProject(16, 12, 2);
    const zero = serializeProject(project);
    zero.width = 0;
    assert.throws(() => deserializeProject(zero), /Project dimensions out of range: 0x12/);
    const huge = serializeProject(project);
    huge.width = 20000;
    huge.height = 20000;
    assert.throws(() => deserializeProject(huge), /Project dimensions out of range: 20000x20000/);
    const fractional = serializeProject(project);
    fractional.width = 16.5;
    assert.throws(() => deserializeProject(fractional), /Project dimensions out of range: 16\.5x12/);
    // The unmodified project still round-trips.
    assert.equal(deserializeProject(serializeProject(project)).layers.length, 2);
  });
});

// ---------------------------------------------------------- 59.3 pool transport

describe('Phase 59.3 — persistent pool + sliced transfers stay byte-identical', () => {
  test('bandedFilterRadius matches the real convolution kernels', () => {
    assert.equal(bandedFilterRadius('box-blur', { radius: 6 }), 6);
    assert.equal(bandedFilterRadius('box-blur', { radius: 0 }), 0);
    assert.equal(bandedFilterRadius('gaussian-blur', { sigma: 2 }), 6); // kernel radius ceil(3σ)
    assert.equal(bandedFilterRadius('gaussian-blur', { sigma: 0 }), 0);
    assert.throws(() => bandedFilterRadius('invert', {}), /cannot be computed on a row band/);
  });

  test('sliced composite (groups, masks, clipping, blends) is byte-identical for 2/3/4 workers', async () => {
    const project = richProject(256, 257);
    // richProject contains an effect stack + an adjustment layer;
    // remove both so the project takes the SLICED path, keeping the
    // group, the gradient mask, the clipped layer and blend modes.
    project.layers = project.layers.filter((l) => l.kind !== 'adjustment');
    const effected = project.layers.find((l) => l.name === 'Effected')!;
    effected.effects = [];
    const serial = sha256(composite(project).data);
    for (const workers of [2, 3, 4]) {
      const out = await compositeProjectAsync(project, { workers });
      assert.equal(sha256(out.data), serial, `workers=${workers}`);
    }
  });

  test('whole-input composite (effects + adjustment + placement) is byte-identical through the pool', async () => {
    const project = richProject(256, 257);
    const multiply = project.layers.find((l) => l.name === 'Multiply')!;
    multiply.placement = [1, 0, 3, 0, 1, -2, 0, 0, 1]; // Mat3 translate — non-sliced on its own too
    const serial = composite(project);
    const out = await compositeProjectAsync(project, { workers: 4 });
    assert.equal(sha256(out.data), sha256(serial.data));
  });

  test('sliced banded filters (halo transport) are byte-identical, impulses straddling band edges', async () => {
    const img = createPixelImage(200, 257);
    img.data.fill(255);
    for (const y of [64, 129, 200]) {
      const i = (y * 200 + 100) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    }
    for (const workers of [2, 4]) {
      const box = await applyFilterAsync(img, 'box-blur', { radius: 6 }, { workers });
      assert.equal(sha256(box.data), sha256(applyFilterToImage(img, 'box-blur', { radius: 6 }).data), `box workers=${workers}`);
      const gauss = await applyFilterAsync(img, 'gaussian-blur', { sigma: 1.5 }, { workers });
      assert.equal(sha256(gauss.data), sha256(applyFilterToImage(img, 'gaussian-blur', { sigma: 1.5 }).data), `gauss workers=${workers}`);
    }
  });

  test('the pool is reused across calls and respawns after an explicit shutdown', async () => {
    const project = plainProject(128, 129, 3);
    const serial = sha256(composite(project).data);
    const first = await compositeProjectAsync(project, { workers: 2 });
    const second = await compositeProjectAsync(project, { workers: 2 });
    assert.equal(sha256(first.data), serial);
    assert.equal(sha256(second.data), serial);
    await shutdownAccelerationWorkers();
    const third = await compositeProjectAsync(project, { workers: 2 });
    assert.equal(sha256(third.data), serial);
    await shutdownAccelerationWorkers();
  });
});

// ---------------------------------------------------------- 59.4 stress

describe('Phase 59.4 — stress: large canvases and complex projects complete without corruption', () => {
  test('4096x4096 composite of 5 layers completes and is deterministic', { timeout: 300_000 }, () => {
    const project = plainProject(4096, 4096, 5);
    const first = composite(project);
    assert.equal(first.width, 4096);
    assert.equal(first.height, 4096);
    const second = composite(project);
    assert.equal(sha256(second.data), sha256(first.data), 'the same project must composite to the same bytes twice');
  });

  test('a very long brush stroke (~29k stamps over 2048x2048) completes and is deterministic', { timeout: 300_000 }, () => {
    const paint = (): string => {
      const p = createProject(2048, 2048);
      patternInto(p.layers[0].image, 11, false);
      const layer = addLayer(p, 'Paint');
      const settings = createBrushSettings({ size: 24, hardness: 0.7, spacing: 0.25, flow: 0.8, opacity: 0.9 });
      paintBrushStroke(p, layer.id, serpentinePoints(2048, 2048, 24), settings, { r: 200, g: 40, b: 90, a: 255 });
      return sha256(layer.image.data);
    };
    const a = paint();
    const b = paint();
    assert.equal(a, b, 'the same stroke must paint the same bytes twice');
  });

  test('a 10-effect stack renders identically to its baked form', { timeout: 120_000 }, () => {
    const project = createProject(320, 240);
    patternInto(project.layers[0].image, 2, false);
    const layer = addLayer(project, 'Stacked');
    patternInto(layer.image, 8, true);
    const stack: Array<[string, Record<string, number>]> = [
      ['sepia', { amount: 0.5 }],
      ['box-blur', { radius: 2 }],
      ['noise', { amount: 12, seed: 3 }],
      ['brightness-contrast', { brightness: 8, contrast: 12 }],
      ['gaussian-blur', { sigma: 1.2 }],
      ['invert', {}],
      ['sharpen', { amount: 0.6 }],
      ['posterize', { levels: 6 }],
      ['threshold', { level: 140 }],
      ['hue-rotate', { degrees: 40 }]
    ];
    for (const [filterId, params] of stack) addLayerEffect(project, layer.id, filterId, params);
    const rendered = sha256(composite(project).data);
    const bakedCopy = deserializeProject(serializeProject(project));
    const bakedLayer = bakedCopy.layers.find((l) => l.name === 'Stacked')!;
    bakeLayerEffects(bakedCopy, bakedLayer.id);
    assert.equal(sha256(composite(bakedCopy).data), rendered, 'baking a 10-effect stack must not change the render');
  });

  test('a 50-layer project survives save/load and a PSD round trip', { timeout: 120_000 }, () => {
    const project = plainProject(256, 192, 50);
    const before = sha256(composite(project).data);
    const loaded = deserializeProject(serializeProject(project));
    assert.equal(loaded.layers.length, 50);
    assert.equal(sha256(composite(loaded).data), before, 'save/load must not change the render');

    const { project: fromPsd, warnings } = importPsd(exportPsd(project));
    assert.equal(fromPsd.layers.length, 50, `PSD round trip lost layers (warnings: ${warnings.join('; ')})`);
    // PSD stores layer pixels exactly (Phase 49); opacity quantizes
    // to 1/255 by the format, so the claim pinned here is per-layer
    // pixel identity + names, not composite identity.
    for (let i = 0; i < 50; i++) {
      assert.equal(fromPsd.layers[i].name, project.layers[i].name, `layer ${i} name`);
      assert.equal(sha256(fromPsd.layers[i].image.data), sha256(project.layers[i].image.data), `layer ${i} pixels`);
    }
  });

  test('a batch over 25 files (one corrupt) completes per-file', { timeout: 120_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p59-batch-'));
    try {
      const inputs: string[] = [];
      for (let i = 0; i < 24; i++) {
        const file = path.join(dir, `in${i}.png`);
        await fs.writeFile(file, encodePng(patternImage(96, 64, i + 1, false)));
        inputs.push(file);
      }
      const corrupt = path.join(dir, 'corrupt.png');
      await fs.writeFile(corrupt, Buffer.from('definitely not an image'));
      inputs.splice(7, 0, corrupt);
      const job = startBatch({
        inputs,
        outputDir: path.join(dir, 'out'),
        action: defineAction('invert-all', [{ op: 'invert', params: {} }])
      });
      const summary = await job.done;
      assert.deepEqual(
        { total: summary.total, done: summary.done, failed: summary.failed, cancelled: summary.cancelled },
        { total: 25, done: 24, failed: 1, cancelled: 0 }
      );
      assert.equal(summary.results[7].status, 'failed');
      assert.ok(summary.results[7].error && summary.results[7].error!.length > 0);
      // Spot-check one output: it must be the inverted input.
      const out0 = decodePng(await fs.readFile(summary.results[0].output!));
      const src = patternImage(96, 64, 1, false);
      assert.equal(out0.data[0], 255 - src.data[0]);
      assert.equal(out0.data[1], 255 - src.data[1]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('repeated composite+encode does not grow RSS without bound (leak smoke test)', { timeout: 300_000 }, () => {
    // SMOKE TEST, not a precise measurement: RSS on a shared VM is
    // noisy, so the bound is deliberately generous (256 MB over 25
    // iterations of ~4 MB outputs). A real per-iteration leak of
    // even one full composite buffer (4 MB) plus one PNG would
    // exceed it; allocator plateau noise does not.
    const project = plainProject(1024, 1024, 6);
    const gc = (globalThis as { gc?: () => void }).gc;
    for (let i = 0; i < 3; i++) encodePng(composite(project)); // warm-up: allocator reaches steady state
    gc?.();
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 25; i++) {
      const out = encodePng(composite(project));
      assert.ok(out.length > 0);
    }
    gc?.();
    const growth = process.memoryUsage().rss - before;
    assert.ok(growth < 256 * 1024 * 1024, `RSS grew by ${(growth / 1048576).toFixed(1)} MB over 25 iterations`);
  });
});
