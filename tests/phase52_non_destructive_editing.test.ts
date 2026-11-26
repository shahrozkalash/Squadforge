import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  addLayer,
  createGroup,
  setLayerGroup,
  addTextLayer,
  createLayerMask,
  createPixelImage,
  setPixel,
  getPixel,
  composite,
  compositeRows,
  applyFilter,
  applyFilterToImage,
  brushStroke,
  fillRect,
  transformLayer,
  applyTransformToImage,
  identityTransform,
  serializeProject,
  deserializeProject,
  HistoryStack,
  addLayerEffect,
  getLayerEffects,
  setLayerEffectParams,
  setLayerEffectEnabled,
  moveLayerEffect,
  removeLayerEffect,
  bakeLayerEffects,
  addAdjustmentLayer,
  setLayerPlacement,
  getLayerPlacement
} from '../server/imageEditor/imageCore.js';
import type { ImageProject, Layer, PixelImage, RgbaColor, SerializedProject, Transform2D } from '../server/imageEditor/types.js';

const RED: RgbaColor = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RgbaColor = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RgbaColor = { r: 0, g: 0, b: 255, a: 255 };
const CLEAR: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };

function paintAll(layer: Layer, color: RgbaColor): void {
  for (let y = 0; y < layer.image.height; y++) {
    for (let x = 0; x < layer.image.width; x++) setPixel(layer.image, x, y, color);
  }
}

/** A deterministic, non-uniform opaque pattern (so filters have something to chew on). */
function patternImage(w: number, h: number): PixelImage {
  const img = createPixelImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      setPixel(img, x, y, {
        r: (x * 37 + y * 11) % 256,
        g: (x * 13 + y * 53) % 256,
        b: (x * 91 + y * 7) % 256,
        a: 255
      });
    }
  }
  return img;
}

function assertBytesEqual(a: PixelImage, b: PixelImage, message?: string): void {
  assert.equal(a.width, b.width, message);
  assert.equal(a.height, b.height, message);
  assert.deepEqual(a.data, b.data, message);
}

function bytesOf(img: PixelImage): Uint8ClampedArray {
  return new Uint8ClampedArray(img.data);
}

/** One opaque pattern layer in a fresh project (the seeded Background layer). */
function patternProject(w = 12, h = 10): { p: ImageProject; layer: Layer } {
  const p = createProject(w, h);
  const layer = p.layers[0];
  layer.name = 'Base';
  layer.image = patternImage(w, h);
  return { p, layer };
}

// ---------------------------------------------------------------- effect stacks (requirement 1)

