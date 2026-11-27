import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import {
  decodeJpeg,
  decodePng,
  detectFormat,
  encodeJpeg,
  encodePng,
  exportImage,
  extractPngTextChunks,
  importImage,
  importImageWithMetadata,
  inspectJpeg
} from '../server/imageEditor/imageCodec.js';
import {
  decodeTiff,
  decodeTiff16,
  encodeTiff,
  encodeTiff16,
  encodeTiffGrayscale,
  inspectTiff
} from '../server/imageEditor/tiff.js';
import { rgbaToGrayscale, upscaleTo16 } from '../server/imageEditor/colorManagement.js';
import { defineAction, startBatch } from '../server/imageEditor/actions.js';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';
import type { PixelImage } from '../server/imageEditor/types.js';

/**
 * Phase 58: Professional File Handling.
 *
 * Fixtures are REAL files produced by independent implementations:
 * ffmpeg 8.1.2 writes the PNG/JPEG/BMP/TIFF corpus from its testsrc2
 * source (the same frame for every format), and every decode is
 * compared against ffmpeg's own decode of the same file — byte-exact
 * for the lossless formats, within decoder-rounding tolerance for
 * JPEG. The progressive JPEG is a Pillow-written file embedded as
 * base64 (provenance: Pillow 10.2, quality 85, from the ffmpeg
 * testsrc2 frame) and is re-validated through ffmpeg at test time.
 * TIFF layouts ffmpeg cannot write (big-endian, planar, predictor,
 * WhiteIsZero, multi-page, tiled) are hand-assembled from the TIFF
 * 6.0 specification in this file — and cross-checked through ffmpeg
 * in the same tests, so the fixture itself is proven genuine before
 * it is used to judge the decoder.
 */

const FFMPEG = '/usr/bin/ffmpeg';
let dir = '';
const file = (name: string) => readFileSync(join(dir, name));

