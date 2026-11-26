import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addAdjustmentLayer,
  addLayer,
  addLayerEffect,
  addTextLayer,
  applyFilter,
  bakeLayerEffects,
  composite,
  createGroup,
  createLayerMask,
  createPixelImage,
  createProject,
  deserializeProject,
  fillRect,
  getBrushPreset,
  getLayer,
  getPixel,
  getTextData,
  paintBrushStroke,
  paintMask,
  rectSelection,
  removeLayer,
  serializeProject,
  setLayerGroup,
  setLayerVisibility,
  updateTextLayer
} from '../server/imageEditor/imageCore.js';
import { decodePng, decodePng16, encodePng, encodePng16, importImage } from '../server/imageEditor/imageCodec.js';
import { exportPsd, importPsd } from '../server/imageEditor/psd.js';
import { compositeProjectAsync, applyFilterAsync } from '../server/imageEditor/acceleration.js';
import { applyFilterToImage } from '../server/imageEditor/imageCore.js';
import { downscaleTo8, upscaleTo16, upscaleValueTo16 } from '../server/imageEditor/colorManagement.js';
import { addGuide, setGridSettings } from '../server/imageEditor/workspace.js';
import { defineAction, startBatch } from '../server/imageEditor/actions.js';
import type { ImageProject, Layer, PixelImage } from '../server/imageEditor/types.js';

// ------------------------------------------------------------ helpers

const W = 64;
const H = 48;

