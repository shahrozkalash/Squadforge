import type { GrayImage, PixelImage, PixelImage16 } from './types.js';

/**
 * Phase 58: TIFF import/export for the graphics editor — a genuine
 * baseline TIFF codec written against the TIFF 6.0 specification.
 * Before this phase the engine had no TIFF support anywhere.
 *
 * Supported on decode (all proven against real files written by
 * independent implementations — ffmpeg and Pillow — in the Phase 58
 * test suite):
 * - Classic TIFF (version 42), little- or big-endian, first page of
 *   multi-page files (the page count is reported in the metadata).
 * - Compression: none (1), LZW (5, TIFF early-change code growth —
 *   calibrated against ffmpeg and Pillow files), PackBits (32773).
 * - Horizontal-differencing predictor (tag 317 = 2) for 8- and
 *   16-bit data, chunky and planar.
 * - Layouts: strips, chunky (planar configuration 1) and planar
 *   (configuration 2, one strip sequence per sample plane).
 * - Photometric: WhiteIsZero (0) and BlackIsZero (1) grayscale,
 *   RGB (2), palette (3, via the 16-bit ColorMap). Grayscale+alpha
 *   and RGB+alpha via a fourth/second sample; ExtraSamples
 *   associated alpha (1) is un-premultiplied, unassociated (2) is
 *   used as stored.
 * - Depths: 8-bit samples via `decodeTiff`; 16-bit samples via
 *   `decodeTiff16` (mirroring the PNG split — the 8-bit decoder
 *   refuses 16-bit files by name so precision is never silently
 *   dropped, and vice versa).
 *
 * Rejected with named errors, never silently mis-decoded:
 * BigTIFF (version 43), Deflate/ZIP compression (8 / 32946),
 * JPEG-in-TIFF (6 / 7), CCITT compression (3 / 4), tiled layout
 * (tag 324), CMYK (5) / YCbCr (6) / CIELab (8) photometric, palette
 * files through the 16-bit decoder, mixed or non-8/16 bit depths,
 * sub-8-bit samples, IEEE-float samples and the float predictor.
 *
 * The orientation tag is reported in the metadata but not applied
 * (pixel data is returned as stored, the convention of this engine's
 * other decoders). Encoding writes classic little-endian TIFF,
 * uncompressed, single strip: RGBA 8-bit (`encodeTiff`), RGBA
 * 16-bit (`encodeTiff16`) and grayscale 8-bit
 * (`encodeTiffGrayscale`) — files that ffmpeg/ffprobe read back
 * pixel-exact (proven in the Phase 58 suite).
 */

// ------------------------------------------------------------------ metadata

export interface TiffMetadata {
  byteOrder: 'little' | 'big';
  width: number;
  height: number;
  /** Bits per sample as stored, one entry per sample. */
  bitsPerSample: number[];
  samplesPerPixel: number;
  photometric: number;
  photometricName: string;
  compression: number;
  compressionName: string;
  planarConfiguration: 1 | 2;
  /** Horizontal-differencing predictor (tag 317); 1 = none. */
  predictor: number;
  /** Orientation (tag 274); 1 = as stored. Reported, not applied. */
  orientation: number;
  xResolution: [number, number] | null;
  yResolution: [number, number] | null;
  resolutionUnit: number | null;
  software: string | null;
  dateTime: string | null;
  artist: string | null;
  copyright: string | null;
  imageDescription: string | null;
  extraSamples: number[];
  iccProfilePresent: boolean;
  iccProfileByteLength: number;
  /** Number of pages (IFDs) in the file; decoding reads page 1. */
  pageCount: number;
}

const PHOTOMETRIC_NAMES: Record<number, string> = {
  0: 'WhiteIsZero',
  1: 'BlackIsZero',
  2: 'RGB',
  3: 'Palette',
  4: 'TransparencyMask',
  5: 'CMYK',
  6: 'YCbCr',
  8: 'CIELab'
};

