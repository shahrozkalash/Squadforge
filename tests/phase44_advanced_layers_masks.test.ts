import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  createProject,
  addLayer,
  setLayerOpacity,
  composite,
  getPixel,
  setPixel,
  fillRect,
  brushStroke,
  eraserStroke,
  drawText,
  cropProject,
  setLayerBlendMode,
  setLayerAlphaLock,
  setLayerClipped,
  createGroup,
  getGroup,
  removeGroup,
  setGroupParent,
  setGroupVisibility,
  setGroupOpacity,
  setGroupBlendMode,
  setLayerGroup,
  createLayerMask,
  getLayerMask,
  removeLayerMask,
  invertLayerMask,
  paintMask,
  applyLayerMask,
  serializeProject,
  deserializeProject,
  HistoryStack
} from '../server/imageEditor/imageCore.js';
import type { RgbaColor } from '../server/imageEditor/types.js';

const RED: RgbaColor = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RgbaColor = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RgbaColor = { r: 0, g: 0, b: 255, a: 255 };
const WHITE: RgbaColor = { r: 255, g: 255, b: 255, a: 255 };
const YELLOW: RgbaColor = { r: 255, g: 255, b: 0, a: 255 };
const GRAY: RgbaColor = { r: 128, g: 128, b: 128, a: 255 };

function assertPixelNear(actual: RgbaColor, expected: RgbaColor, tol = 1, label = ''): void {
  for (const ch of ['r', 'g', 'b', 'a'] as const) {
    assert.ok(
      Math.abs(actual[ch] - expected[ch]) <= tol,
      `${label} channel ${ch}: expected ~${expected[ch]}, got ${actual[ch]} (pixel ${JSON.stringify(actual)})`
    );
  }
}

/** Two-layer project: opaque backdrop color, opaque top layer filled with `top`, blend mode applied to the top. */
function blendedPair(backdrop: RgbaColor, top: RgbaColor, mode: Parameters<typeof setLayerBlendMode>[2]): RgbaColor {
  const p = createProject(2, 2, backdrop);
  const t = addLayer(p);
  fillRect(p, t.id, { x: 0, y: 0, width: 2, height: 2 }, top);
  setLayerBlendMode(p, t.id, mode);
  return getPixel(composite(p), 0, 0);
}

