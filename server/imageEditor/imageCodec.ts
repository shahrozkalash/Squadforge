import * as zlib from 'zlib';
import { decode as jpegJsDecode, encode as jpegJsEncode } from 'jpeg-js';
import type { GrayImage, PixelImage, PixelImage16 } from './types.js';
import { MAX_IMAGE_PIXELS } from './imageCore.js';
import { decodeTiff, encodeTiff, inspectTiff } from './tiff.js';
import type { TiffMetadata } from './tiff.js';

/**
 * Phase 59: cap dimensions read from an untrusted file header
 * before they size any allocation — the same 2^28-pixel engine
 * limit the TIFF and PSD importers already enforce. Without this,
 * a small crafted file could declare e.g. 30000×30000 and force a
 * multi-gigabyte allocation attempt (an OOM kill, not an error).
 */
function assertDecodedDimensions(format: string, width: number, height: number): void {
  if (width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`${format} dimensions ${width}x${height} exceed the engine limit of ${MAX_IMAGE_PIXELS} pixels`);
  }
}

/**
 * Phase 19: real image import/export codecs.
 *
 * PNG: full encoder (filter 0, zlib via Node's built-in zlib) and a
 * decoder handling 8-bit non-interlaced PNGs with all five scanline
 * filters — the format this engine exports, plus the common case of
 * imported files. BMP: 24/32-bit uncompressed read/write.
 *
 * Phase 50 additions (color management):
 * - PNG decode now also covers the remaining 8-bit color types:
 *   grayscale (0), palette/indexed (3, PLTE + tRNS expanded to real
 *   RGBA), and grayscale+alpha (4). Palette and grayscale files at
 *   sub-8-bit depths (1/2/4) are still rejected with a named error.
 * - 16-bit PNGs are decoded by `decodePng16` into the 16-bit
 *   working representation (color types 0/2/4/6) and written by
 *   `encodePng16`. Plain `decodePng` refuses 16-bit files with an
 *   error naming `decodePng16`, so 16-bit data is never silently
 *   reduced to 8-bit.
 * - `encodePngGrayscale` writes a real grayscale (type 0) PNG from
 *   the grayscale working representation.
 * - ICC profiles: `extractPngIccProfile` reads the iCCP chunk
 *   (profile name + inflated profile bytes) and `encodePng` accepts
 *   an `iccProfile` option that writes it back — the profile payload
 *   is carried byte-exact (its zlib container is recompressed).
 *   Profiles are carried as data only; nothing in this engine
 *   applies an ICC transform (all values are treated as sRGB-encoded
 *   as stored — see colorManagement.ts).
 * - What plain decode/encode still drops, stated plainly: every
 *   ancillary chunk other than PLTE/tRNS (which are applied) and
 *   iCCP (which needs the explicit APIs above) — gAMA, cHRM, sRGB,
 *   tEXt and friends are not preserved by a decode→encode round
 *   trip, and tRNS for RGB/grayscale files (a transparent-color
 *   spec, not per-pixel alpha) is not applied. Encoded output is
 *   always plain RGBA/grayscale samples plus the optional iCCP.
 *
 * Phase 58 additions (professional file handling):
 * - Format detection is by content (magic bytes) for PNG, BMP,
 *   JPEG, TIFF and PSD — never by file name. A file whose extension
 *   disagrees with its content imports by its content; data with no
 *   recognized signature fails with a specific error.
 * - JPEG is now genuinely supported through the `jpeg-js` package
 *   (a real pure-JavaScript JPEG codec, added as a dependency in
 *   this phase after verifying it installs and matches ffmpeg's
 *   decode of the same files; before this phase no JPEG codec
 *   existed in the codebase or node_modules and JPEG was refused).
 *   Baseline and progressive files decode; encoding writes baseline
 *   JPEG at a caller-chosen quality (default 90).
 * - TIFF import dispatches to the baseline TIFF codec in
 *   `tiff.ts` (decode/encode/metadata live there).
 * - PSD bytes are detected and refused at this flat-image boundary
 *   with an error naming `importPsd` — PSD is a layered-project
 *   import, not a flat image.
 * - `importImageWithMetadata` returns one consistent metadata
 *   shape (format, dimensions, bit depth, color model, alpha, ICC
 *   presence, PNG text, JPEG structure, TIFF tags) alongside the
 *   pixels, without changing `importImage`'s signature.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

interface PngChunkData {
  type: string;
  data: Buffer;
}

/** Walk a PNG's chunks in file order. Throws on a bad signature. */
function walkPngChunks(buffer: Buffer): PngChunkData[] {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature)');
  }
  const chunks: PngChunkData[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + len) });
    offset += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function pngIhdr(chunks: PngChunkData[]): { width: number; height: number; bitDepth: number; colorType: number; interlace: number } {
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG has no IHDR');
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    interlace: ihdr.data[12]
  };
}