describe('Phase 52 — effect stacks render from pristine pixels', () => {
  test('52.1 a stack renders byte-identically to applying the same filters destructively in order', () => {
    const { p, layer } = patternProject();
    const pristine = bytesOf(layer.image);
    addLayerEffect(p, layer.id, 'box-blur', { radius: 1 });
    addLayerEffect(p, layer.id, 'invert');
    const rendered = composite(p);

    const twin = patternProject();
    applyFilter(twin.p, twin.layer.id, 'box-blur', { radius: 1 });
    applyFilter(twin.p, twin.layer.id, 'invert');
    assertBytesEqual(rendered, composite(twin.p));

    // The stored pixels were never touched by the stack.
    assert.deepEqual(layer.image.data, pristine);
  });

  test('52.2 disabling the whole stack returns the byte-exact original composite', () => {
    const { p, layer } = patternProject();
    const original = composite(p);
    addLayerEffect(p, layer.id, 'box-blur', { radius: 2 });
    addLayerEffect(p, layer.id, 'posterize', { levels: 3 });
    assert.notDeepEqual(composite(p).data, original.data); // the stack does something

    setLayerEffectEnabled(p, layer.id, 0, false);
    setLayerEffectEnabled(p, layer.id, 1, false);
    assertBytesEqual(composite(p), original);

    // An effect added disabled is equally inert.
    const q = patternProject();
    addLayerEffect(q.p, q.layer.id, 'invert', undefined, false);
    assertBytesEqual(composite(q.p), original);
  });

  test('52.3 reordering two non-commuting effects matches the two destructive orders', () => {
    // Threshold and box blur do not commute: threshold-then-blur
    // leaves gray edge pixels; blur-then-threshold re-hardens them.
    const step = (p: ImageProject, layer: Layer) => {
      for (let y = 0; y < layer.image.height; y++) {
        for (let x = 0; x < layer.image.width; x++) {
          setPixel(layer.image, x, y, x < layer.image.width / 2 ? { r: 30, g: 30, b: 30, a: 255 } : { r: 220, g: 220, b: 220, a: 255 });
        }
      }
    };
    const a = patternProject();
    step(a.p, a.layer);
    addLayerEffect(a.p, a.layer.id, 'threshold', { level: 128 });
    addLayerEffect(a.p, a.layer.id, 'box-blur', { radius: 1 });

    const b = patternProject();
    step(b.p, b.layer);
    addLayerEffect(b.p, b.layer.id, 'threshold', { level: 128 });
    addLayerEffect(b.p, b.layer.id, 'box-blur', { radius: 1 });
    moveLayerEffect(b.p, b.layer.id, 1, 0); // blur first now

    const dA = patternProject();
    step(dA.p, dA.layer);
    applyFilter(dA.p, dA.layer.id, 'threshold', { level: 128 });
    applyFilter(dA.p, dA.layer.id, 'box-blur', { radius: 1 });

    const dB = patternProject();
    step(dB.p, dB.layer);
    applyFilter(dB.p, dB.layer.id, 'box-blur', { radius: 1 });
    applyFilter(dB.p, dB.layer.id, 'threshold', { level: 128 });

    assertBytesEqual(composite(a.p), composite(dA.p));
    assertBytesEqual(composite(b.p), composite(dB.p));
    assert.notDeepEqual(composite(a.p).data, composite(b.p).data); // the orders genuinely differ
  });

  test('52.4 removing an effect renders as if it was never there', () => {
    const { p, layer } = patternProject();
    addLayerEffect(p, layer.id, 'invert');
    addLayerEffect(p, layer.id, 'box-blur', { radius: 1 });
    removeLayerEffect(p, layer.id, 0);

    const twin = patternProject();
    applyFilter(twin.p, twin.layer.id, 'box-blur', { radius: 1 });
    assertBytesEqual(composite(p), composite(twin.p));
    assert.equal(getLayerEffects(p, layer.id).length, 1);
    assert.throws(() => removeLayerEffect(p, layer.id, 5), /out of range/);
  });
});

// ---------------------------------------------------------------- parameter editing (requirement 2)

describe('Phase 52 — parameter editing and validation', () => {
  test('52.5 editing an effect parameter re-renders with the new value', () => {
    const { p, layer } = patternProject();
    addLayerEffect(p, layer.id, 'box-blur', { radius: 1 });
    setLayerEffectParams(p, layer.id, 0, { radius: 3 });

    const twin = patternProject();
    applyFilter(twin.p, twin.layer.id, 'box-blur', { radius: 3 });
    assertBytesEqual(composite(p), composite(twin.p));

    // getLayerEffects returns copies: mutating one changes nothing.
    const copy = getLayerEffects(p, layer.id);
    copy[0].params.radius = 9;
    assertBytesEqual(composite(p), composite(twin.p));
  });

  test('52.6 invalid filter ids and parameters are rejected, never stored', () => {
    const { p, layer } = patternProject();
    assert.throws(() => addLayerEffect(p, layer.id, 'no-such-filter'), /Unknown filter/);
    assert.throws(() => addLayerEffect(p, layer.id, 'box-blur', { radius: 999 }), /out of range/);
    assert.throws(() => addLayerEffect(p, layer.id, 'box-blur', { bogus: 1 }), /Unknown parameter/);
    assert.equal(getLayerEffects(p, layer.id).length, 0); // nothing was stored

    addLayerEffect(p, layer.id, 'box-blur', { radius: 1 });
    assert.throws(() => setLayerEffectParams(p, layer.id, 0, { radius: -1 }), /out of range/);
    // The failed edit left the previous parameters intact.
    assert.equal(getLayerEffects(p, layer.id)[0].params.radius, 1);
  });
});

// ---------------------------------------------------------------- adjustment layers (requirement 3)