const COMPRESSION_NAMES: Record<number, string> = {
  1: 'none',
  3: 'CCITT Group 3',
  4: 'CCITT Group 4',
  5: 'LZW',
  6: 'JPEG (old-style)',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate'
};

// ------------------------------------------------------------------ IFD parsing

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8 // DOUBLE
};

interface TiffEntry {
  type: number;
  count: number;
  /** Absolute offset of the value bytes in the file. */
  valueOffset: number;
}

class TiffReader {
  readonly data: Uint8Array;
  readonly littleEndian: boolean;

  constructor(data: Uint8Array) {
    this.data = data;
    if (data.length < 8) throw new Error('Not a TIFF file: shorter than the 8-byte header');
    if (data[0] === 0x49 && data[1] === 0x49) this.littleEndian = true;
    else if (data[0] === 0x4d && data[1] === 0x4d) this.littleEndian = false;
    else throw new Error('Not a TIFF file (bad byte-order signature: expected II or MM)');
    const version = this.u16(2);
    if (version === 43) {
      throw new Error('BigTIFF files (version 43) are not supported — only classic TIFF (version 42)');
    }
    if (version !== 42) throw new Error(`Not a TIFF file (bad version: ${version}, expected 42)`);
  }

  u16(offset: number): number {
    const d = this.data;
    return this.littleEndian ? d[offset] | (d[offset + 1] << 8) : (d[offset] << 8) | d[offset + 1];
  }

  u32(offset: number): number {
    const d = this.data;
    return this.littleEndian
      ? (d[offset] | (d[offset + 1] << 8) | (d[offset + 2] << 16) | (d[offset + 3] << 24)) >>> 0
      : ((d[offset] << 24) | (d[offset + 1] << 16) | (d[offset + 2] << 8) | d[offset + 3]) >>> 0;
  }

  firstIfdOffset(): number {
    return this.u32(4);
  }

