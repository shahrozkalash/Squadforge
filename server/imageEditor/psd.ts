import * as zlib from 'zlib';
import type { BlendMode, ImageProject, Layer, LayerGroup, LayerMask, PixelImage } from './types.js';
import { DEFAULT_GRID_SETTINGS } from './types.js';
import { composite, createPixelImage } from './imageCore.js';

/**
 * Phase 49: PSD import and export for the graphics editor.
 *
 * A scoped, genuine implementation of the Adobe PSD file format
 * (signature '8BPS', version 1 — the classic PSD, not the large-document
 * PSB), written against the format specification. It is NOT full
 * Photoshop compatibility, and it does not claim to be:
 *
 * Supported on import
 * - Header: RGB color mode, 8-bit depth. Other color modes (CMYK, Lab,
 *   Grayscale, Indexed, …) and other depths (16/32-bit) are REJECTED
 *   with a named error rather than silently mangled; PSB (version 2)
 *   files are rejected the same way.
 * - Layer records: bounding boxes (layers are placed at their box
 *   offset on the canvas — this engine's layers are canvas-sized, so
 *   each imported layer is a canvas-sized buffer with the PSD layer's
 *   pixels at its box position), Pascal names with the Unicode name
 *   ('luni') preferred when present, opacity (quantized to 1/255 by
 *   the format), visibility (flags bit 1), clipping (record clipping
 *   byte → the Phase 44 `clipped` flag), transparency protection
 *   (flags bit 0 → the Phase 44 `alphaLock` flag), and the blend mode
 *   keys this engine has modes for (norm/mul /scrn/over/dark/lite).
 * - Layer groups from section-divider records ('lsct'): folder records
 *   become Phase 44 groups with their name/opacity/visibility/blend
 *   mode; 'pass' (pass-through) maps to 'normal' with a warning,
 *   because this engine always composites groups into an isolated
 *   buffer.
 * - Per-layer channel data in RAW (0), RLE/PackBits (1) and ZIP (2,
 *   and 3 = ZIP with per-row delta prediction) compression, for the
 *   R/G/B and alpha (-1) channels. Layer masks from the mask channel
 *   (-2, falling back to -3) placed by the mask rectangle stored in
 *   the record, with the file's default color outside the rectangle.
 * - Flattened PSDs (no layer records): the merged composite image data
 *   section becomes a single layer.
 *
 * Reported, never silently dropped (see PsdImportResult.warnings):
 * unknown blend mode keys (imported as 'normal'), Photoshop text data
 * ('TySh' — the layer imports as raster pixels and is not editable
 * text), layer effects ('lfx2'/'lrFX'), adjustment-layer data
 * ('levl', 'curv', …), fill-layer data ('SoCo'/'GdFl'/'PtFl'), smart
 * objects ('SoLd'/'PlLd'), vector data ('vstk'), fill opacity
 * ('iOpa' ≠ 255), spot/extra channels, layers with no pixel channels,
 * layer content extending beyond the canvas, and disabled masks.
 *
 * Export writes a structurally valid version-1 PSD: header, empty
 * color-mode and image-resource sections, layer records (names as
 * Pascal + 'luni', opacity, visibility, clipping, alpha lock, blend
 * keys, group folder/divider records), RLE-compressed channel data
 * (including a -2 mask channel when the layer has a mask), and an
 * RLE merged-composite section produced by the engine's own
 * `composite()`. A layer's stored bounds are the bounding box of the
 * pixels that carry data — any pixel with a nonzero byte, plus any
 * mask pixel that is not fully revealing — so the writer→reader path
 * is pixel-exact. Known export losses (documented, not hidden):
 * Phase 48 text/shape content layers export as their rendered pixels
 * and re-import as raster layers; group blend mode 'normal' is
 * written as 'norm' (this engine has no pass-through); layer opacity
 * is quantized to 1/255 by the format itself.
 */

// ------------------------------------------------------------------ shared

/** Result of a PSD import: the project plus everything the importer could not preserve. */
export interface PsdImportResult {
  project: ImageProject;
  warnings: string[];
}

const COLOR_MODE_NAMES: Record<number, string> = {
  0: 'Bitmap',
  1: 'Grayscale',
  2: 'Indexed',
  3: 'RGB',
  4: 'CMYK',
  7: 'Multichannel',
  8: 'Duotone',
  9: 'Lab'
};

/** PSD blend mode key → engine blend mode, for the keys this engine implements. */
const PSD_BLEND_TO_ENGINE: Record<string, BlendMode> = {
  norm: 'normal',
  'mul ': 'multiply',
  scrn: 'screen',
  over: 'overlay',
  dark: 'darken',
  lite: 'lighten'
};

const ENGINE_BLEND_TO_PSD: Record<BlendMode, string> = {
  normal: 'norm',
  multiply: 'mul ',
  screen: 'scrn',
  overlay: 'over',
  darken: 'dark',
  lighten: 'lite'
};

/** Additional-layer-info keys whose content this engine cannot preserve. */
const UNSUPPORTED_BLOCK_NOTES: Record<string, string> = {
  TySh: 'Photoshop text data (TySh) is not preserved; the layer imports as raster pixels, not editable text',
  lfx2: 'layer effects (lfx2) are not preserved',
  lrFX: 'layer effects (lrFX) are not preserved',
  SoLd: 'smart object data (SoLd) is not preserved; the layer imports as raster pixels',
  PlLd: 'smart object data (PlLd) is not preserved; the layer imports as raster pixels',
  SoCo: 'solid-color fill layer data (SoCo) is not preserved',
  GdFl: 'gradient fill layer data (GdFl) is not preserved',
  PtFl: 'pattern fill layer data (PtFl) is not preserved',
  vstk: 'vector shape data (vstk) is not preserved; the layer imports as raster pixels'
};