describe('Phase 52 — adjustment layers', () => {
  function twoLayerProject(): ImageProject {
    const p = createProject(10, 8);
    const bottom = p.layers[0];
    bottom.name = 'Bottom';
    bottom.image = patternImage(10, 8);
    const top = addLayer(p, 'Top');
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 10; x++) {
        if ((x + y) % 3 === 0) setPixel(top.image, x, y, { r: 200, g: 40, b: 90, a: 160 });
      }
    }
    return p;
  }

  test('52.7 an adjustment layer filters the flattened composite of everything below it', () => {
    const below = twoLayerProject();
    const expected = applyFilterToImage(composite(below), 'invert');

    const p = twoLayerProject();
    const adj = addAdjustmentLayer(p);
    addLayerEffect(p, adj.id, 'invert');
    assertBytesEqual(composite(p), expected);
  });

  test('52.8 layers above an adjustment layer are unaffected', () => {
    const p = twoLayerProject();
    const adj = addAdjustmentLayer(p);
    addLayerEffect(p, adj.id, 'invert');
    const above = addLayer(p, 'Above');
    setPixel(above.image, 3, 2, RED);
    setPixel(above.image, 4, 2, GREEN);

    const out = composite(p);
    assert.deepEqual(getPixel(out, 3, 2), RED); // marker pixels exact
    assert.deepEqual(getPixel(out, 4, 2), GREEN);

    // A pixel not covered from above shows the adjusted backdrop.
    const belowOnly = twoLayerProject();
    const inv = applyFilterToImage(composite(belowOnly), 'invert');
    assert.deepEqual(getPixel(out, 0, 0), getPixel(inv, 0, 0));
  });

  test('52.9 hiding an adjustment layer removes its effect exactly', () => {
    const plain = twoLayerProject();
    const p = twoLayerProject();
    const adj = addAdjustmentLayer(p);
    addLayerEffect(p, adj.id, 'invert');
    assert.notDeepEqual(composite(p).data, composite(plain).data);

    adj.visible = false;
    assertBytesEqual(composite(p), composite(plain));
    adj.visible = true;
    assert.notDeepEqual(composite(p).data, composite(plain).data);
  });

  test('52.10 adjustment opacity cross-fades between the backdrop and the filtered result', () => {
    const p = createProject(4, 3);
    const base = p.layers[0];
    paintAll(base, { r: 100, g: 150, b: 200, a: 255 });
    const adj = addAdjustmentLayer(p);
    adj.opacity = 0.5;
    addLayerEffect(p, adj.id, 'invert');
    // backdrop (100,150,200) vs inverted (155,105,55) at weight 0.5 → 128,128,128
    assert.deepEqual(getPixel(composite(p), 1, 1), { r: 128, g: 128, b: 128, a: 255 });
  });

  test('52.11 an adjustment layer mask modulates its effect per pixel', () => {
    const p = createProject(6, 2);
    const base = p.layers[0];
    paintAll(base, { r: 10, g: 20, b: 30, a: 255 });
    const adj = addAdjustmentLayer(p);
    addLayerEffect(p, adj.id, 'invert');
    const mask = createLayerMask(p, adj.id, 0); // fully masked out
    for (let y = 0; y < 2; y++) for (let x = 3; x < 6; x++) mask.data[y * 6 + x] = 255; // right half live

    const out = composite(p);
    assert.deepEqual(getPixel(out, 1, 0), { r: 10, g: 20, b: 30, a: 255 }); // untouched
    assert.deepEqual(getPixel(out, 4, 0), { r: 245, g: 235, b: 225, a: 255 }); // inverted
  });

  test('52.12 an adjustment layer inside a group scopes to that group only', () => {
    const build = (withEffect: boolean) => {
      const p = createProject(8, 4);
      const r = p.layers[0];
      r.name = 'Outside';
      paintAll(r, BLUE);
      const g = createGroup(p, 'G');
      const a = addLayer(p, 'Inside');
      setLayerGroup(p, a.id, g.id);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(a.image, x, y, RED); // left half
      const adj = addAdjustmentLayer(p, 'Adj');
      setLayerGroup(p, adj.id, g.id);
      if (withEffect) addLayerEffect(p, adj.id, 'invert');
      return p;
    };
    const out = composite(build(true));
    assert.deepEqual(getPixel(out, 1, 1), { r: 0, g: 255, b: 255, a: 255 }); // red inverted inside the group
    assert.deepEqual(getPixel(out, 6, 1), BLUE); // the outside layer is NOT inverted
    const plain = composite(build(false));
    assert.deepEqual(getPixel(out, 6, 1), getPixel(plain, 6, 1));
  });

  test('52.13 a spatial filter on an adjustment layer sees the full backdrop (band-safe)', () => {
    const below = createProject(10, 6);
    const base = below.layers[0];
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 10; x++) setPixel(base.image, x, y, x < 5 ? { r: 20, g: 20, b: 20, a: 255 } : { r: 230, g: 230, b: 230, a: 255 });
    }
    const expected = applyFilterToImage(composite(below), 'box-blur', { radius: 1 });

    const p = createProject(10, 6);
    const b2 = p.layers[0];
    b2.image.data.set(base.image.data);
    const adj = addAdjustmentLayer(p);
    addLayerEffect(p, adj.id, 'box-blur', { radius: 1 });
    assertBytesEqual(composite(p), expected);

    // Row bands of a project with an active adjustment layer match
    // the same rows of the full composite exactly.
    const full = composite(p);
    const band = compositeRows(p, 2, 4);
    assert.deepEqual(band.data, full.data.subarray(2 * 10 * 4, 4 * 10 * 4));
  });

  test('52.14 an empty adjustment layer changes nothing, and painting one is refused', () => {
    const p = twoLayerProject();
    const before = composite(p);
    const adj = addAdjustmentLayer(p);
    assert.equal(adj.kind, 'adjustment');
    assertBytesEqual(composite(p), before);
    assert.throws(() => brushStroke(p, adj.id, [{ x: 1, y: 1 }], 2, RED), /adjustment layer/);
    assert.throws(() => fillRect(p, adj.id, { x: 0, y: 0, width: 2, height: 2 }, RED), /adjustment layer/);
    assert.throws(() => applyFilter(p, adj.id, 'invert'), /adjustment layer/);
    assert.throws(() => transformLayer(p, adj.id, identityTransform()), /adjustment layer/);
  });
});