function pngIdat(chunks: PngChunkData[], expectedLength?: number): Buffer {
  const compressed = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => Buffer.from(c.data)));
  if (expectedLength === undefined) return zlib.inflateSync(compressed);
  // Phase 59: the decompressed scanline block has an exact expected
  // size ((stride + 1) × height). Bounding the inflate by it means a
  // zip-bomb IDAT fails with a named error instead of allocating
  // unbounded memory; a stream that inflates past the expected size
  // is corrupt by the PNG spec (the scanline block is exact).
  try {
    return zlib.inflateSync(compressed, { maxOutputLength: expectedLength });
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`Corrupt PNG: image data decompresses beyond the expected ${expectedLength} scanline bytes`);
    }
    throw err;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Undo PNG scanline filtering. `stride` is the byte length of one
 * scanline and `bpp` the byte size of one pixel (samples included),
 * which is the filter's "left" distance — this is what generalizes
 * the Phase 19 decoder to 1/2-byte-sample and 16-bit layouts.
 */
function unfilterScanlines(raw: Buffer, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * height);
  // Phase 59: two row buffers swapped per row, instead of a fresh
  // allocation plus a full-row copy per row. Same math, same values.
  let prevRow = new Uint8Array(stride);
  let recon = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = prevRow[i];
      const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
      let v = row[i];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = (v + left) & 0xff;
          break;
        case 2:
          v = (v + up) & 0xff;
          break;
        case 3:
          v = (v + Math.floor((left + up) / 2)) & 0xff;
          break;
        case 4:
          v = (v + paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          throw new Error(`Unknown PNG filter type: ${filter}`);
      }
      recon[i] = v;
    }
    out.set(recon, y * stride);
    const swap = prevRow;
    prevRow = recon;
    recon = swap;
  }
  return out;
}

// ------------------------------------------------------------------ ICC profiles

/** An ICC profile as carried by a PNG iCCP chunk: a Latin-1 name and the raw profile bytes. */
export interface PngIccProfile {
  name: string;
  data: Buffer;
}

/**
 * Read the ICC profile embedded in a PNG's iCCP chunk, if any: the
 * profile name and the inflated profile bytes, exactly as stored.
 * Returns null when the file has no iCCP chunk. The profile is
 * returned as data — this engine never applies ICC transforms.
 */
export function extractPngIccProfile(buffer: Buffer): PngIccProfile | null {
  const chunks = walkPngChunks(buffer);
  const iccp = chunks.find((c) => c.type === 'iCCP');
  if (!iccp) return null;
  const nul = iccp.data.indexOf(0);
  if (nul < 0) throw new Error('Malformed PNG iCCP chunk (no profile name terminator)');
  const name = iccp.data.toString('latin1', 0, nul);
  const method = iccp.data[nul + 1];
  if (method !== 0) throw new Error(`Unsupported PNG iCCP compression method: ${method}`);
  return { name, data: zlib.inflateSync(iccp.data.subarray(nul + 2)) };
}

/**
 * Phase 58: read a PNG's textual metadata — tEXt chunks (Latin-1
 * keyword/value) and zTXt chunks (zlib-compressed value). Returns an
 * empty record when the file carries no text. iTXt (UTF-8
 * international text) is not decoded — a documented limitation.
 */
export function extractPngTextChunks(buffer: Buffer): Record<string, string> {
  const chunks = walkPngChunks(buffer);
  const out: Record<string, string> = {};
  for (const chunk of chunks) {
    if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt') continue;
    const nul = chunk.data.indexOf(0);
    if (nul < 0) continue;
    const keyword = chunk.data.toString('latin1', 0, nul);
    if (chunk.type === 'tEXt') {
      out[keyword] = chunk.data.toString('latin1', nul + 1);
    } else {
      const method = chunk.data[nul + 1];
      if (method !== 0) continue;
      out[keyword] = zlib.inflateSync(chunk.data.subarray(nul + 2)).toString('latin1');
    }
  }
  return out;
}