const ADJUSTMENT_BLOCK_KEYS = new Set([
  'brit', 'levl', 'curv', 'expA', 'blnc', 'hue2', 'hue ', 'nvrt',
  'mixr', 'grdm', 'phfl', 'post', 'thrs', 'selc', 'vibA', 'blwh'
]);

/** Guard against absurd allocations from corrupt headers (PSD itself caps dimensions at 30000). */
const MAX_CANVAS_PIXELS = 1 << 28;

// ------------------------------------------------------------------ byte IO

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}
  get length(): number {
    return this.buf.length;
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
  private need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(`Corrupt PSD: unexpected end of file while reading ${what}`);
    }
  }
  u8(what = 'byte'): number {
    this.need(1, what);
    return this.buf[this.pos++];
  }
  u16(what = 'uint16'): number {
    this.need(2, what);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i16(what = 'int16'): number {
    this.need(2, what);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(what = 'uint32'): number {
    this.need(4, what);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i32(what = 'int32'): number {
    this.need(4, what);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number, what = 'bytes'): Buffer {
    this.need(n, what);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  ascii(n: number, what = 'text'): string {
    return this.bytes(n, what).toString('latin1');
  }
  skip(n: number, what = 'section'): void {
    this.need(n, what);
    this.pos += n;
  }
}

// ------------------------------------------------------------------ PackBits

/** Decode one PackBits stream of `compressedLength` bytes into exactly `expected` bytes. */
function packBitsDecode(data: Buffer, start: number, compressedLength: number, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let ip = start;
  const end = start + compressedLength;
  let op = 0;
  while (ip < end) {
    const header = data.readInt8(ip++);
    if (header >= 0) {
      const count = header + 1;
      if (ip + count > end || op + count > expected) throw new Error('Corrupt PSD: PackBits literal run overruns its data');
      for (let i = 0; i < count; i++) out[op++] = data[ip++];
    } else if (header >= -127) {
      const count = 1 - header;
      if (ip >= end || op + count > expected) throw new Error('Corrupt PSD: PackBits repeat run overruns its data');
      const value = data[ip++];
      for (let i = 0; i < count; i++) out[op++] = value;
    }
    // header === -128 is a no-op packet.
  }
  if (op !== expected) throw new Error(`Corrupt PSD: PackBits decoded ${op} bytes, expected ${expected}`);
  return out;
}

/** Encode one row with PackBits (repeat packets for runs of 3+, literal packets otherwise). */
function packBitsEncodeRow(row: Uint8Array): Buffer {
  const out: number[] = [];
  const n = row.length;
  let i = 0;
  const runLengthAt = (at: number): number => {
    let run = 1;
    while (at + run < n && row[at + run] === row[at] && run < 128) run++;
    return run;
  };
  while (i < n) {
    const run = runLengthAt(i);
    if (run >= 3) {
      out.push(257 - run, row[i]);
      i += run;
    } else {
      const start = i;
      i += run;
      while (i < n && i - start < 128) {
        const r = runLengthAt(i);
        if (r >= 3) break;
        i += Math.min(r, 128 - (i - start));
      }
      const len = i - start;
      out.push(len - 1);
      for (let k = start; k < i; k++) out.push(row[k]);
    }
  }
  return Buffer.from(out);
}

/** RLE-encode a plane: uint16 row byte counts, then each row's PackBits data. */
function encodePlaneRle(plane: Uint8Array, width: number, height: number): Buffer {
  const rows: Buffer[] = [];
  let total = 2 * height;
  for (let y = 0; y < height; y++) {
    const enc = packBitsEncodeRow(plane.subarray(y * width, (y + 1) * width));
    rows.push(enc);
    total += enc.length;
  }
  const out = Buffer.alloc(total);
  let pos = 0;
  for (const enc of rows) {
    out.writeUInt16BE(enc.length, pos);
    pos += 2;
  }
  for (const enc of rows) {
    enc.copy(out, pos);
    pos += enc.length;
  }
  return out;
}

// ------------------------------------------------------------------ channel data

/**
 * Decode one channel's data. `dataLength` is the record's declared
 * length, which includes the 2-byte compression word. The reader is
 * left exactly at start + dataLength regardless of how the codec
 * consumed bytes, so a quirky channel cannot desynchronize the file.
 */
function decodeChannel(r: Reader, dataLength: number, width: number, height: number): Uint8Array {
  const start = r.pos;
  const expected = width * height;
  const compression = r.u16('channel compression');
  if (compression === 0) {
    const raw = r.bytes(expected, 'raw channel data');
    r.pos = start + dataLength;
    return new Uint8Array(raw);
  }
  if (compression === 1) {
    const counts: number[] = [];
    for (let y = 0; y < height; y++) counts.push(r.u16('RLE row byte count'));
    const out = new Uint8Array(expected);
    for (let y = 0; y < height; y++) {
      const row = packBitsDecode(r.buf, r.pos, counts[y], width);
      out.set(row, y * width);
      r.pos += counts[y];
    }
    r.pos = start + dataLength;
    return out;
  }
  if (compression === 2 || compression === 3) {
    const compressed = r.bytes(dataLength - 2, 'ZIP channel data');
    let raw: Buffer;
    try {
      raw = zlib.inflateSync(compressed);
    } catch {
      throw new Error('Corrupt PSD: ZIP-compressed channel data does not inflate');
    }
    if (raw.length !== expected) {
      throw new Error(`Corrupt PSD: ZIP channel decoded ${raw.length} bytes, expected ${expected}`);
    }
    const out = new Uint8Array(raw);
    if (compression === 3) {
      // ZIP with prediction: each row byte is a delta on the previous byte in its row.
      for (let y = 0; y < height; y++) {
        const base = y * width;
        for (let x = 1; x < width; x++) out[base + x] = (out[base + x] + out[base + x - 1]) & 0xff;
      }
    }
    r.pos = start + dataLength;
    return out;
  }
  throw new Error(`Unsupported PSD channel compression: ${compression} (only RAW=0, RLE=1, ZIP=2/3 are supported)`);
}

// ------------------------------------------------------------------ parsing

interface PsdRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface PsdChannelInfo {
  id: number;
  length: number;
}

interface PsdRecord {
  bounds: PsdRect;
  channels: PsdChannelInfo[];
  blendKey: string;
  opacity: number; // 0..255 as stored
  clipping: number;
  flags: number;
  name: string;
  /** 'lsct' type: 1/2 = folder, 3 = bounding divider, null = ordinary layer */
  sectionType: number | null;
  maskRect: PsdRect | null;
  maskDefaultColor: number;
  maskDisabled: boolean;
  notes: string[];
  /** Decoded planes by channel id (bounds-sized, or mask-rect-sized for -2/-3). */
  planes: Map<number, Uint8Array>;
}

interface ParsedPsd {
  width: number;
  height: number;
  headerChannels: number;
  records: PsdRecord[];
  merged: PixelImage | null;
  warnings: string[];
}

function rectWidth(r: PsdRect): number {
  return Math.max(0, r.right - r.left);
}
function rectHeight(r: PsdRect): number {
  return Math.max(0, r.bottom - r.top);
}

function parseLayerRecord(r: Reader): PsdRecord {
  const bounds: PsdRect = { top: r.i32('layer top'), left: r.i32('layer left'), bottom: r.i32('layer bottom'), right: r.i32('layer right') };
  const channelCount = r.u16('channel count');
  const channels: PsdChannelInfo[] = [];
  for (let i = 0; i < channelCount; i++) {
    channels.push({ id: r.i16('channel id'), length: r.u32('channel data length') });
  }
  const blendSig = r.ascii(4, 'blend mode signature');
  if (blendSig !== '8BIM') throw new Error(`Corrupt PSD: expected blend mode signature '8BIM', found '${blendSig}'`);
  const blendKey = r.ascii(4, 'blend mode key');
  const opacity = r.u8('layer opacity');
  const clipping = r.u8('layer clipping');
  const flags = r.u8('layer flags');
  r.u8('layer filler');

  const notes: string[] = [];
  let maskRect: PsdRect | null = null;
  let maskDefaultColor = 0;
  let maskDisabled = false;
  let sectionType: number | null = null;
  let name = '';

  const extraLength = r.u32('layer extra data length');
  const extraEnd = r.pos + extraLength;
  if (extraEnd > r.length) throw new Error('Corrupt PSD: layer extra data overruns the file');

  // Layer mask data.
  const maskDataSize = r.u32('layer mask data size');
  if (maskDataSize > 0) {
    const maskEnd = r.pos + maskDataSize;
    if (maskDataSize >= 18) {
      const rect: PsdRect = { top: r.i32('mask top'), left: r.i32('mask left'), bottom: r.i32('mask bottom'), right: r.i32('mask right') };
      let defaultColor = r.u8('mask default color');
      const maskFlags = r.u8('mask flags');
      maskDisabled = (maskFlags & 0x02) !== 0;
      let realRect: PsdRect | null = null;
      if ((maskFlags & 0x10) !== 0 && maskDataSize >= 36) {
        r.u8('real mask flags');
        defaultColor = r.u8('real mask default color');
        realRect = { top: r.i32('real mask top'), left: r.i32('real mask left'), bottom: r.i32('real mask bottom'), right: r.i32('real mask right') };
      }
      maskRect = realRect ?? rect;
      maskDefaultColor = defaultColor;
    }
    r.pos = maskEnd;
  }

  // Blending ranges (parsed for structure, content not modeled by this engine).
  const rangesLength = r.u32('blending ranges length');
  r.skip(rangesLength, 'blending ranges');

  // Pascal name, padded so the whole field (length byte + chars) is a multiple of 4.
  const nameLength = r.u8('layer name length');
  name = r.ascii(nameLength, 'layer name');
  const nameField = 1 + nameLength;
  r.skip(Math.ceil(nameField / 4) * 4 - nameField, 'layer name padding');

  // Additional layer information blocks.
  while (r.pos + 8 <= extraEnd) {
    const sig = r.ascii(4, 'additional info signature');
    if (sig !== '8BIM' && sig !== '8B64') break;
    const key = r.ascii(4, 'additional info key');
    const size = r.u32('additional info size');
    if (r.pos + size > extraEnd) throw new Error(`Corrupt PSD: additional layer info block '${key}' overruns the layer record`);
    const dataStart = r.pos;
    if (key === 'luni') {
      const count = r.u32('unicode name length');
      const units: number[] = [];
      for (let i = 0; i < count; i++) units.push(r.u16('unicode name character'));
      let unicode = '';
      for (let i = 0; i < units.length; i += 4096) unicode += String.fromCharCode(...units.slice(i, i + 4096));
      unicode = unicode.replace(/\0+$/, '');
      if (unicode) name = unicode;
    } else if (key === 'lsct') {
      sectionType = r.u32('section divider type');
    } else if (key === 'iOpa') {
      const fillOpacity = r.u8('fill opacity');
      if (fillOpacity !== 255) {
        notes.push(`fill opacity (${fillOpacity}/255) is not preserved; this engine has only layer opacity`);
      }
    } else if (ADJUSTMENT_BLOCK_KEYS.has(key)) {
      notes.push(`adjustment layer data ('${key.trim()}') is not preserved`);
    } else if (UNSUPPORTED_BLOCK_NOTES[key]) {
      notes.push(UNSUPPORTED_BLOCK_NOTES[key]);
    }
    r.pos = dataStart + size + (size % 2);
  }
  r.pos = extraEnd;

  return {
    bounds,
    channels,
    blendKey,
    opacity,
    clipping,
    flags,
    name,
    sectionType,
    maskRect,
    maskDefaultColor,
    maskDisabled,
    notes,
    planes: new Map()
  };
}

function decodeMergedImage(r: Reader, width: number, height: number, channels: number, warnings: string[]): PixelImage | null {
  if (r.remaining() < 2) return null;
  const compression = r.u16('merged image compression');
  const planes: Uint8Array[] = [];
  if (compression === 0) {
    for (let c = 0; c < channels; c++) planes.push(new Uint8Array(r.bytes(width * height, 'merged channel data')));
  } else if (compression === 1) {
    const counts: number[] = [];
    for (let i = 0; i < channels * height; i++) counts.push(r.u16('merged RLE row byte count'));
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        const count = counts[c * height + y];
        plane.set(packBitsDecode(r.buf, r.pos, count, width), y * width);
        r.pos += count;
      }
      planes.push(plane);
    }
  } else if (compression === 2 || compression === 3) {
    for (let c = 0; c < channels; c++) {
      // The merged section has no per-channel lengths; ZIP merged data
      // stores each channel's stream back to back and its length is
      // only discoverable by inflating. We cannot delimit the streams
      // reliably here, so this combination is reported, not guessed.
      warnings.push('merged image data uses ZIP compression, which this importer does not decode for the flattened image; layer data (if any) is unaffected');
      return null;
    }
  } else {
    warnings.push(`merged image data uses unsupported compression ${compression}; the flattened image was not imported`);
    return null;
  }
  if (channels > 4) warnings.push(`merged image has ${channels} channels; channels beyond RGBA were ignored`);
  const out = createPixelImage(width, height);
  for (let i = 0; i < width * height; i++) {
    out.data[i * 4] = planes[0]?.[i] ?? 0;
    out.data[i * 4 + 1] = planes[1]?.[i] ?? 0;
    out.data[i * 4 + 2] = planes[2]?.[i] ?? 0;
    out.data[i * 4 + 3] = channels >= 4 ? planes[3][i] : 255;
  }
  return out;
}

function parsePsd(data: Uint8Array): ParsedPsd {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const r = new Reader(buf);
  const warnings: string[] = [];

  if (buf.length < 26) throw new Error('Not a PSD file: file is too short for a PSD header');
  const signature = r.ascii(4, 'signature');
  if (signature !== '8BPS') throw new Error(`Not a PSD file (bad signature: '${signature}')`);
  const version = r.u16('version');
  if (version === 2) throw new Error('Unsupported PSD variant: PSB large-document files (version 2) are not supported — only PSD version 1');
  if (version !== 1) throw new Error(`Unsupported PSD version: ${version} (only version 1 is supported)`);
  r.skip(6, 'reserved bytes');
  const headerChannels = r.u16('channel count');
  const height = r.u32('image height');
  const width = r.u32('image width');
  const depth = r.u16('bit depth');
  if (depth !== 8) throw new Error(`Unsupported PSD bit depth: ${depth} (only 8-bit files are supported)`);
  const colorMode = r.u16('color mode');
  if (colorMode !== 3) {
    throw new Error(`Unsupported PSD color mode: ${COLOR_MODE_NAMES[colorMode] ?? `unknown (${colorMode})`} (only RGB is supported)`);
  }
  if (width < 1 || height < 1 || width > 30000 || height > 30000 || width * height > MAX_CANVAS_PIXELS) {
    throw new Error(`Unsupported PSD dimensions: ${width}x${height}`);
  }

  const colorModeDataLength = r.u32('color mode data length');
  r.skip(colorModeDataLength, 'color mode data');
  const imageResourcesLength = r.u32('image resources length');
  r.skip(imageResourcesLength, 'image resources');

  const layerMaskLength = r.u32('layer and mask information length');
  const layerMaskEnd = r.pos + layerMaskLength;
  if (layerMaskEnd > buf.length) throw new Error('Corrupt PSD: layer and mask section overruns the file');

  const records: PsdRecord[] = [];
  if (layerMaskLength > 0) {
    const layerInfoLength = r.i32('layer info length');
    if (layerInfoLength > 0) {
      const layerInfoEnd = r.pos + layerInfoLength;
      if (layerInfoEnd > layerMaskEnd) throw new Error('Corrupt PSD: layer info section overruns the layer and mask section');
      const count = Math.abs(r.i16('layer count'));
      for (let i = 0; i < count; i++) records.push(parseLayerRecord(r));
      // Channel image data follows all records, in record order.
      for (const rec of records) {
        const bw = rectWidth(rec.bounds);
        const bh = rectHeight(rec.bounds);
        for (const ch of rec.channels) {
          const isMask = ch.id === -2 || ch.id === -3;
          const dims = isMask && rec.maskRect ? rec.maskRect : rec.bounds;
          const w = rectWidth(dims);
          const h = rectHeight(dims);
          if (ch.length < 2) throw new Error(`Corrupt PSD: channel ${ch.id} of layer "${rec.name}" has invalid data length ${ch.length}`);
          if (w === 0 || h === 0) {
            r.skip(ch.length, 'empty channel data');
            rec.planes.set(ch.id, new Uint8Array(0));
          } else {
            rec.planes.set(ch.id, decodeChannel(r, ch.length, w, h));
          }
        }
      }
      r.pos = layerInfoEnd;
    }
  }
  r.pos = layerMaskEnd;

  const needsMerged = records.length === 0;
  let merged: PixelImage | null = null;
  if (needsMerged) {
    merged = decodeMergedImage(r, width, height, headerChannels, warnings);
  }

  return { width, height, headerChannels, records, merged, warnings };
}

// ------------------------------------------------------------------ import

function layerFromRecord(rec: PsdRecord, canvasWidth: number, canvasHeight: number, groupId: string | null, warnings: string[]): Layer {
  const image = createPixelImage(canvasWidth, canvasHeight);
  const bw = rectWidth(rec.bounds);
  const bh = rectHeight(rec.bounds);
  const rPlane = rec.planes.get(0);
  const gPlane = rec.planes.get(1);
  const bPlane = rec.planes.get(2);
  const aPlane = rec.planes.get(-1);
  if (bw > 0 && bh > 0 && !rPlane && !gPlane && !bPlane) {
    warnings.push(`layer "${rec.name}" has no pixel channels (adjustment or fill layer?) and was imported as an empty layer`);
  }
  const offCanvas =
    rec.bounds.left < 0 || rec.bounds.top < 0 || rec.bounds.right > canvasWidth || rec.bounds.bottom > canvasHeight;
  if (offCanvas && bw > 0 && bh > 0) {
    warnings.push(`layer "${rec.name}" extends beyond the canvas; pixels outside the canvas were dropped`);
  }
  for (let y = 0; y < bh; y++) {
    const cy = rec.bounds.top + y;
    if (cy < 0 || cy >= canvasHeight) continue;
    for (let x = 0; x < bw; x++) {
      const cx = rec.bounds.left + x;
      if (cx < 0 || cx >= canvasWidth) continue;
      const si = y * bw + x;
      const di = (cy * canvasWidth + cx) * 4;
      image.data[di] = rPlane ? rPlane[si] : 0;
      image.data[di + 1] = gPlane ? gPlane[si] : 0;
      image.data[di + 2] = bPlane ? bPlane[si] : 0;
      image.data[di + 3] = aPlane ? aPlane[si] : 255;
    }
  }
  for (const id of rec.planes.keys()) {
    if (id !== 0 && id !== 1 && id !== 2 && id !== -1 && id !== -2 && id !== -3) {
      warnings.push(`layer "${rec.name}": channel ${id} (spot/extra channel) was skipped`);
    }
  }

  let mask: LayerMask | null = null;
  const maskPlane = rec.planes.get(-2) ?? rec.planes.get(-3);
  if (maskPlane && rec.maskRect) {
    const mw = rectWidth(rec.maskRect);
    const mh = rectHeight(rec.maskRect);
    if (mw > 0 && mh > 0 && maskPlane.length === mw * mh) {
      const data = new Uint8ClampedArray(canvasWidth * canvasHeight).fill(rec.maskDefaultColor);
      for (let y = 0; y < mh; y++) {
        const cy = rec.maskRect.top + y;
        if (cy < 0 || cy >= canvasHeight) continue;
        for (let x = 0; x < mw; x++) {
          const cx = rec.maskRect.left + x;
          if (cx < 0 || cx >= canvasWidth) continue;
          data[cy * canvasWidth + cx] = maskPlane[y * mw + x];
        }
      }
      mask = { width: canvasWidth, height: canvasHeight, data };
      if (rec.maskDisabled) {
        warnings.push(`layer "${rec.name}": the layer mask was disabled in the source file; it was imported as enabled (this engine has no disabled-mask state)`);
      }
    }
  } else if (rec.planes.has(-2) || rec.planes.has(-3)) {
    warnings.push(`layer "${rec.name}": layer mask channel data is present but has no mask rectangle; the mask was not imported`);
  }

  let blendMode = PSD_BLEND_TO_ENGINE[rec.blendKey];
  if (blendMode === undefined) {
    warnings.push(`layer "${rec.name}": blend mode key '${rec.blendKey.trim()}' is not supported by this engine; imported as 'normal'`);
    blendMode = 'normal';
  }
  for (const note of rec.notes) warnings.push(`layer "${rec.name}": ${note}`);

  return {
    id: crypto.randomUUID(),
    name: rec.name,
    visible: (rec.flags & 0x02) === 0,
    opacity: rec.opacity / 255,
    image,
    kind: 'raster',
    text: null,
    shape: null,
    contentTransform: null,
    effects: [],
    placement: null,
    blendMode,
    mask,
    alphaLock: (rec.flags & 0x01) !== 0,
    clipped: rec.clipping === 1,
    groupId
  };
}

/**
 * Import a PSD file (version 1, RGB, 8-bit) into an engine project.
 * Anything the importer cannot preserve is listed in `warnings` —
 * nothing is dropped silently. Unsupported color modes, bit depths
 * and PSB files throw instead of producing a mangled project.
 */
export function importPsd(data: Uint8Array): PsdImportResult {
  const parsed = parsePsd(data);
  const warnings = [...parsed.warnings];
  const { width, height } = parsed;

  if (parsed.records.length === 0) {
    if (!parsed.merged) {
      throw new Error('PSD contains no layer records and no readable merged image data');
    }
    const layer: Layer = {
      id: crypto.randomUUID(),
      name: 'Background',
      visible: true,
      opacity: 1,
      image: parsed.merged,
      kind: 'raster',
      text: null,
      shape: null,
      contentTransform: null,
      effects: [],
      placement: null,
      blendMode: 'normal',
      mask: null,
      alphaLock: false,
      clipped: false,
      groupId: null
    };
    return { project: { width, height, layers: [layer], groups: [], activeLayerId: layer.id, guides: [], grid: { ...DEFAULT_GRID_SETTINGS } }, warnings };
  }

  // Records are stored top-to-bottom; walk them bottom-to-top so the
  // engine's stack order (index 0 = bottom) falls out directly. In
  // this direction a folder record opens its group and the bounding
  // divider record ('lsct' type 3) closes the innermost open group.
  const layers: Layer[] = [];
  const groups: LayerGroup[] = [];
  const openGroups: LayerGroup[] = [];
  const bottomToTop = [...parsed.records].reverse();
  for (const rec of bottomToTop) {
    if (rec.sectionType === 1 || rec.sectionType === 2) {
      let blendMode = PSD_BLEND_TO_ENGINE[rec.blendKey];
      if (rec.blendKey === 'pass') {
        warnings.push(`group "${rec.name}": pass-through groups are not supported; the group composites as an isolated buffer with 'normal' blending`);
        blendMode = 'normal';
      } else if (blendMode === undefined) {
        warnings.push(`group "${rec.name}": blend mode key '${rec.blendKey.trim()}' is not supported by this engine; imported as 'normal'`);
        blendMode = 'normal';
      }
      for (const note of rec.notes) warnings.push(`group "${rec.name}": ${note}`);
      const group: LayerGroup = {
        id: crypto.randomUUID(),
        name: rec.name,
        parentId: openGroups.length ? openGroups[openGroups.length - 1].id : null,
        visible: (rec.flags & 0x02) === 0,
        opacity: rec.opacity / 255,
        blendMode
      };
      groups.push(group);
      openGroups.push(group);
    } else if (rec.sectionType === 3) {
      if (openGroups.length) {
        openGroups.pop();
      } else {
        warnings.push('found a layer-group end divider with no matching folder record; it was ignored');
      }
    } else {
      const groupId = openGroups.length ? openGroups[openGroups.length - 1].id : null;
      layers.push(layerFromRecord(rec, width, height, groupId, warnings));
    }
  }
  if (openGroups.length) {
    warnings.push(`${openGroups.length} layer group(s) had no closing divider in the file; their contents were imported anyway`);
  }
  if (layers.length === 0) {
    throw new Error('PSD contains layer records but no readable pixel layers');
  }

  const project: ImageProject = {
    width,
    height,
    layers,
    groups,
    activeLayerId: layers[layers.length - 1].id,
    guides: [],
    grid: { ...DEFAULT_GRID_SETTINGS }
  };
  return { project, warnings };
}

// ------------------------------------------------------------------ export

interface OutChannel {
  id: number;
  encoded: Buffer; // compression word + payload, exactly what follows the records
}

interface OutRecord {
  name: string;
  bounds: PsdRect;
  channels: OutChannel[];
  blendKey: string;
  opacityByte: number;
  clipping: number;
  flags: number;
  maskRect: PsdRect | null;
  sectionType: number | null;
}

type StackNode =
  | { type: 'layer'; layer: Layer }
  | { type: 'group'; group: LayerGroup; children: StackNode[] };

/** Ids of a group plus all its descendant groups. */
function groupSubtreeIds(project: ImageProject, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of project.groups) {
      if (g.parentId !== null && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id);
        grew = true;
      }
    }
  }
  return ids;
}

