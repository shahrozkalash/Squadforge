import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as zlib from 'zlib';
import {
  createProject,
  addLayer,
  addTextLayer,
  getPixel,
  setPixel,
  composite,
  setLayerVisibility,
  setLayerOpacity,
  setLayerBlendMode,
  setLayerAlphaLock,
  setLayerClipped,
  createLayerMask,
  createGroup,
  setGroupOpacity,
  setGroupBlendMode,
  setLayerGroup
} from '../server/imageEditor/imageCore.js';
import { importPsd, exportPsd } from '../server/imageEditor/psd.js';

/**
 * Phase 49 tests. The import fixtures are assembled byte-by-byte from
 * the PSD specification with helpers local to this file — they are NOT
 * produced by the engine's own writer, so the parser is tested against
 * the format itself. The writer is verified by a structural walk that
 * re-derives every section offset from the spec, plus a writer→reader
 * round-trip.
 */

// ---------------------------------------------------------- byte helpers

const bU8 = (n: number): Buffer => Buffer.from([n & 0xff]);
const bU16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};
const bI16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
};
const bU32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const bI32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
};
const bAscii = (s: string): Buffer => Buffer.from(s, 'latin1');
const cat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

function fixtureBlock(key: string, data: Buffer): Buffer {
  const parts = [bAscii('8BIM'), bAscii(key), bU32(data.length), data];
  if (data.length % 2) parts.push(Buffer.from([0]));
  return cat(...parts);
}

function fixtureLsct(type: number): Buffer {
  return fixtureBlock('lsct', cat(bU32(type), bAscii('8BIM'), bAscii('lsdk')));
}

function fixtureLuni(name: string): Buffer {
  const data = Buffer.alloc(4 + name.length * 2);
  data.writeUInt32BE(name.length, 0);
  for (let i = 0; i < name.length; i++) data.writeUInt16BE(name.charCodeAt(i), 4 + i * 2);
  return fixtureBlock('luni', data);
}

function pascalField(name: string): Buffer {
  const bytes = Buffer.from(name.slice(0, 255), 'latin1');
  const fieldLength = Math.ceil((1 + bytes.length) / 4) * 4;
  const out = Buffer.alloc(fieldLength);
  out[0] = bytes.length;
  bytes.copy(out, 1);
  return out;
}

interface FixtureChannel {
  id: number;
  /** Channel data including the 2-byte compression word. */
  data: Buffer;
}

interface FixtureRecordOpts {
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: FixtureChannel[];
  blendKey?: string;
  opacity?: number;
  clipping?: number;
  flags?: number;
  blocks?: Buffer[];
}

function fixtureRecord(o: FixtureRecordOpts): { record: Buffer; channelData: Buffer } {
  const parts: Buffer[] = [bI32(o.top), bI32(o.left), bI32(o.bottom), bI32(o.right), bU16(o.channels.length)];
  for (const ch of o.channels) parts.push(bI16(ch.id), bU32(ch.data.length));
  parts.push(bAscii('8BIM'), bAscii((o.blendKey ?? 'norm').padEnd(4, ' ')));
  parts.push(bU8(o.opacity ?? 255), bU8(o.clipping ?? 0), bU8(o.flags ?? 0), bU8(0));
  const colorChannels = o.channels.filter((c) => c.id !== -2 && c.id !== -3).length;
  const ranges = Buffer.alloc(8 + 8 * colorChannels);
  for (let i = 0; i < ranges.length; i += 4) {
    ranges[i] = 0;
    ranges[i + 1] = 0;
    ranges[i + 2] = 255;
    ranges[i + 3] = 255;
  }
  const extra = cat(bU32(0), bU32(ranges.length), ranges, pascalField(o.name), ...(o.blocks ?? []));
  parts.push(bU32(extra.length), extra);
  return {
    record: cat(...parts),
    channelData: cat(...o.channels.map((c) => c.data))
  };
}