// ---------------------------------------------------------------- raster placement (requirement 4)

describe('Phase 52 — non-destructive raster placement', () => {
  function markerProject(): { p: ImageProject; layer: Layer } {
    const p = createProject(10, 8);
    const bg = p.layers[0];
    bg.name = 'BG';
    paintAll(bg, BLUE);
    const layer = addLayer(p, 'Marker');
    setPixel(layer.image, 1, 1, RED);
    return { p, layer };
  }

  test('52.15 an offset placement moves the render; clearing it restores the original byte-exactly', () => {
    const { p, layer } = markerProject();
    const original = composite(p);
    const pristine = bytesOf(layer.image);

    setLayerPlacement(p, layer.id, { ...identityTransform(), translateX: 3, translateY: 2 });
    const moved = composite(p);
    assert.deepEqual(getPixel(moved, 4, 3), RED);
    assert.deepEqual(getPixel(moved, 1, 1), BLUE); // vacated
    assert.deepEqual(layer.image.data, pristine); // pixels retained

    setLayerPlacement(p, layer.id, null);
    assertBytesEqual(composite(p), original);
    assert.equal(getLayerPlacement(p, layer.id), null);
  });

  test('52.16 a placement renders identically to the same transform applied destructively', () => {
    const t: Transform2D = { ...identityTransform(4, 4), rotationDeg: 90 };
    const { p, layer } = patternProject(9, 9);
    setLayerPlacement(p, layer.id, t);

    const twin = patternProject(9, 9);
    twin.layer.image = applyTransformToImage(twin.layer.image, t);
    assertBytesEqual(composite(p), composite(twin.p));
    assert.deepEqual(layer.image.data, patternImage(9, 9).data); // still pristine
  });

  test('52.17 transforms on a placed layer compose into the placement instead of baking', () => {
    const { p, layer } = markerProject();
    const pristine = bytesOf(layer.image);
    setLayerPlacement(p, layer.id, { ...identityTransform(), translateX: 2 });
    transformLayer(p, layer.id, { ...identityTransform(), translateY: 3 });

    const out = composite(p);
    assert.deepEqual(getPixel(out, 3, 4), RED); // (1,1) + (2,3)
    assert.deepEqual(layer.image.data, pristine);
    const m = getLayerPlacement(p, layer.id);
    assert.ok(m);
    assert.equal(m[2], 2); // combined translation x
    assert.equal(m[5], 3); // combined translation y
  });

  test('52.18 a placed layer mask warps with the placement and stays aligned', () => {
    const p = createProject(10, 4);
    const bg = p.layers[0];
    paintAll(bg, BLUE);
    const layer = addLayer(p, 'Masked');
    paintAll(layer, RED);
    const mask = createLayerMask(p, layer.id, 0);
    for (let y = 0; y < 4; y++) for (let x = 5; x < 10; x++) mask.data[y * 10 + x] = 255; // right half visible

    setLayerPlacement(p, layer.id, { ...identityTransform(), translateX: 2 });
    const out = composite(p);
    assert.deepEqual(getPixel(out, 8, 1), RED); // visible region shifted right
    assert.deepEqual(getPixel(out, 6, 1), BLUE); // mask moved off this pixel
    assert.deepEqual(getPixel(out, 3, 1), BLUE);
  });

  test('52.19 placement applies after the effect stack, and is refused for non-raster layers', () => {
    const p = createProject(8, 6);
    const layer = p.layers[0];
    layer.name = 'Dot';
    setPixel(layer.image, 1, 1, RED);
    addLayerEffect(p, layer.id, 'invert');
    setLayerPlacement(p, layer.id, { ...identityTransform(), translateX: 3, translateY: 2 });
    assert.deepEqual(getPixel(composite(p), 4, 3), { r: 0, g: 255, b: 255, a: 255 }); // inverted, then moved

    const text = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
    assert.throws(() => setLayerPlacement(p, text.id, identityTransform()), /raster layers/);
    const adj = addAdjustmentLayer(p);
    assert.throws(() => setLayerPlacement(p, adj.id, identityTransform()), /raster layers/);
  });

  test('52.20 effects also apply to content layers (over their render cache)', () => {
    const p1 = createProject(16, 12);
    const t1 = addTextLayer(p1, { text: 'A', fontSize: 7, color: RED });
    addLayerEffect(p1, t1.id, 'invert');

    const p2 = createProject(16, 12);
    const t2 = addTextLayer(p2, { text: 'A', fontSize: 7, color: RED });
    applyFilter(p2, t2.id, 'invert');
    assertBytesEqual(composite(p1), composite(p2));
  });
});