/**
 * The bottom-to-top node list of one stack level: sibling layers in
 * stack order, with each group placed at the position of its lowest
 * member (the engine's compositing rule).
 */
function levelNodes(project: ImageProject, parentId: string | null): StackNode[] {
  const nodes: StackNode[] = [];
  const emitted = new Set<string>();
  const childGroups = project.groups.filter((g) => g.parentId === parentId);
  const emitGroup = (g: LayerGroup): void => {
    nodes.push({ type: 'group', group: g, children: levelNodes(project, g.id) });
    emitted.add(g.id);
  };
  for (const layer of project.layers) {
    if ((layer.groupId ?? null) === parentId) nodes.push({ type: 'layer', layer });
    for (const g of childGroups) {
      if (emitted.has(g.id)) continue;
      const subtree = groupSubtreeIds(project, g.id);
      if (layer.groupId !== null && subtree.has(layer.groupId)) emitGroup(g);
    }
  }
  // Groups with no members at all have no stack position; they go on top of their level.
  for (const g of childGroups) if (!emitted.has(g.id)) emitGroup(g);
  return nodes;
}

/** The bounding box of everything a layer stores: nonzero pixels and non-revealing mask pixels. */
function layerDataBounds(layer: Layer): PsdRect {
  const { width, height, data } = layer.image;
  let top = height;
  let left = width;
  let bottom = -1;
  let right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const carries = data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0 || data[i + 3] !== 0;
      const maskCarries = layer.mask ? layer.mask.data[y * width + x] !== 255 : false;
      if (carries || maskCarries) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (bottom < 0) return { top: 0, left: 0, bottom: 0, right: 0 };
  return { top, left, bottom: bottom + 1, right: right + 1 };
}