/** Deterministic opaque pattern (the "photograph" the workflow edits). */
function patternImage(seed: number, width = W, height = H): PixelImage {
  const img = createPixelImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = (x * 37 + y * 17 + seed * 53) % 256;
      img.data[i + 1] = (x * 13 + y * 41 + seed * 91) % 256;
      img.data[i + 2] = (x * 7 + y * 29 + seed * 7) % 256;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

function assertBytesEqual(actual: PixelImage, expected: PixelImage, message?: string): void {
  assert.equal(actual.width, expected.width, message);
  assert.equal(actual.height, expected.height, message);
  assert.ok(
    Buffer.from(actual.data).equals(Buffer.from(expected.data)),
    message ?? 'image bytes differ'
  );
}

function assertBytesDiffer(a: PixelImage, b: PixelImage, message?: string): void {
  assert.ok(!Buffer.from(a.data).equals(Buffer.from(b.data)), message ?? 'image bytes unexpectedly identical');
}

interface Workflow {
  project: ImageProject;
  photo: Layer;
  paint: Layer;
  grade: Layer | null;
  title: Layer;
  /** Stage composites captured while building (only when effects are on). */
  stages: { afterPaint?: PixelImage; afterEffects?: PixelImage };
}

/**
 * The full realistic workflow, chaining Phases 19/44/45/46/47/48/52/54:
 * PNG import → selection-scoped filter → group + masked layer → brush
 * painting → (optionally) a Phase 52 effect stack + adjustment layer →
 * text layer → guides/grid. With `effects: false` it builds the pristine
 * reference: the same project with no non-destructive state, which is
 * exactly what the PSD layer records are documented to carry.
 */
function buildWorkflow(seed = 1, options: { effects?: boolean; text?: string } = {}): Workflow {
  const effects = options.effects ?? true;
  const project = createProject(W, H);
  const photo = project.layers[0];
  photo.name = 'Photo';
  // Import a real PNG through the codec, as a user opening a photo would.
  photo.image = importImage(encodePng(patternImage(seed)));

  // Phase 45 selection + Phase 47 filter scoped through it (destructive
  // edit of the photo's corner, performed identically in both variants).
  const sel = rectSelection(W, H, { x: 0, y: 40, width: 20, height: 8 });
  applyFilter(project, photo.id, 'invert', {}, { selectionMask: sel });

  // Phase 44 group + masked layer; Phase 46 brush painting on it.
  const group = createGroup(project, 'FX');
  const paint = addLayer(project, 'Paint');
  setLayerGroup(project, paint.id, group.id);
  fillRect(project, paint.id, { x: 4, y: 4, width: 40, height: 30 }, { r: 200, g: 40, b: 40, a: 255 });
  createLayerMask(project, paint.id, 255);
  paintMask(project, paint.id, [{ x: 10, y: 10 }, { x: 30, y: 10 }], 4, 0);
  const preset = getBrushPreset('Hard Round');
  paintBrushStroke(
    project,
    paint.id,
    [{ x: 8, y: 36 }, { x: 40, y: 36 }],
    preset.settings,
    { r: 20, g: 200, b: 60, a: 255 }
  );

  const stages: Workflow['stages'] = {};
  let grade: Layer | null = null;
  if (effects) {
    stages.afterPaint = composite(project);
    // Phase 52: non-destructive effect stack on the paint layer…
    addLayerEffect(project, paint.id, 'sepia', { amount: 0.7 });
    stages.afterEffects = composite(project);
    // …and an adjustment layer grading everything below it.
    grade = addAdjustmentLayer(project, 'Grade');
    addLayerEffect(project, grade.id, 'brightness-contrast', { brightness: 10, contrast: 5 });
  }

  // Phase 48 editable text layer on top.
  const title = addTextLayer(project, { text: options.text ?? 'HI', fontSize: 14 }, 'Title');

  // Phase 54 document data: guides + a custom grid.
  addGuide(project, 'vertical', 16);
  addGuide(project, 'horizontal', 24);
  setGridSettings(project, { spacingX: 8, spacingY: 8, offsetX: 0, offsetY: 0 });

  return { project, photo, paint, grade, title, stages };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase55-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ 55.1 staged workflow + JSON

describe('55.1 full workflow, stage by stage, and JSON persistence', () => {
  test('each subsystem changes the composite exactly where it should', () => {
    const { project, photo, grade, stages } = buildWorkflow(1);

    // The selection-scoped invert touched only the selected corner of
    // the photo: inside pixel inverted exactly, outside pixel intact.
    const inside = getPixel(photo.image, 5, 44);
    const src = patternImage(1);
    const srcInside = getPixel(src, 5, 44);
    assert.deepEqual(inside, { r: 255 - srcInside.r, g: 255 - srcInside.g, b: 255 - srcInside.b, a: 255 });
    assert.deepEqual(getPixel(photo.image, 30, 44), getPixel(src, 30, 44));

    // The mask hides the paint layer along the painted mask line: at
    // (20,10) the group contributes nothing (its only member is masked
    // out and the photo is opaque), so the composite there is exactly
    // the adjustment layer's pointwise grade applied to the photo.
    const comp = composite(project);
    const gradedPhoto = applyFilterToImage(photo.image, 'brightness-contrast', { brightness: 10, contrast: 5 });
    assert.deepEqual(getPixel(comp, 20, 10), getPixel(gradedPhoto, 20, 10));
    // The Phase 46 brush stroke is visible in the composite (green paint).
    const strokePx = getPixel(comp, 24, 36);
    assert.ok(strokePx.g > 120 && strokePx.g > strokePx.r, `stroke pixel should be green-dominant, got ${JSON.stringify(strokePx)}`);

    // Effect stack and adjustment layer each change the render, and
    // hiding the adjustment layer removes exactly its contribution.
    assertBytesDiffer(stages.afterEffects!, stages.afterPaint!, 'effect stack must change the composite');
    const full = composite(project);
    setLayerVisibility(project, grade!.id, false);
    const noGrade = composite(project);
    assertBytesDiffer(noGrade, full, 'adjustment layer must change the composite');
    setLayerVisibility(project, grade!.id, true);
    assertBytesEqual(composite(project), full, 're-showing the adjustment layer must restore the composite');
  });

  test('JSON round trip of the full project is byte-exact and stays editable', () => {
    const { project } = buildWorkflow(1);
    const before = composite(project);
    const serialized = serializeProject(project);
    const reloaded = deserializeProject(JSON.parse(JSON.stringify(serialized)) as typeof serialized);

    assertBytesEqual(composite(reloaded), before, 'reloaded project must render byte-identically');
    // Serialization is field-exact and idempotent across the whole
    // feature set (effects, guides, grid, content layers, groups).
    assert.deepEqual(serializeProject(reloaded), serialized);
    assert.deepEqual(reloaded.guides, project.guides);
    assert.deepEqual(reloaded.grid, project.grid);
    const reloadedPaint = reloaded.layers.find((l) => l.name === 'Paint')!;
    assert.deepEqual(getLayer(reloaded, reloadedPaint.id).effects, getLayer(project, project.layers.find((l) => l.name === 'Paint')!.id).effects);
    assert.equal(reloaded.groups.length, 1);
    assert.equal(reloadedPaint.groupId, reloaded.groups[0].id);

    // The text layer is still a live content layer after the round
    // trip: editing it re-renders, and the result matches a project
    // built with the new text from the start.
    const reloadedTitle = reloaded.layers.find((l) => l.name === 'Title')!;
    assert.equal(reloadedTitle.kind, 'text');
    assert.equal(getTextData(reloaded, reloadedTitle.id).text, 'HI');
    updateTextLayer(reloaded, reloadedTitle.id, { text: 'OK' });
    const edited = composite(reloaded);
    assertBytesDiffer(edited, before);
    assertBytesEqual(edited, composite(buildWorkflow(1, { text: 'OK' }).project));
    assert.equal(getTextData(reloaded, reloadedTitle.id).text, 'OK');
  });
});

// ------------------------------------------------------------ 55.2 PSD integration

describe('55.2 PSD export/import of the integrated project', () => {
  test('PSD carries the documented state: pristine pixels, rendered text, masks, groups', () => {
    const { project, paint, title } = buildWorkflow(1);
    const full = composite(project);
    const { project: imported, warnings } = importPsd(exportPsd(project));
    assert.deepEqual(warnings, []);

    const byName = new Map(imported.layers.map((l) => [l.name, l]));
    // Text exports as rendered pixels and re-imports as raster
    // (Phase 49 documented behavior), byte-identical pixels.
    const impTitle = byName.get('Title')!;
    assert.equal(impTitle.kind, 'raster');
    assertBytesEqual(impTitle.image, title.image);
    // The effect-stack layer carries its PRISTINE pixels (Phase 52
    // documented PSD behavior), with its mask intact.
    const impPaint = byName.get('Paint')!;
    assertBytesEqual(impPaint.image, paint.image);
    assert.ok(impPaint.mask, 'mask must survive the PSD round trip');
    assert.ok(Buffer.from(impPaint.mask!.data).equals(Buffer.from(paint.mask!.data)), 'mask bytes must survive');
    assert.equal(impPaint.groupId, imported.groups[0].id);
    // The adjustment layer has no pixels of its own: it re-imports as
    // an empty raster layer under its name.
    const impGrade = byName.get('Grade')!;
    assert.equal(impGrade.kind, 'raster');
    assert.ok(impGrade.image.data.every((v) => v === 0), 'adjustment layer must re-import empty');

    // Net effect: the re-imported project renders exactly like the
    // pristine reference (same workflow, no non-destructive state),
    // and differently from the full project.
    const reference = buildWorkflow(1, { effects: false });
    assertBytesEqual(composite(imported), composite(reference.project));
    assertBytesDiffer(composite(imported), full);
  });

  test('once effects are baked and the adjustment layer removed, the PSD round trip is lossless', () => {
    const { project } = buildWorkflow(1);
    const clone = deserializeProject(JSON.parse(JSON.stringify(serializeProject(project))) as ReturnType<typeof serializeProject>);
    const paint = clone.layers.find((l) => l.name === 'Paint')!;
    bakeLayerEffects(clone, paint.id);
    const grade = clone.layers.find((l) => l.name === 'Grade')!;
    removeLayer(clone, grade.id);
    const expected = composite(clone);
    const { project: imported, warnings } = importPsd(exportPsd(clone));
    assert.deepEqual(warnings, []);
    assertBytesEqual(composite(imported), expected);
  });
});

// ------------------------------------------------------------ 55.3 acceleration integration

describe('55.3 acceleration providers on the integrated project', () => {
  test('parallel composite of a project with an adjustment layer is byte-identical to serial', async () => {
    const { project } = buildWorkflow(1);
    const serial = composite(project);
    const parallel = await compositeProjectAsync(project, { provider: 'cpu-parallel', workers: 2 });
    assertBytesEqual(parallel, serial);
  });

  test('applyFilterAsync matches the synchronous filter on the workflow composite', async () => {
    const { project } = buildWorkflow(1);
    const flat = composite(project);
    const viaAsync = await applyFilterAsync(flat, 'box-blur', { radius: 2 }, { provider: 'cpu-parallel', workers: 2 });
    assertBytesEqual(viaAsync, applyFilterToImage(flat, 'box-blur', { radius: 2 }));
  });
});

// ------------------------------------------------------------ 55.4 color management integration

describe('55.4 16-bit pipeline on the workflow composite', () => {
  test('composite survives the 16-bit PNG round trip byte-exactly', () => {
    const { project } = buildWorkflow(1);
    const flat = composite(project);
    const decoded = decodePng16(encodePng16(upscaleTo16(flat)));
    assert.equal(decoded.width, flat.width);
    assert.equal(decoded.height, flat.height);
    // Spot-check exact 16-bit samples against the upscale rule.
    for (const [x, y] of [[0, 0], [24, 36], [63, 47]] as const) {
      const px = getPixel(flat, x, y);
      const i16 = (y * decoded.width + x) * 4;
      assert.equal(decoded.data[i16], upscaleValueTo16(px.r));
      assert.equal(decoded.data[i16 + 1], upscaleValueTo16(px.g));
      assert.equal(decoded.data[i16 + 2], upscaleValueTo16(px.b));
      assert.equal(decoded.data[i16 + 3], upscaleValueTo16(px.a));
    }
    assertBytesEqual(downscaleTo8(decoded), flat);
  });
});

// ------------------------------------------------------------ 55.5 batch integration

describe('55.5 batch processing over workflow outputs', () => {
  test('a Phase 53 action batch processes exported workflow composites, with per-file error recovery', async () => {
    await withTmpDir(async (dir) => {
      const inDir = path.join(dir, 'in');
      const outDir = path.join(dir, 'out');
      await fs.mkdir(inDir);
      const inputs: string[] = [];
      const expected: PixelImage[] = [];
      for (let seed = 1; seed <= 3; seed++) {
        const flat = composite(buildWorkflow(seed).project);
        const p = path.join(inDir, `shot${seed}.png`);
        await fs.writeFile(p, encodePng(flat));
        inputs.push(p);
        // The action inverts: expected output is the inverted composite.
        expected.push(applyFilterToImage(flat, 'invert'));
      }
      const corrupt = path.join(inDir, 'broken.png');
      await fs.writeFile(corrupt, Buffer.from('this is not a png'));
      inputs.push(corrupt);

      const action = defineAction('invert-and-export', [
        { op: 'invert', params: {} },
        { op: 'export', params: { format: 'png', name: 'result.png' } }
      ]);
      const summary = await startBatch({ inputs, outputDir: outDir, action }).done;
      assert.equal(summary.total, 4);
      assert.equal(summary.done, 3);
      assert.equal(summary.failed, 1);
      assert.equal(summary.cancelled, 0);
      const broken = summary.results.find((r) => r.input === corrupt)!;
      assert.equal(broken.status, 'failed');
      assert.ok(broken.error && broken.error.length > 0);
      for (let i = 0; i < 3; i++) {
        const result = summary.results[i];
        assert.equal(result.status, 'done');
        const out = decodePng(await fs.readFile(result.output!));
        assertBytesEqual(out, expected[i]);
      }
    });
  });
});