// ---------------------------------------------------------------- persistence + history (requirement 5)

describe('Phase 52 — persistence and history', () => {
  function richProject(): ImageProject {
    const p = createProject(12, 10);
    const base = p.layers[0];
    base.name = 'Base';
    base.image = patternImage(12, 10);
    addLayerEffect(p, base.id, 'box-blur', { radius: 2 });
    addLayerEffect(p, base.id, 'invert', undefined, false);
    setLayerPlacement(p, base.id, { ...identityTransform(), translateX: 1, translateY: 1 });
    const adj = addAdjustmentLayer(p, 'Grade');
    addLayerEffect(p, adj.id, 'sepia', { amount: 0.5 });
    const text = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
    addLayerEffect(p, text.id, 'grayscale');
    return p;
  }

  test('52.21 stacks, adjustment layers and placements round-trip field-exactly and render identically', () => {
    const p = richProject();
    const before = composite(p);
    const s1 = serializeProject(p);
    const loaded = deserializeProject(JSON.parse(JSON.stringify(s1)) as SerializedProject);
    const s2 = serializeProject(loaded);
    assert.deepEqual(s2, s1);
    assertBytesEqual(composite(loaded), before);

    const base = loaded.layers[0];
    assert.deepEqual(getLayerEffects(loaded, base.id), getLayerEffects(p, p.layers[0].id));
    assert.deepEqual(getLayerPlacement(loaded, base.id), getLayerPlacement(p, p.layers[0].id));
    assert.equal(loaded.layers[1].kind, 'adjustment');
  });

  test('52.22 pre-Phase-52 files load with empty stacks and no placement', () => {
    const p = richProject();
    const s = JSON.parse(JSON.stringify(serializeProject(p))) as Record<string, unknown>;
    const layers = s.layers as Array<Record<string, unknown>>;
    for (const l of layers) {
      delete l.effects;
      delete l.placement;
    }
    const loaded = deserializeProject(s as unknown as SerializedProject);
    for (const layer of loaded.layers) {
      assert.deepEqual(layer.effects, []);
      assert.equal(layer.placement, null);
    }
    // And a version-1 shaped file (no Phase 44/48/52 fields at all).
    const v1 = {
      format: 'squadforge-image-project',
      version: 1,
      name: s.name,
      width: s.width,
      height: s.height,
      activeLayerId: s.activeLayerId,
      layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, pixelsBase64: l.pixelsBase64 }))
    };
    const loadedV1 = deserializeProject(v1 as unknown as SerializedProject);
    assert.equal(loadedV1.layers.length, 3);
    assert.deepEqual(loadedV1.layers[0].effects, []);
  });

  test('52.23 corrupt stack data is rejected on load', () => {
    const p = richProject();
    const mutate = (fn: (s: Record<string, unknown>) => void): SerializedProject => {
      const s = JSON.parse(JSON.stringify(serializeProject(p))) as Record<string, unknown>;
      fn(s);
      return s as unknown as SerializedProject;
    };
    const layersOf = (s: Record<string, unknown>) => s.layers as Array<Record<string, unknown>>;

    assert.throws(
      () => deserializeProject(mutate((s) => { (layersOf(s)[0].effects as Array<Record<string, unknown>>)[0].filterId = 'nope'; })),
      /Unknown filter/
    );
    assert.throws(
      () => deserializeProject(mutate((s) => { (layersOf(s)[0].effects as Array<Record<string, unknown>>)[0].params = { radius: 500 }; })),
      /out of range/
    );
    assert.throws(
      () => deserializeProject(mutate((s) => { layersOf(s)[0].effects = 'stack'; })),
      /must be an array/
    );
    assert.throws(
      () => deserializeProject(mutate((s) => { layersOf(s)[0].placement = [1, 0, 0]; })),
      /9 finite numbers/
    );
    assert.throws(
      () => deserializeProject(mutate((s) => { layersOf(s)[2].placement = [1, 0, 0, 0, 1, 0, 0, 0, 1]; })),
      /raster layers only/
    );
    assert.throws(
      () => deserializeProject(mutate((s) => { layersOf(s)[2].kind = 'adjustment'; })),
      /must not carry text or shape data/
    );
  });

  test('52.24 undo of adding an effect restores the original render; redo reapplies it', () => {
    const { p, layer } = patternProject();
    const original = composite(p);
    const h = new HistoryStack();
    h.commit(p);
    addLayerEffect(p, layer.id, 'invert');
    const inverted = composite(p);
    assert.notDeepEqual(inverted.data, original.data);

    assert.equal(h.undo(p), true);
    assert.equal(getLayerEffects(p, layer.id).length, 0);
    assertBytesEqual(composite(p), original);

    assert.equal(h.redo(p), true);
    assert.equal(getLayerEffects(p, layer.id).length, 1);
    assertBytesEqual(composite(p), inverted);
  });
});

