import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  addLayer,
  getLayer,
  composite,
  getPixel,
  setLayerVisibility,
  setLayerOpacity,
  createLayerMask,
  drawText,
  rotateImage,
  transformLayer,
  identityTransform,
  HistoryStack,
  serializeProject,
  deserializeProject,
  addTextLayer,
  addShapeLayer,
  getTextData,
  getShapeData,
  updateTextLayer,
  updateShapeLayer,
  renderContentLayer,
  setContentTransform,
  transformContentLayer,
  createTextLayerData,
  measureTextBlock,
  textScaleFor,
  cubicBezierPoint,
  flattenBezierSegment,
  flattenPath,
  rectangleShape,
  ellipseShape,
  lineShape,
  polygonShape,
  pathShape
} from '../server/imageEditor/imageCore.js';
import { glyphRowsFor } from '../server/imageEditor/bitmapFont.js';
import type { BezierSegment, RgbaColor } from '../server/imageEditor/types.js';

/**
 * Phase 48: Typography and Vector Tools.
 *
 * Expected pixels are computed from the documented models, not copied
 * from the implementation: the 5x7 glyph table (A = rows 0x0e, 0x11,
 * 0x11, 0x1f, ...; I = row 1 is 0x04, col 2 only; the bold set dilates
 * each row by its right shift, so bold I row 1 is 0x06, cols 2-3),
 * the layout rules (advance 6*scale + letterSpacing, line advance
 * 7*scale + lineSpacing, alignment inside the block width), outline =
 * dilated coverage minus coverage, and the cubic Bézier formula
 * (the symmetric segment (0,0),(0,10),(10,10),(10,0) passes exactly
 * through (5, 7.5) at t = 0.5 and (1.5625, 5.625) at t = 0.25).
 */

const RED: RgbaColor = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RgbaColor = { r: 0, g: 200, b: 0, a: 255 };
const BLUE: RgbaColor = { r: 0, g: 0, b: 255, a: 255 };
const BLACK: RgbaColor = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
const CLEAR: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };

function bytes(img: { data: Uint8ClampedArray }): number[] {
  return [...img.data];
}