function cropPlane(layer: Layer, channel: number, bounds: PsdRect): Uint8Array {
  const w = rectWidth(bounds);
  const h = rectHeight(bounds);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = layer.image.data[((bounds.top + y) * layer.image.width + bounds.left + x) * 4 + channel];
    }
  }
  return out;
}

function cropMask(layer: Layer, bounds: PsdRect): Uint8Array {
  const w = rectWidth(bounds);
  const h = rectHeight(bounds);
  const out = new Uint8Array(w * h);
  const mask = layer.mask!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = mask.data[(bounds.top + y) * mask.width + bounds.left + x];
    }
  }
  return out;
}

function encodeChannelRle(plane: Uint8Array, width: number, height: number): Buffer {
  if (width === 0 || height === 0) return Buffer.from([0, 0]); // compression word only (RAW, no data)
  return Buffer.concat([Buffer.from([0, 1]), encodePlaneRle(plane, width, height)]);
}

function layerToOutRecord(layer: Layer): OutRecord {
  const bounds = layerDataBounds(layer);
  const w = rectWidth(bounds);
  const h = rectHeight(bounds);
  const channels: OutChannel[] = [];
  const channelIds = [0, 1, 2, -1];
  for (let c = 0; c < 4; c++) {
    channels.push({ id: channelIds[c], encoded: encodeChannelRle(cropPlane(layer, c, bounds), w, h) });
  }
  let maskRect: PsdRect | null = null;
  if (layer.mask) {
    maskRect = bounds;
    channels.push({ id: -2, encoded: encodeChannelRle(cropMask(layer, bounds), w, h) });
  }
  const flags = (layer.alphaLock ? 0x01 : 0) | (layer.visible ? 0 : 0x02);
  return {
    name: layer.name,
    bounds,
    channels,
    blendKey: ENGINE_BLEND_TO_PSD[layer.blendMode],
    opacityByte: Math.round(Math.min(1, Math.max(0, layer.opacity)) * 255),
    clipping: layer.clipped ? 1 : 0,
    flags,
    maskRect,
    sectionType: null
  };
}