function iccpChunk(profile: PngIccProfile): Buffer {
  const nameBytes = Buffer.from(profile.name, 'latin1');
  if (nameBytes.length === 0 || nameBytes.length > 79 || nameBytes.includes(0)) {
    throw new Error('Invalid ICC profile name for PNG iCCP: must be 1..79 Latin-1 characters without NUL');
  }
  const data = Buffer.concat([nameBytes, Buffer.from([0, 0]), zlib.deflateSync(profile.data, { level: 6 })]);
  return pngChunk('iCCP', data);
}

export interface EncodePngOptions {
  /** When given, an iCCP chunk carrying this profile is written before IDAT. */
  iccProfile?: PngIccProfile;
}

// ------------------------------------------------------------------ PNG 8-bit

export function encodePng(img: PixelImage, options?: EncodePngOptions): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(img.data.buffer, img.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (options?.iccProfile) parts.push(iccpChunk(options.iccProfile));
  parts.push(pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Write a grayscale working image as a real grayscale (color type 0, 8-bit) PNG. */
export function encodePngGrayscale(img: GrayImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((img.width + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (img.width + 1)] = 0; // filter: none
    Buffer.from(img.data.buffer, img.data.byteOffset + y * img.width, img.width).copy(raw, y * (img.width + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Decode an 8-bit PNG to RGBA. Color types: grayscale (0), RGB (2),
 * palette (3 — PLTE expanded, tRNS applied per index), grayscale+
 * alpha (4) and RGBA (6). 16-bit files are refused with an error
 * naming `decodePng16`; sub-8-bit depths and interlaced files are
 * refused with named errors.
 */
export function decodePng(buffer: Buffer): PixelImage {
  const chunks = walkPngChunks(buffer);
  const { width, height, bitDepth, colorType, interlace } = pngIhdr(chunks);
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth === 16) {
    throw new Error('Unsupported PNG bit depth: 16 in decodePng — use decodePng16 so 16-bit data is not silently reduced to 8-bit');
  }
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth} (only 8 supported)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType} (only grayscale=0, RGB=2, palette=3, grayscale+alpha=4 and RGBA=6 supported)`);

  assertDecodedDimensions('PNG', width, height);
  const plte = chunks.find((c) => c.type === 'PLTE')?.data;
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  if (colorType === 3 && (!plte || plte.length < 3)) throw new Error('Palette PNG has no PLTE chunk');

  const stride = width * channels;
  const raw = pngIdat(chunks, (stride + 1) * height);
  if (raw.length < (stride + 1) * height) {
    throw new Error(`Corrupt PNG: image data is truncated (${raw.length} of ${(stride + 1) * height} scanline bytes)`);
  }
  const recon = unfilterScanlines(raw, height, stride, channels);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, px = 0; p < width * height; p++, px += 4) {
    const si = p * channels;
    switch (colorType) {
      case 0: {
        const v = recon[si];
        out[px] = v;
        out[px + 1] = v;
        out[px + 2] = v;
        out[px + 3] = 255;
        break;
      }
      case 2:
        out[px] = recon[si];
        out[px + 1] = recon[si + 1];
        out[px + 2] = recon[si + 2];
        out[px + 3] = 255;
        break;
      case 3: {
        const idx = recon[si];
        const palette = plte as Buffer;
        const entries = Math.floor(palette.length / 3);
        if (idx >= entries) throw new Error(`PNG palette index ${idx} out of range (${entries} palette entries)`);
        out[px] = palette[idx * 3];
        out[px + 1] = palette[idx * 3 + 1];
        out[px + 2] = palette[idx * 3 + 2];
        out[px + 3] = trns && idx < trns.length ? trns[idx] : 255;
        break;
      }
      case 4: {
        const v = recon[si];
        out[px] = v;
        out[px + 1] = v;
        out[px + 2] = v;
        out[px + 3] = recon[si + 1];
        break;
      }
      case 6:
        out[px] = recon[si];
        out[px + 1] = recon[si + 1];
        out[px + 2] = recon[si + 2];
        out[px + 3] = recon[si + 3];
        break;
    }
  }
  return { width, height, data: out };
}

/** Decode a PNG's pixels together with its embedded ICC profile (null when it has none). */
export function decodePngWithProfile(buffer: Buffer): { image: PixelImage; iccProfile: PngIccProfile | null } {
  return { image: decodePng(buffer), iccProfile: extractPngIccProfile(buffer) };
}

// ------------------------------------------------------------------ PNG 16-bit

/** Write a 16-bit working image as a real 16-bit RGBA (color type 6, depth 16) PNG. */
export function encodePng16(img: PixelImage16): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = img.width * 8;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let i = 0; i < img.width * 4; i++) {
      const v = img.data[y * img.width * 4 + i];
      const di = y * (stride + 1) + 1 + i * 2;
      raw[di] = (v >> 8) & 0xff;
      raw[di + 1] = v & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Decode a 16-bit PNG into the 16-bit working representation —
 * samples are read big-endian and kept at full precision. Color
 * types: grayscale (0, replicated, opaque), RGB (2, opaque),
 * grayscale+alpha (4) and RGBA (6). Palette files cannot be 16-bit
 * in PNG and are refused, as are 8-bit files (use `decodePng`).
 */
export function decodePng16(buffer: Buffer): PixelImage16 {
  const chunks = walkPngChunks(buffer);
  const { width, height, bitDepth, colorType, interlace } = pngIhdr(chunks);
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth !== 16) throw new Error(`decodePng16 needs a 16-bit PNG, got bit depth ${bitDepth} (use decodePng for 8-bit files)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type for 16-bit decode: ${colorType} (only grayscale=0, RGB=2, grayscale+alpha=4 and RGBA=6 supported)`);

  assertDecodedDimensions('PNG', width, height);
  const stride = width * channels * 2;
  const raw = pngIdat(chunks, (stride + 1) * height);
  if (raw.length < (stride + 1) * height) {
    throw new Error(`Corrupt PNG: image data is truncated (${raw.length} of ${(stride + 1) * height} scanline bytes)`);
  }
  const recon = unfilterScanlines(raw, height, stride, channels * 2);
  const sample = (si: number) => (recon[si] << 8) | recon[si + 1];
  const out = new Uint16Array(width * height * 4);
  for (let p = 0, px = 0; p < width * height; p++, px += 4) {
    const si = p * channels * 2;
    switch (colorType) {
      case 0: {
        const v = sample(si);
        out[px] = v;
        out[px + 1] = v;
        out[px + 2] = v;
        out[px + 3] = 65535;
        break;
      }
      case 2:
        out[px] = sample(si);
        out[px + 1] = sample(si + 2);
        out[px + 2] = sample(si + 4);
        out[px + 3] = 65535;
        break;
      case 4: {
        const v = sample(si);
        out[px] = v;
        out[px + 1] = v;
        out[px + 2] = v;
        out[px + 3] = sample(si + 2);
        break;
      }
      case 6:
        out[px] = sample(si);
        out[px + 1] = sample(si + 2);
        out[px + 2] = sample(si + 4);
        out[px + 3] = sample(si + 6);
        break;
    }
  }
  return { width, height, data: out };
}

// ------------------------------------------------------------------ BMP

export function encodeBmp(img: PixelImage): Buffer {
  const rowSize = Math.ceil((img.width * 3) / 4) * 4;
  const pixelBytes = rowSize * img.height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + pixelBytes, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(img.width, 18);
  buf.writeInt32LE(img.height, 22); // positive = bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < img.height; y++) {
    const srcY = img.height - 1 - y;
    for (let x = 0; x < img.width; x++) {
      const si = (srcY * img.width + x) * 4;
      const di = 54 + y * rowSize + x * 3;
      buf[di] = img.data[si + 2]; // B
      buf[di + 1] = img.data[si + 1]; // G
      buf[di + 2] = img.data[si]; // R
    }
  }
  return buf;
}

export function decodeBmp(buffer: Buffer): PixelImage {
  if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Not a BMP file (bad signature)');
  }
  const dataOffset = buffer.readUInt32LE(10);
  const width = buffer.readInt32LE(18);
  const heightRaw = buffer.readInt32LE(22);
  const bpp = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (bpp !== 24 && bpp !== 32) throw new Error(`Unsupported BMP bit depth: ${bpp} (only 24/32 supported)`);
  if (compression !== 0) throw new Error('Compressed BMPs are not supported');
  const topDown = heightRaw < 0;
  const height = Math.abs(heightRaw);
  // Phase 59: the header's dimensions were previously trusted —
  // a negative width produced a negative-length allocation attempt
  // (RangeError), a huge one an OOM risk, and a truncated file
  // decoded silently to black. All three are named errors now.
  if (width < 1 || height < 1) {
    throw new Error(`Invalid BMP dimensions: ${width}x${heightRaw} (width and height must be non-zero)`);
  }
  assertDecodedDimensions('BMP', width, height);
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;
  if (dataOffset + rowSize * height > buffer.length) {
    throw new Error(
      `Corrupt BMP: pixel data is truncated (needs ${dataOffset + rowSize * height} bytes, file has ${buffer.length})`
    );
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fileY = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const si = dataOffset + fileY * rowSize + x * bytesPerPixel;
      const di = (y * width + x) * 4;
      out[di] = buffer[si + 2];
      out[di + 1] = buffer[si + 1];
      out[di + 2] = buffer[si];
      out[di + 3] = bpp === 32 ? buffer[si + 3] : 255;
    }
  }
  return { width, height, data: out };
}

// ------------------------------------------------------------------ JPEG

/** Structural facts about a JPEG file, read by walking its markers (no pixel decode). */
export interface JpegInfo {
  /** Sample precision in bits from the frame header (8 for baseline/progressive files this engine handles). */
  precision: number;
  width: number;
  height: number;
  /** Number of image components in the frame header (1 = grayscale, 3 = color, 4 = CMYK). */
  components: number;
  /** True for progressive DCT (SOF2), false for baseline (SOF0) and other sequential frames. */
  progressive: boolean;
  /** True when a JFIF APP0 segment is present. */
  jfif: boolean;
  /** True when an EXIF APP1 segment is present. */
  exifPresent: boolean;
  /** True when an ICC profile APP2 segment is present. */
  iccProfilePresent: boolean;
}

/**
 * Walk a JPEG's marker segments up to the start of scan and report
 * the frame structure. Throws a named error when the data is not a
 * well-formed JPEG header.
 */
export function inspectJpeg(buffer: Buffer): JpegInfo {
  if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Not a JPEG file (missing FF D8 start-of-image marker)');
  }
  let offset = 2;
  let info: JpegInfo | null = null;
  let jfif = false;
  let exifPresent = false;
  let iccProfilePresent = false;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error(`Corrupt JPEG: expected a marker at offset ${offset}`);
    const marker = buffer[offset + 1];
    if (marker === 0xda) break; // start of scan: header is over
    if (marker === 0xd9) break; // end of image
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    if (offset + 4 > buffer.length) throw new Error('Corrupt JPEG: truncated segment header');
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) {
      throw new Error(`Corrupt JPEG: segment at offset ${offset} declares length ${length}, past the end of the file`);
    }
    const segment = buffer.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe0 && segment.length >= 5 && segment.toString('latin1', 0, 5) === 'JFIF\0') jfif = true;
    if (marker === 0xe1 && segment.length >= 6 && segment.toString('latin1', 0, 6) === 'Exif\0\0') exifPresent = true;
    if (marker === 0xe2 && segment.length >= 12 && segment.toString('latin1', 0, 12) === 'ICC_PROFILE\0') iccProfilePresent = true;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (segment.length < 6) throw new Error('Corrupt JPEG: frame header segment is too short');
      info = {
        precision: segment[0],
        height: segment.readUInt16BE(1),
        width: segment.readUInt16BE(3),
        components: segment[5],
        progressive: marker === 0xc2,
        jfif,
        exifPresent,
        iccProfilePresent
      };
      break;
    }
    offset += 2 + length;
  }
  if (!info) throw new Error('Corrupt JPEG: no frame header (SOF0/SOF1/SOF2) found before the scan data');
  return info;
}

/**
 * Decode a JPEG (baseline or progressive) to RGBA via the jpeg-js
 * codec. JPEG carries no alpha: every pixel is opaque. Decoder
 * failures are rethrown with the format named.
 */
export function decodeJpeg(buffer: Buffer): PixelImage {
  // Phase 59: when the frame header parses, cap its dimensions
  // before the decoder allocates width×height×4 from them (a JPEG
  // header can declare up to 65535×65535). When the header does not
  // parse, fall through — the decoder's own failure is reported
  // below, exactly as before.
  let info: JpegInfo | null = null;
  try {
    info = inspectJpeg(buffer);
  } catch {
    info = null; // malformed header — the decoder below reports its own failure
  }
  if (info) assertDecodedDimensions('JPEG', info.width, info.height);
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpegJsDecode(buffer, { useTArray: true });
  } catch (err) {
    throw new Error(`JPEG decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!decoded.width || !decoded.height || decoded.data.length !== decoded.width * decoded.height * 4) {
    throw new Error(`JPEG decode failed: decoder returned ${decoded.width}x${decoded.height} with ${decoded.data.length} bytes`);
  }
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) };
}