function fixtureFile(
  width: number,
  height: number,
  recs: { record: Buffer; channelData: Buffer }[],
  merged: Buffer,
  headerChannels = 3
): Buffer {
  let layerInfo = cat(bI16(recs.length), ...recs.map((r) => r.record), ...recs.map((r) => r.channelData));
  if (layerInfo.length % 2) layerInfo = cat(layerInfo, Buffer.from([0]));
  const layerMaskSection = cat(bU32(layerInfo.length), layerInfo, bU32(0));
  const header = cat(
    bAscii('8BPS'),
    bU16(1),
    Buffer.alloc(6),
    bU16(headerChannels),
    bU32(height),
    bU32(width),
    bU16(8),
    bU16(3)
  );
  return cat(header, bU32(0), bU32(0), bU32(layerMaskSection.length), layerMaskSection, merged);
}

const rawChannel = (plane: number[]): Buffer => cat(bU16(0), Buffer.from(plane));

/** RLE channel data from pre-encoded PackBits rows (hand-encoded in the tests). */
const rleChannel = (rows: number[][]): Buffer =>
  cat(bU16(1), ...rows.map((r) => bU16(r.length)), ...rows.map((r) => Buffer.from(r)));

const rawMerged = (planes: number[][]): Buffer => cat(bU16(0), ...planes.map((p) => Buffer.from(p)));
const zeros = (n: number): number[] => new Array(n).fill(0);

// ---------------------------------------------------------- import fixtures

