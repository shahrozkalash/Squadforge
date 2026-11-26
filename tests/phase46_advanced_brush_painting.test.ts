import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  addLayer,
  getLayer,
  getPixel,
  setPixel,
  fillRect,
  setLayerAlphaLock,
  createPixelImage,
  createSelection,
  rectSelection,
  createBrushSettings,
  DEFAULT_BRUSH_SETTINGS,
  createBrushTip,
  roundBrushTip,
  brushTipFromImage,
  brushTipFromLayer,
  smoothStrokePoints,
  paintBrushStroke,
  eraseBrushStroke,
  BUILT_IN_BRUSH_PRESETS,
  getBrushPreset,
  serializeBrushPreset,
  deserializeBrushPreset,
  sampleColor,
  sampleLayerColor
} from '../server/imageEditor/imageCore.js';
import type { RgbaColor, StrokePoint } from '../server/imageEditor/types.js';

/**
 * Phase 46: Advanced Brush and Painting Engine.
 *
 * The rendering model under test (documented in imageCore.ts): stamps
 * deposit shape × flow coverage with the build-up rule
 * cov += deposit × (1 − cov); the stroke is applied once at opacity.
 * Expected values below are computed from that model and from
 * blendOver's rounding, not copied from the implementation's output.
 */

const RED: RgbaColor = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RgbaColor = { r: 0, g: 0, b: 255, a: 255 };

function layerPx(project: ReturnType<typeof createProject>, layerId: string, x: number, y: number): RgbaColor {
  return getPixel(getLayer(project, layerId).image, x, y);
}

function alphaSum(project: ReturnType<typeof createProject>, layerId: string): number {
  const img = getLayer(project, layerId).image;
  let sum = 0;
  for (let i = 3; i < img.data.length; i += 4) sum += img.data[i];
  return sum;
}