/**
 * Encode an image as a baseline JPEG at the given quality (1..100,
 * default 90) via the jpeg-js codec. JPEG has no alpha channel: the
 * alpha byte is ignored by the format, as in every JPEG encoder.
 */
export function encodeJpeg(img: PixelImage, quality = 90): Buffer {
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error(`Invalid JPEG quality: ${quality} (expected an integer 1..100)`);
  }
  const encoded = jpegJsEncode(
    { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height },
    quality
  );
  return Buffer.from(encoded.data);
}

// ------------------------------------------------------------------ dispatch

/** Formats `exportImage` can write from a flat image. PSD export is project-level (`exportPsd`). */
export type ImageFormat = 'png' | 'bmp' | 'jpeg' | 'tiff';

/** Every format `detectFormat` can recognize by content, including the project-level PSD. */
export type DetectedImageFormat = ImageFormat | 'psd';

/**
 * Detect an image's format from its content (magic bytes), never
 * from a file name: PNG (89 50 4E 47…), BMP ('BM'), JPEG (FF D8 FF),
 * TIFF ('II' 2A 00 or 'MM' 00 2A), PSD ('8BPS'). Returns null when
 * no known signature matches.
 */
export function detectFormat(buffer: Buffer): DetectedImageFormat | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && (buffer[2] === 0x2a || buffer[2] === 0x2b) && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && (buffer[3] === 0x2a || buffer[3] === 0x2b)))
  ) {
    // Classic TIFF (42) and BigTIFF (43) both detect as TIFF;
    // decodeTiff then refuses BigTIFF with its named error.
    return 'tiff';
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === '8BPS') return 'psd';
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