describe('SquadForge Phase 48: Typography and Vector Tools Test Suite', () => {
  describe('1. Text layers: model and rendering', () => {
    test('1.1 A text layer renders its glyph at the computed pixels and carries editable data', () => {
      const p = createProject(16, 12);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, origin: { x: 1, y: 1 }, color: RED });
      assert.equal(t.kind, 'text');
      assert.equal(p.activeLayerId, t.id);
      const data = getTextData(p, t.id);
      assert.equal(data.text, 'A');
      assert.equal(data.font, 'pixel');
      assert.equal(data.fontSize, 7);
      assert.equal(data.align, 'left');
      assert.equal(data.letterSpacing, 0);
      assert.equal(data.lineSpacing, 0);
      assert.deepEqual(data.color, RED);
      assert.equal(data.outline, null);
      assert.equal(data.shadow, null);
      assert.deepEqual(data.origin, { x: 1, y: 1 });
      assert.equal(data.blockWidth, 0);
      const out = composite(p);
      // A row 0 (0x0e) sets cols 1-3 at y=1; col 0 stays empty.
      assert.deepEqual(getPixel(out, 2, 1), RED);
      assert.deepEqual(getPixel(out, 3, 1), RED);
      assert.deepEqual(getPixel(out, 4, 1), RED);
      assert.deepEqual(getPixel(out, 1, 1), CLEAR);
      // A row 1 (0x11) sets cols 0 and 4; row 3 (0x1f) sets all cols.
      assert.deepEqual(getPixel(out, 1, 2), RED);
      assert.deepEqual(getPixel(out, 5, 2), RED);
      assert.deepEqual(getPixel(out, 1, 4), RED);
      assert.deepEqual(getPixel(out, 5, 4), RED);
      // Below the glyph (glyph is 7 tall from y=1): empty.
      assert.deepEqual(getPixel(out, 2, 8), CLEAR);
    });

    test('1.2 Lowercase folds to uppercase; unknown characters render the fallback box; space renders nothing', () => {
      const lower = createProject(8, 9);
      addTextLayer(lower, { text: 'a', fontSize: 7, color: RED });
      const upper = createProject(8, 9);
      addTextLayer(upper, { text: 'A', fontSize: 7, color: RED });
      assert.deepEqual(bytes(composite(lower)), bytes(composite(upper)));

      const unknown = createProject(8, 9);
      addTextLayer(unknown, { text: 'É', fontSize: 7, color: RED });
      const out = composite(unknown);
      // Fallback box: top row fully set, centre hollow.
      assert.deepEqual(getPixel(out, 0, 0), RED);
      assert.deepEqual(getPixel(out, 4, 0), RED);
      assert.deepEqual(getPixel(out, 2, 3), CLEAR);

      const space = createProject(8, 9);
      addTextLayer(space, { text: ' ', fontSize: 7, color: RED });
      assert.ok(composite(space).data.every((v) => v === 0));
    });

    test('1.3 fontSize snaps to the bitmap grid; block measurement follows the layout rules', () => {
      assert.equal(textScaleFor(7), 1);
      assert.equal(textScaleFor(10), 1);
      assert.equal(textScaleFor(11), 2);
      assert.equal(textScaleFor(14), 2);
      assert.equal(textScaleFor(21), 3);
      const two = measureTextBlock(createTextLayerData({ text: 'AA', fontSize: 14 }));
      assert.equal(two.scale, 2);
      assert.equal(two.width, 2 * 6 * 2 - 2); // advance 6*scale per char, trailing gap removed
      assert.equal(two.height, 14);
      assert.equal(two.lineCount, 1);
      const spaced = measureTextBlock(createTextLayerData({ text: 'AA', fontSize: 7, letterSpacing: 4 }));
      assert.equal(spaced.width, 2 * 6 - 1 + 4);
      const lines = measureTextBlock(createTextLayerData({ text: 'A\nA', fontSize: 7, lineSpacing: 3 }));
      assert.equal(lines.height, 7 + 3 + 7);
      assert.equal(lines.lineCount, 2);
      const blocked = measureTextBlock(createTextLayerData({ text: 'A', fontSize: 7, blockWidth: 30 }));
      assert.equal(blocked.width, 30); // explicit block width wins over content width
    });

    test('1.4 getTextData returns the live data; renderContentLayer re-renders after a direct edit', () => {
      const p = createProject(8, 9);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      getTextData(p, t.id).text = 'B';
      // The cache is stale until an explicit re-render (mutators re-render for you).
      assert.deepEqual(getPixel(composite(p), 0, 0), CLEAR); // A row 0 col 0 is empty
      renderContentLayer(p, t.id);
      assert.deepEqual(getPixel(composite(p), 0, 0), RED); // B row 0 (0x1e) sets col 0
    });

    test('1.5 Content layers honor visibility, opacity and Phase 44 masks like raster layers', () => {
      const p = createProject(8, 9, WHITE);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      setLayerOpacity(p, t.id, 0.5);
      const half = getPixel(composite(p), 1, 0);
      assert.equal(half.a, 255); // over the opaque white background
      assert.equal(half.g, 128); // white showing through at half strength: round(255 * 0.5) = 128
      setLayerOpacity(p, t.id, 1);
      setLayerVisibility(p, t.id, false);
      assert.deepEqual(getPixel(composite(p), 1, 0), WHITE);
      setLayerVisibility(p, t.id, true);
      createLayerMask(p, t.id, 0); // mask hides everything
      assert.deepEqual(getPixel(composite(p), 1, 0), WHITE);
    });
  });

  describe('2. Editing text properties re-renders', () => {
    test('2.1 Changing color and content changes the output; the rest of the data is untouched', () => {
      const p = createProject(8, 9);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      assert.deepEqual(getPixel(composite(p), 0, 0), CLEAR);
      updateTextLayer(p, t.id, { text: 'B' });
      assert.deepEqual(getPixel(composite(p), 0, 0), RED); // B row 0 sets col 0
      updateTextLayer(p, t.id, { color: BLUE });
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE);
      const data = getTextData(p, t.id);
      assert.equal(data.text, 'B');
      assert.equal(data.fontSize, 7);
      assert.equal(data.font, 'pixel');
    });

    test('2.2 Changing fontSize rescales the glyph', () => {
      const p = createProject(16, 16);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      assert.deepEqual(getPixel(composite(p), 5, 0), CLEAR); // scale 1: row 0 spans x 1..3
      updateTextLayer(p, t.id, { fontSize: 14 });
      const out = composite(p);
      // Scale 2: row 0 cols 1-3 become 2x2 blocks spanning x 2..7, y 0..1.
      assert.deepEqual(getPixel(out, 5, 0), RED);
      assert.deepEqual(getPixel(out, 7, 1), RED);
      assert.deepEqual(getPixel(out, 8, 0), CLEAR);
    });

    test('2.3 Alignment positions the line inside the block width', () => {
      const p = createProject(24, 9);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED, blockWidth: 20 });
      // 'A' is 5 wide. Row 1 col 0 is the glyph's leftmost set pixel.
      assert.deepEqual(getPixel(composite(p), 0, 1), RED); // left: offset 0
      updateTextLayer(p, t.id, { align: 'right' });
      assert.deepEqual(getPixel(composite(p), 0, 1), CLEAR);
      assert.deepEqual(getPixel(composite(p), 15, 1), RED); // right: offset 20 - 5
      updateTextLayer(p, t.id, { align: 'center' });
      assert.deepEqual(getPixel(composite(p), 15, 1), CLEAR);
      assert.deepEqual(getPixel(composite(p), 8, 1), RED); // center: round((20 - 5) / 2) = 8
    });

    test('2.4 Letter spacing widens the advance between glyphs', () => {
      const p = createProject(20, 9);
      const t = addTextLayer(p, { text: 'AA', fontSize: 7, color: RED });
      // Row 3 is full width on both glyphs; second glyph starts at x=6.
      assert.deepEqual(getPixel(composite(p), 6, 3), RED);
      updateTextLayer(p, t.id, { letterSpacing: 4 });
      const out = composite(p);
      assert.deepEqual(getPixel(out, 6, 3), CLEAR); // now inside the spacing gap
      assert.deepEqual(getPixel(out, 9, 3), CLEAR);
      assert.deepEqual(getPixel(out, 10, 3), RED); // second glyph now starts at 6 + 4
      assert.deepEqual(getPixel(out, 14, 3), RED);
    });

    test('2.5 Line spacing separates lines', () => {
      const p = createProject(8, 20);
      const t = addTextLayer(p, { text: 'A\nB', fontSize: 7, color: RED });
      assert.deepEqual(getPixel(composite(p), 0, 7), RED); // B row 0 col 0, line 2 at y=7
      updateTextLayer(p, t.id, { lineSpacing: 3 });
      const out = composite(p);
      assert.deepEqual(getPixel(out, 0, 7), CLEAR);
      assert.deepEqual(getPixel(out, 0, 10), RED); // line 2 now at y = 7 + 3
    });

    test('2.6 The bold built-in font renders measurably different glyphs', () => {
      assert.equal(glyphRowsFor('pixel', 'I')[1], 0x04);
      assert.equal(glyphRowsFor('pixel-bold', 'I')[1], 0x06);
      const regular = createProject(8, 9);
      addTextLayer(regular, { text: 'I', fontSize: 7, color: RED });
      assert.deepEqual(getPixel(composite(regular), 2, 1), RED);
      assert.deepEqual(getPixel(composite(regular), 3, 1), CLEAR);
      const bold = createProject(8, 9);
      addTextLayer(bold, { text: 'I', fontSize: 7, font: 'pixel-bold', color: RED });
      assert.deepEqual(getPixel(composite(bold), 2, 1), RED);
      assert.deepEqual(getPixel(composite(bold), 3, 1), RED); // the dilated stem pixel
    });
  });

  describe('3. Text outline and shadow', () => {
    test('3.1 Outline is the dilated glyph coverage minus the glyph, painted under the fill', () => {
      const p = createProject(16, 12);
      addTextLayer(p, {
        text: 'A',
        fontSize: 7,
        origin: { x: 2, y: 2 },
        color: RED,
        outline: { width: 1, color: BLUE }
      });
      const out = composite(p);
      assert.deepEqual(getPixel(out, 3, 2), RED); // glyph pixel (row 0 col 1): fill wins
      assert.deepEqual(getPixel(out, 2, 2), BLUE); // left neighbour of the glyph: outline
      assert.deepEqual(getPixel(out, 2, 1), BLUE); // diagonal neighbour: outline (square dilation)
      assert.deepEqual(getPixel(out, 3, 4), BLUE); // gap between the A's legs, outlined
      assert.deepEqual(getPixel(out, 1, 1), CLEAR); // two away: untouched
      const plain = createProject(16, 12);
      addTextLayer(plain, {
        text: 'A',
        fontSize: 7,
        origin: { x: 2, y: 2 },
        color: RED,
        outline: { width: 0, color: BLUE }
      });
      assert.deepEqual(getPixel(composite(plain), 2, 2), CLEAR); // width 0 draws no outline
    });

    test('3.2 Shadow is the glyph coverage translated, painted under the fill', () => {
      const p = createProject(16, 12);
      addTextLayer(p, {
        text: 'A',
        fontSize: 7,
        origin: { x: 2, y: 2 },
        color: RED,
        shadow: { offsetX: 4, offsetY: 0, blur: 0, color: BLACK }
      });
      const out = composite(p);
      // Row 3 (y=5) is fully set across x 2..6; its shadow covers x 6..10.
      assert.deepEqual(getPixel(out, 8, 5), BLACK); // shadow only
      assert.deepEqual(getPixel(out, 10, 5), BLACK); // shadow of the last glyph pixel
      assert.deepEqual(getPixel(out, 6, 5), RED); // glyph and shadow overlap: fill wins
      assert.deepEqual(getPixel(out, 4, 5), RED); // glyph only
      assert.deepEqual(getPixel(out, 7, 2), BLACK); // row 0 shadow
      assert.deepEqual(getPixel(out, 11, 5), CLEAR); // beyond the shadow
    });

    test('3.3 Shadow blur spreads coverage: edge pixels soften, distant pixels stay empty', () => {
      const sharp = createProject(20, 16);
      addTextLayer(sharp, {
        text: 'A',
        fontSize: 7,
        origin: { x: 4, y: 4 },
        color: RED,
        shadow: { offsetX: 3, offsetY: 0, blur: 0, color: BLACK }
      });
      // Glyph pixel (6,4) (row 0 col 2) casts a full shadow at (9,4).
      assert.equal(getPixel(composite(sharp), 9, 4).a, 255);
      const soft = createProject(20, 16);
      addTextLayer(soft, {
        text: 'A',
        fontSize: 7,
        origin: { x: 4, y: 4 },
        color: RED,
        shadow: { offsetX: 3, offsetY: 0, blur: 1, color: BLACK }
      });
      const softened = getPixel(composite(soft), 9, 4);
      assert.ok(softened.a > 0 && softened.a < 255, `expected softened alpha, got ${softened.a}`);
      const spread = getPixel(composite(soft), 11, 4);
      assert.ok(spread.a > 0 && spread.a < 255, `expected spread alpha, got ${spread.a}`);
      assert.deepEqual(getPixel(composite(soft), 0, 0), CLEAR);
    });
  });

  describe('4. Text transformation stays editable', () => {
    test('4.1 setContentTransform moves the rendering and is stored as placement data', () => {
      const p = createProject(20, 12);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      assert.deepEqual(getPixel(composite(p), 1, 0), RED);
      const before = createTextLayerData(getTextData(p, t.id));
      setContentTransform(p, t.id, { ...identityTransform(), translateX: 5, translateY: 3 });
      assert.deepEqual(getLayer(p, t.id).contentTransform, [1, 0, 5, 0, 1, 3, 0, 0, 1]);
      assert.deepEqual(getPixel(composite(p), 1, 0), CLEAR);
      assert.deepEqual(getPixel(composite(p), 6, 3), RED);
      assert.deepEqual(getTextData(p, t.id), before); // the text data itself did not change
      setContentTransform(p, t.id, null);
      assert.equal(getLayer(p, t.id).contentTransform, null);
      assert.deepEqual(getPixel(composite(p), 1, 0), RED);
    });

    test('4.2 transformLayer composes into placement — a later edit renders with the transform applied', () => {
      const p = createProject(20, 12);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      transformLayer(p, t.id, { ...identityTransform(), translateX: 4 });
      assert.deepEqual(getLayer(p, t.id).contentTransform, [1, 0, 4, 0, 1, 0, 0, 0, 1]);
      assert.deepEqual(getPixel(composite(p), 5, 0), RED); // glyph (1,0) moved to (5,0)
      transformContentLayer(p, t.id, { ...identityTransform(), translateY: 2 });
      assert.deepEqual(getLayer(p, t.id).contentTransform, [1, 0, 4, 0, 1, 2, 0, 0, 1]);
      // If the transform had been baked into pixels, this edit would lose it.
      updateTextLayer(p, t.id, { text: 'B' });
      const out = composite(p);
      assert.deepEqual(getPixel(out, 4, 2), RED); // B row 0 col 0, placed at (+4, +2)
      assert.deepEqual(getPixel(out, 0, 0), CLEAR);
      assert.equal(getTextData(p, t.id).text, 'B');
    });

    test('4.3 A 90-degree transformLayer rotation of a text layer matches rotateImage of its render', () => {
      const p = createProject(16, 16);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, origin: { x: 2, y: 2 }, color: RED });
      const before = { width: 16, height: 16, data: new Uint8ClampedArray(getLayer(p, t.id).image.data) };
      transformLayer(p, t.id, { ...identityTransform(7.5, 7.5), rotationDeg: 90 });
      const expected = rotateImage(before, 90);
      assert.deepEqual(bytes(getLayer(p, t.id).image), bytes(expected));
      assert.equal(getTextData(p, t.id).text, 'A'); // still editable data, unchanged
    });

    test('4.4 Content transforms reject raster layers', () => {
      const p = createProject(8, 8);
      const raster = p.layers[0];
      assert.throws(() => setContentTransform(p, raster.id, identityTransform()), /not a content layer/);
      assert.throws(() => transformContentLayer(p, raster.id, identityTransform()), /not a content layer/);
    });
  });

  describe('5. Vector shapes', () => {
    test('5.1 Rectangle fill, stroke and fill+stroke render at the shape geometry', () => {
      const filled = createProject(10, 8);
      const s = addShapeLayer(filled, rectangleShape({ x: 2, y: 2, width: 4, height: 3 }, RED));
      assert.equal(s.kind, 'shape');
      assert.equal(getShapeData(filled, s.id).kind, 'rectangle');
      const fout = composite(filled);
      assert.deepEqual(getPixel(fout, 2, 2), RED);
      assert.deepEqual(getPixel(fout, 5, 4), RED);
      assert.deepEqual(getPixel(fout, 6, 4), CLEAR);
      assert.deepEqual(getPixel(fout, 2, 5), CLEAR);

      const stroked = createProject(10, 8);
      addShapeLayer(stroked, rectangleShape({ x: 2, y: 2, width: 4, height: 3 }, null, BLUE, 1));
      const sout = composite(stroked);
      assert.deepEqual(getPixel(sout, 2, 2), BLUE);
      assert.deepEqual(getPixel(sout, 5, 2), BLUE);
      assert.deepEqual(getPixel(sout, 3, 4), BLUE);
      assert.deepEqual(getPixel(sout, 3, 3), CLEAR); // interior is not stroked
      assert.deepEqual(getPixel(sout, 6, 2), CLEAR);

      const both = createProject(10, 8);
      addShapeLayer(both, rectangleShape({ x: 2, y: 2, width: 4, height: 3 }, RED, BLUE, 1));
      const bout = composite(both);
      assert.deepEqual(getPixel(bout, 2, 2), BLUE); // stroke over fill on the edge
      assert.deepEqual(getPixel(bout, 3, 3), RED); // fill inside
    });

    test('5.2 Editing shape parameters re-renders the shape', () => {
      const p = createProject(10, 8);
      const s = addShapeLayer(p, rectangleShape({ x: 2, y: 2, width: 4, height: 3 }, RED));
      assert.deepEqual(getPixel(composite(p), 2, 2), RED);
      updateShapeLayer(p, s.id, { rect: { x: 4, y: 2, width: 4, height: 3 } });
      const out = composite(p);
      assert.deepEqual(getPixel(out, 2, 2), CLEAR);
      assert.deepEqual(getPixel(out, 7, 4), RED);
      assert.deepEqual(getShapeData(p, s.id).rect, { x: 4, y: 2, width: 4, height: 3 });
      updateShapeLayer(p, s.id, { fill: GREEN });
      assert.deepEqual(getPixel(composite(p), 7, 4), GREEN);
    });

    test('5.3 Ellipse fill follows the inscribed-ellipse rule', () => {
      const p = createProject(8, 8);
      addShapeLayer(p, ellipseShape({ x: 1, y: 1, width: 6, height: 6 }, GREEN));
      const out = composite(p);
      assert.deepEqual(getPixel(out, 3, 3), GREEN); // near centre
      assert.deepEqual(getPixel(out, 4, 1), GREEN); // top middle: (0.5/3)^2 + (-2.5/3)^2 < 1
      assert.deepEqual(getPixel(out, 6, 3), GREEN); // right middle
      assert.deepEqual(getPixel(out, 1, 1), CLEAR); // corner: (-2.5/3)^2 * 2 > 1
      assert.deepEqual(getPixel(out, 6, 6), CLEAR);
    });

    test('5.4 Ellipse stroke paints the outline and leaves the centre empty', () => {
      const p = createProject(12, 12);
      addShapeLayer(p, ellipseShape({ x: 1, y: 1, width: 10, height: 10 }, null, BLUE, 2));
      const out = composite(p);
      assert.deepEqual(getPixel(out, 10, 5), BLUE); // rightmost outline point
      assert.deepEqual(getPixel(out, 5, 1), BLUE); // top outline point
      assert.deepEqual(getPixel(out, 5, 5), CLEAR); // centre untouched
      assert.deepEqual(getPixel(out, 0, 0), CLEAR);
    });

    test('5.5 Line shapes stroke from endpoint to endpoint', () => {
      const p = createProject(8, 4);
      addShapeLayer(p, lineShape({ x: 1, y: 1 }, { x: 5, y: 1 }, RED, 1));
      const out = composite(p);
      for (const x of [1, 2, 3, 4, 5]) assert.deepEqual(getPixel(out, x, 1), RED);
      assert.deepEqual(getPixel(out, 0, 1), CLEAR);
      assert.deepEqual(getPixel(out, 6, 1), CLEAR);
      assert.deepEqual(getPixel(out, 3, 2), CLEAR);

      const diag = createProject(5, 5);
      addShapeLayer(diag, lineShape({ x: 0, y: 0 }, { x: 3, y: 3 }, RED, 1));
      const dout = composite(diag);
      for (const k of [0, 1, 2, 3]) assert.deepEqual(getPixel(dout, k, k), RED);
      assert.deepEqual(getPixel(dout, 1, 0), CLEAR);
    });

    test('5.6 Polygon fill uses the even-odd rule; polygon stroke follows the edges', () => {
      const tri: Array<{ x: number; y: number }> = [
        { x: 1, y: 1 },
        { x: 8, y: 1 },
        { x: 1, y: 6 }
      ];
      const p = createProject(10, 8);
      addShapeLayer(p, polygonShape(tri, GREEN));
      const out = composite(p);
      assert.deepEqual(getPixel(out, 1, 1), GREEN);
      assert.deepEqual(getPixel(out, 2, 2), GREEN);
      assert.deepEqual(getPixel(out, 6, 4), CLEAR); // beyond the hypotenuse
      assert.deepEqual(getPixel(out, 7, 2), CLEAR);

      const s = createProject(10, 8);
      addShapeLayer(s, polygonShape(tri, null, BLUE, 1));
      const sout = composite(s);
      assert.deepEqual(getPixel(sout, 4, 1), BLUE); // top edge
      assert.deepEqual(getPixel(sout, 1, 3), BLUE); // left edge
      assert.deepEqual(getPixel(sout, 4, 2), CLEAR); // interior not stroked, not filled
    });
  });

  describe('6. Bézier curves and paths', () => {
    const SEG: BezierSegment = { p0: { x: 0, y: 0 }, c1: { x: 0, y: 10 }, c2: { x: 10, y: 10 }, p1: { x: 10, y: 0 } };

    test('6.1 cubicBezierPoint evaluates the real cubic formula exactly', () => {
      assert.deepEqual(cubicBezierPoint(SEG, 0), { x: 0, y: 0 });
      assert.deepEqual(cubicBezierPoint(SEG, 1), { x: 10, y: 0 });
      // Symmetric segment: B(0.5) = (p0 + 3 c1 + 3 c2 + p1) / 8 = (5, 7.5), exact in binary fractions.
      assert.deepEqual(cubicBezierPoint(SEG, 0.5), { x: 5, y: 7.5 });
      assert.deepEqual(cubicBezierPoint(SEG, 0.25), { x: 1.5625, y: 5.625 });
      assert.throws(() => cubicBezierPoint(SEG, 1.5), /t out of range/);
      assert.throws(() => cubicBezierPoint(SEG, -0.1), /t out of range/);
    });

    test('6.2 Flattening samples the curve, joints appear once', () => {
      const flat = flattenBezierSegment(SEG, 8);
      assert.equal(flat.length, 9);
      assert.deepEqual(flat[0], { x: 0, y: 0 });
      assert.deepEqual(flat[4], { x: 5, y: 7.5 }); // the exact midpoint is a polyline vertex
      assert.deepEqual(flat[8], { x: 10, y: 0 });
      const next: BezierSegment = { p0: { x: 10, y: 0 }, c1: { x: 10, y: -10 }, c2: { x: 20, y: -10 }, p1: { x: 20, y: 0 } };
      const path = flattenPath([SEG, next]);
      assert.equal(path.length, 17 + 16); // joint point counted once
      assert.deepEqual(path[16], { x: 10, y: 0 });
      assert.deepEqual(path[32], { x: 20, y: 0 });
    });

    test('6.3 A stroked path passes through the computed curve points', () => {
      const p = createProject(12, 12);
      addShapeLayer(p, pathShape([SEG], { stroke: RED, strokeWidth: 1 }));
      const out = composite(p);
      assert.deepEqual(getPixel(out, 0, 0), RED); // start point
      assert.deepEqual(getPixel(out, 10, 0), RED); // end point
      // The curve passes exactly through (5, 7.5); a width-1 stamp there paints both neighbours.
      assert.deepEqual(getPixel(out, 5, 7), RED);
      assert.deepEqual(getPixel(out, 5, 8), RED);
      assert.deepEqual(getPixel(out, 5, 0), CLEAR); // the curve never visits the top middle
    });

    test('6.4 A closed path fills its interior; the same path open does not fill', () => {
      const blob: BezierSegment[] = [
        { p0: { x: 2, y: 6 }, c1: { x: 2, y: 2 }, c2: { x: 10, y: 2 }, p1: { x: 10, y: 6 } },
        { p0: { x: 10, y: 6 }, c1: { x: 10, y: 10 }, c2: { x: 2, y: 10 }, p1: { x: 2, y: 6 } }
      ];
      const p = createProject(12, 12);
      addShapeLayer(p, pathShape(blob, { closed: true, fill: GREEN }));
      const out = composite(p);
      assert.deepEqual(getPixel(out, 6, 6), GREEN); // interior
      assert.deepEqual(getPixel(out, 6, 2), CLEAR); // above the top arc (apex (6,3))
      assert.deepEqual(getPixel(out, 1, 6), CLEAR); // left of the blob
      const open = createProject(12, 12);
      addShapeLayer(open, pathShape(blob, { closed: false, fill: GREEN }));
      assert.ok(composite(open).data.every((v) => v === 0));
    });
  });

  describe('7. Persistence of editable data', () => {
    function richProject() {
      const p = createProject(24, 18, WHITE);
      const t = addTextLayer(p, {
        text: 'AB',
        font: 'pixel-bold',
        fontSize: 7,
        align: 'center',
        letterSpacing: 3,
        lineSpacing: 2,
        color: { r: 10, g: 20, b: 30, a: 200 },
        outline: { width: 2, color: { r: 1, g: 2, b: 3, a: 255 } },
        shadow: { offsetX: 2, offsetY: 1, blur: 1, color: { r: 9, g: 9, b: 9, a: 128 } },
        origin: { x: 1, y: 1 },
        blockWidth: 20
      });
      setContentTransform(p, t.id, { ...identityTransform(), translateX: 1, translateY: 1 });
      const blob: BezierSegment[] = [
        { p0: { x: 2, y: 3 }, c1: { x: 2, y: 1 }, c2: { x: 10, y: 1 }, p1: { x: 10, y: 3 } },
        { p0: { x: 10, y: 3 }, c1: { x: 10, y: 5 }, c2: { x: 2, y: 5 }, p1: { x: 2, y: 3 } }
      ];
      const s = addShapeLayer(
        p,
        pathShape(blob, { closed: true, fill: { r: 200, g: 100, b: 50, a: 255 }, stroke: BLACK, strokeWidth: 2 })
      );
      const r = addShapeLayer(p, rectangleShape({ x: 14, y: 12, width: 5, height: 4 }, GREEN, BLUE, 1));
      return { p, t, s, r };
    }

    test('7.1 Save/load round-trip preserves every editable field and renders identically', () => {
      const { p, t, s, r } = richProject();
      const textBefore = createTextLayerData(getTextData(p, t.id));
      const shapeBefore = getShapeData(p, s.id);
      const serialized = serializeProject(p);
      const sText = serialized.layers.find((l) => l.id === t.id)!;
      assert.equal(sText.kind, 'text');
      assert.equal(sText.text?.font, 'pixel-bold');
      const restored = deserializeProject(JSON.parse(JSON.stringify(serialized)));
      const rt = getLayer(restored, t.id);
      assert.equal(rt.kind, 'text');
      assert.deepEqual(getTextData(restored, t.id), textBefore);
      assert.deepEqual(rt.contentTransform, [1, 0, 1, 0, 1, 1, 0, 0, 1]);
      const rs = getLayer(restored, s.id);
      assert.equal(rs.kind, 'shape');
      assert.deepEqual(getShapeData(restored, s.id), shapeBefore);
      assert.equal(getShapeData(restored, r.id).kind, 'rectangle');
      // Pixel-identical composite after the round-trip.
      assert.ok(Buffer.from(composite(restored).data).equals(Buffer.from(composite(p).data)));
      // And the loaded project is still editable.
      const beforeEdit = bytes(composite(restored));
      updateTextLayer(restored, t.id, { text: 'C' });
      assert.equal(getTextData(restored, t.id).text, 'C');
      assert.notDeepEqual(bytes(composite(restored)), beforeEdit);
      updateShapeLayer(restored, r.id, { fill: RED });
      assert.deepEqual(getShapeData(restored, r.id).fill, RED);
    });

    test('7.2 Projects written before Phase 48 load as raster layers from their pixels', () => {
      const { p } = richProject();
      const expected = bytes(composite(p));
      const stripped = JSON.parse(JSON.stringify(serializeProject(p)));
      for (const l of stripped.layers) {
        delete l.kind;
        delete l.text;
        delete l.shape;
        delete l.contentTransform;
      }
      const restored = deserializeProject(stripped);
      assert.ok(restored.layers.every((l) => l.kind === 'raster' && l.text === null && l.shape === null));
      assert.deepEqual(bytes(composite(restored)), expected); // pixels carry the content
      const v1 = JSON.parse(JSON.stringify(serializeProject(p)));
      v1.version = 1;
      delete v1.groups;
      for (const l of v1.layers) {
        delete l.blendMode;
        delete l.alphaLock;
        delete l.clipped;
        delete l.groupId;
        delete l.maskBase64;
        delete l.kind;
        delete l.text;
        delete l.shape;
        delete l.contentTransform;
      }
      const restoredV1 = deserializeProject(v1);
      assert.deepEqual(bytes(composite(restoredV1)), expected);
    });

    test('7.3 Corrupt content data is rejected, not silently loaded', () => {
      const { p, t, s } = richProject();
      const missing = JSON.parse(JSON.stringify(serializeProject(p)));
      delete missing.layers.find((l: { id: string }) => l.id === t.id).text;
      assert.throws(() => deserializeProject(missing), /missing its text data/);
      const badFont = JSON.parse(JSON.stringify(serializeProject(p)));
      badFont.layers.find((l: { id: string }) => l.id === t.id).text.font = 'comic-sans';
      assert.throws(() => deserializeProject(badFont), /Unknown built-in font/);
      const badKind = JSON.parse(JSON.stringify(serializeProject(p)));
      badKind.layers.find((l: { id: string }) => l.id === t.id).kind = 'blob';
      assert.throws(() => deserializeProject(badKind), /unknown kind/);
      const badShape = JSON.parse(JSON.stringify(serializeProject(p)));
      badShape.layers.find((l: { id: string }) => l.id === s.id).shape.kind = 'star';
      assert.throws(() => deserializeProject(badShape), /Unknown vector shape kind/);
      const badTransform = JSON.parse(JSON.stringify(serializeProject(p)));
      badTransform.layers.find((l: { id: string }) => l.id === t.id).contentTransform = [1, 2, 3];
      assert.throws(() => deserializeProject(badTransform), /9 finite numbers/);
    });

    test('7.4 Undo/redo carries text and shape layers', () => {
      const p = createProject(16, 12);
      const h = new HistoryStack();
      h.commit(p);
      const t = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
      const s = addShapeLayer(p, rectangleShape({ x: 10, y: 8, width: 3, height: 3 }, BLUE));
      h.commit(p);
      updateTextLayer(p, t.id, { text: 'B' });
      assert.deepEqual(getPixel(composite(p), 0, 0), RED); // B row 0 col 0 is set
      assert.equal(h.undo(p), true);
      assert.equal(getTextData(p, t.id).text, 'A');
      assert.equal(getShapeData(p, s.id).kind, 'rectangle');
      assert.deepEqual(getPixel(composite(p), 0, 0), CLEAR); // A row 0 col 0 is empty again
      assert.deepEqual(getPixel(composite(p), 10, 8), BLUE); // shape layer survived the round trip
      assert.equal(h.redo(p), true);
      assert.equal(getTextData(p, t.id).text, 'B');
      assert.deepEqual(getPixel(composite(p), 0, 0), RED);
    });
  });

  describe('8. Validation', () => {
    test('8.1 Invalid text data is rejected at creation and update', () => {
      const p = createProject(8, 8);
      assert.throws(() => addTextLayer(p, { text: 'A', fontSize: 0 }), /fontSize out of range/);
      assert.throws(() => addTextLayer(p, { text: 'A', fontSize: -3 }), /fontSize out of range/);
      assert.throws(() => addTextLayer(p, { text: 'A', font: 'nope' as never }), /Unknown built-in font/);
      assert.throws(() => addTextLayer(p, { text: 'A', letterSpacing: -1 }), /letterSpacing out of range/);
      assert.throws(() => addTextLayer(p, { text: 'A', outline: { width: 1.5, color: RED } }), /outline width out of range/);
      assert.throws(() => addTextLayer(p, { text: 'A', shadow: { offsetX: 1, offsetY: 1, blur: -1, color: RED } }), /shadow blur out of range/);
      const t = addTextLayer(p, { text: 'A' });
      assert.throws(() => updateTextLayer(p, t.id, { fontSize: 0 }), /fontSize out of range/);
      assert.equal(getTextData(p, t.id).fontSize, 14); // failed update left the data alone (default size)
    });

    test('8.2 Invalid shape data is rejected at creation', () => {
      const p = createProject(8, 8);
      assert.throws(() => polygonShape([{ x: 0, y: 0 }, { x: 1, y: 1 }], RED), /at least 3 points/);
      assert.throws(() => rectangleShape({ x: 0, y: 0, width: 0, height: 2 }, RED), /positive width and height/);
      assert.throws(() => rectangleShape({ x: 0, y: 0, width: 2, height: 2 }, RED, BLUE, -1), /strokeWidth out of range/);
      assert.throws(
        () =>
          addShapeLayer(p, {
            kind: 'path',
            rect: null,
            from: null,
            to: null,
            points: null,
            segments: [],
            closed: false,
            fill: null,
            stroke: RED,
            strokeWidth: 1
          }),
        /at least 1 Bézier segment/
      );
    });

    test('8.3 Kind-checked accessors and updates reject the wrong layer kind', () => {
      const p = createProject(8, 8);
      const t = addTextLayer(p, { text: 'A' });
      const s = addShapeLayer(p, rectangleShape({ x: 0, y: 0, width: 2, height: 2 }, RED));
      assert.throws(() => getTextData(p, s.id), /not a text layer/);
      assert.throws(() => getShapeData(p, t.id), /not a shape layer/);
      assert.throws(() => updateTextLayer(p, s.id, { text: 'X' }), /not a text layer/);
      assert.throws(() => updateShapeLayer(p, t.id, { fill: RED }), /not a shape layer/);
      assert.throws(() => updateTextLayer(p, p.layers[0].id, { text: 'X' }), /not a text layer/);
    });

    test('8.4 Raster layers keep the Phase 19 model and tools', () => {
      const p = createProject(8, 9);
      const raster = addLayer(p);
      assert.equal(raster.kind, 'raster');
      assert.equal(raster.text, null);
      assert.equal(raster.shape, null);
      assert.equal(raster.contentTransform, null);
      drawText(p, raster.id, { x: 1, y: 1 }, 'A', 1, RED); // the Phase 19 text tool still paints pixels
      assert.deepEqual(getPixel(composite(p), 2, 1), RED);
    });
  });
});
