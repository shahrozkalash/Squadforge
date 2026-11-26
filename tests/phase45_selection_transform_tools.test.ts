import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  addLayer,
  getLayer,
  composite,
  createPixelImage,
  getPixel,
  setPixel,
  fillRect,
  rotateImage,
  createLayerMask,
  getLayerMask,
  paintMask,
  createGroup,
  setLayerGroup,
  createSelection,
  rectSelection,
  ellipseSelection,
  polygonSelection,
  lassoSelection,
  magicWandSelection,
  colorRangeSelection,
  invertSelection,
  featherSelection,
  expandSelection,
  contractSelection,
  selectedPixelCount,
  selectionBounds,
  selectionFromLayerAlpha,
  applySelectionAsMask,
  rotateImageFree,
  rotateSelectionFree,
  rotateLayerFree,
  solveHomography,
  perspectiveImage,
  perspectiveSelection,
  perspectiveLayer,
  identityTransform,
  applyTransformToImage,
  applyTransformToSelection,
  transformLayer,
  transformGroup
} from '../server/imageEditor/imageCore.js';
import type { PixelImage, Point, RgbaColor } from '../server/imageEditor/types.js';

const RED: RgbaColor = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RgbaColor = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RgbaColor = { r: 0, g: 0, b: 255, a: 255 };
const WHITE: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
const TRANSPARENT: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };

function selAt(sel: { width: number; data: Uint8ClampedArray }, x: number, y: number): number {
  return sel.data[y * sel.width + x];
}

/** Image where every pixel has a distinct color encoding its coordinates. */
function encodedImage(w: number, h: number): PixelImage {
  const img = createPixelImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      setPixel(img, x, y, { r: 10 + x * 50, g: 20 + y * 50, b: x * 3 + y * 7, a: 255 });
    }
  }
  return img;
}

function buffersEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