function structuralRecord(name: string, sectionType: number, blendKey: string, opacity: number, visible: boolean): OutRecord {
  return {
    name,
    bounds: { top: 0, left: 0, bottom: 0, right: 0 },
    channels: [],
    blendKey,
    opacityByte: Math.round(Math.min(1, Math.max(0, opacity)) * 255),
    clipping: 0,
    flags: visible ? 0 : 0x02,
    maskRect: null,
    sectionType
  };
}

/** Flatten the stack into file order (top-to-bottom): divider, children…, folder for each group. */
function emitRecords(nodes: StackNode[], out: OutRecord[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.type === 'layer') {
      out.push(layerToOutRecord(node.layer));
    } else {
      out.push(structuralRecord('</Layer group>', 3, 'norm', 1, true));
      emitRecords(node.children, out);
      out.push(
        structuralRecord(node.group.name, 1, ENGINE_BLEND_TO_PSD[node.group.blendMode], node.group.opacity, node.group.visible)
      );
    }
  }
}

// ------------------------------------------------------------- writer pieces

class Writer {
  private parts: Buffer[] = [];
  u8(v: number): void {
    this.parts.push(Buffer.from([v & 0xff]));
  }
  u16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xffff, 0);
    this.parts.push(b);
  }
  i16(v: number): void {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    this.parts.push(b);
  }
  u32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0, 0);
    this.parts.push(b);
  }
  i32(v: number): void {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    this.parts.push(b);
  }
  raw(b: Buffer): void {
    this.parts.push(b);
  }
  ascii(s: string): void {
    this.parts.push(Buffer.from(s, 'latin1'));
  }
  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function pascalNameField(name: string): Buffer {
  const bytes = Buffer.from(name.slice(0, 255), 'latin1');
  const fieldLength = Math.ceil((1 + bytes.length) / 4) * 4;
  const out = Buffer.alloc(fieldLength);
  out[0] = bytes.length;
  bytes.copy(out, 1);
  return out;
}