describe('SquadForge Phase 44: Advanced Layers and Masks Test Suite', () => {
  describe('1. Blend modes (pixel-exact compositing)', () => {
    const CB: RgbaColor = { r: 200, g: 100, b: 50, a: 255 };
    const CS: RgbaColor = { r: 128, g: 255, b: 0, a: 255 };

    test('1.1 Multiply: B = Cb*Cs per channel', () => {
      // (200*128/255, 100*255/255, 50*0/255) = (100.4, 100, 0)
      assertPixelNear(blendedPair(CB, CS, 'multiply'), { r: 100, g: 100, b: 0, a: 255 }, 1, 'multiply');
    });

    test('1.2 Screen: B = 1-(1-Cb)(1-Cs) per channel', () => {
      // (255-55*127/255, 255-155*0, 255-205*255/255) = (227.6, 255, 50)
      assertPixelNear(blendedPair(CB, CS, 'screen'), { r: 228, g: 255, b: 50, a: 255 }, 1, 'screen');
    });

    test('1.3 Overlay: dark backdrop doubles, light backdrop screens', () => {
      const dark: RgbaColor = { r: 64, g: 64, b: 64, a: 255 };
      const mid: RgbaColor = { r: 128, g: 128, b: 128, a: 255 };
      // Cb=64/255<=0.5 -> 2*Cb*Cs = 2*64*128/255 = 64.25
      assertPixelNear(blendedPair(dark, mid, 'overlay'), { r: 64, g: 64, b: 64, a: 255 }, 1, 'overlay dark');
      const light: RgbaColor = { r: 192, g: 192, b: 192, a: 255 };
      // Cb=192/255>0.5 -> 255-2*(63*127)/255 = 255-62.8 = 192.2
      assertPixelNear(blendedPair(light, mid, 'overlay'), { r: 192, g: 192, b: 192, a: 255 }, 1, 'overlay light');
    });

    test('1.4 Darken takes the per-channel minimum, Lighten the maximum', () => {
      assert.deepEqual(blendedPair(CB, CS, 'darken'), { r: 128, g: 100, b: 0, a: 255 });
      assert.deepEqual(blendedPair(CB, CS, 'lighten'), { r: 200, g: 255, b: 50, a: 255 });
    });

    test('1.5 Blend modes mix with partial opacity via the W3C formula', () => {
      // 50% opaque blue multiply over opaque red: B = 0, result = 0.5*0 + 0.5*red
      const p = createProject(2, 2, RED);
      const t = addLayer(p);
      fillRect(p, t.id, { x: 0, y: 0, width: 2, height: 2 }, BLUE);
      setLayerBlendMode(p, t.id, 'multiply');
      setLayerOpacity(p, t.id, 0.5);
      assertPixelNear(getPixel(composite(p), 0, 0), { r: 128, g: 0, b: 0, a: 255 }, 1, 'multiply @50%');
    });

    test('1.6 Unknown blend modes are rejected', () => {
      const p = createProject(2, 2, RED);
      assert.throws(() => setLayerBlendMode(p, p.layers[0].id, 'vivid-light' as never), /Unknown blend mode/);
      const g = createGroup(p, 'g');
      assert.throws(() => setGroupBlendMode(p, g.id, 'hue' as never), /Unknown blend mode/);
    });
  });

  describe('2. Layer masks', () => {
    function maskedProject(maskFill: number) {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      createLayerMask(p, top.id, maskFill);
      return { p, top };
    }

    test('2.1 White mask reveals fully, black mask hides fully, gray halves alpha', () => {
      assert.deepEqual(getPixel(composite(maskedProject(255).p), 1, 1), BLUE);
      assert.deepEqual(getPixel(composite(maskedProject(0).p), 1, 1), RED);
      // mask 128 -> effective alpha 128/255: r=255*(1-128/255)=127, b=255*128/255=128
      assertPixelNear(getPixel(composite(maskedProject(128).p), 1, 1), { r: 127, g: 0, b: 128, a: 255 }, 1, 'gray mask');
    });

    test('2.2 Painting the mask edits where the layer shows', () => {
      const { p, top } = maskedProject(255);
      paintMask(p, top.id, [{ x: 1, y: 1 }], 0.5, 0);
      const mask = getLayerMask(p, top.id)!;
      assert.equal(mask.data[1 * 4 + 1], 0);
      assert.equal(mask.data[3 * 4 + 3], 255); // untouched corner
      assert.deepEqual(getPixel(composite(p), 1, 1), RED); // hidden by mask
      assert.deepEqual(getPixel(composite(p), 3, 3), BLUE); // still revealed
    });

    test('2.3 Mask painting honors strength (partial blend toward the value)', () => {
      const { p, top } = maskedProject(255);
      paintMask(p, top.id, [{ x: 2, y: 2 }], 0.5, 0, 0.5);
      assert.equal(getLayerMask(p, top.id)!.data[2 * 4 + 2], 128); // round(255*0.5)
    });

    test('2.4 Mask inversion flips every value and the composite follows', () => {
      const { p, top } = maskedProject(255);
      paintMask(p, top.id, [{ x: 0, y: 0 }], 0.5, 30);
      invertLayerMask(p, top.id);
      const mask = getLayerMask(p, top.id)!;
      assert.equal(mask.data[0], 225); // 255-30
      assert.equal(mask.data[5], 0); // 255-255
      assert.deepEqual(getPixel(composite(p), 1, 1), RED); // was revealed, now hidden
      assertPixelNear(getPixel(composite(p), 0, 0), { r: 30, g: 0, b: 225, a: 255 }, 1, 'inverted mask composite');
    });

    test('2.5 Applying the mask bakes it into layer alpha and removes it', () => {
      const { p, top } = maskedProject(128);
      applyLayerMask(p, top.id);
      assert.equal(getLayerMask(p, top.id), null);
      assert.equal(getPixel(top.image, 0, 0).a, 128); // round(255*128/255)
      assertPixelNear(getPixel(composite(p), 0, 0), { r: 127, g: 0, b: 128, a: 255 }, 1, 'applied mask');
    });

    test('2.6 Removing the mask restores full visibility; mask ops without a mask throw', () => {
      const { p, top } = maskedProject(0);
      removeLayerMask(p, top.id);
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE);
      assert.throws(() => invertLayerMask(p, top.id), /no mask/);
      assert.throws(() => paintMask(p, top.id, [{ x: 0, y: 0 }], 1, 0), /no mask/);
      assert.throws(() => applyLayerMask(p, top.id), /no mask/);
      assert.throws(() => createLayerMask(p, top.id, 300), /out of range/);
    });

    test('2.7 Masks stay aligned with their layer through cropping', () => {
      const p = createProject(6, 6, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 6, height: 6 }, BLUE);
      createLayerMask(p, top.id, 255);
      paintMask(p, top.id, [{ x: 5, y: 5 }], 0.5, 0);
      cropProject(p, { x: 3, y: 3, width: 3, height: 3 });
      const mask = getLayerMask(p, top.id)!;
      assert.equal(mask.width, 3);
      assert.equal(mask.data[2 * 3 + 2], 0); // the painted spot moved to (2,2)
      assert.deepEqual(getPixel(composite(p), 2, 2), RED);
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE);
    });
  });

  describe('3. Nested layer groups', () => {
    function groupedProject() {
      const p = createProject(4, 4, RED);
      const outer = createGroup(p, 'Outer');
      const inner = createGroup(p, 'Inner', outer.id);
      const leaf = addLayer(p, 'leaf');
      fillRect(p, leaf.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerGroup(p, leaf.id, inner.id);
      return { p, outer, inner, leaf };
    }

    test('3.1 A layer inside nested groups composites; hiding any ancestor hides it', () => {
      const { p, outer, inner } = groupedProject();
      assert.deepEqual(getPixel(composite(p), 1, 1), BLUE);
      setGroupVisibility(p, inner.id, false);
      assert.deepEqual(getPixel(composite(p), 1, 1), RED);
      setGroupVisibility(p, inner.id, true);
      setGroupVisibility(p, outer.id, false);
      assert.deepEqual(getPixel(composite(p), 1, 1), RED);
    });

    test('3.2 Group opacity scales the whole subtree', () => {
      const { p, inner } = groupedProject();
      setGroupOpacity(p, inner.id, 0.5);
      assertPixelNear(getPixel(composite(p), 1, 1), { r: 128, g: 0, b: 127, a: 255 }, 1, 'group opacity');
    });

    test('3.3 Group blend mode applies to the flattened group, not per child', () => {
      const p = createProject(2, 2, GRAY);
      const g = createGroup(p, 'g');
      const leaf = addLayer(p);
      fillRect(p, leaf.id, { x: 0, y: 0, width: 2, height: 2 }, WHITE);
      setLayerGroup(p, leaf.id, g.id);
      assert.deepEqual(getPixel(composite(p), 0, 0), WHITE); // normal group: white wins
      setGroupBlendMode(p, g.id, 'multiply');
      assert.deepEqual(getPixel(composite(p), 0, 0), GRAY); // white multiply = backdrop unchanged
    });

    test('3.4 Child blend modes resolve inside the group, isolated from the backdrop', () => {
      const p = createProject(2, 2, BLUE);
      const g = createGroup(p, 'g');
      const a = addLayer(p, 'a');
      fillRect(p, a.id, { x: 0, y: 0, width: 2, height: 2 }, RED);
      setLayerGroup(p, a.id, g.id);
      const b = addLayer(p, 'b');
      fillRect(p, b.id, { x: 0, y: 0, width: 2, height: 2 }, WHITE);
      setLayerBlendMode(p, b.id, 'multiply');
      setLayerGroup(p, b.id, g.id);
      // Inside the group: white multiply over red = red. If the multiply
      // leaked to the blue backdrop the result would be blue.
      assert.deepEqual(getPixel(composite(p), 0, 0), RED);
    });

    test('3.5 Group cycles are rejected; missing groups are rejected', () => {
      const { p, outer, inner, leaf } = groupedProject();
      assert.throws(() => setGroupParent(p, outer.id, inner.id), /inside itself or its descendants/);
      assert.throws(() => setGroupParent(p, outer.id, outer.id), /inside itself or its descendants/);
      assert.throws(() => createGroup(p, 'x', 'missing'), /not found/);
      assert.throws(() => setLayerGroup(p, leaf.id, 'missing'), /not found/);
      assert.equal(getGroup(p, inner.id).parentId, outer.id);
    });

    test('3.6 Removing a group lifts its children; deleting contents removes them', () => {
      const { p, inner, leaf } = groupedProject();
      removeGroup(p, inner.id);
      assert.equal(leaf.groupId, getGroup(p, p.groups[0].id).id); // lifted to Outer
      assert.deepEqual(getPixel(composite(p), 1, 1), BLUE); // still renders
      const g2 = createGroup(p, 'Temp');
      const extra = addLayer(p, 'extra');
      fillRect(p, extra.id, { x: 0, y: 0, width: 4, height: 4 }, GREEN);
      setLayerGroup(p, extra.id, g2.id);
      removeGroup(p, g2.id, true);
      assert.equal(p.layers.some((l) => l.id === extra.id), false);
      assert.equal(p.groups.some((g) => g.id === g2.id), false);
    });
  });

  describe('4. Clipping', () => {
    test('4.1 A clipped layer only shows where the layer below has alpha', () => {
      const p = createProject(4, 4, RED);
      const base = addLayer(p, 'base');
      fillRect(p, base.id, { x: 0, y: 0, width: 2, height: 4 }, GREEN); // left half
      const clip = addLayer(p, 'clip');
      fillRect(p, clip.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerClipped(p, clip.id, true);
      assert.deepEqual(getPixel(composite(p), 1, 1), BLUE); // over base footprint
      assert.deepEqual(getPixel(composite(p), 3, 1), RED); // outside footprint: clipped away
    });

    test('4.2 A clipped layer with nothing below it contributes nothing', () => {
      const p = createProject(2, 2);
      fillRect(p, p.layers[0].id, { x: 0, y: 0, width: 2, height: 2 }, BLUE);
      setLayerClipped(p, p.layers[0].id, true);
      assert.equal(getPixel(composite(p), 0, 0).a, 0);
    });

    test('4.3 Consecutive clipped layers share the same base', () => {
      const p = createProject(4, 4, RED);
      const base = addLayer(p, 'base');
      fillRect(p, base.id, { x: 0, y: 0, width: 2, height: 4 }, GREEN);
      const c1 = addLayer(p, 'c1');
      fillRect(p, c1.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerClipped(p, c1.id, true);
      const c2 = addLayer(p, 'c2');
      fillRect(p, c2.id, { x: 0, y: 0, width: 4, height: 4 }, YELLOW);
      setLayerClipped(p, c2.id, true);
      assert.deepEqual(getPixel(composite(p), 1, 1), YELLOW); // top clipped layer wins inside footprint
      assert.deepEqual(getPixel(composite(p), 3, 1), RED);
    });

    test('4.4 The base layer mask shapes the clipping footprint', () => {
      const p = createProject(4, 4, RED);
      const base = addLayer(p, 'base');
      fillRect(p, base.id, { x: 0, y: 0, width: 4, height: 4 }, GREEN);
      createLayerMask(p, base.id, 255);
      paintMask(p, base.id, [{ x: 3, y: 1 }], 0.5, 0); // knock out one pixel of the base
      const clip = addLayer(p, 'clip');
      fillRect(p, clip.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerClipped(p, clip.id, true);
      assert.deepEqual(getPixel(composite(p), 1, 1), BLUE);
      assert.deepEqual(getPixel(composite(p), 3, 1), RED); // base masked out here -> clip gone, base gone
    });

    test('4.5 A group can serve as the clipping base for a layer above it', () => {
      const p = createProject(4, 4, RED);
      const g = createGroup(p, 'g');
      const inside = addLayer(p, 'inside');
      fillRect(p, inside.id, { x: 0, y: 0, width: 2, height: 4 }, GREEN);
      setLayerGroup(p, inside.id, g.id);
      const clip = addLayer(p, 'clip');
      fillRect(p, clip.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerClipped(p, clip.id, true);
      assert.deepEqual(getPixel(composite(p), 1, 1), BLUE);
      assert.deepEqual(getPixel(composite(p), 3, 1), RED);
    });
  });

  describe('5. Alpha lock', () => {
    test('5.1 Locked brush cannot create alpha on transparent pixels', () => {
      const p = createProject(6, 6);
      const layer = p.layers[0];
      setLayerAlphaLock(p, layer.id, true);
      brushStroke(p, layer.id, [{ x: 3, y: 3 }], 1, RED);
      assert.equal(getPixel(layer.image, 3, 3).a, 0);
      fillRect(p, layer.id, { x: 0, y: 0, width: 6, height: 6 }, RED);
      assert.equal(getPixel(layer.image, 0, 0).a, 0);
      drawText(p, layer.id, { x: 0, y: 0 }, 'A', 1, RED);
      assert.equal(getPixel(layer.image, 2, 0).a, 0);
    });

    test('5.2 Locked brush recolors existing pixels but preserves their alpha exactly', () => {
      const p = createProject(6, 6, WHITE);
      const layer = p.layers[0];
      setPixel(layer.image, 3, 3, { r: 0, g: 0, b: 0, a: 100 });
      setLayerAlphaLock(p, layer.id, true);
      brushStroke(p, layer.id, [{ x: 1, y: 1 }], 0.5, BLUE);
      assert.deepEqual(getPixel(layer.image, 1, 1), { ...BLUE }); // opaque stays opaque, now blue
      brushStroke(p, layer.id, [{ x: 3, y: 3 }], 0.5, RED);
      const semi = getPixel(layer.image, 3, 3);
      assert.equal(semi.a, 100); // alpha preserved exactly
      assert.equal(semi.r, 255); // color fully applied at full brush alpha
    });

    test('5.3 Locked eraser is a no-op; unlocking restores normal painting', () => {
      const p = createProject(6, 6, WHITE);
      const layer = p.layers[0];
      setLayerAlphaLock(p, layer.id, true);
      eraserStroke(p, layer.id, [{ x: 3, y: 3 }], 1);
      assert.equal(getPixel(layer.image, 3, 3).a, 255);
      setLayerAlphaLock(p, layer.id, false);
      eraserStroke(p, layer.id, [{ x: 3, y: 3 }], 1);
      assert.equal(getPixel(layer.image, 3, 3).a, 0);
    });
  });

  describe('6. Persistence (Phase 44 state round-trips)', () => {
    function richProject() {
      const p = createProject(4, 4, RED);
      const outer = createGroup(p, 'Outer');
      setGroupOpacity(p, outer.id, 0.9);
      const inner = createGroup(p, 'Inner', outer.id);
      setGroupBlendMode(p, inner.id, 'screen');
      const leaf = addLayer(p, 'leaf');
      fillRect(p, leaf.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      setLayerGroup(p, leaf.id, inner.id);
      setLayerBlendMode(p, leaf.id, 'multiply');
      setLayerAlphaLock(p, leaf.id, true);
      createLayerMask(p, leaf.id, 255);
      paintMask(p, leaf.id, [{ x: 1, y: 1 }], 0.5, 77);
      const clipped = addLayer(p, 'clipped');
      fillRect(p, clipped.id, { x: 0, y: 0, width: 4, height: 4 }, GREEN);
      setLayerClipped(p, clipped.id, true);
      setLayerBlendMode(p, clipped.id, 'overlay');
      return p;
    }

    test('6.1 Masks, groups, clipping, alpha lock and blend modes survive save/load', () => {
      const p = richProject();
      const restored = deserializeProject(JSON.parse(JSON.stringify(serializeProject(p))));
      assert.equal(restored.groups.length, 2);
      const [outer, inner] = restored.groups;
      assert.equal(inner.parentId, outer.id);
      assert.equal(outer.opacity, 0.9);
      assert.equal(inner.blendMode, 'screen');
      const leaf = restored.layers.find((l) => l.name === 'leaf')!;
      assert.equal(leaf.groupId, inner.id);
      assert.equal(leaf.blendMode, 'multiply');
      assert.equal(leaf.alphaLock, true);
      assert.ok(leaf.mask);
      assert.equal(leaf.mask!.data[1 * 4 + 1], 77);
      assert.equal(leaf.mask!.data[0], 255);
      const clipped = restored.layers.find((l) => l.name === 'clipped')!;
      assert.equal(clipped.clipped, true);
      assert.equal(clipped.blendMode, 'overlay');
      // The restored project composites identically, pixel for pixel.
      assert.ok(Buffer.from(composite(restored).data).equals(Buffer.from(composite(p).data)));
    });

    test('6.2 Version-1 projects still load, with Phase 44 defaults', () => {
      const p = createProject(2, 2, RED);
      const v2 = serializeProject(p);
      const v1 = JSON.parse(JSON.stringify(v2));
      v1.version = 1;
      delete v1.groups;
      for (const l of v1.layers) {
        delete l.blendMode;
        delete l.alphaLock;
        delete l.clipped;
        delete l.groupId;
        delete l.maskBase64;
      }
      const restored = deserializeProject(v1);
      assert.equal(restored.groups.length, 0);
      assert.equal(restored.layers[0].blendMode, 'normal');
      assert.equal(restored.layers[0].mask, null);
      assert.equal(restored.layers[0].alphaLock, false);
      assert.deepEqual(getPixel(composite(restored), 0, 0), RED);
    });

    test('6.3 Corrupt Phase 44 data is rejected, not silently loaded', () => {
      const p = richProject();
      const badMask = JSON.parse(JSON.stringify(serializeProject(p)));
      badMask.layers[1].maskBase64 = Buffer.from([1, 2, 3]).toString('base64');
      assert.throws(() => deserializeProject(badMask), /mask data size mismatch/);
      const badGroup = JSON.parse(JSON.stringify(serializeProject(p)));
      badGroup.layers[1].groupId = 'no-such-group';
      assert.throws(() => deserializeProject(badGroup), /missing group/);
      const cyclic = JSON.parse(JSON.stringify(serializeProject(p)));
      cyclic.groups[0].parentId = cyclic.groups[1].id;
      cyclic.groups[1].parentId = cyclic.groups[0].id;
      assert.throws(() => deserializeProject(cyclic), /cycle/);
    });

    test('6.4 Undo/redo carries masks and group state', () => {
      const p = createProject(4, 4, RED);
      const top = addLayer(p);
      fillRect(p, top.id, { x: 0, y: 0, width: 4, height: 4 }, BLUE);
      createLayerMask(p, top.id, 255);
      const g = createGroup(p, 'g');
      setLayerGroup(p, top.id, g.id);
      const history = new HistoryStack();
      history.commit(p);
      invertLayerMask(p, top.id);
      setGroupVisibility(p, g.id, false);
      assert.deepEqual(getPixel(composite(p), 0, 0), RED); // group hidden
      assert.equal(history.undo(p), true);
      assert.equal(getLayerMask(p, top.id)!.data[0], 255); // mask restored
      assert.deepEqual(getPixel(composite(p), 0, 0), BLUE); // group visible again
    });
  });
});