describe('SquadForge Phase 45: Professional Selection and Transform Tools Test Suite', () => {
  describe('1. Shape selections', () => {
    test('1.1 Rectangle selection selects exactly the rect, clipped to the canvas', () => {
      const sel = rectSelection(4, 4, { x: 1, y: 1, width: 2, height: 2 });
      assert.equal(selectedPixelCount(sel), 4);
      assert.equal(selAt(sel, 1, 1), 255);
      assert.equal(selAt(sel, 2, 2), 255);
      assert.equal(selAt(sel, 0, 0), 0);
      assert.equal(selAt(sel, 3, 1), 0);
      const clipped = rectSelection(4, 4, { x: 3, y: 3, width: 5, height: 5 });
      assert.equal(selectedPixelCount(clipped), 1);
      assert.equal(selAt(clipped, 3, 3), 255);
    });

    test('1.2 Ellipse selection: pixel centres inside the inscribed ellipse', () => {
      const sel = ellipseSelection(4, 4, { x: 0, y: 0, width: 4, height: 4 });
      // Corners: centre offset (±1.5, ±1.5)/2 -> 0.5625+0.5625 > 1 (out).
      // Edge-adjacent: 0.0625+0.5625 <= 1 (in). Rows hold 2, 4, 4, 2 = 12 pixels.
      assert.equal(selectedPixelCount(sel), 12);
      assert.equal(selAt(sel, 0, 0), 0);
      assert.equal(selAt(sel, 3, 3), 0);
      assert.equal(selAt(sel, 1, 0), 255);
      assert.equal(selAt(sel, 0, 1), 255);
      assert.equal(selAt(sel, 3, 2), 255);
      assert.equal(selAt(sel, 2, 3), 255);
      const empty = ellipseSelection(4, 4, { x: 1, y: 1, width: 0, height: 3 });
      assert.equal(selectedPixelCount(empty), 0);
    });

    test('1.3 Polygon selection fills a triangle by the even-odd centre rule', () => {
      const tri: Point[] = [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 4 }
      ];
      const sel = polygonSelection(5, 5, tri);
      // Centres with (x+0.5)+(y+0.5) < 4, i.e. x+y <= 2: exactly 6 pixels.
      assert.equal(selectedPixelCount(sel), 6);
      for (const [x, y] of [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
        [0, 2]
      ]) {
        assert.equal(selAt(sel, x, y), 255, `expected (${x},${y}) selected`);
      }
      assert.equal(selAt(sel, 4, 0), 0);
      assert.equal(selAt(sel, 0, 4), 0);
      assert.equal(selAt(sel, 4, 4), 0);
      assert.throws(() => polygonSelection(4, 4, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), /at least 3 points/);
    });

    test('1.4 Lasso (freehand) selection closes and fills the pointer path', () => {
      const path: Point[] = [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 1 },
        { x: 3, y: 3 },
        { x: 1, y: 3 },
        { x: 0, y: 2 }
      ];
      const sel = lassoSelection(4, 4, path);
      assert.equal(selectedPixelCount(sel), 8);
      assert.equal(selAt(sel, 1, 1), 255);
      assert.equal(selAt(sel, 2, 2), 255);
      assert.equal(selAt(sel, 0, 0), 255);
      assert.equal(selAt(sel, 2, 0), 0); // centre lies on the slanted edge -> outside by the ray rule
      assert.equal(selAt(sel, 3, 3), 0);
      assert.equal(selAt(sel, 0, 3), 0);
    });
  });

  describe('2. Magic wand and color range', () => {
    function halvesImage(): PixelImage {
      const img = createPixelImage(4, 4);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) setPixel(img, x, y, x < 2 ? RED : BLUE);
      }
      setPixel(img, 3, 3, GREEN);
      return img;
    }

    test('2.1 Wand selects exactly the connected same-color region', () => {
      const img = halvesImage();
      const left = magicWandSelection(img, 0, 0, 0);
      assert.equal(selectedPixelCount(left), 8);
      assert.equal(selAt(left, 1, 3), 255);
      assert.equal(selAt(left, 2, 0), 0);
      const right = magicWandSelection(img, 3, 0, 0);
      assert.equal(selectedPixelCount(right), 7); // right half minus the green pixel
      assert.equal(selAt(right, 3, 3), 0);
      const green = magicWandSelection(img, 3, 3, 0);
      assert.equal(selectedPixelCount(green), 1);
    });

    test('2.2 Wand tolerance boundary is inclusive and exact', () => {
      const img = createPixelImage(3, 1);
      setPixel(img, 0, 0, RED);
      setPixel(img, 1, 0, { r: 250, g: 5, b: 0, a: 255 }); // max channel distance from RED = 5
      setPixel(img, 2, 0, BLUE);
      assert.equal(selectedPixelCount(magicWandSelection(img, 0, 0, 4)), 1);
      assert.equal(selectedPixelCount(magicWandSelection(img, 0, 0, 5)), 2);
    });

    test('2.3 Non-contiguous wand selects every matching pixel, contiguous only its region', () => {
      const img = createPixelImage(3, 1);
      setPixel(img, 0, 0, RED);
      setPixel(img, 1, 0, BLUE);
      setPixel(img, 2, 0, RED);
      assert.equal(selectedPixelCount(magicWandSelection(img, 0, 0, 0, true)), 1);
      const global = magicWandSelection(img, 0, 0, 0, false);
      assert.equal(selectedPixelCount(global), 2);
      assert.equal(selAt(global, 2, 0), 255);
    });

    test('2.4 Color range selects globally by distance to a target color', () => {
      const img = createPixelImage(3, 1);
      setPixel(img, 0, 0, RED);
      setPixel(img, 1, 0, { r: 250, g: 5, b: 0, a: 255 });
      setPixel(img, 2, 0, BLUE);
      assert.equal(selectedPixelCount(colorRangeSelection(img, RED, 4)), 1);
      const near = colorRangeSelection(img, RED, 5);
      assert.equal(selectedPixelCount(near), 2);
      assert.equal(selAt(near, 1, 0), 255);
      const blue = colorRangeSelection(img, BLUE, 0);
      assert.equal(selectedPixelCount(blue), 1);
      assert.equal(selAt(blue, 2, 0), 255);
    });

    test('2.5 Wand starting on a transparent pixel selects the transparent region', () => {
      const p = createProject(4, 4); // background layer is fully transparent
      const sel = magicWandSelection(p.layers[0].image, 2, 2, 0);
      assert.equal(selectedPixelCount(sel), 16); // all pixels identical (0,0,0,0)
    });

    test('2.6 Wand and color range validate their inputs', () => {
      const img = halvesImage();
      assert.throws(() => magicWandSelection(img, 4, 0, 0), /out of bounds/);
      assert.throws(() => magicWandSelection(img, 0, -1, 0), /out of bounds/);
      assert.throws(() => magicWandSelection(img, 0, 0, 256), /Tolerance out of range/);
      assert.throws(() => colorRangeSelection(img, RED, -1), /Tolerance out of range/);
    });
  });

  describe('3. Selection operations: invert, feather, expand, contract', () => {
    test('3.1 Inversion flips every value; empty inverts to full; double inversion restores', () => {
      const sel = rectSelection(4, 4, { x: 1, y: 1, width: 2, height: 2 });
      const inv = invertSelection(sel);
      assert.equal(selectedPixelCount(inv), 12);
      assert.equal(selAt(inv, 0, 0), 255);
      assert.equal(selAt(inv, 1, 1), 0);
      assert.ok(buffersEqual(invertSelection(inv).data, sel.data));
      const empty = createSelection(3, 3);
      assert.equal(selectedPixelCount(invertSelection(empty)), 9);
      assert.equal(selectedPixelCount(sel), 4); // input not mutated
    });

    test('3.2 Feathering a hard edge produces the exact box-blur intermediates', () => {
      const sel = rectSelection(5, 5, { x: 2, y: 0, width: 3, height: 5 });
      const f = featherSelection(sel, 1);
      // Vertical edge between x=1 (0) and x=2 (255): radius-1 box blur gives 85 / 170.
      for (const y of [0, 2, 4]) {
        assert.equal(selAt(f, 0, y), 0);
        assert.equal(selAt(f, 1, y), 85);
        assert.equal(selAt(f, 2, y), 170);
        assert.equal(selAt(f, 3, y), 255);
        assert.equal(selAt(f, 4, y), 255);
      }
      assert.ok(buffersEqual(featherSelection(sel, 0).data, sel.data)); // radius 0 = identity
      assert.equal(selAt(sel, 1, 0), 0); // input not mutated
      assert.throws(() => featherSelection(sel, -1), /out of range/);
    });

    test('3.3 Feathering an empty selection keeps it empty', () => {
      const f = featherSelection(createSelection(4, 4), 2);
      assert.equal(selectedPixelCount(f), 0);
      assert.equal(selectionBounds(f), null);
    });

    test('3.4 Expansion grows the selected area by the exact ring', () => {
      const sel = createSelection(5, 5);
      sel.data[2 * 5 + 2] = 255;
      const e1 = expandSelection(sel, 1);
      assert.equal(selectedPixelCount(e1), 9); // 3x3 block
      assert.equal(selAt(e1, 1, 1), 255);
      assert.equal(selAt(e1, 3, 3), 255);
      assert.equal(selAt(e1, 0, 0), 0);
      assert.equal(selectedPixelCount(expandSelection(sel, 2)), 25); // whole 5x5
      assert.equal(selectedPixelCount(sel), 1); // input not mutated
      assert.ok(buffersEqual(expandSelection(sel, 0).data, sel.data));
      assert.equal(selectedPixelCount(expandSelection(createSelection(4, 4), 2)), 0); // empty stays empty
      assert.throws(() => expandSelection(sel, -1), /out of range/);
    });

    test('3.5 Expansion propagates partial (feathered) values by maximum', () => {
      const sel = createSelection(5, 5);
      sel.data[2 * 5 + 2] = 128;
      const e = expandSelection(sel, 1);
      assert.equal(selAt(e, 1, 1), 128);
      assert.equal(selAt(e, 3, 2), 128);
      assert.equal(selAt(e, 0, 0), 0);
    });

    test('3.6 Contraction erodes the exact ring; thin regions vanish', () => {
      const sel = rectSelection(5, 5, { x: 1, y: 1, width: 3, height: 3 });
      const c1 = contractSelection(sel, 1);
      assert.equal(selectedPixelCount(c1), 1);
      assert.equal(selAt(c1, 2, 2), 255);
      assert.equal(selectedPixelCount(contractSelection(sel, 2)), 0);
      const dot = createSelection(5, 5);
      dot.data[2 * 5 + 2] = 255;
      assert.equal(selectedPixelCount(contractSelection(dot, 1)), 0);
      assert.throws(() => contractSelection(sel, -2), /out of range/);
    });

    test('3.7 Selection bounds report the tight box, or null when empty', () => {
      const sel = rectSelection(5, 5, { x: 1, y: 2, width: 2, height: 1 });
      assert.deepEqual(selectionBounds(sel), { x: 1, y: 2, width: 2, height: 1 });
      assert.equal(selectionBounds(createSelection(5, 5)), null);
    });
  });

  describe('4. Bridges to layers and masks (Phase 44 model)', () => {
    test('4.1 Selection from a layer alpha footprint', () => {
      const p = createProject(4, 4);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 2, height: 4 }, RED);
      const sel = selectionFromLayerAlpha(p, top.id);
      assert.equal(selectedPixelCount(sel), 8);
      assert.equal(selAt(sel, 0, 0), 255);
      assert.equal(selAt(sel, 3, 3), 0);
      const empty = selectionFromLayerAlpha(p, p.layers[0].id);
      assert.equal(selectedPixelCount(empty), 0);
      assert.equal(selectionBounds(empty), null);
    });

    test('4.2 Selection from layer alpha honors semi-alpha and the layer mask', () => {
      const p = createProject(4, 4);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, RED);
      setPixel(top.image, 3, 3, { r: 255, g: 0, b: 0, a: 128 });
      createLayerMask(p, top.id, 255);
      paintMask(p, top.id, [{ x: 0, y: 0 }], 0.5, 0);
      const sel = selectionFromLayerAlpha(p, top.id);
      assert.equal(selAt(sel, 0, 0), 0); // masked out
      assert.equal(selAt(sel, 1, 0), 255);
      assert.equal(selAt(sel, 3, 3), 128); // semi-transparent alpha carried through
    });

    test('4.3 A selection becomes a layer mask and drives the composite', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      const sel = rectSelection(4, 4, { x: 0, y: 0, width: 2, height: 4 });
      applySelectionAsMask(p, top.id, sel);
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE);
      assert.deepEqual(getPixel(composite(p), 3, 3), RED);
      const mask = getLayerMask(p, top.id)!;
      assert.ok(buffersEqual(mask.data, sel.data));
      sel.data[0] = 0; // the mask holds its own copy
      assert.equal(mask.data[0], 255);
      assert.throws(() => applySelectionAsMask(p, top.id, createSelection(2, 2)), /does not match/);
    });
  });

  describe('5. Free rotation (bilinear)', () => {
    test('5.1 Rotation by 0 degrees is an exact identity', () => {
      const img = encodedImage(4, 3);
      assert.ok(buffersEqual(rotateImageFree(img, 0).data, img.data));
    });

    test('5.2 Rotation by 90/180/270 degrees reproduces the exact step rotations', () => {
      const sq = encodedImage(4, 4);
      assert.ok(buffersEqual(rotateImageFree(sq, 90).data, rotateImage(sq, 90).data));
      assert.ok(buffersEqual(rotateImageFree(sq, 270).data, rotateImage(sq, 270).data));
      const wide = encodedImage(4, 2);
      assert.ok(buffersEqual(rotateImageFree(wide, 180).data, rotateImage(wide, 180).data));
    });

    test('5.3 Arbitrary angle: centre is fixed, corners fall off the source', () => {
      const img = createPixelImage(5, 5, WHITE);
      setPixel(img, 2, 2, RED);
      const out = rotateImageFree(img, 45);
      assert.deepEqual(getPixel(out, 2, 2), RED); // centre maps to itself exactly
      // Corner (0,0) samples the source at (2-2*sqrt(2), 2) = (-0.828, 2):
      // only the (0,2) tap is inside, with weight 0.1716 -> alpha round(255*0.1716) = 44.
      assert.equal(getPixel(out, 0, 0).a, 44);
      assert.equal(getPixel(out, 0, 2).a, 255); // edge midpoint still lands inside the source
      assert.throws(() => rotateImageFree(img, Number.NaN), /out of range/);
    });

    test('5.4 Rotating a layer rotates its mask with it', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      createLayerMask(p, top.id, 255);
      paintMask(p, top.id, [{ x: 0, y: 0 }], 0.5, 0); // knock out (0,0)
      assert.deepEqual(getPixel(composite(p), 0, 0), RED);
      assert.deepEqual(getPixel(composite(p), 3, 0), BLUE);
      rotateLayerFree(p, top.id, 90);
      const mask = getLayerMask(p, top.id)!;
      assert.equal(mask.data[0 * 4 + 3], 0); // the knockout moved (0,0) -> (3,0), the rotateImage(90) mapping
      assert.deepEqual(getPixel(composite(p), 3, 0), RED);
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE);
    });

    test('5.5 Rotating a selection by 90 degrees moves the selected column to the top row', () => {
      const sel = rectSelection(4, 4, { x: 0, y: 0, width: 1, height: 4 });
      const out = rotateSelectionFree(sel, 90);
      assert.equal(selectedPixelCount(out), 4);
      for (let x = 0; x < 4; x++) assert.equal(selAt(out, x, 0), 255);
      assert.equal(selAt(out, 0, 1), 0);
      assert.equal(selAt(out, 3, 3), 0);
    });
  });

  describe('6. Transform model (handles: translate / scale / rotate about a centre)', () => {
    test('6.1 The identity transform is an exact copy', () => {
      const img = encodedImage(4, 4);
      assert.ok(buffersEqual(applyTransformToImage(img, identityTransform(1.5, 1.5)).data, img.data));
    });

    test('6.2 Translation shifts pixels exactly and vacated pixels are transparent', () => {
      const img = encodedImage(4, 4);
      const t = { ...identityTransform(0, 0), translateX: 1 };
      const out = applyTransformToImage(img, t);
      assert.deepEqual(getPixel(out, 0, 0), TRANSPARENT);
      assert.deepEqual(getPixel(out, 0, 3), TRANSPARENT);
      assert.deepEqual(getPixel(out, 1, 0), getPixel(img, 0, 0));
      assert.deepEqual(getPixel(out, 3, 2), getPixel(img, 2, 2));
    });

    test('6.3 Rotation about the centre through the transform model equals the exact 90 step', () => {
      const img = encodedImage(4, 4);
      const t = { ...identityTransform(1.5, 1.5), rotationDeg: 90 };
      assert.ok(buffersEqual(applyTransformToImage(img, t).data, rotateImage(img, 90).data));
    });

    test('6.4 Scaling a selection about its centre spreads the centre pixel bilinearly', () => {
      const sel = createSelection(5, 5);
      sel.data[2 * 5 + 2] = 255;
      const t = { ...identityTransform(2, 2), scaleX: 2, scaleY: 2 };
      const out = applyTransformToSelection(sel, t);
      assert.equal(selAt(out, 2, 2), 255); // centre fixed
      assert.equal(selAt(out, 3, 2), 128); // source (2.5, 2): half-weight of the centre pixel
      assert.equal(selAt(out, 1, 2), 128);
      assert.equal(selAt(out, 2, 1), 128);
      assert.equal(selAt(out, 3, 3), 64); // source (2.5, 2.5): quarter weight
      assert.equal(selAt(out, 4, 2), 0); // source (3, 2): empty
      assert.equal(selAt(out, 0, 0), 0);
    });

    test('6.5 Transforming a layer moves its pixels and its mask together', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      setPixel(top.image, 0, 0, BLUE);
      createLayerMask(p, top.id, 255);
      paintMask(p, top.id, [{ x: 0, y: 0 }], 0.5, 0);
      transformLayer(p, top.id, { ...identityTransform(0, 0), translateX: 1 });
      assert.deepEqual(getPixel(top.image, 1, 0), BLUE);
      assert.equal(getPixel(top.image, 0, 0).a, 0);
      const mask = getLayerMask(p, top.id)!;
      assert.equal(mask.data[0 * 4 + 1], 0); // mask zero moved to (1,0)
      assert.equal(mask.data[0 * 4 + 2], 255);
      assert.deepEqual(getPixel(composite(p), 1, 0), RED); // moved pixel is masked out, as before
    });

    test('6.6 Transforming a group transforms every layer in its subtree only', () => {
      const p = createProject(4, 4, RED);
      const g = createGroup(p, 'g');
      const inner = createGroup(p, 'inner', g.id);
      const a = addLayer(p, 'a');
      setPixel(a.image, 0, 0, BLUE);
      setLayerGroup(p, a.id, g.id);
      const b = addLayer(p, 'b');
      setPixel(b.image, 1, 0, GREEN);
      setLayerGroup(p, b.id, inner.id);
      transformGroup(p, g.id, { ...identityTransform(0, 0), translateY: 1 });
      assert.deepEqual(getPixel(a.image, 0, 1), BLUE);
      assert.equal(getPixel(a.image, 0, 0).a, 0);
      assert.deepEqual(getPixel(b.image, 1, 1), GREEN);
      assert.deepEqual(getPixel(p.layers[0].image, 0, 0), RED); // background (outside the group) untouched
    });

    test('6.7 Transforms of a 1x1 layer: rotation is identity, translation off-canvas clears it', () => {
      const img = createPixelImage(1, 1, RED);
      assert.deepEqual(getPixel(rotateImageFree(img, 33), 0, 0), RED);
      const moved = applyTransformToImage(img, { ...identityTransform(0, 0), translateX: 5 });
      assert.equal(getPixel(moved, 0, 0).a, 0);
      const sel = createSelection(1, 1, 255);
      assert.equal(selAt(rotateSelectionFree(sel, 45), 0, 0), 255);
    });

    test('6.8 Degenerate transforms are rejected', () => {
      const img = encodedImage(2, 2);
      assert.throws(() => applyTransformToImage(img, { ...identityTransform(0, 0), scaleX: 0 }), /non-zero/);
      assert.throws(() => applyTransformToImage(img, { ...identityTransform(0, 0), rotationDeg: Number.NaN }), /out of range/);
    });
  });

  describe('7. Perspective transformation', () => {
    function applyH(h: number[], p: Point): Point {
      const w = h[6] * p.x + h[7] * p.y + h[8];
      return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
    }

    test('7.1 solveHomography finds the keystone matrix and maps every corner', () => {
      const src: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 }
      ];
      const dst: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 2 }
      ];
      const h = solveHomography(src, dst);
      // The closed form of this warp is [[1,0,0],[0,1,0],[0.5,0,1]].
      const expected = [1, 0, 0, 0, 1, 0, 0.5, 0, 1];
      for (let i = 0; i < 9; i++) assert.ok(Math.abs(h[i] - expected[i]) < 1e-9, `h[${i}] = ${h[i]}, expected ${expected[i]}`);
      for (let i = 0; i < 4; i++) {
        const mapped = applyH(h, src[i]);
        assert.ok(Math.abs(mapped.x - dst[i].x) < 1e-9 && Math.abs(mapped.y - dst[i].y) < 1e-9);
      }
    });

    test('7.2 Corner translation warps pixels exactly one step right', () => {
      const img = encodedImage(4, 4);
      const corners: [Point, Point, Point, Point] = [
        { x: 1, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 1, y: 3 }
      ];
      const out = perspectiveImage(img, corners);
      assert.deepEqual(getPixel(out, 0, 0), TRANSPARENT);
      assert.deepEqual(getPixel(out, 0, 3), TRANSPARENT);
      assert.deepEqual(getPixel(out, 1, 0), getPixel(img, 0, 0));
      assert.deepEqual(getPixel(out, 3, 3), getPixel(img, 2, 3));
    });

    test('7.3 A 2x corner expansion samples bilinear midpoints exactly', () => {
      const img = createPixelImage(4, 4);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) setPixel(img, x, y, { r: x * 40, g: y * 40, b: 0, a: 255 });
      }
      const corners: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 6 },
        { x: 0, y: 6 }
      ];
      const out = perspectiveImage(img, corners);
      assert.deepEqual(getPixel(out, 0, 0), { r: 0, g: 0, b: 0, a: 255 });
      assert.deepEqual(getPixel(out, 2, 2), { r: 40, g: 40, b: 0, a: 255 }); // source (1,1) exactly
      assert.deepEqual(getPixel(out, 1, 1), { r: 20, g: 20, b: 0, a: 255 }); // source (0.5,0.5): mean of 4
      assert.deepEqual(getPixel(out, 3, 3), { r: 60, g: 60, b: 0, a: 255 }); // source (1.5,1.5): mean of 4
    });

    test('7.4 Keystone warp lands known source pixels on known destinations', () => {
      const img = encodedImage(3, 3);
      const corners: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 2 }
      ];
      const out = perspectiveImage(img, corners);
      // Inverse keystone (H^-1 has p = -0.5): dest (1,0) <- src (2,0), dest (1,1) <- src (2,2).
      assert.deepEqual(getPixel(out, 0, 0), getPixel(img, 0, 0));
      assert.deepEqual(getPixel(out, 1, 0), getPixel(img, 2, 0));
      assert.deepEqual(getPixel(out, 1, 1), getPixel(img, 2, 2));
      assert.deepEqual(getPixel(out, 0, 1), getPixel(img, 0, 1));
      assert.deepEqual(getPixel(out, 0, 2), getPixel(img, 0, 2));
    });

    test('7.5 Perspective-warping a selection moves the selected region', () => {
      const sel = rectSelection(4, 4, { x: 0, y: 0, width: 1, height: 4 });
      const corners: [Point, Point, Point, Point] = [
        { x: 1, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 1, y: 3 }
      ];
      const out = perspectiveSelection(sel, corners);
      assert.equal(selectedPixelCount(out), 4);
      assert.equal(selAt(out, 1, 0), 255);
      assert.equal(selAt(out, 1, 3), 255);
      assert.equal(selAt(out, 0, 0), 0);
    });

    test('7.6 Perspective-warping a layer warps its mask with it', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      setPixel(top.image, 0, 0, BLUE);
      createLayerMask(p, top.id, 255);
      paintMask(p, top.id, [{ x: 0, y: 0 }], 0.5, 0);
      const corners: [Point, Point, Point, Point] = [
        { x: 1, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 1, y: 3 }
      ];
      perspectiveLayer(p, top.id, corners);
      assert.deepEqual(getPixel(top.image, 1, 0), BLUE);
      const mask = getLayerMask(p, top.id)!;
      assert.equal(mask.data[0 * 4 + 1], 0);
      assert.equal(mask.data[0 * 4 + 2], 255);
    });

    test('7.7 Degenerate corner configurations are rejected, including a 1x1 image', () => {
      const img = createPixelImage(1, 1, RED);
      const corners: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 }
      ];
      // A 1x1 image's four source corners coincide, so no homography exists.
      assert.throws(() => perspectiveImage(img, corners), /degenerate/);
      const img4 = encodedImage(4, 4);
      const collinear: [Point, Point, Point, Point] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 2 }
      ];
      assert.throws(() => perspectiveImage(img4, collinear), /degenerate/);
      assert.throws(() => perspectiveImage(img4, [{ x: 0, y: 0 }] as never), /exactly 4/);
    });
  });
});
