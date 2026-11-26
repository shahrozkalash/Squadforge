import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as zlib from 'zlib';
import {
  createProject,
  getPixel,
  setPixel,
  grayscale
} from '../server/imageEditor/imageCore.js';
import {
  encodePng,
  decodePng,
  encodePng16,
  decodePng16,
  encodePngGrayscale,
  extractPngIccProfile,
  decodePngWithProfile,
  importImage,
  detectFormat
} from '../server/imageEditor/imageCodec.js';
import {
  createGrayImage,
  rgbaToGrayscale,
  grayscaleToRgba,
  luminance601,
  upscaleValueTo16,
  downscaleValueTo8,
  createPixelImage16,
  upscaleTo16,
  downscaleTo8,
  applyGain16,
  boxBlur16
} from '../server/imageEditor/colorManagement.js';
import type { PixelImage, PixelImage16 } from '../server/imageEditor/types.js';

/**
 * Phase 50 tests. The PNG fixtures are assembled byte-by-byte from
 * the PNG specification with helpers local to this file (own CRC,
 * own chunk writer, hand-filtered scanlines) — they are NOT produced
 * by the engine's encoders, so the decoders are tested against the
 * format itself. The encoders are verified by structural chunk walks
 * plus decoder round-trips.
 */

// ---------------------------------------------------------- PNG fixture helpers

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdrChunk(width: number, height: number, bitDepth: number, colorType: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return chunk('IHDR', ihdr);
}