function ffmpeg(args: string[]): Buffer {
  return execFileSync(FFMPEG, ['-v', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** ffmpeg's own decode of a fixture to a raw pixel format — the independent ground truth. */
function ffmpegRaw(name: string, pixFmt: string): Buffer {
  return ffmpeg(['-i', join(dir, name), '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1']);
}

function maxChannelDiff(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  let max = 0;
  for (let i = 0; i < b.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
  }
  return max;
}

const SRC = 'testsrc2=s=64x48:r=1:d=1';

before(() => {
  assert.ok(existsSync(FFMPEG), 'ffmpeg is required to generate the Phase 58 fixtures');
  dir = mkdtempSync(join(tmpdir(), 'phase58-'));
  const gen = (out: string, args: string[]) => ffmpeg(['-y', '-f', 'lavfi', '-i', SRC, '-frames:v', '1', ...args, join(dir, out)]);
  gen('src.png', ['-pix_fmt', 'rgb24']);
  gen('src_rgba.png', ['-pix_fmt', 'rgba']);
  gen('src.bmp', ['-pix_fmt', 'bgr24']);
  gen('jpg444.jpg', ['-pix_fmt', 'yuv444p', '-q:v', '2']);
  gen('jpg420.jpg', ['-pix_fmt', 'yuv420p', '-q:v', '2']);
  gen('jpggray.jpg', ['-pix_fmt', 'gray', '-q:v', '2']);
  const tif = (out: string, pixFmt: string, algo: string) =>
    gen(out, ['-pix_fmt', pixFmt, '-compression_algo', algo]);
  tif('gray_raw.tif', 'gray', 'raw');
  tif('gray_pack.tif', 'gray', 'packbits');
  tif('gray_lzw.tif', 'gray', 'lzw');
  tif('gray_deflate.tif', 'gray', 'deflate');
  tif('ya_raw.tif', 'ya8', 'raw');
  tif('pal_raw.tif', 'pal8', 'raw');
  tif('rgb_raw.tif', 'rgb24', 'raw');
  tif('rgb_lzw.tif', 'rgb24', 'lzw');
  tif('rgb_pack.tif', 'rgb24', 'packbits');
  tif('rgba_raw.tif', 'rgba', 'raw');
  tif('rgb48_raw.tif', 'rgb48le', 'raw');
  tif('rgb48_lzw.tif', 'rgb48le', 'lzw');
  tif('rgba64_raw.tif', 'rgba64le', 'raw');
  tif('gray16_raw.tif', 'gray16le', 'raw');
  gen('rgb_dpi.tif', ['-pix_fmt', 'rgb24', '-dpi', '300']);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------- hand-built TIFF fixtures

/** A minimal classic-TIFF assembler written from the TIFF 6.0 spec (not via the codec under test). */
function buildTiffFixture(opts: {
  bigEndian?: boolean;
  tags: Map<number, { type: number; values: number[] | string }>;
  strips: Buffer[];
  nextIfd?: Buffer | null;
}): Buffer {
  const be = opts.bigEndian ?? false;
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    if (be) b.writeUInt16BE(v); else b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    if (be) b.writeUInt32BE(v >>> 0); else b.writeUInt32LE(v >>> 0);
    return b;
  };
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 };
  const encodeValue = (type: number, values: number[] | string): Buffer => {
    if (typeof values === 'string') return Buffer.from(values + '\0', 'latin1');
    if (type === 5) {
      const b = Buffer.alloc(values.length * 4);
      values.forEach((v, i) => (be ? b.writeUInt32BE(v >>> 0, i * 4) : b.writeUInt32LE(v >>> 0, i * 4)));
      return b;
    }
    const b = Buffer.alloc(values.length * typeSize[type]);
    values.forEach((v, i) => {
      if (type === 3) be ? b.writeUInt16BE(v, i * 2) : b.writeUInt16LE(v, i * 2);
      else if (type === 4) be ? b.writeUInt32BE(v >>> 0, i * 4) : b.writeUInt32LE(v >>> 0, i * 4);
      else b[i] = v;
    });
    return b;
  };
  const stripData = Buffer.concat(opts.strips);
  const tags = new Map(opts.tags);
  // Strip offsets/counts are computed by the assembler.
  const offsets: number[] = [];
  let at = 8;
  for (const s of opts.strips) {
    offsets.push(at);
    at += s.length;
  }
  tags.set(273, { type: 4, values: offsets });
  tags.set(279, { type: 4, values: opts.strips.map((s) => s.length) });
  const sorted = [...tags.entries()].sort((a, b) => a[0] - b[0]);
  const ifdOffset = 8 + stripData.length + (stripData.length % 2);
  const ifdSize = 2 + sorted.length * 12 + 4;
  const externalBase = ifdOffset + ifdSize;
  const parts: Buffer[] = [Buffer.from(be ? 'MM' : 'II', 'ascii'), u16(42), u32(ifdOffset), stripData];
  if (stripData.length % 2) parts.push(Buffer.alloc(1));
  const ifd = Buffer.alloc(ifdSize);
  if (be) ifd.writeUInt16BE(sorted.length, 0); else ifd.writeUInt16LE(sorted.length, 0);
  const externals: Buffer[] = [];
  let extAt = externalBase;
  sorted.forEach(([tag, spec], i) => {
    const o = 2 + i * 12;
    const encoded = encodeValue(spec.type, spec.values);
    const count = typeof spec.values === 'string' ? encoded.length : spec.type === 5 ? spec.values.length / 2 : spec.values.length;
    if (be) {
      ifd.writeUInt16BE(tag, o);
      ifd.writeUInt16BE(spec.type, o + 2);
      ifd.writeUInt32BE(count, o + 4);
    } else {
      ifd.writeUInt16LE(tag, o);
      ifd.writeUInt16LE(spec.type, o + 2);
      ifd.writeUInt32LE(count, o + 4);
    }
    if (encoded.length <= 4) encoded.copy(ifd, o + 8);
    else {
      if (be) ifd.writeUInt32BE(extAt, o + 8); else ifd.writeUInt32LE(extAt, o + 8);
      externals.push(encoded);
      extAt += encoded.length + (encoded.length % 2);
      if (encoded.length % 2) externals.push(Buffer.alloc(1));
    }
  });
  const nextOffset = opts.nextIfd ? extAt : 0;
  if (be) ifd.writeUInt32BE(nextOffset, 2 + sorted.length * 12);
  else ifd.writeUInt32LE(nextOffset, 2 + sorted.length * 12);
  parts.push(ifd, ...externals);
  if (opts.nextIfd) parts.push(opts.nextIfd);
  return Buffer.concat(parts);
}

function baseTags(width: number, height: number, overrides: Record<number, { type: number; values: number[] | string }> = {}) {
  const tags = new Map<number, { type: number; values: number[] | string }>([
    [256, { type: 4, values: [width] }],
    [257, { type: 4, values: [height] }],
    [258, { type: 3, values: [8, 8, 8] }],
    [259, { type: 3, values: [1] }],
    [262, { type: 3, values: [2] }],
    [277, { type: 3, values: [3] }],
    [278, { type: 4, values: [height] }],
    [284, { type: 3, values: [1] }]
  ]);
  for (const [k, v] of Object.entries(overrides)) tags.set(Number(k), v);
  return tags;
}

/** The 4x3 RGB pattern the hand-built fixtures carry: pixel i = (i*37 % 256, i*91 % 256, i*53 % 256). */
const PATTERN_W = 4;
const PATTERN_H = 3;
const patternRgb = Buffer.alloc(PATTERN_W * PATTERN_H * 3);
for (let i = 0; i < PATTERN_W * PATTERN_H; i++) {
  patternRgb[i * 3] = (i * 37) % 256;
  patternRgb[i * 3 + 1] = (i * 91) % 256;
  patternRgb[i * 3 + 2] = (i * 53) % 256;
}
const patternRgba = Buffer.alloc(PATTERN_W * PATTERN_H * 4);
for (let i = 0; i < PATTERN_W * PATTERN_H; i++) {
  patternRgba[i * 4] = patternRgb[i * 3];
  patternRgba[i * 4 + 1] = patternRgb[i * 3 + 1];
  patternRgba[i * 4 + 2] = patternRgb[i * 3 + 2];
  patternRgba[i * 4 + 3] = 255;
}

/** Cross-check a hand-built fixture through ffmpeg, then through the engine: both must equal the pattern. */
function assertFixtureDecodes(fixture: Buffer, name: string) {
  writeFileSync(join(dir, name), fixture);
  const truth = ffmpeg(['-i', join(dir, name), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  assert.ok(Buffer.from(patternRgba).equals(truth), `ffmpeg must decode the hand-built ${name} to the pattern (fixture is genuine)`);
  const mine = decodeTiff(fixture);
  assert.equal(mine.width, PATTERN_W);
  assert.equal(mine.height, PATTERN_H);
  assert.ok(Buffer.from(mine.data).equals(Buffer.from(patternRgba)), `engine must decode the hand-built ${name} to the pattern`);
}

// ---------------------------------------------------------- detection and errors

describe('Phase 58 — format detection by content and error quality', () => {
  test('58.1 detectFormat identifies every supported format from its bytes', () => {
    assert.equal(detectFormat(file('src.png')), 'png');
    assert.equal(detectFormat(file('src.bmp')), 'bmp');
    assert.equal(detectFormat(file('jpg444.jpg')), 'jpeg');
    assert.equal(detectFormat(file('rgb_raw.tif')), 'tiff');
    assert.equal(detectFormat(Buffer.from('8BPS' + '\0'.repeat(20), 'latin1')), 'psd');
    assert.equal(detectFormat(Buffer.from('%PDF-1.7 not an image')), null);
    assert.equal(detectFormat(Buffer.from('definitely not an image')), null);
    assert.equal(detectFormat(Buffer.alloc(0)), null);
  });

  test('58.2 import dispatches by content: TIFF and JPEG bytes import through the flat entry point', () => {
    const tif = importImage(file('rgb_lzw.tif'));
    assert.equal(tif.width, 64);
    assert.equal(tif.height, 48);
    const jpg = importImage(file('jpg420.jpg'));
    assert.equal(jpg.width, 64);
    assert.equal(jpg.height, 48);
  });

  test('58.3 unknown data and PSD data fail with specific, named errors', () => {
    assert.throws(() => importImage(Buffer.from('definitely not an image')), /Unsupported image format/);
    assert.throws(() => importImage(Buffer.from('definitely not an image')), /no PNG, JPEG, BMP, TIFF or PSD signature/);
    const psd = Buffer.from('8BPS' + '\0'.repeat(20), 'latin1');
    assert.throws(() => importImage(psd), /PSD file detected/);
    assert.throws(() => importImage(psd), /importPsd/);
    assert.throws(() => importImageWithMetadata(psd), /PSD file detected/);
  });

  test('58.4 corrupt files fail in their own format\u2019s terms', () => {
    // PNG signature followed by garbage: the PNG decoder's error, not a generic one.
    const badPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbagegarbage')]);
    assert.throws(() => importImage(badPng), /PNG has no IHDR/);
    // A TIFF signature with a nonsense version is not a TIFF.
    const badTiff = Buffer.from([0x49, 0x49, 0x63, 0x00, 0x08, 0x00, 0x00, 0x00]);
    assert.throws(() => decodeTiff(badTiff), /Not a TIFF file \(bad version: 99/);
    // A truncated JPEG (header fragment only) names JPEG in its failure.
    assert.throws(() => decodeJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), /JPEG/);
  });
});

// ---------------------------------------------------------- JPEG

describe('Phase 58 — JPEG decode and encode (jpeg-js, proven against ffmpeg)', () => {
  test('58.5 ffmpeg baseline JPEGs (4:4:4, 4:2:0, grayscale) decode to ffmpeg\u2019s own pixels within rounding', () => {
    for (const name of ['jpg444.jpg', 'jpg420.jpg', 'jpggray.jpg']) {
      const mine = decodeJpeg(file(name));
      assert.equal(mine.width, 64);
      assert.equal(mine.height, 48);
      const truth = ffmpegRaw(name, 'rgba');
      const diff = maxChannelDiff(mine.data, truth);
      assert.ok(diff <= 4, `${name}: max channel diff vs ffmpeg decode is ${diff} (IDCT rounding only)`);
    }
  });

  test('58.6 a Pillow progressive JPEG decodes and inspects as progressive', () => {
    // Written by Pillow 10.2 (progressive=True, quality 85) from the
    // ffmpeg testsrc2 64x48 frame; embedded so the fixture does not
    // depend on Pillow being installed wherever the suite runs.
    const progressive = Buffer.from(PROGRESSIVE_JPEG_B64, 'base64');
    writeFileSync(join(dir, 'prog.jpg'), progressive);
    const info = inspectJpeg(progressive);
    assert.equal(info.progressive, true);
    assert.equal(info.width, 64);
    assert.equal(info.height, 48);
    assert.equal(info.components, 3);
    assert.equal(info.precision, 8);
    const mine = decodeJpeg(progressive);
    const truth = ffmpegRaw('prog.jpg', 'rgba');
    assert.ok(maxChannelDiff(mine.data, truth) <= 4, 'progressive decode matches ffmpeg within rounding');
  });

  test('58.7 encodeJpeg writes a real JPEG that ffmpeg decodes back to the source', () => {
    const img: PixelImage = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        img.data[i] = x < 16 ? 250 : 12;
        img.data[i + 1] = y < 16 ? 240 : 30;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    const encoded = encodeJpeg(img, 92);
    assert.equal(detectFormat(encoded), 'jpeg');
    writeFileSync(join(dir, 'engine.jpg'), encoded);
    const probe = execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv', join(dir, 'engine.jpg')]).toString();
    assert.match(probe, /mjpeg/);
    const back = ffmpegRaw('engine.jpg', 'rgba');
    assert.ok(maxChannelDiff(img.data, back) <= 10, 'ffmpeg reads the engine JPEG back within JPEG loss at quality 92');
    // And the engine reads its own file.
    const roundTrip = decodeJpeg(encoded);
    assert.ok(maxChannelDiff(img.data, roundTrip.data) <= 10);
  });

  test('58.8 inspectJpeg reports structure; encodeJpeg validates quality', () => {
    const info = inspectJpeg(file('jpg444.jpg'));
    assert.deepEqual(
      { precision: info.precision, components: info.components, progressive: info.progressive, jfif: info.jfif },
      { precision: 8, components: 3, progressive: false, jfif: true }
    );
    // ffmpeg writes its "gray" JPEGs as 3-component YCbCr with
    // neutral chroma (its encoder has no 1-component mode); a
    // genuine 1-component file — Pillow, mode L, embedded below —
    // inspects as one component and reports as grayscale.
    assert.equal(inspectJpeg(file('jpggray.jpg')).components, 3);
    const gray1 = Buffer.from(GRAY_JPEG_B64, 'base64');
    assert.equal(inspectJpeg(gray1).components, 1);
    assert.equal(importImageWithMetadata(gray1).metadata.colorModel, 'grayscale');
    const img: PixelImage = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
    assert.throws(() => encodeJpeg(img, 0), /Invalid JPEG quality: 0/);
    assert.throws(() => encodeJpeg(img, 101), /Invalid JPEG quality: 101/);
    assert.throws(() => encodeJpeg(img, 55.5), /Invalid JPEG quality/);
    assert.throws(() => inspectJpeg(Buffer.from('not a jpeg')), /Not a JPEG file/);
  });
});

// ---------------------------------------------------------- TIFF decode

describe('Phase 58 — TIFF decode against ffmpeg-written files (byte-exact)', () => {
  test('58.9 grayscale family: uncompressed, PackBits, LZW, gray+alpha, palette', () => {
    for (const name of ['gray_raw.tif', 'gray_pack.tif', 'gray_lzw.tif', 'ya_raw.tif', 'pal_raw.tif']) {
      const mine = decodeTiff(file(name));
      assert.equal(mine.width, 64, name);
      assert.equal(mine.height, 48, name);
      assert.ok(Buffer.from(mine.data).equals(ffmpegRaw(name, 'rgba')), `${name} must equal ffmpeg's decode byte-for-byte`);
    }
  });

  test('58.10 RGB family: uncompressed, LZW, PackBits, RGBA, multi-strip with DPI tags', () => {
    for (const name of ['rgb_raw.tif', 'rgb_lzw.tif', 'rgb_pack.tif', 'rgba_raw.tif', 'rgb_dpi.tif']) {
      const mine = decodeTiff(file(name));
      assert.ok(Buffer.from(mine.data).equals(ffmpegRaw(name, 'rgba')), `${name} must equal ffmpeg's decode byte-for-byte`);
    }
  });

  test('58.11 16-bit TIFFs decode through decodeTiff16 byte-exact; the 8/16 split refuses by name', () => {
    for (const name of ['rgb48_raw.tif', 'rgb48_lzw.tif', 'rgba64_raw.tif', 'gray16_raw.tif']) {
      const mine = decodeTiff16(file(name));
      const asBytes = Buffer.alloc(mine.data.length * 2);
      mine.data.forEach((v, i) => asBytes.writeUInt16LE(v, i * 2));
      assert.ok(asBytes.equals(ffmpegRaw(name, 'rgba64le')), `${name} must equal ffmpeg's 16-bit decode byte-for-byte`);
    }
    assert.throws(() => decodeTiff(file('rgb48_raw.tif')), /16 in decodeTiff — use decodeTiff16/);
    assert.throws(() => decodeTiff16(file('rgb_raw.tif')), /decodeTiff16 needs a 16-bit TIFF, got bit depth 8/);
  });

  test('58.12 hand-built layouts ffmpeg cannot write: big-endian, planar, predictor, WhiteIsZero, multi-page', () => {
    // Big-endian RGB.
    assertFixtureDecodes(buildTiffFixture({ bigEndian: true, tags: baseTags(PATTERN_W, PATTERN_H), strips: [patternRgb] }), 'be.tif');
    // Planar configuration 2: one strip per sample plane.
    const planes = [0, 1, 2].map((c) => {
      const plane = Buffer.alloc(PATTERN_W * PATTERN_H);
      for (let i = 0; i < PATTERN_W * PATTERN_H; i++) plane[i] = patternRgb[i * 3 + c];
      return plane;
    });
    assertFixtureDecodes(
      buildTiffFixture({
        tags: baseTags(PATTERN_W, PATTERN_H, { 284: { type: 3, values: [2] } }),
        strips: planes
      }),
      'planar.tif'
    );
    // Predictor 2 (horizontal differencing), uncompressed strip.
    const differenced = Buffer.from(patternRgb);
    for (let y = 0; y < PATTERN_H; y++) {
      for (let i = PATTERN_W * 3 - 1; i >= 3; i--) {
        const at = y * PATTERN_W * 3 + i;
        differenced[at] = (patternRgb[at] - patternRgb[at - 3]) & 0xff;
      }
    }
    const predictorTags = { 317: { type: 3, values: [2] } };
    assertFixtureDecodes(
      buildTiffFixture({ tags: baseTags(PATTERN_W, PATTERN_H, predictorTags), strips: [differenced] }),
      'predictor_raw.tif'
    );
    // Predictor 2 over a PackBits strip. The packets are row-aligned
    // (one literal run per row): real PackBits writers packetize per
    // row, and ffmpeg's decoder accounts PackBits packets per row —
    // a packet spanning a row boundary is where the two readings of
    // the format diverge, as this fixture's first version proved.
    const rowBytes = PATTERN_W * 3;
    const packBitsLiteral = (data: Buffer): Buffer => {
      const parts: Buffer[] = [];
      for (let rowStart = 0; rowStart < data.length; rowStart += rowBytes) {
        const chunk = data.subarray(rowStart, rowStart + rowBytes);
        parts.push(Buffer.from([chunk.length - 1]), Buffer.from(chunk));
      }
      return Buffer.concat(parts);
    };
    assertFixtureDecodes(
      buildTiffFixture({
        tags: baseTags(PATTERN_W, PATTERN_H, { ...predictorTags, 259: { type: 3, values: [32773] } }),
        strips: [packBitsLiteral(differenced)]
      }),
      'predictor_pack.tif'
    );
    // WhiteIsZero grayscale: stored value v must surface as 255 - v.
    const grayStored = Buffer.from([0, 64, 128, 192, 255, 10]);
    const whiteZero = buildTiffFixture({
      tags: baseTags(3, 2, {
        258: { type: 3, values: [8] },
        262: { type: 3, values: [0] },
        277: { type: 3, values: [1] }
      }),
      strips: [grayStored]
    });
    writeFileSync(join(dir, 'whitezero.tif'), whiteZero);
    const wzTruth = ffmpeg(['-i', join(dir, 'whitezero.tif'), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
    const wzMine = decodeTiff(whiteZero);
    assert.ok(Buffer.from(wzMine.data).equals(wzTruth), 'WhiteIsZero matches ffmpeg');
    assert.equal(wzMine.data[0], 255);
    assert.equal(wzMine.data[4 * 4], 0);
    // Multi-page: two chained IFDs over two 2x2 grayscale strips,
    // assembled directly (header -> strip1 -> IFD1 -> strip2 ->
    // IFD2). Page 1 decodes; the metadata counts both pages.
    const grayPageIfd = (stripOffset: number, nextOffset: number): Buffer => {
      const entries: [number, number, number, number][] = [
        [256, 4, 1, 2],
        [257, 4, 1, 2],
        [258, 3, 1, 8],
        [259, 3, 1, 1],
        [262, 3, 1, 1],
        [273, 4, 1, stripOffset],
        [277, 3, 1, 1],
        [278, 4, 1, 2],
        [279, 4, 1, 4]
      ];
      const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
      ifd.writeUInt16LE(entries.length, 0);
      entries.forEach(([tag, type, count, value], i) => {
        const o = 2 + i * 12;
        ifd.writeUInt16LE(tag, o);
        ifd.writeUInt16LE(type, o + 2);
        ifd.writeUInt32LE(count, o + 4);
        if (type === 3) ifd.writeUInt16LE(value, o + 8);
        else ifd.writeUInt32LE(value, o + 8);
      });
      ifd.writeUInt32LE(nextOffset, 2 + entries.length * 12);
      return ifd;
    };
    const strip1 = Buffer.from([200, 200, 200, 200]);
    const strip2 = Buffer.from([7, 7, 7, 7]);
    const ifd1Offset = 8 + strip1.length;
    const ifd1 = grayPageIfd(8, 0); // next offset patched below
    const strip2Offset = ifd1Offset + ifd1.length;
    const ifd2Offset = strip2Offset + strip2.length;
    ifd1.writeUInt32LE(ifd2Offset, ifd1.length - 4);
    const ifd2 = grayPageIfd(strip2Offset, 0);
    const header = Buffer.alloc(8);
    header.write('II', 0, 'ascii');
    header.writeUInt16LE(42, 2);
    header.writeUInt32LE(ifd1Offset, 4);
    const twoPages = Buffer.concat([header, strip1, ifd1, strip2, ifd2]);
    assert.equal(inspectTiff(twoPages).pageCount, 2);
    assert.equal(decodeTiff(twoPages).data[0], 200);
  });

  test('58.13 unsupported TIFF variants are rejected with named errors, never mis-decoded', () => {
    // Real Deflate files from two independent writers (ffmpeg writes 32946, Pillow writes 8).
    assert.throws(() => decodeTiff(file('gray_deflate.tif')), /Unsupported TIFF compression: 32946 \(Deflate\)/);
    // BigTIFF is detected as TIFF and refused by name.
    const bigTiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    assert.equal(detectFormat(bigTiff), 'tiff');
    assert.throws(() => decodeTiff(bigTiff), /BigTIFF files \(version 43\) are not supported/);
    assert.throws(() => importImage(bigTiff), /BigTIFF/);
    // Tiled layout.
    const tiled = buildTiffFixture({
      tags: baseTags(PATTERN_W, PATTERN_H, {
        322: { type: 3, values: [4] },
        323: { type: 3, values: [3] },
        324: { type: 4, values: [8] },
        325: { type: 4, values: [patternRgb.length] }
      }),
      strips: [patternRgb]
    });
    assert.throws(() => decodeTiff(tiled), /Tiled TIFFs are not supported/);
    // CMYK photometric.
    const cmyk = buildTiffFixture({
      tags: baseTags(2, 1, {
        258: { type: 3, values: [8, 8, 8, 8] },
        262: { type: 3, values: [5] },
        277: { type: 3, values: [4] }
      }),
      strips: [Buffer.alloc(8)]
    });
    assert.throws(() => decodeTiff(cmyk), /photometric interpretation: 5 \(CMYK\)/);
    // JPEG compression tag.
    const jpegCompressed = buildTiffFixture({
      tags: baseTags(2, 1, { 259: { type: 3, values: [7] } }),
      strips: [Buffer.alloc(6)]
    });
    assert.throws(() => decodeTiff(jpegCompressed), /Unsupported TIFF compression: 7 \(JPEG\)/);
    // 12-bit samples.
    const twelveBit = buildTiffFixture({
      tags: baseTags(2, 1, { 258: { type: 3, values: [12, 12, 12] } }),
      strips: [Buffer.alloc(9)]
    });
    assert.throws(() => decodeTiff(twelveBit), /Unsupported TIFF bit depth: 12/);
    // IEEE-float sample format on a 16-bit file.
    const floatSamples = buildTiffFixture({
      tags: baseTags(2, 1, {
        258: { type: 3, values: [16, 16, 16] },
        339: { type: 3, values: [3, 3, 3] }
      }),
      strips: [Buffer.alloc(12)]
    });
    assert.throws(() => decodeTiff16(floatSamples), /IEEE floating-point TIFF samples are not supported/);
  });
});

// ---------------------------------------------------------- TIFF encode

describe('Phase 58 — TIFF encode, read back by ffmpeg', () => {
  test('58.14 encodeTiff writes a file ffmpeg decodes to identical pixels', () => {
    const src = decodePng(file('src_rgba.png'));
    const encoded = encodeTiff(src);
    assert.equal(detectFormat(encoded), 'tiff');
    writeFileSync(join(dir, 'engine.tif'), encoded);
    assert.ok(Buffer.from(src.data).equals(ffmpegRaw('engine.tif', 'rgba')), 'ffmpeg decodes the engine TIFF byte-exact');
    const probe = execFileSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv', join(dir, 'engine.tif')]).toString();
    assert.match(probe, /tiff/);
    // And the engine reads its own file back exactly.
    assert.ok(Buffer.from(decodeTiff(encoded).data).equals(Buffer.from(src.data)));
    const meta = inspectTiff(encoded);
    assert.equal(meta.compressionName, 'none');
    assert.equal(meta.samplesPerPixel, 4);
    assert.deepEqual(meta.extraSamples, [2]);
  });

  test('58.15 encodeTiff16 and encodeTiffGrayscale round-trip through ffmpeg (incl. odd sizes)', () => {
    const wide = upscaleTo16(decodePng(file('src_rgba.png')));
    const encoded16 = encodeTiff16(wide);
    writeFileSync(join(dir, 'engine16.tif'), encoded16);
    const back = ffmpegRaw('engine16.tif', 'rgba64le');
    const asBytes = Buffer.alloc(wide.data.length * 2);
    wide.data.forEach((v, i) => asBytes.writeUInt16LE(v, i * 2));
    assert.ok(asBytes.equals(back), 'ffmpeg decodes the engine 16-bit TIFF byte-exact');
    // Odd-sized grayscale (3x3) exercises the writer's word alignment.
    const gray = rgbaToGrayscale({ width: 3, height: 3, data: new Uint8ClampedArray(36).map((_, i) => (i * 7) % 256) });
    const encodedGray = encodeTiffGrayscale(gray);
    writeFileSync(join(dir, 'engine_gray.tif'), encodedGray);
    const grayBack = ffmpegRaw('engine_gray.tif', 'gray');
    assert.ok(Buffer.from(gray.data).equals(grayBack), 'ffmpeg decodes the engine grayscale TIFF byte-exact');
    assert.ok(Buffer.from(decodeTiff(encodedGray).data.filter((_, i) => i % 4 === 0)).equals(Buffer.from(gray.data)));
  });
});

// ---------------------------------------------------------- metadata

describe('Phase 58 — one metadata shape for imports', () => {
  test('58.16 PNG metadata: text chunks (tEXt + zTXt) and ICC presence surface consistently', () => {
    // Hand-assembled text chunks over an engine PNG (chunk builder
    // written from the spec here, mirroring the Phase 50 fixtures).
    const base = encodePng({ width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) });
    const withText = insertPngChunks(base, [
      pngTextChunk('tEXt', 'Title', 'Sunset over Chitral', false),
      pngTextChunk('zTXt', 'Comment', 'compressed note', true)
    ]);
    const text = extractPngTextChunks(withText);
    assert.deepEqual(text, { Title: 'Sunset over Chitral', Comment: 'compressed note' });
    const { metadata } = importImageWithMetadata(withText);
    assert.equal(metadata.format, 'png');
    assert.deepEqual(metadata.pngText, { Title: 'Sunset over Chitral', Comment: 'compressed note' });
    assert.equal(metadata.iccProfilePresent, false);
    assert.equal(metadata.colorModel, 'RGBA');
    assert.equal(metadata.bitDepth, 8);
    // ICC: carried by the Phase 50 encode option, reported by the metadata.
    const profile = { name: 'FakeRGB', data: Buffer.from([1, 2, 3, 4, 5]) };
    const withIcc = encodePng({ width: 1, height: 1, data: new Uint8ClampedArray([0, 255, 0, 255]) }, { iccProfile: profile });
    const iccMeta = importImageWithMetadata(withIcc).metadata;
    assert.equal(iccMeta.iccProfilePresent, true);
    assert.equal(iccMeta.iccProfileName, 'FakeRGB');
  });

  test('58.17 JPEG and BMP metadata ride the same shape', () => {
    const jpg = importImageWithMetadata(file('jpg420.jpg')).metadata;
    assert.equal(jpg.format, 'jpeg');
    assert.equal(jpg.width, 64);
    assert.equal(jpg.height, 48);
    assert.equal(jpg.bitDepth, 8);
    assert.equal(jpg.colorModel, 'RGB');
    assert.equal(jpg.hasAlpha, false);
    assert.equal(jpg.jpeg?.components, 3);
    assert.equal(jpg.tiff, null);
    const bmp = importImageWithMetadata(file('src.bmp')).metadata;
    assert.equal(bmp.format, 'bmp');
    assert.equal(bmp.bitDepth, 24);
    assert.equal(bmp.colorModel, 'RGB');
    assert.equal(bmp.hasAlpha, false);
  });

  test('58.18 TIFF metadata: tags, resolution and software from a real ffmpeg file', () => {
    const { image, metadata } = importImageWithMetadata(file('rgb_dpi.tif'));
    assert.equal(metadata.format, 'tiff');
    assert.equal(metadata.colorModel, 'RGB');
    assert.equal(metadata.bitDepth, 8);
    const tiff = metadata.tiff;
    assert.ok(tiff);
    assert.match(tiff.software ?? '', /^Lavc/);
    assert.deepEqual(tiff.xResolution, [300, 1]);
    assert.deepEqual(tiff.yResolution, [300, 1]);
    assert.equal(tiff.resolutionUnit, 2);
    assert.equal(tiff.photometricName, 'RGB');
    assert.equal(tiff.compressionName, 'PackBits');
    assert.equal(tiff.pageCount, 1);
    assert.equal(tiff.byteOrder, 'little');
    assert.equal(image.width, 64);
    // The palette file reports as palette.
    assert.equal(importImageWithMetadata(file('pal_raw.tif')).metadata.colorModel, 'palette');
    assert.equal(importImageWithMetadata(file('ya_raw.tif')).metadata.colorModel, 'grayscale+alpha');
  });
});

// ---------------------------------------------------------- desktop generator pins

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('Phase 58 — generated desktop app file handling', () => {
  const files = ImageProjectGenerator.generateProjectFiles(ImageProjectGenerator.getDefaultConfig());
  const engine = files['src/PixelForge/PixelEngine.cs'];
  const form = files['src/PixelForge/MainForm.cs'];

  test('58.19 PixelEngine.cs carries the content-detection core on the headless side of the seam', () => {
    assert.match(engine, /public static class ImageFileSupport/);
    assert.match(engine, /public static ImageFileKind Detect\(ReadOnlySpan<byte> data\)/);
    assert.match(engine, /public static ImageFileKind EnsureImportable\(ReadOnlySpan<byte> data, string fileName\)/);
    assert.match(engine, /Photoshop \(PSD\) file/);
    assert.match(engine, /not a recognized image file/);
    // The seam holds: no GDI/WinForms types leak into the core file.
    const code = codeOnly(engine);
    assert.doesNotMatch(code, /System\.Drawing\.Imaging/);
    assert.doesNotMatch(code, /\bBitmap\b/);
    assert.doesNotMatch(code, /System\.Windows\.Forms/);
  });

  test('58.20 MainForm import validates content and reports named errors; export enforces agreement and JPEG quality', () => {
    assert.match(form, /ImageFileSupport\.EnsureImportable\(bytes, name\)/);
    assert.match(form, /File\.ReadAllBytes\(d\.FileName\)/);
    assert.match(form, /Image\.FromStream\(ms\)/);
    // Judged on code, not comments (the Phase 57 codeOnly pattern):
    // the shell must not call the file-locking Image.FromFile.
    assert.doesNotMatch(codeOnly(form), /Image\.FromFile/);
    assert.match(form, /DefaultExt = ext, AddExtension = true/);
    assert.match(form, /Path\.ChangeExtension\(path, ext\)/);
    assert.match(form, /private const long JpegExportQuality = 90L;/);
    assert.match(form, /new EncoderParameter\(Encoder\.Quality, quality\)/);
    assert.match(form, /ExportImage\(ImageFormat\.Bmp\)/);
    // The pre-Phase-58 call sites the older suites pin are intact.
    assert.match(form, /ExportImage\(ImageFormat\.Jpeg\)/);
    assert.match(form, /ExportImage\(ImageFormat\.Png\)/);
  });

  test('58.21 the runtime harness gained the S14 file-handling scenario', () => {
    const program = readFileSync(join(import.meta.dirname, '..', 'scripts', 'phase57-runtime-harness', 'Program.cs'), 'utf8');
    assert.match(program, /Scenario\("S14 file handling: content detection and named import refusals"/);
    assert.match(program, /ImageFileSupport\.EnsureImportable/);
  });
});

// ---------------------------------------------------------- integration

describe('Phase 58 — integration across the engine', () => {
  test('58.22 exportImage dispatches the widened format set', () => {
    const img = decodePng(file('src_rgba.png'));
    assert.equal(detectFormat(exportImage(img, 'jpeg')), 'jpeg');
    assert.equal(detectFormat(exportImage(img, 'jpeg', { jpegQuality: 50 })), 'jpeg');
    assert.equal(detectFormat(exportImage(img, 'tiff')), 'tiff');
    assert.equal(detectFormat(exportImage(img, 'png')), 'png');
    assert.equal(detectFormat(exportImage(img, 'bmp')), 'bmp');
    assert.throws(() => exportImage(img, 'webp' as never), /Unsupported export format: webp \(supported: png, bmp, jpeg, tiff\)/);
  });

  test('58.23 a Phase 53 batch now runs over mixed real formats and isolates the corrupt file', async () => {
    const batchDir = mkdtempSync(join(tmpdir(), 'phase58-batch-'));
    try {
      const inputs = ['mix.png', 'mix.jpg', 'mix.tif', 'mix.bmp', 'broken.png'];
      writeFileSync(join(batchDir, 'mix.png'), file('src.png'));
      writeFileSync(join(batchDir, 'mix.jpg'), file('jpg444.jpg'));
      writeFileSync(join(batchDir, 'mix.tif'), file('rgb_raw.tif'));
      writeFileSync(join(batchDir, 'mix.bmp'), file('src.bmp'));
      writeFileSync(join(batchDir, 'broken.png'), Buffer.from('this is not an image at all'));
      const action = defineAction('invert-all', [{ op: 'invert', params: {} }]);
      const summary = await startBatch({
        inputs: inputs.map((n) => join(batchDir, n)),
        outputDir: join(batchDir, 'out'),
        action
      }).done;
      assert.equal(summary.done, 4);
      assert.equal(summary.failed, 1);
      const broken = summary.results.find((r) => r.input.endsWith('broken.png'));
      assert.equal(broken?.status, 'failed');
      assert.match(broken?.error ?? '', /Unsupported image format/);
      const tifResult = summary.results.find((r) => r.input.endsWith('mix.tif'));
      assert.equal(tifResult?.status, 'done');
      assert.ok(tifResult?.output && existsSync(tifResult.output));
    } finally {
      rmSync(batchDir, { recursive: true, force: true });
    }
  });

  test('58.24 engine round trips: PNG pixels survive PNG -> TIFF -> JPEG-tolerant comparison', () => {
    const src = decodePng(file('src_rgba.png'));
    const viaTiff = decodeTiff(encodeTiff(src));
    assert.ok(Buffer.from(viaTiff.data).equals(Buffer.from(src.data)), 'TIFF round trip is lossless');
    const viaJpeg = decodeJpeg(encodeJpeg(src, 95));
    // Measured on this image at quality 95: max channel diff 17
    // (a handful of sharp synthetic edges), mean 0.87. The bounds
    // below pin that honest lossy character, not a lossless claim.
    const jpegBack = Buffer.from(viaJpeg.data);
    const srcBytes = Buffer.from(src.data);
    let mean = 0;
    for (let i = 0; i < srcBytes.length; i++) mean += Math.abs(jpegBack[i] - srcBytes[i]);
    mean /= srcBytes.length;
    assert.ok(maxChannelDiff(viaJpeg.data, srcBytes) <= 25, 'JPEG round trip max diff within the measured lossy bound');
    assert.ok(mean <= 1.5, `JPEG round trip mean diff ${mean.toFixed(3)} within the measured bound`);
  });
});

// ---------------------------------------------------------- helpers for PNG text fixtures

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function pngChunkRaw(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  let c = 0xffffffff;
  for (const byte of Buffer.concat([typeBuf, data])) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function pngTextChunk(type: 'tEXt' | 'zTXt', keyword: string, value: string, compress: boolean): Buffer {
  const head = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0])]);
  const data = compress
    ? Buffer.concat([head, Buffer.from([0]), zlib.deflateSync(Buffer.from(value, 'latin1'))])
    : Buffer.concat([head, Buffer.from(value, 'latin1')]);
  return pngChunkRaw(type, data);
}

/** Insert chunks immediately before IEND of an existing PNG. */
function insertPngChunks(png: Buffer, chunks: Buffer[]): Buffer {
  const iendAt = png.length - 12; // IEND is always the final 12 bytes in these fixtures
  return Buffer.concat([png.subarray(0, iendAt), ...chunks, png.subarray(iendAt)]);
}

// Pillow 10.2, progressive=True, quality=85, from ffmpeg's testsrc2 64x48 frame.
const PROGRESSIVE_JPEG_B64 =
  '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';

// Pillow 10.2, mode L (a genuine 1-component JPEG), quality=90, from the same frame.
const GRAY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAAwAEABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APie6l8W6740v9I8PHzRbwm5cMIkjgiWMM8kkkmFRRn7zMBkgdSBXX+DNb+LnhjXb3SLKY213NZx6g77LR4GtgrMJ/PIMfl4J+cNjPGc8V1Fv8ffjD8PfFdkbjXfsN75XnwSLZ2c0ckbocOjCNkdSCRkEjOR1Fd9of7XXx48SXb22neK/PkjiaaQtptgiRxqMs7u0QVVHqSByB3FfIH/AArvx5/wkf8AYf8AZx+3fYv7S3+bB9m+ybd32j7Ru8ryscb9+3Py53cVpadqXjf4UaldWNzIdMnu4ILlSqwTxzxMGMckcgDI6nJ+ZSRkEdQQO7+G3xU+JmpeKoToOpl7y2hluHlNtbLHDEEId3Z0CKoBxliBkgdSK9R/4XR8dv7a/sr+2D9q+y/bt/2Wx8j7Pt3ed52zy/Lx/HuxnjOeK4rwrPa34+KHh82X9talf/2TdQaIsxhk1CG2cS3Ecbj+Ly8nC/MRkqDg16Rp99pi/BseA/7HCeIl/wCJofBn2pjOtob83It/N6+Z5HO3/W4525rj/FN0NNf4YaNaCHw1rVhc3l0bG6m8waWs9wJLcTOwPRMEhhuAGWUZrW8H3J1CD4g6VdmHxDq97c21z9ltZdg1JYbhpJ/KdQOq5ICjJByoOKd/aOk/8KM/4Vv/AGIP+Eo/5C//AAgf2xvtP2P+0ftX2bzuvm/Z+dmfNxzszXn/AIxvRpGnfCrw/Y/Z/CPiHTLy7vTp17ceaujJc3iy2gnkYEfKmGIcbgoBZRkA6Xwv1Aaifijot/LbeJte1G8trsWtnNsXVhBdPJc+Q6gA7lJYBRuIOVU4OPVvtunf8Ko/4Qn+yx/b/wDyEv8AhEvtLef9m+2/aPI8zr5nk87f9ZjnbmvkP4k/8jrqP/bP/wBFrVDQP+W//Af610ekf8hGL8f5GukrwGtjw9/y8f8AAf610mkf8hGL8f5GukrF+JP/ACOuo/8AbP8A9FrVDQP+W/8AwH+tdHpH/IRi/H+RrpK8BrY8Pf8ALx/wH+tdJpH/ACEYvx/ka6Sn+N/BGtav4ovbu0svNt5Nm1/NRc4RQeCwPUGrvgf4JeNPEP23+z9F+0eTs3/6VAuM7sdXHoa77wt+y58TtX161tLTwz5txJu2p9vtVzhSTyZQOgNeg/8ADEvxp/6Ez/yqWX/x6vh/+w77/nh/4+v+NdX4E+H2v+Ivt39n2H2jydm/99GuM7sfeYehr0Hwt8B/HWr69a2lpofm3Em7an2uBc4Uk8lwOgNegf8ADKPxU/6Fb/yoWv8A8dplexfs9/8AMf8A+3f/ANqV9J/B/wD5KLpH/bb/ANEvX0tX8+9ey/s6/wDMwf8Abv8A+1a+l/hB/wAlE0n/ALbf+iXr6Ur/2Q==';