function taggedBlock(key: string, data: Buffer): Buffer {
  const w = new Writer();
  w.ascii('8BIM');
  w.ascii(key);
  w.u32(data.length);
  w.raw(data);
  if (data.length % 2) w.u8(0);
  return w.build();
}

function unicodeNameBlock(name: string): Buffer {
  const data = Buffer.alloc(4 + name.length * 2);
  data.writeUInt32BE(name.length, 0);
  for (let i = 0; i < name.length; i++) data.writeUInt16BE(name.charCodeAt(i), 4 + i * 2);
  return taggedBlock('luni', data);
}

function sectionDividerBlock(type: number): Buffer {
  const data = Buffer.alloc(12);
  data.writeUInt32BE(type, 0);
  data.write('8BIM', 4, 'latin1');
  data.write('lsdk', 8, 'latin1');
  return taggedBlock('lsct', data);
}

function serializeRecord(rec: OutRecord): Buffer {
  const w = new Writer();
  w.i32(rec.bounds.top);
  w.i32(rec.bounds.left);
  w.i32(rec.bounds.bottom);
  w.i32(rec.bounds.right);
  w.u16(rec.channels.length);
  for (const ch of rec.channels) {
    w.i16(ch.id);
    w.u32(ch.encoded.length);
  }
  w.ascii('8BIM');
  w.ascii(rec.blendKey.padEnd(4, ' ').slice(0, 4));
  w.u8(rec.opacityByte);
  w.u8(rec.clipping);
  w.u8(rec.flags);
  w.u8(0); // filler

  // Extra data: mask data, blending ranges, Pascal name, tagged blocks.
  const extra = new Writer();
  if (rec.maskRect) {
    extra.u32(20);
    extra.i32(rec.maskRect.top);
    extra.i32(rec.maskRect.left);
    extra.i32(rec.maskRect.bottom);
    extra.i32(rec.maskRect.right);
    extra.u8(255); // default color outside the mask rectangle (exact: bounds cover every non-255 mask pixel)
    extra.u8(0); // mask flags
    extra.u16(0); // padding
  } else {
    extra.u32(0);
  }
  const colorChannels = rec.channels.filter((c) => c.id !== -2 && c.id !== -3).length;
  const ranges = new Writer();
  const rangeCount = 1 + colorChannels; // composite gray + one per color channel
  for (let i = 0; i < rangeCount * 2; i++) {
    ranges.u16(0);
    ranges.u16(0xffff);
  }
  const rangesBuf = ranges.build();
  extra.u32(rangesBuf.length);
  extra.raw(rangesBuf);
  extra.raw(pascalNameField(rec.name));
  extra.raw(unicodeNameBlock(rec.name));
  if (rec.sectionType !== null) extra.raw(sectionDividerBlock(rec.sectionType));
  const extraBuf = extra.build();
  w.u32(extraBuf.length);
  w.raw(extraBuf);
  return w.build();
}