describe('Phase 49: PSD import from hand-built spec fixtures', () => {
  test('parses layer records: bounds offsets, unicode name, opacity, visibility, blend key, RLE and RAW channels', () => {
    // Top layer: 2x2 at (left=1, top=0), RLE channels, hidden, opacity 200, multiply.
    // Pixels (bounds-local): row0 (255,0,0,255) (0,255,0,128); row1 (0,0,255,255) (10,20,30,40).
    const top = fixtureRecord({
      name: 'Top',
      top: 0,
      left: 1,
      bottom: 2,
      right: 3,
      blendKey: 'mul ',
      opacity: 200,
      flags: 2, // hidden
      blocks: [fixtureLuni('Top ★'), fixtureBlock('lfx2', Buffer.from([0, 0, 0, 0]))],
      channels: [
        { id: 0, data: rleChannel([[1, 255, 0], [1, 0, 10]]) },
        { id: 1, data: rleChannel([[1, 0, 255], [1, 0, 20]]) },
        // B row 0 is a PackBits repeat packet: header 255 = repeat the next byte 2 times.
        { id: 2, data: rleChannel([[255, 0], [1, 255, 30]]) },
        { id: -1, data: rleChannel([[1, 255, 128], [1, 255, 40]]) }
      ]
    });
    // Adjustment layer: no channels, carries a 'levl' block.
    const levels = fixtureRecord({
      name: 'Levels 1',
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      channels: [],
      blocks: [fixtureBlock('levl', Buffer.alloc(8))]
    });
    // Bottom layer: full 4x3 canvas, RAW RGB (no alpha channel -> opaque in bounds).
    const bottom = fixtureRecord({
      name: 'Bottom',
      top: 0,
      left: 0,
      bottom: 3,
      right: 4,
      channels: [
        { id: 0, data: rawChannel([1, ...new Array(11).fill(50)]) },
        { id: 1, data: rawChannel([2, ...new Array(11).fill(60)]) },
        { id: 2, data: rawChannel([3, ...new Array(11).fill(70)]) }
      ]
    });
    const file = fixtureFile(4, 3, [top, levels, bottom], rawMerged([zeros(12), zeros(12), zeros(12)]));
    const { project, warnings } = importPsd(file);

    assert.strictEqual(project.width, 4);
    assert.strictEqual(project.height, 3);
    assert.deepStrictEqual(
      project.layers.map((l) => l.name),
      ['Bottom', 'Levels 1', 'Top ★']
    );

    const bottomLayer = project.layers[0];
    assert.deepStrictEqual(getPixel(bottomLayer.image, 0, 0), { r: 1, g: 2, b: 3, a: 255 });
    assert.deepStrictEqual(getPixel(bottomLayer.image, 3, 2), { r: 50, g: 60, b: 70, a: 255 });
    assert.strictEqual(bottomLayer.visible, true);
    assert.strictEqual(bottomLayer.opacity, 1);
    assert.strictEqual(bottomLayer.blendMode, 'normal');

    const levelsLayer = project.layers[1];
    assert.deepStrictEqual(getPixel(levelsLayer.image, 0, 0), { r: 0, g: 0, b: 0, a: 0 });
    assert.ok(
      warnings.some((w) => w.includes('Levels 1') && w.includes('levl')),
      `expected an adjustment-data warning for Levels 1, got: ${JSON.stringify(warnings)}`
    );

    const topLayer = project.layers[2];
    assert.strictEqual(topLayer.visible, false);
    assert.strictEqual(topLayer.opacity, 200 / 255);
    assert.strictEqual(topLayer.blendMode, 'multiply');
    // Bounds offset: the 2x2 layer sits at canvas x=1..2, y=0..1.
    assert.deepStrictEqual(getPixel(topLayer.image, 1, 0), { r: 255, g: 0, b: 0, a: 255 });
    assert.deepStrictEqual(getPixel(topLayer.image, 2, 0), { r: 0, g: 255, b: 0, a: 128 });
    assert.deepStrictEqual(getPixel(topLayer.image, 1, 1), { r: 0, g: 0, b: 255, a: 255 });
    assert.deepStrictEqual(getPixel(topLayer.image, 2, 1), { r: 10, g: 20, b: 30, a: 40 });
    assert.deepStrictEqual(getPixel(topLayer.image, 0, 0), { r: 0, g: 0, b: 0, a: 0 });
    assert.deepStrictEqual(getPixel(topLayer.image, 3, 0), { r: 0, g: 0, b: 0, a: 0 });
    assert.ok(
      warnings.some((w) => w.includes('Top ★') && w.includes('lfx2')),
      `expected a layer-effects warning for Top, got: ${JSON.stringify(warnings)}`
    );
  });

  test('parses layer groups from section divider records', () => {
    const divider = fixtureRecord({
      name: '</Layer group>',
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      channels: [],
      blocks: [fixtureLsct(3)]
    });
    const kid = fixtureRecord({
      name: 'Kid',
      top: 0,
      left: 0,
      bottom: 2,
      right: 2,
      channels: [
        { id: 0, data: rawChannel([9, 9, 9, 9]) },
        { id: 1, data: rawChannel([8, 8, 8, 8]) },
        { id: 2, data: rawChannel([7, 7, 7, 7]) }
      ]
    });
    const folder = fixtureRecord({
      name: 'Group A',
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
      channels: [],
      opacity: 128,
      blocks: [fixtureLsct(1)]
    });
    const file = fixtureFile(2, 2, [divider, kid, folder], rawMerged([zeros(4), zeros(4), zeros(4)]));
    const { project, warnings } = importPsd(file);

    assert.strictEqual(project.groups.length, 1);
    assert.strictEqual(project.groups[0].name, 'Group A');
    assert.strictEqual(project.groups[0].opacity, 128 / 255);
    assert.strictEqual(project.groups[0].parentId, null);
    assert.strictEqual(project.layers.length, 1);
    assert.strictEqual(project.layers[0].name, 'Kid');
    assert.strictEqual(project.layers[0].groupId, project.groups[0].id);
    assert.deepStrictEqual(getPixel(project.layers[0].image, 0, 0), { r: 9, g: 8, b: 7, a: 255 });
    assert.deepStrictEqual(warnings, []);
  });

  test('imports a flattened PSD (no layer records) from its RLE merged image data', () => {
    // 3x2, 3 channels. Counts are stored channel-major, then the rows.
    const counts = [2, 4, 2, 2, 4, 4].map(bU16);
    const data = Buffer.from([
      254, 5, 2, 6, 7, 8, // R: row0 = run of three 5s; row1 = literals 6,7,8
      254, 100, 254, 100, // G: two rows, each a run of three 100s
      2, 1, 2, 3, 2, 4, 5, 6 // B: two literal rows
    ]);
    const merged = cat(bU16(1), ...counts, data);
    const header = cat(bAscii('8BPS'), bU16(1), Buffer.alloc(6), bU16(3), bU32(2), bU32(3), bU16(8), bU16(3));
    const file = cat(header, bU32(0), bU32(0), bU32(0), merged);
    const { project, warnings } = importPsd(file);

    assert.strictEqual(project.layers.length, 1);
    assert.strictEqual(project.layers[0].name, 'Background');
    const img = project.layers[0].image;
    assert.deepStrictEqual(getPixel(img, 0, 0), { r: 5, g: 100, b: 1, a: 255 });
    assert.deepStrictEqual(getPixel(img, 2, 0), { r: 5, g: 100, b: 3, a: 255 });
    assert.deepStrictEqual(getPixel(img, 0, 1), { r: 6, g: 100, b: 4, a: 255 });
    assert.deepStrictEqual(getPixel(img, 2, 1), { r: 8, g: 100, b: 6, a: 255 });
    assert.deepStrictEqual(warnings, []);
  });

  test('decodes ZIP (2) and ZIP-with-prediction (3) channel compression', () => {
    const zip = fixtureRecord({
      name: 'Zip',
      top: 0,
      left: 0,
      bottom: 1,
      right: 3,
      channels: [
        { id: 0, data: cat(bU16(2), zlib.deflateSync(Buffer.from([200, 100, 50]))) },
        // Stored as per-row deltas of the real plane [10, 30, 60].
        { id: 1, data: cat(bU16(3), zlib.deflateSync(Buffer.from([10, 20, 30]))) },
        { id: 2, data: rawChannel([1, 2, 3]) }
      ]
    });
    const file = fixtureFile(3, 1, [zip], rawMerged([zeros(3), zeros(3), zeros(3)]));
    const { project } = importPsd(file);
    const img = project.layers[0].image;
    assert.deepStrictEqual(getPixel(img, 0, 0), { r: 200, g: 10, b: 1, a: 255 });
    assert.deepStrictEqual(getPixel(img, 1, 0), { r: 100, g: 30, b: 2, a: 255 });
    assert.deepStrictEqual(getPixel(img, 2, 0), { r: 50, g: 60, b: 3, a: 255 });
  });

  test('rejects non-PSD data, PSB files, 16-bit depth and non-RGB color modes with named errors', () => {
    const headerWith = (version: number, depth: number, colorMode: number): Buffer =>
      cat(bAscii('8BPS'), bU16(version), Buffer.alloc(6), bU16(3), bU32(1), bU32(1), bU16(depth), bU16(colorMode), bU32(0), bU32(0), bU32(0), bU16(0));
    assert.throws(() => importPsd(Buffer.from('NOPE' + 'x'.repeat(40))), /Not a PSD file/);
    assert.throws(() => importPsd(headerWith(2, 8, 3)), /PSB/);
    assert.throws(() => importPsd(headerWith(1, 16, 3)), /bit depth: 16/);
    assert.throws(() => importPsd(headerWith(1, 8, 4)), /CMYK/);
    assert.throws(() => importPsd(headerWith(1, 8, 1)), /Grayscale/);
  });
});