// ---------------------------------------------------------------- destructive commit (requirement 6)

describe('Phase 52 — bakeLayerEffects (the explicit destructive commit)', () => {
  test('52.25 baking writes the stacked result into the pixels, clears the stack, and renders identically', () => {
    const { p, layer } = patternProject();
    addLayerEffect(p, layer.id, 'box-blur', { radius: 1 });
    addLayerEffect(p, layer.id, 'invert');
    const before = composite(p);
    const expectedPixels = applyFilterToImage(applyFilterToImage(layer.image, 'box-blur', { radius: 1 }), 'invert');

    bakeLayerEffects(p, layer.id);
    assert.deepEqual(getLayerEffects(p, layer.id), []);
    assertBytesEqual(layer.image, expectedPixels);
    assertBytesEqual(composite(p), before);
  });

  test('52.26 baking keeps a placement in force on top of the baked pixels', () => {
    const { p, layer } = patternProject();
    addLayerEffect(p, layer.id, 'invert');
    setLayerPlacement(p, layer.id, { ...identityTransform(), translateX: 2 });
    const before = composite(p);
    bakeLayerEffects(p, layer.id);
    assert.ok(getLayerPlacement(p, layer.id));
    assertBytesEqual(composite(p), before);
  });

  test('52.27 baking is refused where there are no ownable pixels', () => {
    const p = createProject(12, 10);
    const adj = addAdjustmentLayer(p);
    addLayerEffect(p, adj.id, 'invert');
    assert.throws(() => bakeLayerEffects(p, adj.id), /adjustment layer/);
    const text = addTextLayer(p, { text: 'A', fontSize: 7, color: RED });
    addLayerEffect(p, text.id, 'invert');
    assert.throws(() => bakeLayerEffects(p, text.id), /render cache/);
  });
});