describe('SquadForge Phase 46: Advanced Brush and Painting Engine Test Suite', () => {
  describe('1. Adjustable brush: size, hardness, spacing, opacity, flow', () => {
    test('1.1 Brush size controls the painted footprint', () => {
      const small = createProject(40, 30);
      const smallId = small.layers[0].id;
      paintBrushStroke(small, smallId, [{ x: 20, y: 15 }], createBrushSettings({ size: 6, hardness: 1 }), RED);
      assert.equal(layerPx(small, smallId, 22, 15).a, 255); // dist 2 <= r 3
      assert.equal(layerPx(small, smallId, 24, 15).a, 0); // dist 4 > r 3

      const large = createProject(40, 30);
      const largeId = large.layers[0].id;
      paintBrushStroke(large, largeId, [{ x: 20, y: 15 }], createBrushSettings({ size: 12, hardness: 1 }), RED);
      assert.equal(layerPx(large, largeId, 24, 15).a, 255); // dist 4 <= r 6
      assert.equal(layerPx(large, largeId, 27, 15).a, 0); // dist 7 > r 6
    });

    test('1.2 Hardness sets the edge falloff, with exact intermediate alphas', () => {
      // size 10 (r 5), hardness 0: shape at distance d is (1 - d/5).
      const soft = createProject(30, 30);
      const softId = soft.layers[0].id;
      paintBrushStroke(soft, softId, [{ x: 15, y: 15 }], createBrushSettings({ size: 10, hardness: 0, flow: 1, opacity: 1 }), RED);
      assert.equal(layerPx(soft, softId, 15, 15).a, 255); // centre: shape 1
      assert.equal(layerPx(soft, softId, 18, 15).a, 102); // dist 3: shape 0.4 -> round(0.4*255)
      assert.equal(layerPx(soft, softId, 18, 15).r, 255); // color is full, only alpha falls off
      assert.equal(layerPx(soft, softId, 20, 15).a, 0); // rim: shape 0

      // hardness 0.5: full strength out to nd 0.5, then (1-nd)/0.5.
      const mid = createProject(30, 30);
      const midId = mid.layers[0].id;
      paintBrushStroke(mid, midId, [{ x: 15, y: 15 }], createBrushSettings({ size: 10, hardness: 0.5, flow: 1, opacity: 1 }), RED);
      assert.equal(layerPx(mid, midId, 17, 15).a, 255); // dist 2, nd 0.4 <= 0.5
      assert.equal(layerPx(mid, midId, 18, 15).a, 204); // dist 3, nd 0.6: shape 0.8 -> round(0.8*255)
      assert.equal(layerPx(mid, midId, 19, 15).a, 102); // dist 4, nd 0.8: shape 0.4
    });

    test('1.3 Spacing above the diameter leaves real gaps; small spacing is continuous', () => {
      // size 6 (r 3), spacing 3 -> stamps every 18 px: at x = 2, 20, 38.
      const gappy = createProject(44, 24);
      const gappyId = gappy.layers[0].id;
      paintBrushStroke(
        gappy,
        gappyId,
        [
          { x: 2, y: 12 },
          { x: 38, y: 12 }
        ],
        createBrushSettings({ size: 6, hardness: 1, spacing: 3 }),
        RED
      );
      assert.equal(layerPx(gappy, gappyId, 20, 12).a, 255); // a stamp centre
      assert.equal(layerPx(gappy, gappyId, 5, 12).a, 255); // dist 3 = r, hard edge includes it
      assert.equal(layerPx(gappy, gappyId, 11, 12).a, 0); // 9 px from the nearest stamp: the gap

      const dense = createProject(44, 24);
      const denseId = dense.layers[0].id;
      paintBrushStroke(
        dense,
        denseId,
        [
          { x: 2, y: 12 },
          { x: 38, y: 12 }
        ],
        createBrushSettings({ size: 6, hardness: 1, spacing: 0.5 }),
        RED
      );
      assert.equal(layerPx(dense, denseId, 11, 12).a, 255); // stamps every 3 px cover it
    });

    test('1.4 Opacity caps the stroke no matter how many stamps overlap', () => {
      const project = createProject(30, 30);
      const id = project.layers[0].id;
      // Back-and-forth over the same pixels: coverage saturates at 1,
      // so the applied alpha is exactly opacity.
      paintBrushStroke(
        project,
        id,
        [
          { x: 15, y: 15 },
          { x: 25, y: 15 },
          { x: 15, y: 15 },
          { x: 25, y: 15 },
          { x: 15, y: 15 }
        ],
        createBrushSettings({ size: 10, hardness: 1, flow: 1, opacity: 0.5, spacing: 0.1 }),
        RED
      );
      assert.equal(layerPx(project, id, 15, 15).a, 128); // round(0.5 * 255)
    });

    test('1.5 Flow builds up over repeated stamps by the 1-(1-f)^n rule', () => {
      // Single stamp, flow 0.5: coverage 0.5. Flow 0.25: coverage 0.25.
      const single = createProject(30, 30);
      const singleId = single.layers[0].id;
      paintBrushStroke(single, singleId, [{ x: 15, y: 15 }], createBrushSettings({ size: 10, hardness: 1, flow: 0.5 }), RED);
      assert.equal(layerPx(single, singleId, 15, 15).a, 128); // round(0.5*255)

      const quarter = createProject(30, 30);
      const quarterId = quarter.layers[0].id;
      paintBrushStroke(quarter, quarterId, [{ x: 15, y: 15 }], createBrushSettings({ size: 10, hardness: 1, flow: 0.25 }), RED);
      assert.equal(layerPx(quarter, quarterId, 15, 15).a, 64); // round(0.25*255) = round(63.75)

      // spacing = size: stamps at x = 5, 15, 25 (r 5). The midpoint
      // pixel (10,12) is on the rim of two stamps (two deposits of
      // 0.5 -> coverage 0.75); a stamp centre gets only one deposit.
      const built = createProject(40, 24);
      const builtId = built.layers[0].id;
      paintBrushStroke(
        built,
        builtId,
        [
          { x: 5, y: 12 },
          { x: 25, y: 12 }
        ],
        createBrushSettings({ size: 10, hardness: 1, flow: 0.5, spacing: 1 }),
        RED
      );
      assert.equal(layerPx(built, builtId, 5, 12).a, 128); // one deposit: coverage 0.5
      assert.equal(layerPx(built, builtId, 10, 12).a, 191); // two deposits: coverage 0.75 -> round(191.25)
    });

    test('1.6 Settings defaults, partial overrides and validation', () => {
      const d = createBrushSettings();
      assert.equal(d.size, DEFAULT_BRUSH_SETTINGS.size);
      assert.equal(d.hardness, DEFAULT_BRUSH_SETTINGS.hardness);
      assert.equal(d.tip, null);
      const custom = createBrushSettings({ size: 20 });
      assert.equal(custom.size, 20);
      assert.equal(custom.flow, DEFAULT_BRUSH_SETTINGS.flow);
      assert.throws(() => createBrushSettings({ size: 0 }), /size out of range/);
      assert.throws(() => createBrushSettings({ size: -3 }), /size out of range/);
      assert.throws(() => createBrushSettings({ hardness: 1.5 }), /hardness out of range/);
      assert.throws(() => createBrushSettings({ opacity: -0.1 }), /opacity out of range/);
      assert.throws(() => createBrushSettings({ flow: 2 }), /flow out of range/);
      assert.throws(() => createBrushSettings({ spacing: -1 }), /spacing out of range/);
      assert.throws(() => createBrushSettings({ smoothing: 1.2 }), /smoothing out of range/);
    });
  });

  describe('2. Pressure input', () => {
    test('2.1 Pressure scales the stamp diameter when pressureSize is on', () => {
      const light = createProject(50, 50);
      const lightId = light.layers[0].id;
      // size 20 at pressure 0.25 -> diameter 5, r 2.5.
      paintBrushStroke(
        light,
        lightId,
        [{ x: 25, y: 25, pressure: 0.25 }],
        createBrushSettings({ size: 20, hardness: 1, pressureSize: true }),
        RED
      );
      assert.equal(layerPx(light, lightId, 27, 25).a, 255); // dist 2 <= 2.5
      assert.equal(layerPx(light, lightId, 29, 25).a, 0); // dist 4 > 2.5

      const full = createProject(50, 50);
      const fullId = full.layers[0].id;
      paintBrushStroke(
        full,
        fullId,
        [{ x: 25, y: 25, pressure: 1 }],
        createBrushSettings({ size: 20, hardness: 1, pressureSize: true }),
        RED
      );
      assert.equal(layerPx(full, fullId, 29, 25).a, 255); // dist 4 <= r 10
      assert.equal(layerPx(full, fullId, 36, 25).a, 0); // dist 11 > r 10
    });

    test('2.2 Pressure scales stamp strength when pressureOpacity is on; absent pressure is full', () => {
      const pressed = createProject(30, 30);
      const pressedId = pressed.layers[0].id;
      paintBrushStroke(
        pressed,
        pressedId,
        [{ x: 15, y: 15, pressure: 0.5 }],
        createBrushSettings({ size: 10, hardness: 1, flow: 1, pressureOpacity: true }),
        RED
      );
      assert.equal(layerPx(pressed, pressedId, 15, 15).a, 128); // deposit 0.5 -> round(0.5*255)

      const noPressure = createProject(30, 30);
      const noPressureId = noPressure.layers[0].id;
      paintBrushStroke(
        noPressure,
        noPressureId,
        [{ x: 15, y: 15 }],
        createBrushSettings({ size: 10, hardness: 1, flow: 1, pressureOpacity: true }),
        RED
      );
      assert.equal(layerPx(noPressure, noPressureId, 15, 15).a, 255); // no pressure data -> treated as 1
    });

    test('2.3 Pressure is ignored when both pressure routes are off', () => {
      const project = createProject(30, 30);
      const id = project.layers[0].id;
      paintBrushStroke(project, id, [{ x: 15, y: 15, pressure: 0.1 }], createBrushSettings({ size: 10, hardness: 1 }), RED);
      assert.equal(layerPx(project, id, 15, 15).a, 255);
      assert.equal(layerPx(project, id, 19, 15).a, 255); // dist 4 <= r 5 at full size
    });

    test('2.4 Zero pressure leaves no mark on either route', () => {
      const bySize = createProject(30, 30);
      const bySizeId = bySize.layers[0].id;
      paintBrushStroke(
        bySize,
        bySizeId,
        [{ x: 15, y: 15, pressure: 0 }],
        createBrushSettings({ size: 10, hardness: 1, pressureSize: true }),
        RED
      );
      assert.equal(alphaSum(bySize, bySizeId), 0);

      const byOpacity = createProject(30, 30);
      const byOpacityId = byOpacity.layers[0].id;
      paintBrushStroke(
        byOpacity,
        byOpacityId,
        [{ x: 15, y: 15, pressure: 0 }],
        createBrushSettings({ size: 10, hardness: 1, pressureOpacity: true }),
        RED
      );
      assert.equal(alphaSum(byOpacity, byOpacityId), 0);
    });

    test('2.5 Pressure interpolates along the stroke: the footprint grows with pressure', () => {
      const project = createProject(60, 30);
      const id = project.layers[0].id;
      paintBrushStroke(
        project,
        id,
        [
          { x: 5, y: 15, pressure: 0 },
          { x: 55, y: 15, pressure: 1 }
        ],
        createBrushSettings({ size: 20, hardness: 1, spacing: 0.05, pressureSize: true }),
        RED
      );
      assert.equal(layerPx(project, id, 5, 15).a, 0); // pressure ~0 at the start: no stamp covers it
      assert.equal(layerPx(project, id, 5, 19).a, 0); // 4 px off the line at the start: still nothing
      assert.equal(layerPx(project, id, 30, 19).a, 255); // halfway: pressure ~0.5, r ~5 covers 4 px off-line
      assert.equal(layerPx(project, id, 54, 23).a, 255); // near the end: pressure ~1, r ~10 covers 8 px off-line
    });
  });

  describe('3. Brush presets', () => {
    test('3.1 Built-in presets exist, are distinct, valid, and returned as copies', () => {
      assert.ok(BUILT_IN_BRUSH_PRESETS.length >= 4);
      const names = BUILT_IN_BRUSH_PRESETS.map((p) => p.name);
      assert.equal(new Set(names).size, names.length);
      const hard = getBrushPreset('Hard Round');
      const air = getBrushPreset('Airbrush');
      assert.ok(air.settings.flow < hard.settings.flow); // airbrush builds up slowly
      assert.equal(hard.settings.hardness, 1);
      assert.notEqual(getBrushPreset('Speckle Tip').settings.tip, null);
      assert.throws(() => getBrushPreset('No Such Preset'), /Unknown brush preset/);
      hard.settings.size = 999; // mutating the copy must not poison the library
      assert.equal(getBrushPreset('Hard Round').settings.size, 12);
    });

    test('3.2 Presets serialize to JSON and load back losslessly, tip included', () => {
      const preset = getBrushPreset('Speckle Tip');
      const revived = deserializeBrushPreset(JSON.parse(JSON.stringify(serializeBrushPreset(preset))));
      assert.equal(revived.name, preset.name);
      assert.equal(revived.settings.size, preset.settings.size);
      assert.equal(revived.settings.flow, preset.settings.flow);
      assert.deepEqual(Array.from(revived.settings.tip!.data), Array.from(preset.settings.tip!.data));
      assert.equal(revived.settings.tip!.width, preset.settings.tip!.width);

      const plain = deserializeBrushPreset(JSON.parse(JSON.stringify(serializeBrushPreset(getBrushPreset('Soft Round')))));
      assert.equal(plain.settings.tip, null);
      assert.equal(plain.name, 'Soft Round');
    });

    test('3.3 A loaded preset paints pixel-identically to the original', () => {
      const original = getBrushPreset('Speckle Tip');
      const loaded = deserializeBrushPreset(JSON.parse(JSON.stringify(serializeBrushPreset(original))));
      const a = createProject(24, 24);
      const aId = a.layers[0].id;
      const b = createProject(24, 24);
      const bId = b.layers[0].id;
      paintBrushStroke(a, aId, [{ x: 10, y: 10 }], original.settings, RED);
      paintBrushStroke(b, bId, [{ x: 10, y: 10 }], loaded.settings, RED);
      assert.deepEqual(Array.from(getLayer(b, bId).image.data), Array.from(getLayer(a, aId).image.data));
      assert.equal(layerPx(a, aId, 6, 6).a, 255); // speckle texel (0,0) is fully opaque
    });

    test('3.4 Corrupt preset data is rejected', () => {
      const good = serializeBrushPreset(getBrushPreset('Speckle Tip'));
      assert.throws(
        () => deserializeBrushPreset({ ...good, format: 'other' } as never),
        /Not a SquadForge brush preset/
      );
      assert.throws(() => deserializeBrushPreset({ ...good, version: 2 } as never), /Not a SquadForge brush preset/);
      const badTip = JSON.parse(JSON.stringify(good));
      badTip.settings.tip.dataBase64 = Buffer.from([1, 2, 3]).toString('base64'); // 3 bytes for a 4x4 tip
      assert.throws(() => deserializeBrushPreset(badTip), /tip data size mismatch/);
      const badSize = JSON.parse(JSON.stringify(good));
      badSize.settings.size = -5;
      assert.throws(() => deserializeBrushPreset(badSize), /size out of range/);
    });
  });

  describe('4. Smoothing / stabilization', () => {
    const zigzag: StrokePoint[] = Array.from({ length: 11 }, (_, i) => ({
      x: i * 4,
      y: 20 + (i % 2 === 0 ? 4 : -4)
    }));

    test('4.1 Amount 0 returns the input unchanged and does not mutate it', () => {
      const input: StrokePoint[] = [
        { x: 1, y: 2 },
        { x: 3, y: 4, pressure: 0.5 },
        { x: 5, y: 6 }
      ];
      const snapshot = JSON.parse(JSON.stringify(input));
      const out = smoothStrokePoints(input, 0);
      assert.deepEqual(out, snapshot);
      assert.deepEqual(input, snapshot);
    });

    test('4.2 Smoothing measurably reduces jitter around the stroke line', () => {
      const deviation = (pts: StrokePoint[]) => pts.reduce((sum, p) => sum + Math.abs(p.y - 20), 0);
      const raw = deviation(zigzag);
      assert.equal(raw, 44); // 11 points, each 4 px off the line
      const smoothed = smoothStrokePoints(zigzag, 0.9);
      assert.equal(smoothed[0].x, zigzag[0].x); // anchored at the first point
      assert.equal(smoothed[0].y, zigzag[0].y);
      assert.ok(deviation(smoothed) < raw / 2, `smoothed deviation ${deviation(smoothed)} should be < ${raw / 2}`);
      assert.ok(Math.abs(smoothed[smoothed.length - 1].y - 20) < 4); // pulled toward the line
    });

    test('4.3 A smoothed stroke renders on the line; the raw stroke renders the jitter peaks', () => {
      const points: StrokePoint[] = [
        { x: 2, y: 20 },
        { x: 6, y: 24 },
        { x: 10, y: 16 },
        { x: 14, y: 24 },
        { x: 18, y: 16 },
        { x: 22, y: 24 },
        { x: 26, y: 16 },
        { x: 30, y: 24 },
        { x: 34, y: 20 }
      ];
      const raw = createProject(40, 40);
      const rawId = raw.layers[0].id;
      paintBrushStroke(raw, rawId, points, createBrushSettings({ size: 3, hardness: 1, spacing: 0.1 }), RED);
      assert.equal(layerPx(raw, rawId, 6, 24).a, 255); // jitter peak is a stroke vertex
      assert.equal(layerPx(raw, rawId, 10, 16).a, 255); // jitter valley likewise
      assert.equal(layerPx(raw, rawId, 16, 20).a, 255); // the raw path crosses the centreline here

      const smooth = createProject(40, 40);
      const smoothId = smooth.layers[0].id;
      paintBrushStroke(smooth, smoothId, points, createBrushSettings({ size: 3, hardness: 1, spacing: 0.1, smoothing: 0.9 }), RED);
      assert.equal(layerPx(smooth, smoothId, 6, 24).a, 0); // stabilized path never reaches the peak
      assert.equal(layerPx(smooth, smoothId, 10, 16).a, 0); // nor the valley
      assert.equal(layerPx(smooth, smoothId, 16, 20).a, 255); // but it does paint the centreline
    });

    test('4.4 Smoothing validates its amount', () => {
      assert.throws(() => smoothStrokePoints(zigzag, -0.1), /Smoothing amount out of range/);
      assert.throws(() => smoothStrokePoints(zigzag, 1.5), /Smoothing amount out of range/);
    });
  });

  describe('5. Custom brush tips', () => {
    test('5.1 A tip raster is the stamp shape: painted and unpainted texels land exactly', () => {
      // 4x4 tip: left half opaque, right half empty.
      const data = new Uint8Array(16);
      for (let y = 0; y < 4; y++) {
        data[y * 4 + 0] = 255;
        data[y * 4 + 1] = 255;
      }
      const tip = createBrushTip(4, 4, data);
      const project = createProject(24, 24);
      const id = project.layers[0].id;
      // Stamp diameter = tip size, centred at (10,10): footprint x 8..11.
      paintBrushStroke(project, id, [{ x: 10, y: 10 }], createBrushSettings({ size: 4, tip, flow: 1 }), RED);
      assert.equal(layerPx(project, id, 8, 10).a, 255);
      assert.equal(layerPx(project, id, 9, 10).a, 255);
      assert.equal(layerPx(project, id, 10, 10).a, 0);
      assert.equal(layerPx(project, id, 11, 10).a, 0);
      assert.equal(layerPx(project, id, 8, 8).a, 255); // top row behaves the same
    });

    test('5.2 Tips derive from images and layers by luminance x alpha', () => {
      const img = createPixelImage(4, 4);
      setPixel(img, 0, 0, { r: 0, g: 0, b: 0, a: 255 }); // opaque black: luminance 0
      setPixel(img, 3, 3, { r: 255, g: 255, b: 255, a: 255 }); // opaque white: full
      const tip = brushTipFromImage(img);
      assert.equal(tip.data[0], 0);
      assert.equal(tip.data[15], 255);
      assert.equal(tip.data[5], 0); // transparent pixel stamps nothing

      const project = createProject(4, 4);
      const id = project.layers[0].id;
      setPixel(getLayer(project, id).image, 3, 3, { r: 255, g: 255, b: 255, a: 255 });
      const layerTip = brushTipFromLayer(project, id);
      assert.deepEqual(Array.from(layerTip.data), Array.from(tip.data));

      // Painting with the derived tip marks only the white corner texel.
      const canvas = createProject(24, 24);
      const canvasId = canvas.layers[0].id;
      paintBrushStroke(canvas, canvasId, [{ x: 10, y: 10 }], createBrushSettings({ size: 4, tip, flow: 1 }), RED);
      assert.equal(layerPx(canvas, canvasId, 11, 11).a, 255);
      assert.equal(layerPx(canvas, canvasId, 8, 8).a, 0);
    });

    test('5.3 Tips scale to the brush size with bilinear sampling', () => {
      // 2x2 tip, only the bottom-right texel empty.
      const tip = createBrushTip(2, 2, new Uint8Array([255, 255, 255, 0]));
      const project = createProject(30, 30);
      const id = project.layers[0].id;
      // Diameter 6 stamp at (12,12): footprint 9..14.
      paintBrushStroke(project, id, [{ x: 12, y: 12 }], createBrushSettings({ size: 6, tip, flow: 1 }), RED);
      assert.equal(layerPx(project, id, 9, 9).a, 255); // clamps to the opaque corner texel
      assert.equal(layerPx(project, id, 11, 9).a, 255); // top row mixes two opaque texels
      assert.equal(layerPx(project, id, 14, 14).a, 0); // deepest in the empty texel's cell
    });

    test('5.4 Tip construction validates its data; the round-tip generator follows the profile', () => {
      assert.throws(() => createBrushTip(2, 2, new Uint8Array(3)), /data size mismatch/);
      assert.throws(() => createBrushTip(0, 2, new Uint8Array(0)), /positive integer dimensions/);
      assert.throws(() => roundBrushTip(0, 0.5), /diameter out of range/);
      const tip = roundBrushTip(5, 0);
      assert.equal(tip.data[2 * 5 + 2], 255); // centre
      assert.equal(tip.data[0], 0); // corner: nd > 1
      assert.equal(tip.data[0 * 5 + 2], 51); // top-middle: nd 0.8, hardness 0 -> round(0.2*255)
    });
  });

  describe('6. Color sampling (eyedropper)', () => {
    test('6.1 Sampling the canvas returns the composited color', () => {
      const project = createProject(8, 8, BLUE);
      const top = addLayer(project, 'tint');
      fillRect(project, top.id, { x: 0, y: 0, width: 8, height: 8 }, { r: 255, g: 0, b: 0, a: 128 });
      // Half-strength red over opaque blue: r = 128, b = 127, a = 255.
      assert.deepEqual(sampleColor(project, 4, 4), { r: 128, g: 0, b: 127, a: 255 });
    });

    test('6.2 Sampling a layer returns that layer’s own pixels, uncomposited', () => {
      const project = createProject(8, 8, BLUE);
      const top = addLayer(project, 'tint');
      fillRect(project, top.id, { x: 0, y: 0, width: 8, height: 8 }, { r: 255, g: 0, b: 0, a: 128 });
      assert.deepEqual(sampleLayerColor(project, top.id, 4, 4), { r: 255, g: 0, b: 0, a: 128 });
      assert.deepEqual(sampleLayerColor(project, project.layers[0].id, 4, 4), { r: 0, g: 0, b: 255, a: 255 });
    });

    test('6.3 Radius sampling averages the window, clipped at the edges', () => {
      const project = createProject(4, 1);
      const id = project.layers[0].id;
      const img = getLayer(project, id).image;
      setPixel(img, 0, 0, { r: 0, g: 0, b: 0, a: 255 });
      setPixel(img, 1, 0, { r: 0, g: 0, b: 0, a: 255 });
      setPixel(img, 2, 0, { r: 255, g: 255, b: 255, a: 255 });
      setPixel(img, 3, 0, { r: 255, g: 255, b: 255, a: 255 });
      assert.deepEqual(sampleColor(project, 1, 0, 1), { r: 85, g: 85, b: 85, a: 255 }); // (0+0+255)/3
      assert.deepEqual(sampleColor(project, 0, 0, 1), { r: 0, g: 0, b: 0, a: 255 }); // window clips to x 0..1
      assert.deepEqual(sampleColor(project, 3, 0, 1), { r: 255, g: 255, b: 255, a: 255 }); // window clips to x 2..3
      assert.deepEqual(sampleColor(project, 2, 0), { r: 255, g: 255, b: 255, a: 255 }); // radius 0: the pixel itself
    });

    test('6.4 Sampling validates its inputs', () => {
      const project = createProject(4, 4);
      assert.throws(() => sampleColor(project, 9, 0), /Sample point out of bounds/);
      assert.throws(() => sampleColor(project, 0, -1), /Sample point out of bounds/);
      assert.throws(() => sampleColor(project, 0, 0, -1), /Sample radius out of range/);
      assert.throws(() => sampleLayerColor(project, 'missing-layer', 0, 0), /Layer not found/);
    });
  });

  describe('7. Integration: alpha lock, selections, eraser', () => {
    test('7.1 Alpha lock: paint recolors but never changes alpha, and never creates it', () => {
      const project = createProject(20, 20, { r: 0, g: 0, b: 255, a: 128 });
      const id = project.layers[0].id;
      setLayerAlphaLock(project, id, true);
      paintBrushStroke(project, id, [{ x: 10, y: 10 }], createBrushSettings({ size: 6, hardness: 1 }), RED);
      assert.deepEqual(layerPx(project, id, 10, 10), { r: 255, g: 0, b: 0, a: 128 }); // recolored, alpha exact

      const empty = createProject(20, 20);
      const emptyId = empty.layers[0].id;
      setLayerAlphaLock(empty, emptyId, true);
      paintBrushStroke(empty, emptyId, [{ x: 10, y: 10 }], createBrushSettings({ size: 6, hardness: 1 }), RED);
      assert.equal(layerPx(empty, emptyId, 10, 10).a, 0); // locked: no new alpha
    });

    test('7.2 A Phase 45 raster selection scopes and scales the stroke', () => {
      const project = createProject(30, 20);
      const id = project.layers[0].id;
      const sel = createSelection(30, 20, 0);
      sel.data[10 * 30 + 5] = 255; // (5,10) fully selected
      sel.data[10 * 30 + 20] = 128; // (20,10) half selected
      const settings = createBrushSettings({ size: 24, hardness: 1, flow: 1 });
      paintBrushStroke(project, id, [{ x: 12, y: 10 }], settings, RED, { selectionMask: sel });
      assert.equal(layerPx(project, id, 5, 10).a, 255);
      assert.equal(layerPx(project, id, 20, 10).a, 128); // coverage 1 x selection 128/255
      assert.equal(layerPx(project, id, 22, 10).a, 0); // inside the stamp, outside the selection
      assert.throws(
        () => paintBrushStroke(project, id, [{ x: 12, y: 10 }], settings, RED, { selectionMask: createSelection(10, 10) }),
        /does not match layer size/
      );
    });

    test('7.3 The Phase 19 rect selection still scopes the advanced brush', () => {
      const project = createProject(30, 20);
      const id = project.layers[0].id;
      paintBrushStroke(
        project,
        id,
        [
          { x: 2, y: 10 },
          { x: 28, y: 10 }
        ],
        createBrushSettings({ size: 6, hardness: 1, spacing: 0.1 }),
        RED,
        { selection: { x: 0, y: 0, width: 10, height: 20 } }
      );
      assert.equal(layerPx(project, id, 5, 10).a, 255);
      assert.equal(layerPx(project, id, 20, 10).a, 0);
      // The rect-selection helper itself is unchanged Phase 45 stock:
      assert.equal(rectSelection(30, 20, { x: 0, y: 0, width: 10, height: 20 }).data[10 * 30 + 5], 255);
    });

    test('7.4 The advanced eraser removes alpha by coverage and honors the alpha lock', () => {
      const project = createProject(20, 20, RED);
      const id = project.layers[0].id;
      eraseBrushStroke(project, id, [{ x: 10, y: 10 }], createBrushSettings({ size: 10, hardness: 1, flow: 0.5 }));
      assert.deepEqual(layerPx(project, id, 10, 10), { r: 255, g: 0, b: 0, a: 128 }); // round(255 * (1-0.5))
      assert.equal(layerPx(project, id, 2, 2).a, 255); // outside the stamp

      const locked = createProject(20, 20, RED);
      const lockedId = locked.layers[0].id;
      setLayerAlphaLock(locked, lockedId, true);
      eraseBrushStroke(locked, lockedId, [{ x: 10, y: 10 }], createBrushSettings({ size: 10, hardness: 1, flow: 1 }));
      assert.equal(layerPx(locked, lockedId, 10, 10).a, 255); // erase is alpha-only: a lock makes it a no-op
    });

    test('7.5 Empty strokes paint nothing; a single point paints a dot', () => {
      const project = createProject(20, 20);
      const id = project.layers[0].id;
      paintBrushStroke(project, id, [], createBrushSettings({ size: 6, hardness: 1 }), RED);
      assert.equal(alphaSum(project, id), 0);
      paintBrushStroke(project, id, [{ x: 10, y: 10 }], createBrushSettings({ size: 6, hardness: 1 }), RED);
      assert.equal(layerPx(project, id, 10, 10).a, 255);
    });
  });

  describe('8. Performance', () => {
    test('8.1 A long stroke of thousands of stamps on a 1024x1024 canvas completes fast', () => {
      const project = createProject(1024, 1024);
      const id = project.layers[0].id;
      // Serpentine path across the whole canvas.
      const points: StrokePoint[] = [];
      const rows = [64, 192, 320, 448, 576, 704, 832, 960];
      rows.forEach((y, i) => {
        if (i % 2 === 0) points.push({ x: 32, y }, { x: 992, y });
        else points.push({ x: 992, y }, { x: 32, y });
      });
      const settings = createBrushSettings({ size: 24, hardness: 0.8, spacing: 0.1 });
      const start = performance.now();
      paintBrushStroke(project, id, points, settings, RED);
      const elapsed = performance.now() - start;
      // ~8,576 px of path at a 2.4 px stamp interval = ~3,570 stamps.
      console.log(`Phase 46 perf: serpentine stroke, ~3570 stamps of size 24 on 1024x1024: ${elapsed.toFixed(1)} ms`);
      assert.ok(layerPx(project, id, 512, 64).a > 0); // the stroke really rendered
      assert.ok(elapsed < 10000, `stroke took ${elapsed.toFixed(1)} ms (bound 10000 ms)`);
    });
  });
});