export function importImage(buffer: Buffer): PixelImage {
  const format = detectFormat(buffer);
  if (format === 'png') return decodePng(buffer);
  if (format === 'bmp') return decodeBmp(buffer);
  if (format === 'jpeg') return decodeJpeg(buffer);
  if (format === 'tiff') return decodeTiff(buffer);
  if (format === 'psd') {
    throw new Error(
      'PSD file detected: importImage imports flat images only — use importPsd (server/imageEditor/psd.ts) to import a PSD as a layered project'
    );
  }
  throw new Error(
    'Unsupported image format: the data has no PNG, JPEG, BMP, TIFF or PSD signature — it is not a recognized image file (or is corrupt). ' +
      'importImage supports PNG, JPEG, BMP and TIFF; PSD imports via importPsd'
  );
}

export interface ExportImageOptions {
  /** JPEG quality 1..100 when exporting JPEG (default 90). Ignored by the lossless formats. */
  jpegQuality?: number;
}

export function exportImage(img: PixelImage, format: ImageFormat, options?: ExportImageOptions): Buffer {
  if (format === 'png') return encodePng(img);
  if (format === 'bmp') return encodeBmp(img);
  if (format === 'jpeg') return encodeJpeg(img, options?.jpegQuality ?? 90);
  if (format === 'tiff') return encodeTiff(img);
  throw new Error(`Unsupported export format: ${format} (supported: png, bmp, jpeg, tiff)`);
}