// ---------------------------------------------------------- round-trip

function buildRoundTripProject() {
  const project = createProject(6, 5);
  const base = project.layers[0];
  base.name = 'Base';
  for (let i = 0; i < base.image.data.length; i += 4) {
    base.image.data[i] = 200;
    base.image.data[i + 1] = 100;
    base.image.data[i + 2] = 50;
    base.image.data[i + 3] = 255;
  }
  const mul = addLayer(project, 'Multiply');
  setLayerBlendMode(project, mul.id, 'multiply');
  setLayerOpacity(project, mul.id, 0.6);
  setLayerAlphaLock(project, mul.id, true);
  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 4; x++) setPixel(mul.image, x, y, { r: 100, g: 150, b: 200, a: 255 });
  }
  // A fully transparent pixel that still carries RGB: the export
  // bounds rule must include it, so it survives the round-trip.
  setPixel(mul.image, 5, 4, { r: 10, g: 20, b: 30, a: 0 });

  const hidden = addLayer(project, 'ScreenHidden');
  setLayerBlendMode(project, hidden.id, 'screen');
  setLayerOpacity(project, hidden.id, 0.2);
  setLayerVisibility(project, hidden.id, false);
  setPixel(hidden.image, 0, 0, { r: 255, g: 255, b: 255, a: 200 });

  const masked = addLayer(project, 'Masked');
  for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]] as const) {
    setPixel(masked.image, x, y, { r: 255, g: 0, b: 0, a: 255 });
  }
  const mask = createLayerMask(project, masked.id, 255);
  mask.data[0 * 6 + 2] = 0;
  mask.data[0 * 6 + 3] = 128;
  setLayerClipped(project, masked.id, true);

  const group = createGroup(project, 'Folder');
  setGroupOpacity(project, group.id, 0.8);
  setGroupBlendMode(project, group.id, 'screen');
  setLayerGroup(project, hidden.id, group.id);
  return project;
}