  /** Parse one IFD; returns its tag entries and the next IFD's offset (0 = none). */
  parseIfd(offset: number): { entries: Map<number, TiffEntry>; nextOffset: number } {
    if (offset <= 0 || offset + 2 > this.data.length) {
      throw new Error(`Corrupt TIFF: IFD offset ${offset} is outside the file`);
    }
    const count = this.u16(offset);
    const entries = new Map<number, TiffEntry>();
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      if (at + 12 > this.data.length) throw new Error('Corrupt TIFF: IFD entry runs past the end of the file');
      const tag = this.u16(at);
      const type = this.u16(at + 2);
      const n = this.u32(at + 4);
      const size = TYPE_SIZES[type];
      if (!size) throw new Error(`Corrupt TIFF: tag ${tag} has unknown field type ${type}`);
      const total = size * n;
      const valueOffset = total <= 4 ? at + 8 : this.u32(at + 8);
      if (valueOffset + total > this.data.length) {
        throw new Error(`Corrupt TIFF: tag ${tag} value (${total} bytes at ${valueOffset}) runs past the end of the file`);
      }
      entries.set(tag, { type, count: n, valueOffset });
    }
    const nextAt = offset + 2 + count * 12;
    if (nextAt + 4 > this.data.length) throw new Error('Corrupt TIFF: IFD has no room for its next-offset field');
    return { entries, nextOffset: this.u32(nextAt) };
  }

  /** Numeric values of an entry (SHORT/LONG/BYTE read as unsigned; RATIONAL flattened to num/den pairs). */
  numbers(entry: TiffEntry): number[] {
    const out: number[] = [];
    const { type, count, valueOffset } = entry;
    for (let i = 0; i < count; i++) {
      switch (type) {
        case 1:
        case 6:
        case 7:
          out.push(this.data[valueOffset + i]);
          break;
        case 3:
        case 8:
          out.push(this.u16(valueOffset + i * 2));
          break;
        case 4:
        case 9:
          out.push(this.u32(valueOffset + i * 4));
          break;
        case 5:
        case 10:
          out.push(this.u32(valueOffset + i * 8), this.u32(valueOffset + i * 8 + 4));
          break;
        default:
          throw new Error(`TIFF field type ${type} is not numeric`);
      }
    }
    return out;
  }

  text(entry: TiffEntry): string {
    let s = '';
    for (let i = 0; i < entry.count; i++) {
      const c = this.data[entry.valueOffset + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

function tagNumbers(entries: Map<number, TiffEntry>, reader: TiffReader, tag: number): number[] | null {
  const e = entries.get(tag);
  return e ? reader.numbers(e) : null;
}

function tagText(entries: Map<number, TiffEntry>, reader: TiffReader, tag: number): string | null {
  const e = entries.get(tag);
  return e ? reader.text(e) : null;
}

function tagRational(entries: Map<number, TiffEntry>, reader: TiffReader, tag: number): [number, number] | null {
  const nums = tagNumbers(entries, reader, tag);
  return nums && nums.length >= 2 ? [nums[0], nums[1]] : null;
}

/** Parse the header and first IFD into metadata. Throws the named errors documented above. */
export function inspectTiff(data: Uint8Array): TiffMetadata {
  const reader = new TiffReader(data);
  let pageCount = 0;
  let offset = reader.firstIfdOffset();
  let first: Map<number, TiffEntry> | null = null;
  const seen = new Set<number>();
  while (offset !== 0) {
    if (seen.has(offset)) throw new Error('Corrupt TIFF: the IFD chain loops');
    seen.add(offset);
    const parsed = reader.parseIfd(offset);
    if (!first) first = parsed.entries;
    pageCount++;
    offset = parsed.nextOffset;
  }
  if (!first || pageCount === 0) throw new Error('Corrupt TIFF: no image file directory (IFD) found');
  const entries = first;
  const width = tagNumbers(entries, reader, 256)?.[0];
  const height = tagNumbers(entries, reader, 257)?.[0];
  if (!width || !height) throw new Error('Corrupt TIFF: missing ImageWidth/ImageLength tags');
  const photometric = tagNumbers(entries, reader, 262)?.[0] ?? 2;
  const compression = tagNumbers(entries, reader, 259)?.[0] ?? 1;
  const icc = entries.get(34675);
  return {
    byteOrder: reader.littleEndian ? 'little' : 'big',
    width,
    height,
    bitsPerSample: tagNumbers(entries, reader, 258) ?? [1],
    samplesPerPixel: tagNumbers(entries, reader, 277)?.[0] ?? 1,
    photometric,
    photometricName: PHOTOMETRIC_NAMES[photometric] ?? `unknown (${photometric})`,
    compression,
    compressionName: COMPRESSION_NAMES[compression] ?? `unknown (${compression})`,
    planarConfiguration: (tagNumbers(entries, reader, 284)?.[0] ?? 1) === 2 ? 2 : 1,
    predictor: tagNumbers(entries, reader, 317)?.[0] ?? 1,
    orientation: tagNumbers(entries, reader, 274)?.[0] ?? 1,
    xResolution: tagRational(entries, reader, 282),
    yResolution: tagRational(entries, reader, 283),
    resolutionUnit: tagNumbers(entries, reader, 296)?.[0] ?? null,
    software: tagText(entries, reader, 305),
    dateTime: tagText(entries, reader, 306),
    artist: tagText(entries, reader, 315),
    copyright: tagText(entries, reader, 33432),
    imageDescription: tagText(entries, reader, 270),
    extraSamples: tagNumbers(entries, reader, 338) ?? [],
    iccProfilePresent: !!icc,
    iccProfileByteLength: icc ? icc.count * (TYPE_SIZES[icc.type] ?? 1) : 0,
    pageCount
  };
}

// ------------------------------------------------------------------ strip decompression

/** PackBits: one continuous stream per strip (unlike PSD's per-row counts). */
function packBitsDecode(data: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let si = 0;
  let di = 0;
  while (si < data.length && di < expected) {
    const header = data[si++];
    const n = header < 128 ? header : header - 256; // signed
    if (n >= 0) {
      const len = n + 1;
      for (let i = 0; i < len && di < expected; i++) out[di++] = data[si++];
    } else if (n >= -127) {
      const len = 1 - n;
      const v = data[si++];
      for (let i = 0; i < len && di < expected; i++) out[di++] = v;
    }
    // n === -128 is a no-op
  }
  if (di < expected) throw new Error(`Corrupt TIFF: PackBits strip decoded to ${di} bytes, expected ${expected}`);
  return out;
}

/**
 * TIFF LZW (MSB-first codes, ClearCode 256, EOI 257, early change):
 * the code width grows as soon as the next assignable code reaches
 * (1 << width) - 1. Calibrated byte-exact against ffmpeg and Pillow
 * LZW files in the Phase 58 suite — the neighbouring rule (bump at
 * (1 << width)) desynchronizes within the first kilobyte.
 */
function lzwDecode(data: Uint8Array, expected: number): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;
  let table: Uint8Array[] = [];
  const reset = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push(Uint8Array.of(i));
    table.push(new Uint8Array(0), new Uint8Array(0)); // 256, 257 placeholders
  };
  reset();
  let nextCode = 258;
  let width = 9;
  let bitPos = 0;
  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < width; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return -1;
      code = (code << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return code;
  };
  const out = new Uint8Array(expected);
  let outLen = 0;
  const emit = (entry: Uint8Array) => {
    for (let i = 0; i < entry.length && outLen < expected; i++) out[outLen++] = entry[i];
  };
  let prev: Uint8Array | null = null;
  while (outLen < expected) {
    const code = readCode();
    if (code < 0) break;
    if (code === CLEAR) {
      reset();
      nextCode = 258;
      width = 9;
      prev = null;
      continue;
    }
    if (code === EOI) break;
    let entry: Uint8Array;
    if (prev === null) {
      entry = table[code];
      if (!entry || entry.length === 0) throw new Error(`Corrupt TIFF: LZW stream starts with non-literal code ${code}`);
      emit(entry);
      prev = entry;
      continue;
    }
    if (code < nextCode) entry = table[code];
    else if (code === nextCode) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0];
    } else {
      throw new Error(`Corrupt TIFF: LZW code ${code} exceeds the dictionary size ${nextCode}`);
    }
    emit(entry);
    const added = new Uint8Array(prev.length + 1);
    added.set(prev);
    added[prev.length] = entry[0];
    table[nextCode++] = added;
    if (nextCode === (1 << width) - 1 && width < 12) width++;
    prev = entry;
  }
  if (outLen < expected) throw new Error(`Corrupt TIFF: LZW strip decoded to ${outLen} bytes, expected ${expected}`);
  return out;
}

