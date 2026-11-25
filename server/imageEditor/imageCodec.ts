import * as zlib from 'zlib';
import type { PixelImage } from './types.js';

/**
 * Phase 19: real image import/export codecs.
 *
 * PNG: full encoder (filter 0, zlib via Node's built-in zlib) and a
 * decoder handling 8-bit RGB/RGBA non-interlaced PNGs with all five
 * scanline filters — the format this engine exports, plus the common
 * case of imported files. BMP: 24/32-bit uncompressed read/write.
 *
 * JPEG is intentionally NOT faked: there is no pure-TypeScript JPEG
 * codec in this codebase, so JPEG import/export is reported as
 * unsupported rather than simulated (the generated desktop app uses
 * System.Drawing, which does support JPEG — see the generator).
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

export function encodePng(img: PixelImage): Buffer {
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
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
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

export function decodePng(buffer: Buffer): PixelImage {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature)');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  if (!width || !height) throw new Error('PNG has no IHDR');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth} (only 8 supported)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType} (only RGB=2 and RGBA=6 supported)`);

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? recon[i - channels] : 0;
      const up = prevRow[i];
      const upLeft = i >= channels ? prevRow[i - channels] : 0;
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
    prevRow.set(recon);
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      out[di] = recon[si];
      out[di + 1] = recon[si + 1];
      out[di + 2] = recon[si + 2];
      out[di + 3] = channels === 4 ? recon[si + 3] : 255;
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
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;
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

// ------------------------------------------------------------------ dispatch

export type ImageFormat = 'png' | 'bmp';

export function detectFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

export function importImage(buffer: Buffer): PixelImage {
  const format = detectFormat(buffer);
  if (format === 'png') return decodePng(buffer);
  if (format === 'bmp') return decodeBmp(buffer);
  throw new Error('Unsupported image format: only PNG and BMP can be imported by the TypeScript engine (JPEG is supported by the generated desktop app via System.Drawing)');
}

export function exportImage(img: PixelImage, format: ImageFormat): Buffer {
  if (format === 'png') return encodePng(img);
  if (format === 'bmp') return encodeBmp(img);
  throw new Error(`Unsupported export format: ${format}`);
}