describe('Phase 49: PSD export and round-trip', () => {
  test('writer->reader round-trip preserves names, order, visibility, opacity, blend modes, flags, masks and pixels exactly', () => {
    const project = buildRoundTripProject();
    const { project: back, warnings } = importPsd(exportPsd(project));

    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(back.width, 6);
    assert.strictEqual(back.height, 5);
    assert.deepStrictEqual(
      back.layers.map((l) => l.name),
      ['Base', 'Multiply', 'ScreenHidden', 'Masked']
    );
    for (let i = 0; i < project.layers.length; i++) {
      const orig = project.layers[i];
      const got = back.layers[i];
      assert.strictEqual(got.visible, orig.visible, `${orig.name} visibility`);
      assert.strictEqual(got.opacity, orig.opacity, `${orig.name} opacity`);
      assert.strictEqual(got.blendMode, orig.blendMode, `${orig.name} blend mode`);
      assert.strictEqual(got.clipped, orig.clipped, `${orig.name} clipped`);
      assert.strictEqual(got.alphaLock, orig.alphaLock, `${orig.name} alpha lock`);
      assert.deepStrictEqual(got.image.data, orig.image.data, `${orig.name} pixels`);
      if (orig.mask) {
        assert.ok(got.mask, `${orig.name} mask present`);
        assert.deepStrictEqual(got.mask!.data, orig.mask.data, `${orig.name} mask pixels`);
      } else {
        assert.strictEqual(got.mask, null, `${orig.name} has no mask`);
      }
    }
    assert.strictEqual(back.groups.length, 1);
    assert.strictEqual(back.groups[0].name, 'Folder');
    assert.strictEqual(back.groups[0].opacity, 0.8);
    assert.strictEqual(back.groups[0].blendMode, 'screen');
    assert.strictEqual(back.groups[0].visible, true);
    const hiddenBack = back.layers.find((l) => l.name === 'ScreenHidden')!;
    assert.strictEqual(hiddenBack.groupId, back.groups[0].id);
    assert.strictEqual(back.layers[0].groupId, null);
  });

  test('exported file walks cleanly section by section per the spec, and its merged section decodes to composite()', () => {
    const project = buildRoundTripProject();
    const bytes = exportPsd(project);
    const u16 = (at: number): number => bytes.readUInt16BE(at);
    const i16 = (at: number): number => bytes.readInt16BE(at);
    const u32 = (at: number): number => bytes.readUInt32BE(at);
    const i32 = (at: number): number => bytes.readInt32BE(at);

    assert.strictEqual(bytes.toString('latin1', 0, 4), '8BPS');
    assert.strictEqual(u16(4), 1, 'version');
    assert.strictEqual(u16(12), 4, 'merged channel count');
    assert.strictEqual(u32(14), 5, 'height');
    assert.strictEqual(u32(18), 6, 'width');
    assert.strictEqual(u16(22), 8, 'depth');
    assert.strictEqual(u16(24), 3, 'color mode RGB');

    let pos = 26;
    assert.strictEqual(u32(pos), 0, 'color mode data length');
    pos += 4;
    assert.strictEqual(u32(pos), 0, 'image resources length');
    pos += 4;
    const lmLen = u32(pos);
    const lmStart = pos + 4;
    pos += 4;
    const liLen = i32(pos);
    const liStart = pos + 4;
    pos += 4;
    const count = i16(pos);
    pos += 2;
    assert.strictEqual(count, 6, 'four layers + group divider + group folder records');

    const names: string[] = [];
    const blendKeys: string[] = [];
    let channelTotal = 0;
    for (let rec = 0; rec < count; rec++) {
      pos += 16; // bounds rectangle
      const chCount = u16(pos);
      pos += 2;
      for (let c = 0; c < chCount; c++) {
        pos += 2; // channel id
        channelTotal += u32(pos);
        pos += 4;
      }
      assert.strictEqual(bytes.toString('latin1', pos, pos + 4), '8BIM', 'blend signature');
      pos += 4;
      blendKeys.push(bytes.toString('latin1', pos, pos + 4));
      pos += 4;
      pos += 4; // opacity, clipping, flags, filler
      const extraStart = pos;
      const extraLen = u32(pos);
      pos += 4;
      const maskSize = u32(pos);
      pos += 4 + maskSize;
      const rangesLen = u32(pos);
      pos += 4 + rangesLen;
      const nameLen = bytes[pos];
      names.push(bytes.toString('latin1', pos + 1, pos + 1 + nameLen));
      pos = extraStart + 4 + extraLen;
    }
    assert.deepStrictEqual(names, ['Masked', '</Layer group>', 'ScreenHidden', 'Folder', 'Multiply', 'Base']);
    assert.ok(blendKeys.includes('mul '), `blend keys: ${JSON.stringify(blendKeys)}`);
    assert.ok(blendKeys.includes('scrn'), `blend keys: ${JSON.stringify(blendKeys)}`);

    pos += channelTotal;
    assert.ok(liStart + liLen - pos === 0 || liStart + liLen - pos === 1, 'layer info ends at its declared length');
    pos = liStart + liLen;
    assert.strictEqual(u32(pos), 0, 'global layer mask info is empty');
    pos += 4;
    assert.strictEqual(pos, lmStart + lmLen, 'layer & mask section ends at its declared length');

    // Merged image data: RLE, counts channel-major, decodes to composite().
    assert.strictEqual(u16(pos), 1, 'merged compression is RLE');
    pos += 2;
    const counts: number[] = [];
    for (let i = 0; i < 4 * 5; i++) {
      counts.push(u16(pos));
      pos += 2;
    }
    const unpack = (start: number, len: number, expected: number): number[] => {
      const out: number[] = [];
      let ip = start;
      const end = start + len;
      while (ip < end) {
        const h = bytes.readInt8(ip++);
        if (h >= 0) {
          for (let k = 0; k <= h; k++) out.push(bytes[ip++]);
        } else if (h >= -127) {
          const v = bytes[ip++];
          for (let k = 0; k < 1 - h; k++) out.push(v);
        }
      }
      assert.strictEqual(out.length, expected);
      return out;
    };
    const flat = composite(project);
    for (let c = 0; c < 4; c++) {
      for (let y = 0; y < 5; y++) {
        const row = unpack(pos, counts[c * 5 + y], 6);
        pos += counts[c * 5 + y];
        for (let x = 0; x < 6; x++) {
          assert.strictEqual(row[x], flat.data[(y * 6 + x) * 4 + c], `merged channel ${c} at (${x},${y})`);
        }
      }
    }
    assert.strictEqual(pos, bytes.length, 'the walk consumes the file exactly');
  });

  test('content layers export as their rendered pixels and re-import as raster layers (documented loss)', () => {
    const project = createProject(24, 16);
    const title = addTextLayer(project, { text: 'A' }, 'Title');
    const rendered = new Uint8ClampedArray(title.image.data);
    const { project: back } = importPsd(exportPsd(project));
    const backTitle = back.layers.find((l) => l.name === 'Title')!;
    assert.ok(backTitle, 'the text layer survives as a layer');
    assert.strictEqual(backTitle.kind, 'raster');
    assert.strictEqual(backTitle.text, null);
    assert.deepStrictEqual(backTitle.image.data, rendered);
  });
});