/** rows: one Buffer per scanline, each starting with its filter byte. */
function pngWithRows(header: Buffer, extraChunks: Buffer[], rows: Buffer[]): Buffer {
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([PNG_SIG, header, ...extraChunks, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunkTypes(png: Buffer): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const len = png.readUInt32BE(offset);
    types.push(png.toString('ascii', offset + 4, offset + 8));
    offset += 12 + len;
  }
  return types;
}

function px(img: PixelImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function px16(img: PixelImage16, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

function rgbaImage(width: number, height: number, pixels: Array<[number, number, number, number]>): PixelImage {
  const img: PixelImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  pixels.forEach((p, i) => img.data.set(p, i * 4));
  return img;
}

// ---------------------------------------------------------- grayscale representation

describe('Phase 50 — grayscale working representation', () => {
  test('rgbaToGrayscale uses Rec.601 with exact values for known colors', () => {
    const img = rgbaImage(3, 2, [
      [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
      [255, 255, 255, 255], [0, 0, 0, 255], [10, 20, 30, 255]
    ]);
    const gray = rgbaToGrayscale(img);
    assert.equal(gray.width, 3);
    assert.equal(gray.height, 2);
    // 0.299*255 = 76.245 -> 76; 0.587*255 = 149.685 -> 150; 0.114*255 = 29.07 -> 29
    // (10,20,30): 2.99 + 11.74 + 3.42 = 18.15 -> 18
    assert.deepEqual(Array.from(gray.data), [76, 150, 29, 255, 0, 18]);
    // luminance601 itself is the unrounded float
    assert.ok(Math.abs(luminance601(255, 0, 0) - 76.245) < 1e-9);
  });

  test('mid-gray maps to itself — values are sRGB-encoded as stored, never linearized', () => {
    const img = rgbaImage(1, 1, [[128, 128, 128, 255]]);
    assert.equal(rgbaToGrayscale(img).data[0], 128);
  });

  test('alpha is discarded by design: RGB is used as stored, not premultiplied', () => {
    const img = rgbaImage(2, 1, [[255, 0, 0, 0], [0, 0, 0, 0]]);
    const gray = rgbaToGrayscale(img);
    assert.deepEqual(Array.from(gray.data), [76, 0]);
  });

  test('grayscaleToRgba replicates channels with opaque alpha; gray->rgba->gray is the identity for all 256 levels', () => {
    const gray = createGrayImage(256, 1);
    for (let i = 0; i < 256; i++) gray.data[i] = i;
    const rgba = grayscaleToRgba(gray);
    assert.deepEqual(px(rgba, 7, 0), [7, 7, 7, 255]);
    assert.deepEqual(px(rgba, 200, 0), [200, 200, 200, 255]);
    const back = rgbaToGrayscale(rgba);
    assert.deepEqual(Array.from(back.data), Array.from(gray.data));
  });

  test('the grayscale representation agrees with the Phase 19 grayscale adjustment', () => {
    const p = createProject(2, 1);
    const layer = p.layers[0];
    setPixel(layer.image, 0, 0, { r: 200, g: 100, b: 50, a: 255 });
    setPixel(layer.image, 1, 0, { r: 12, g: 34, b: 56, a: 255 });
    const rep = rgbaToGrayscale(layer.image);
    grayscale(p, layer.id);
    // The adjustment keeps alpha and sets r=g=b=luminance; the representation must match.
    assert.equal(getPixel(layer.image, 0, 0).r, rep.data[0]);
    assert.equal(getPixel(layer.image, 1, 0).r, rep.data[1]);
    assert.equal(getPixel(layer.image, 0, 0).g, rep.data[0]);
    assert.equal(getPixel(layer.image, 0, 0).a, 255);
  });

  test('a grayscale image round-trips through a real grayscale PNG', () => {
    const gray = createGrayImage(2, 2);
    gray.data.set([0, 90, 160, 255]);
    const png = encodePngGrayscale(gray);
    // Structural check: the file really is color type 0.
    assert.equal(png[25], 0); // IHDR color-type byte (sig 8 + len 4 + type 4 + w 4 + h 4 + depth 1)
    const decoded = decodePng(png);
    assert.deepEqual(px(decoded, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(px(decoded, 1, 0), [90, 90, 90, 255]);
    assert.deepEqual(px(decoded, 0, 1), [160, 160, 160, 255]);
    assert.deepEqual(px(decoded, 1, 1), [255, 255, 255, 255]);
  });
});

// ---------------------------------------------------------- 16-bit workflow

describe('Phase 50 — 16-bit workflow', () => {
  test('upscale is exactly v*257 and downscale is round(v/257)', () => {
    assert.equal(upscaleValueTo16(0), 0);
    assert.equal(upscaleValueTo16(1), 257);
    assert.equal(upscaleValueTo16(128), 32896);
    assert.equal(upscaleValueTo16(255), 65535);
    // Downscale pins: 128/257 = 0.498 -> 0; 129/257 = 0.502 -> 1; 256/257 = 0.996 -> 1
    const img = createPixelImage16(7, 1);
    [0, 128, 129, 256, 257, 32896, 65535].forEach((v, i) => {
      img.data[i * 4] = v;
    });
    const down = downscaleTo8(img);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => down.data[i * 4]), [0, 0, 1, 1, 1, 128, 255]);
    assert.equal(downscaleValueTo8(25786), 100); // the blurred value from the blur test below
  });

  test('8->16->8 is byte-exact for every level and channel pattern', () => {
    const img: PixelImage = { width: 256, height: 1, data: new Uint8ClampedArray(256 * 4) };
    for (let i = 0; i < 256; i++) {
      img.data[i * 4] = i;
      img.data[i * 4 + 1] = 255 - i;
      img.data[i * 4 + 2] = (i * 37) % 256;
      img.data[i * 4 + 3] = 255;
    }
    const back = downscaleTo8(upscaleTo16(img));
    assert.deepEqual(Array.from(back.data), Array.from(img.data));
  });

  test('applyGain16 computes at 16-bit precision (result is not an 8-bit level)', () => {
    const img = createPixelImage16(1, 1, { r: 25957, g: 100, b: 60000, a: 4242 });
    const out = applyGain16(img, 0.5);
    // 25957 * 0.5 = 12978.5 -> 12979, which no 8-bit upscale can hold (12979 % 257 = 129)
    assert.equal(out.data[0], 12979);
    assert.notEqual(out.data[0] % 257, 0);
    assert.equal(out.data[1], 50);
    assert.equal(out.data[2], 30000);
    assert.equal(out.data[3], 4242); // alpha carried unchanged
    // Input not mutated; gain clamps at 65535; invalid gain rejected.
    assert.equal(img.data[0], 25957);
    assert.equal(applyGain16(img, 2).data[2], 65535);
    assert.throws(() => applyGain16(img, -1), /Invalid gain/);
    assert.throws(() => applyGain16(img, NaN), /Invalid gain/);
  });

  test('boxBlur16 averages at 16-bit precision and only quantizes on downscale', () => {
    const img = createPixelImage16(2, 1);
    img.data.set([25700, 0, 0, 65535, 25957, 0, 0, 65535]);
    const blurred = boxBlur16(img, 1);
    // Edge-replicated 3-tap average: (25700+25700+25957)/3 = 25785.67 -> 25786
    //                                 (25700+25957+25957)/3 = 25871.33 -> 25871
    assert.deepEqual(px16(blurred, 0, 0), [25786, 0, 0, 65535]);
    assert.deepEqual(px16(blurred, 1, 0), [25871, 0, 0, 65535]);
    assert.notEqual(blurred.data[0] % 257, 0); // between 8-bit levels: real 16-bit precision
    const down = downscaleTo8(blurred);
    assert.deepEqual([down.data[0], down.data[4]], [100, 101]);
    // A uniform image stays exactly uniform; radius 0 is an equal copy.
    const uniform = createPixelImage16(3, 3, { r: 12345, g: 2222, b: 65535, a: 999 });
    assert.deepEqual(Array.from(boxBlur16(uniform, 2).data), Array.from(uniform.data));
    const copy = boxBlur16(img, 0);
    assert.deepEqual(Array.from(copy.data), Array.from(img.data));
    assert.notEqual(copy, img);
    assert.throws(() => boxBlur16(img, -1), /Invalid blur radius/);
    assert.throws(() => createPixelImage16(1, 1, { r: 70000, g: 0, b: 0, a: 0 }), /Invalid 16-bit channel value/);
  });
});

// ---------------------------------------------------------- PNG palette / grayscale decode

describe('Phase 50 — PNG palette and grayscale decoding', () => {
  const PLTE = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]); // red, green, blue

  test('palette PNG expands PLTE and applies tRNS alpha per index', () => {
    const rows = [
      Buffer.from([0, 0, 1]), // filter 0: indices 0, 1
      Buffer.from([0, 2, 1]) //  filter 0: indices 2, 1
    ];
    const png = pngWithRows(ihdrChunk(2, 2, 8, 3), [chunk('PLTE', PLTE), chunk('tRNS', Buffer.from([128]))], rows);
    const img = decodePng(png);
    assert.deepEqual(px(img, 0, 0), [255, 0, 0, 128]); // tRNS[0] = 128
    assert.deepEqual(px(img, 1, 0), [0, 255, 0, 255]); // no tRNS entry -> opaque
    assert.deepEqual(px(img, 0, 1), [0, 0, 255, 255]);
    assert.deepEqual(px(img, 1, 1), [0, 255, 0, 255]);
  });

  test('palette PNG without tRNS is fully opaque, and Sub-filtered palette rows unfilter at bpp=1', () => {
    // Row: filter 1 (Sub), filtered bytes [1, 1] -> recon indices [1, 2]
    const png = pngWithRows(ihdrChunk(2, 1, 8, 3), [chunk('PLTE', PLTE)], [Buffer.from([1, 1, 1])]);
    const img = decodePng(png);
    assert.deepEqual(px(img, 0, 0), [0, 255, 0, 255]);
    assert.deepEqual(px(img, 1, 0), [0, 0, 255, 255]);
  });

  test('palette PNG without PLTE, or with an out-of-range index, is rejected', () => {
    const noPlte = pngWithRows(ihdrChunk(1, 1, 8, 3), [], [Buffer.from([0, 0])]);
    assert.throws(() => decodePng(noPlte), /no PLTE/);
    const badIndex = pngWithRows(ihdrChunk(1, 1, 8, 3), [chunk('PLTE', PLTE)], [Buffer.from([0, 5])]);
    assert.throws(() => decodePng(badIndex), /out of range/);
  });

  test('grayscale and grayscale+alpha PNGs decode to replicated RGBA', () => {
    const gray = pngWithRows(ihdrChunk(2, 1, 8, 0), [], [Buffer.from([0, 37, 200])]);
    const g = decodePng(gray);
    assert.deepEqual(px(g, 0, 0), [37, 37, 37, 255]);
    assert.deepEqual(px(g, 1, 0), [200, 200, 200, 255]);
    const graya = pngWithRows(ihdrChunk(1, 1, 8, 4), [], [Buffer.from([0, 90, 12])]);
    assert.deepEqual(px(decodePng(graya), 0, 0), [90, 90, 90, 12]);
  });

  test('sub-8-bit palette files are rejected with a named error, not mangled', () => {
    const packed = pngWithRows(ihdrChunk(2, 1, 4, 3), [chunk('PLTE', PLTE)], [Buffer.from([0, 0x12])]);
    assert.throws(() => decodePng(packed), /bit depth: 4/);
  });
});

// ---------------------------------------------------------- 16-bit PNG

describe('Phase 50 — 16-bit PNG decode and encode', () => {
  function be16(...values: number[]): Buffer {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeUInt16BE(v, i * 2));
    return b;
  }

  test('hand-built 16-bit RGBA PNG decodes at full precision; decodePng refuses it by name', () => {
    const row = Buffer.concat([Buffer.from([0]), be16(65535, 32896, 257, 0, 1000, 2000, 3000, 4000)]);
    const png = pngWithRows(ihdrChunk(2, 1, 16, 6), [], [row]);
    const img = decodePng16(png);
    assert.deepEqual(px16(img, 0, 0), [65535, 32896, 257, 0]);
    assert.deepEqual(px16(img, 1, 0), [1000, 2000, 3000, 4000]);
    assert.throws(() => decodePng(png), /decodePng16/);
  });

  test('16-bit Sub-filtered rows unfilter at bpp=8', () => {
    // Raw samples: px0 (1000, 0, 0, 65535), px1 (1500, 0, 0, 65535).
    const raw = be16(1000, 0, 0, 65535, 1500, 0, 0, 65535);
    const filtered = Buffer.from(raw.map((byte, i) => (i < 8 ? byte : (byte - raw[i - 8]) & 0xff)));
    const png = pngWithRows(ihdrChunk(2, 1, 16, 6), [], [Buffer.concat([Buffer.from([1]), filtered])]);
    const img = decodePng16(png);
    assert.deepEqual(px16(img, 0, 0), [1000, 0, 0, 65535]);
    assert.deepEqual(px16(img, 1, 0), [1500, 0, 0, 65535]);
  });

  test('16-bit grayscale replicates with opaque alpha; 16-bit RGB gains opaque alpha', () => {
    const gray = pngWithRows(ihdrChunk(2, 1, 16, 0), [], [Buffer.concat([Buffer.from([0]), be16(1000, 65535)])]);
    const g = decodePng16(gray);
    assert.deepEqual(px16(g, 0, 0), [1000, 1000, 1000, 65535]);
    assert.deepEqual(px16(g, 1, 0), [65535, 65535, 65535, 65535]);
    const rgb = pngWithRows(ihdrChunk(1, 1, 16, 2), [], [Buffer.concat([Buffer.from([0]), be16(111, 222, 333)])]);
    assert.deepEqual(px16(decodePng16(rgb), 0, 0), [111, 222, 333, 65535]);
  });

  test('encodePng16 writes a real 16-bit RGBA PNG that decodePng16 reads back exactly', () => {
    const img = upscaleTo16(rgbaImage(2, 1, [[10, 128, 255, 255], [0, 64, 32, 128]]));
    const png = encodePng16(img);
    assert.deepEqual(chunkTypes(png), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(png[24], 16); // IHDR bit-depth byte
    assert.equal(png[25], 6); // IHDR color-type byte
    const back = decodePng16(png);
    assert.deepEqual(Array.from(back.data), Array.from(img.data));
    // And the whole 8->file->16->8 chain is lossless.
    assert.deepEqual(Array.from(downscaleTo8(back).data), [10, 128, 255, 255, 0, 64, 32, 128]);
  });

  test('decodePng16 refuses 8-bit files and palette files by name', () => {
    const eight = encodePng(rgbaImage(1, 1, [[1, 2, 3, 255]]));
    assert.throws(() => decodePng16(eight), /use decodePng for 8-bit/);
    const palette16 = pngWithRows(ihdrChunk(1, 1, 16, 3), [], [Buffer.from([0, 0, 0])]);
    assert.throws(() => decodePng16(palette16), /color type/);
  });
});

// ---------------------------------------------------------- ICC profiles

describe('Phase 50 — ICC profile carriage', () => {
  // A fabricated profile payload: the engine carries profiles as
  // opaque bytes and never parses them, so the fixture only needs
  // the shape of a real ICC header (128 bytes, 'acsp' at offset 36).
  const PROFILE = (() => {
    const b = Buffer.alloc(132);
    b.writeUInt32BE(132, 0);
    b.write('acsp', 36, 'ascii');
    b.write('sRGB', 52, 'ascii');
    return b;
  })();

  function pngWithIccp(): Buffer {
    const iccpData = Buffer.concat([Buffer.from('FakeRGB', 'latin1'), Buffer.from([0, 0]), zlib.deflateSync(PROFILE)]);
    const row = Buffer.from([0, 255, 0, 0, 255]); // filter 0, one red RGBA pixel
    return pngWithRows(ihdrChunk(1, 1, 8, 6), [chunk('iCCP', iccpData)], [row]);
  }

  test('extractPngIccProfile returns the stored name and byte-exact profile payload', () => {
    const found = extractPngIccProfile(pngWithIccp());
    assert.ok(found);
    assert.equal(found.name, 'FakeRGB');
    assert.deepEqual(found.data, PROFILE);
    // A PNG without iCCP yields null, not an error.
    assert.equal(extractPngIccProfile(encodePng(rgbaImage(1, 1, [[0, 0, 0, 255]]))), null);
  });

  test('decode -> encode carries the profile through byte-exact (decodePngWithProfile + encodePng option)', () => {
    const { image, iccProfile } = decodePngWithProfile(pngWithIccp());
    assert.deepEqual(px(image, 0, 0), [255, 0, 0, 255]);
    assert.ok(iccProfile);
    const reencoded = encodePng(image, { iccProfile });
    assert.deepEqual(chunkTypes(reencoded), ['IHDR', 'iCCP', 'IDAT', 'IEND']);
    const again = extractPngIccProfile(reencoded);
    assert.ok(again);
    assert.equal(again.name, 'FakeRGB');
    assert.deepEqual(again.data, PROFILE);
    assert.deepEqual(px(decodePng(reencoded), 0, 0), [255, 0, 0, 255]);
  });

  test('an invalid iCCP profile name is rejected at encode time', () => {
    const img = rgbaImage(1, 1, [[0, 0, 0, 255]]);
    assert.throws(() => encodePng(img, { iccProfile: { name: '', data: PROFILE } }), /Invalid ICC profile name/);
  });
});

// ---------------------------------------------------------- JPEG honesty + color accuracy

describe('Phase 50 — JPEG state and color accuracy', () => {
  test('JPEG bytes are recognized and refused with the exact reason (no codec exists)', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1')]);
    assert.equal(detectFormat(jpeg), null);
    assert.throws(() => importImage(jpeg), /JPEG image detected/);
    assert.throws(() => importImage(jpeg), /no JPEG codec/);
  });

  test('primaries and mid-gray survive the 8->16->8 path exactly', () => {
    const img = rgbaImage(4, 1, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [128, 128, 128, 255]]);
    const wide = upscaleTo16(img);
    assert.deepEqual(px16(wide, 0, 0), [65535, 0, 0, 65535]);
    assert.deepEqual(px16(wide, 3, 0), [32896, 32896, 32896, 65535]);
    assert.deepEqual(Array.from(downscaleTo8(wide).data), Array.from(img.data));
  });
});