// ------------------------------------------------------------------ import metadata

/**
 * Phase 58: the one metadata shape every flat-image import reports.
 * Format-specific detail rides in the nullable `pngText` / `jpeg` /
 * `tiff` fields; the common fields are always present.
 */
export interface ImageImportMetadata {
  format: ImageFormat;
  width: number;
  height: number;
  /** Bits per channel as stored in the file. */
  bitDepth: number;
  /** Human-readable color model: 'RGBA', 'RGB', 'grayscale', 'grayscale+alpha' or 'palette'. */
  colorModel: string;
  hasAlpha: boolean;
  iccProfilePresent: boolean;
  /** PNG iCCP profile name; null for other formats and when no profile is embedded. */
  iccProfileName: string | null;
  /** PNG tEXt/zTXt text chunks; null for non-PNG files and PNGs without text. */
  pngText: Record<string, string> | null;
  /** JPEG marker structure; null for non-JPEG files. */
  jpeg: JpegInfo | null;
  /** Full TIFF tag summary; null for non-TIFF files. */
  tiff: TiffMetadata | null;
}

const PNG_COLOR_MODELS: Record<number, { name: string; hasAlpha: boolean }> = {
  0: { name: 'grayscale', hasAlpha: false },
  2: { name: 'RGB', hasAlpha: false },
  3: { name: 'palette', hasAlpha: false },
  4: { name: 'grayscale+alpha', hasAlpha: true },
  6: { name: 'RGBA', hasAlpha: true }
};