/**
 * Export a project as a structurally valid PSD (version 1, RGB,
 * 8-bit) with RLE-compressed layer channels and an RLE merged
 * composite. See the module header for exactly what is preserved and
 * what is documented loss (content layers export as rendered pixels).
 */
export function exportPsd(project: ImageProject): Buffer {
  const records: OutRecord[] = [];
  emitRecords(levelNodes(project, null), records);

  const recordBufs = records.map(serializeRecord);
  const channelDataBufs: Buffer[] = [];
  for (const rec of records) for (const ch of rec.channels) channelDataBufs.push(ch.encoded);

  const layerInfoBody = new Writer();
  layerInfoBody.i16(records.length);
  for (const b of recordBufs) layerInfoBody.raw(b);
  for (const b of channelDataBufs) layerInfoBody.raw(b);
  let layerInfo = layerInfoBody.build();
  if (layerInfo.length % 2) layerInfo = Buffer.concat([layerInfo, Buffer.from([0])]);

  const layerMaskSection = new Writer();
  layerMaskSection.u32(layerInfo.length);
  layerMaskSection.raw(layerInfo);
  layerMaskSection.u32(0); // global layer mask info: empty
  const layerMaskBuf = layerMaskSection.build();

  // Merged composite: the engine's own flatten, RGBA, RLE.
  const flat = composite(project);
  const merged = new Writer();
  merged.u16(1);
  const planes: Uint8Array[] = [];
  for (let c = 0; c < 4; c++) {
    const plane = new Uint8Array(project.width * project.height);
    for (let i = 0; i < plane.length; i++) plane[i] = flat.data[i * 4 + c];
    planes.push(plane);
  }
  const encodedPlanes = planes.map((p) => encodePlaneRle(p, project.width, project.height));
  // Row byte counts for all channels come first in the merged section.
  const counts = new Writer();
  for (const enc of encodedPlanes) {
    // encodePlaneRle output starts with the per-row counts; copy them.
    counts.raw(enc.subarray(0, project.height * 2));
  }
  merged.raw(counts.build());
  for (const enc of encodedPlanes) merged.raw(enc.subarray(project.height * 2));
  const mergedBuf = merged.build();

  const out = new Writer();
  out.ascii('8BPS');
  out.u16(1);
  out.raw(Buffer.alloc(6));
  out.u16(4); // merged channels: R, G, B, A
  out.u32(project.height);
  out.u32(project.width);
  out.u16(8);
  out.u16(3);
  out.u32(0); // color mode data: empty
  out.u32(0); // image resources: empty
  out.u32(layerMaskBuf.length);
  out.raw(layerMaskBuf);
  out.raw(mergedBuf);
  return out.build();
}