function decompressStrip(
  data: Uint8Array,
  offset: number,
  byteCount: number,
  compression: number,
  expected: number
): Uint8Array {
  if (offset + byteCount > data.length) throw new Error('Corrupt TIFF: strip data runs past the end of the file');
  const raw = data.subarray(offset, offset + byteCount);
  switch (compression) {
    case 1:
      if (byteCount < expected) throw new Error(`Corrupt TIFF: uncompressed strip has ${byteCount} bytes, expected ${expected}`);
      return raw.subarray(0, expected);
    case 5:
      return lzwDecode(raw, expected);
    case 32773:
      return packBitsDecode(raw, expected);
    default:
      throw new Error('unreachable: compression validated earlier');
  }
}

// ------------------------------------------------------------------ decode

interface TiffLayout {
  reader: TiffReader;
  entries: Map<number, TiffEntry>;
  meta: TiffMetadata;
  bitDepth: number;
  samplesPerPixel: number;
}

function validateLayout(data: Uint8Array, wantDepth: 8 | 16): TiffLayout {
  const reader = new TiffReader(data);
  const meta = inspectTiff(data);
  const { entries } = reader.parseIfd(reader.firstIfdOffset());
  if (meta.width * meta.height > 268_435_456) {
    throw new Error(`TIFF dimensions ${meta.width}x${meta.height} are implausibly large (over 256M pixels)`);
  }
  // Compression first: it decides whether the data can be read at all.
  if (meta.compression !== 1 && meta.compression !== 5 && meta.compression !== 32773) {
    throw new Error(
      `Unsupported TIFF compression: ${meta.compression} (${meta.compressionName}) — supported: none (1), LZW (5), PackBits (32773)`
    );
  }
  if (entries.has(324) || entries.has(325)) {
    throw new Error('Tiled TIFFs are not supported (this file stores image data in tiles, tags 324/325); strip-based TIFFs are supported');
  }
  const spp = meta.samplesPerPixel;
  const bps = meta.bitsPerSample;
  if (bps.length !== 1 && bps.length !== spp) {
    throw new Error(`Corrupt TIFF: BitsPerSample has ${bps.length} entries for ${spp} samples per pixel`);
  }
  const fullBps = bps.length === spp ? bps : new Array(spp).fill(bps[0]);
  const bitDepth = fullBps[0];
  if (!fullBps.every((b) => b === bitDepth)) {
    throw new Error(`Unsupported TIFF bit depths: ${fullBps.join('/')} (all samples must share one depth)`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported TIFF bit depth: ${bitDepth} (only 8 and 16 supported)`);
  }
  if (bitDepth !== wantDepth) {
    if (wantDepth === 8) {
      throw new Error('Unsupported TIFF bit depth: 16 in decodeTiff — use decodeTiff16 so 16-bit data is not silently reduced to 8-bit');
    }
    throw new Error(`decodeTiff16 needs a 16-bit TIFF, got bit depth ${bitDepth} (use decodeTiff for 8-bit files)`);
  }
  const sampleFormat = tagNumbers(entries, reader, 339);
  if (sampleFormat && sampleFormat.some((f) => f === 3)) {
    throw new Error('IEEE floating-point TIFF samples are not supported');
  }
  if (sampleFormat && sampleFormat.some((f) => f !== 1)) {
    throw new Error(`Unsupported TIFF sample format: ${sampleFormat.join('/')} (only unsigned integer samples are supported)`);
  }
  if (meta.predictor === 3) {
    throw new Error('The TIFF floating-point predictor (tag 317 = 3) is not supported');
  }
  if (meta.predictor !== 1 && meta.predictor !== 2) {
    throw new Error(`Unsupported TIFF predictor: ${meta.predictor} (only 1 = none and 2 = horizontal differencing)`);
  }
  const photo = meta.photometric;
  if (photo !== 0 && photo !== 1 && photo !== 2 && photo !== 3) {
    throw new Error(
      `Unsupported TIFF photometric interpretation: ${photo} (${meta.photometricName}) — supported: WhiteIsZero (0), BlackIsZero (1), RGB (2), Palette (3)`
    );
  }
  if (photo === 2 && spp !== 3 && spp !== 4) {
    throw new Error(`Corrupt TIFF: RGB photometric with ${spp} samples per pixel (expected 3 or 4)`);
  }
  if (photo === 3 && spp !== 1) {
    throw new Error(`Corrupt TIFF: palette photometric with ${spp} samples per pixel (expected 1)`);
  }
  if ((photo === 0 || photo === 1) && spp !== 1 && spp !== 2) {
    throw new Error(`Corrupt TIFF: grayscale photometric with ${spp} samples per pixel (expected 1 or 2)`);
  }
  if (photo === 3 && wantDepth === 16) {
    throw new Error('Palette TIFFs store 8-bit indices — use decodeTiff (the ColorMap expands them to 8-bit RGB)');
  }
  return { reader, entries, meta, bitDepth, samplesPerPixel: spp };
}

/**
 * Read all sample planes as one chunky sample array of `width *
 * height * spp` values in row-major order (16-bit samples as host
 * numbers). Handles strips, both planar configurations, all three
 * compressions and the horizontal predictor.
 */
function readSamples(layout: TiffLayout): Uint16Array {
  const { reader, entries, meta, bitDepth, samplesPerPixel: spp } = layout;
  const { width, height } = meta;
  const bytesPerSample = bitDepth / 8;
  const offsets = tagNumbers(entries, reader, 273);
  const byteCounts = tagNumbers(entries, reader, 279);
  if (!offsets || !byteCounts || offsets.length !== byteCounts.length) {
    throw new Error('Corrupt TIFF: missing or mismatched StripOffsets/StripByteCounts tags');
  }
  const rowsPerStrip = tagNumbers(entries, reader, 278)?.[0] ?? height;
  if (rowsPerStrip <= 0) throw new Error('Corrupt TIFF: RowsPerStrip is 0');
  const stripsPerPlane = Math.ceil(height / rowsPerStrip);
  const planar = meta.planarConfiguration === 2;
  const expectedStrips = planar ? stripsPerPlane * spp : stripsPerPlane;
  if (offsets.length < expectedStrips) {
    throw new Error(`Corrupt TIFF: ${offsets.length} strips present, ${expectedStrips} required by the layout`);
  }
  const samples = new Uint16Array(width * height * spp);
  const readSample = (buf: Uint8Array, i: number): number => {
    if (bitDepth === 8) return buf[i];
    const o = i * 2;
    return reader.littleEndian ? buf[o] | (buf[o + 1] << 8) : (buf[o] << 8) | buf[o + 1];
  };

  for (let s = 0; s < expectedStrips; s++) {
    const plane = planar ? Math.floor(s / stripsPerPlane) : 0;
    const stripInPlane = planar ? s % stripsPerPlane : s;
    const firstRow = stripInPlane * rowsPerStrip;
    const rows = Math.min(rowsPerStrip, height - firstRow);
    const samplesPerRow = planar ? width : width * spp;
    const expectedBytes = rows * samplesPerRow * bytesPerSample;
    const strip = decompressStrip(reader.data, offsets[s], byteCounts[s], meta.compression, expectedBytes);
    // The predictor pass writes in place; never mutate the caller's
    // buffer through the uncompressed path's subarray view.
    const buf = meta.predictor === 2 ? Uint8Array.from(strip) : strip;
    // Horizontal predictor: each sample gains the value of the same
    // component one pixel earlier in its row (chunky stride = spp,
    // planar stride = 1), in the sample's own arithmetic.
    if (meta.predictor === 2) {
      const stride = planar ? 1 : spp;
      for (let y = 0; y < rows; y++) {
        const rowStart = y * samplesPerRow;
        for (let i = stride; i < samplesPerRow; i++) {
          const cur = readSample(buf, rowStart + i) + readSample(buf, rowStart + i - stride);
          const o = (rowStart + i) * bytesPerSample;
          if (bitDepth === 8) buf[o] = cur & 0xff;
          else if (reader.littleEndian) {
            buf[o] = cur & 0xff;
            buf[o + 1] = (cur >> 8) & 0xff;
          } else {
            buf[o] = (cur >> 8) & 0xff;
            buf[o + 1] = cur & 0xff;
          }
        }
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < width; x++) {
        const dstPixel = (firstRow + y) * width + x;
        if (planar) {
          samples[dstPixel * spp + plane] = readSample(buf, y * width + x);
        } else {
          for (let c = 0; c < spp; c++) {
            samples[dstPixel * spp + c] = readSample(buf, y * samplesPerRow + x * spp + c);
          }
        }
      }
    }
  }
  return samples;
}

function samplesToRgba(layout: TiffLayout, samples: Uint16Array, depth: 8 | 16): Uint8ClampedArray | Uint16Array {
  const { reader, entries, meta, samplesPerPixel: spp } = layout;
  const { width, height, photometric } = meta;
  const max = depth === 8 ? 255 : 65535;
  const out = depth === 8 ? new Uint8ClampedArray(width * height * 4) : new Uint16Array(width * height * 4);
  const associated = meta.extraSamples.length > 0 && meta.extraSamples[0] === 1;
  const unpremultiply = (v: number, a: number): number => (a === 0 ? 0 : Math.min(max, Math.round((v * max) / a)));

  let colorMap: number[] | null = null;
  if (photometric === 3) {
    const e = entries.get(320);
    if (!e) throw new Error('Corrupt TIFF: palette image has no ColorMap tag (320)');
    colorMap = reader.numbers(e);
    if (colorMap.length < 3) throw new Error('Corrupt TIFF: ColorMap has fewer than one entry');
  }

  for (let p = 0, px = 0; p < width * height; p++, px += 4) {
    const si = p * spp;
    if (photometric === 3) {
      const idx = samples[si];
      const map = colorMap as number[];
      const entriesCount = Math.floor(map.length / 3);
      if (idx >= entriesCount) throw new Error(`Corrupt TIFF: palette index ${idx} out of range (${entriesCount} ColorMap entries)`);
      // ColorMap values are 16-bit regardless of the index depth.
      if (depth === 8) {
        out[px] = map[idx] >> 8;
        out[px + 1] = map[entriesCount + idx] >> 8;
        out[px + 2] = map[2 * entriesCount + idx] >> 8;
      } else {
        out[px] = map[idx];
        out[px + 1] = map[entriesCount + idx];
        out[px + 2] = map[2 * entriesCount + idx];
      }
      out[px + 3] = max;
    } else if (photometric === 0 || photometric === 1) {
      let v = samples[si];
      if (photometric === 0) v = max - v;
      const a = spp === 2 ? samples[si + 1] : max;
      if (spp === 2 && associated) v = unpremultiply(v, a);
      out[px] = v;
      out[px + 1] = v;
      out[px + 2] = v;
      out[px + 3] = a;
    } else {
      // RGB
      let r = samples[si];
      let g = samples[si + 1];
      let b = samples[si + 2];
      const a = spp === 4 ? samples[si + 3] : max;
      if (spp === 4 && associated) {
        r = unpremultiply(r, a);
        g = unpremultiply(g, a);
        b = unpremultiply(b, a);
      }
      out[px] = r;
      out[px + 1] = g;
      out[px + 2] = b;
      out[px + 3] = a;
    }
  }
  return out;
}

/** Decode an 8-bit TIFF (first page) to RGBA. 16-bit files are refused by name — use `decodeTiff16`. */
export function decodeTiff(data: Uint8Array): PixelImage {
  const layout = validateLayout(data, 8);
  const samples = readSamples(layout);
  const rgba = samplesToRgba(layout, samples, 8) as Uint8ClampedArray;
  return { width: layout.meta.width, height: layout.meta.height, data: rgba };
}

/** Decode a 16-bit TIFF (first page) into the 16-bit working representation. */
export function decodeTiff16(data: Uint8Array): PixelImage16 {
  const layout = validateLayout(data, 16);
  const samples = readSamples(layout);
  const rgba = samplesToRgba(layout, samples, 16) as Uint16Array;
  return { width: layout.meta.width, height: layout.meta.height, data: rgba };
}

// ------------------------------------------------------------------ encode

interface TiffTagSpec {
  tag: number;
  type: number; // 3 SHORT, 4 LONG, 5 RATIONAL, 2 ASCII
  values: number[] | string;
}

function buildTiff(tags: TiffTagSpec[], pixelBytes: Buffer): Buffer {
  // Pixel data goes right after the 8-byte header; the IFD follows,
  // then any tag values that do not fit inline. Tags are sorted
  // ascending, as the specification requires. All offsets are kept
  // word-aligned (the pixel block is padded to an even length; the
  // strip byte count still records the true count).
  const stripOffset = 8;
  const paddedPixelLength = pixelBytes.length + (pixelBytes.length % 2);
  const ifdOffset = stripOffset + paddedPixelLength;
  const sorted = [...tags].sort((a, b) => a.tag - b.tag);
  const external = new Map<number, Buffer>();
  let externalSize = 0;
  const encodeValue = (spec: TiffTagSpec): Buffer => {
    if (typeof spec.values === 'string') return Buffer.from(spec.values + '\0', 'latin1');
    const buf = Buffer.alloc(spec.values.length * (TYPE_SIZES[spec.type] ?? 1));
    spec.values.forEach((v, i) => {
      if (spec.type === 3) buf.writeUInt16LE(v, i * 2);
      else if (spec.type === 4) buf.writeUInt32LE(v >>> 0, i * 4);
      else if (spec.type === 5) buf.writeUInt32LE(v >>> 0, i * 4); // flat num/den list
    });
    return buf;
  };
  for (const spec of sorted) {
    const encoded = encodeValue(spec);
    if (encoded.length > 4) {
      external.set(spec.tag, encoded);
      externalSize += encoded.length + (encoded.length % 2);
    }
  }
  const ifdSize = 2 + sorted.length * 12 + 4;
  const externalBase = ifdOffset + ifdSize;
  const out = Buffer.alloc(externalBase + externalSize);
  out.write('II', 0, 'ascii');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifdOffset, 4);
  pixelBytes.copy(out, stripOffset);
  out.writeUInt16LE(sorted.length, ifdOffset);
  let externalAt = externalBase;
  sorted.forEach((spec, i) => {
    const at = ifdOffset + 2 + i * 12;
    const encoded = encodeValue(spec);
    out.writeUInt16LE(spec.tag, at);
    out.writeUInt16LE(spec.type, at + 2);
    const count =
      typeof spec.values === 'string' ? encoded.length : spec.type === 5 ? spec.values.length / 2 : spec.values.length;
    out.writeUInt32LE(count, at + 4);
    if (encoded.length <= 4) {
      encoded.copy(out, at + 8);
    } else {
      out.writeUInt32LE(externalAt, at + 8);
      encoded.copy(out, externalAt);
      externalAt += encoded.length + (encoded.length % 2);
    }
  });
  out.writeUInt32LE(0, ifdOffset + 2 + sorted.length * 12);
  return out;
}

function baseTags(width: number, height: number, bitDepth: number, spp: number, stripByteCount: number): TiffTagSpec[] {
  return [
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: new Array(spp).fill(bitDepth) },
    { tag: 259, type: 3, values: [1] }, // compression: none
    { tag: 262, type: 3, values: [2] }, // photometric: RGB
    { tag: 273, type: 4, values: [8] }, // strip offset: right after the header
    { tag: 277, type: 3, values: [spp] },
    { tag: 278, type: 4, values: [height] }, // one strip
    { tag: 279, type: 4, values: [stripByteCount] },
    { tag: 282, type: 5, values: [72, 1] },
    { tag: 283, type: 5, values: [72, 1] },
    { tag: 284, type: 3, values: [1] }, // chunky
    { tag: 296, type: 3, values: [2] } // resolution unit: inch
  ];
}

/** Write an 8-bit RGBA image as an uncompressed classic TIFF (alpha stored as unassociated, ExtraSamples = 2). */
export function encodeTiff(img: PixelImage): Buffer {
  const pixels = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const tags = baseTags(img.width, img.height, 8, 4, pixels.length);
  tags.push({ tag: 338, type: 3, values: [2] });
  return buildTiff(tags, pixels);
}

/** Write a 16-bit RGBA working image as an uncompressed 16-bit classic TIFF. */
export function encodeTiff16(img: PixelImage16): Buffer {
  const pixels = Buffer.alloc(img.data.length * 2);
  for (let i = 0; i < img.data.length; i++) pixels.writeUInt16LE(img.data[i], i * 2);
  const tags = baseTags(img.width, img.height, 16, 4, pixels.length);
  tags.push({ tag: 338, type: 3, values: [2] });
  return buildTiff(tags, pixels);
}

/** Write a grayscale working image as an uncompressed 8-bit grayscale TIFF (BlackIsZero). */
export function encodeTiffGrayscale(img: GrayImage): Buffer {
  const pixels = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const tags = baseTags(img.width, img.height, 8, 1, pixels.length);
  const photo = tags.find((t) => t.tag === 262);
  if (photo) photo.values = [1];
  return buildTiff(tags, pixels);
}