/**
 * Import a flat image (PNG, BMP, JPEG or TIFF — detected by
 * content) together with its `ImageImportMetadata`. PSD data is
 * refused with the same named error as `importImage`.
 */
export function importImageWithMetadata(buffer: Buffer): { image: PixelImage; metadata: ImageImportMetadata } {
  const format = detectFormat(buffer);
  if (format === 'psd') {
    throw new Error(
      'PSD file detected: importImageWithMetadata imports flat images only — use importPsd (server/imageEditor/psd.ts) to import a PSD as a layered project'
    );
  }
  if (format === null) {
    throw new Error(
      'Unsupported image format: the data has no PNG, JPEG, BMP, TIFF or PSD signature — it is not a recognized image file (or is corrupt). ' +
        'importImageWithMetadata supports PNG, JPEG, BMP and TIFF; PSD imports via importPsd'
    );
  }
  const image = importImage(buffer);
  let metadata: ImageImportMetadata;
  if (format === 'png') {
    const chunks = walkPngChunks(buffer);
    const ihdr = pngIhdr(chunks);
    const model = PNG_COLOR_MODELS[ihdr.colorType] ?? { name: `color type ${ihdr.colorType}`, hasAlpha: false };
    const profile = extractPngIccProfile(buffer);
    const text = extractPngTextChunks(buffer);
    metadata = {
      format,
      width: image.width,
      height: image.height,
      bitDepth: ihdr.bitDepth,
      colorModel: model.name,
      // A palette PNG's alpha lives in tRNS; report it when present.
      hasAlpha: model.hasAlpha || (ihdr.colorType === 3 && chunks.some((c) => c.type === 'tRNS')),
      iccProfilePresent: profile !== null,
      iccProfileName: profile?.name ?? null,
      pngText: Object.keys(text).length > 0 ? text : null,
      jpeg: null,
      tiff: null
    };
  } else if (format === 'bmp') {
    const bpp = buffer.readUInt16LE(28);
    metadata = {
      format,
      width: image.width,
      height: image.height,
      bitDepth: bpp,
      colorModel: bpp === 32 ? 'RGBA' : 'RGB',
      hasAlpha: bpp === 32,
      iccProfilePresent: false,
      iccProfileName: null,
      pngText: null,
      jpeg: null,
      tiff: null
    };
  } else if (format === 'jpeg') {
    const info = inspectJpeg(buffer);
    metadata = {
      format,
      width: image.width,
      height: image.height,
      bitDepth: info.precision,
      colorModel: info.components === 1 ? 'grayscale' : 'RGB',
      hasAlpha: false,
      iccProfilePresent: info.iccProfilePresent,
      iccProfileName: null,
      pngText: null,
      jpeg: info,
      tiff: null
    };
  } else {
    const tiff = inspectTiff(buffer);
    const colorModel =
      tiff.photometric === 3
        ? 'palette'
        : tiff.photometric === 2
          ? tiff.samplesPerPixel === 4
            ? 'RGBA'
            : 'RGB'
          : tiff.samplesPerPixel === 2
            ? 'grayscale+alpha'
            : 'grayscale';
    metadata = {
      format,
      width: image.width,
      height: image.height,
      bitDepth: tiff.bitsPerSample[0] ?? 8,
      colorModel,
      hasAlpha: colorModel === 'RGBA' || colorModel === 'grayscale+alpha',
      iccProfilePresent: tiff.iccProfilePresent,
      iccProfileName: null,
      pngText: null,
      jpeg: null,
      tiff
    };
  }
  return { image, metadata };
}
