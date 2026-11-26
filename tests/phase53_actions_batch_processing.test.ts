import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addLayer,
  adjustBrightnessContrast,
  applyFilter,
  composite,
  createPixelImage,
  createProject,
  fillRect,
  getFilterDescriptor,
  setLayerOpacity
} from '../server/imageEditor/imageCore.js';
import { decodeBmp, decodePng, detectFormat, encodePng } from '../server/imageEditor/imageCodec.js';
import {
  ActionRecorder,
  applyAction,
  defineAction,
  listActionOps,
  parseAction,
  serializeAction,
  startBatch,
  validateAction
} from '../server/imageEditor/actions.js';
import type { ImageAction } from '../server/imageEditor/actions.js';
import type { ImageProject, PixelImage, RgbaColor } from '../server/imageEditor/types.js';

// ------------------------------------------------------------ helpers

/** Deterministic non-trivial pixel pattern (opaque). */
function patternImage(width: number, height: number, seed = 0): PixelImage {
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

/** A fresh project whose Background layer holds the pattern. */
function patternProject(width = 24, height = 16, seed = 0): ImageProject {
  const project = createProject(width, height);
  project.layers[0].image = patternImage(width, height, seed);
  return project;
}

function assertImageBytesEqual(actual: PixelImage, expected: PixelImage, message?: string): void {
  assert.equal(actual.width, expected.width, message);
  assert.equal(actual.height, expected.height, message);
  assert.ok(Buffer.from(actual.data).equals(Buffer.from(expected.data)), message ?? 'image bytes differ');
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase53-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Write `count` distinct pattern PNGs into dir and return their paths. */
async function writeFixturePngs(dir: string, count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(dir, `in${i}.png`);
    await fs.writeFile(p, encodePng(patternImage(20, 12, i + 1)));
    paths.push(p);
  }
  return paths;
}

// ------------------------------------------------------- action model

describe('Phase 53: action model and validation', () => {
  test('the vocabulary covers filters, adjustments, layers, canvas ops and export', () => {
    const ids = listActionOps().map((o) => o.id);
    for (const id of ['filter', 'brightness-contrast', 'saturation', 'invert', 'grayscale', 'add-layer', 'flatten', 'resize', 'rotate', 'export']) {
      assert.ok(ids.includes(id), `vocabulary is missing '${id}'`);
    }
  });

  test('filter steps are validated and resolved through the Phase 47 registry', () => {
    const action = defineAction('blur', [{ op: 'filter', params: { filter: 'gaussian-blur', params: { sigma: 2 } } }]);
    const resolved = action.steps[0].params.params as Record<string, number>;
    // Every schema parameter is present afterwards, defaults filled.
    const schema = getFilterDescriptor('gaussian-blur').params.map((p) => p.name);
    assert.deepEqual(Object.keys(resolved).sort(), schema.sort());
    assert.equal(resolved.sigma, 2);
    assert.equal(resolved.radius, 0);
  });

  test('invalid actions are rejected at definition time, never mid-replay', () => {
    const bad: unknown[] = [
      { name: 'x', steps: [{ op: 'no-such-op', params: {} }] },
      { name: 'x', steps: [{ op: 'filter', params: { filter: 'no-such-filter' } }] },
      { name: 'x', steps: [{ op: 'filter', params: { filter: 'box-blur', params: { radius: 99 } } }] },
      { name: 'x', steps: [{ op: 'filter', params: { filter: 'box-blur', params: { bogus: 1 } } }] },
      { name: 'x', steps: [{ op: 'filter', params: { filter: 'box-blur', stray: 1 } }] },
      { name: 'x', steps: [{ op: 'saturation', params: { amount: 2 } }] },
      { name: 'x', steps: [{ op: 'set-opacity', params: { opacity: 1.5 } }] },
      { name: 'x', steps: [{ op: 'set-blend-mode', params: { mode: 'vivid' } }] },
      { name: 'x', steps: [{ op: 'rotate', params: { degrees: 45 } }] },
      { name: 'x', steps: [{ op: 'resize', params: { width: 0, height: 10 } }] },
      { name: 'x', steps: [{ op: 'export', params: { name: '../evil.png' } }] },
      { name: 'x', steps: [{ op: 'fill-rect', params: { rect: { x: 0, y: 0, width: -1, height: 2 }, color: { r: 0, g: 0, b: 0, a: 255 } } }] },
      { name: 'x', steps: 'not-an-array' },
      { steps: [] },
      'not-an-object'
    ];
    for (const candidate of bad) {
      assert.throws(() => validateAction(candidate), /Invalid action/, JSON.stringify(candidate));
    }
    assert.throws(() => parseAction('{not json'), /Invalid action/);
  });

  test('actions serialize to JSON and back field-exactly (presets)', () => {
    const action = defineAction('preset', [
      { op: 'filter', params: { filter: 'box-blur', params: { radius: 2 }, layer: 'Background' } },
      { op: 'brightness-contrast', params: { brightness: 10, contrast: -5 } },
      { op: 'add-layer', params: { name: 'Patch' } },
      { op: 'fill-rect', params: { rect: { x: 1, y: 2, width: 3, height: 4 }, color: { r: 1, g: 2, b: 3, a: 200 }, layer: 'Patch' } },
      { op: 'export', params: { format: 'bmp', name: 'out.bmp' } }
    ]);
    const json = serializeAction(action);
    const loaded = parseAction(json);
    assert.deepEqual(loaded, action);
    // Serializing the loaded preset reproduces the identical text.
    assert.equal(serializeAction(loaded), json);
  });
});

// ------------------------------------------------------------- replay

describe('Phase 53: replay', () => {
  const OVERLAY_RECT = { x: 2, y: 2, width: 6, height: 4 };
  const OVERLAY_COLOR: RgbaColor = { r: 0, g: 255, b: 0, a: 128 };

  function manualRun(): ImageProject {
    const project = patternProject();
    const bg = project.layers[0].id;
    applyFilter(project, bg, 'box-blur', { radius: 1 });
    adjustBrightnessContrast(project, bg, 15, 5);
    const overlay = addLayer(project, 'Overlay');
    fillRect(project, overlay.id, OVERLAY_RECT, OVERLAY_COLOR);
    setLayerOpacity(project, overlay.id, 0.5);
    return project;
  }

  const EQUIVALENT_ACTION: ImageAction = defineAction('manual-equivalent', [
    { op: 'filter', params: { filter: 'box-blur', params: { radius: 1 }, layer: 'Background' } },
    { op: 'brightness-contrast', params: { brightness: 15, contrast: 5, layer: 'Background' } },
    { op: 'add-layer', params: { name: 'Overlay' } },
    { op: 'fill-rect', params: { rect: OVERLAY_RECT, color: OVERLAY_COLOR, layer: 'Overlay' } },
    { op: 'set-opacity', params: { opacity: 0.5, layer: 'Overlay' } }
  ]);

  test('replaying an action matches performing the operations by hand, byte-exactly', () => {
    const replayed = patternProject();
    applyAction(replayed, EQUIVALENT_ACTION);
    assertImageBytesEqual(composite(replayed), composite(manualRun()));
    // Layer structure matches too: same names in the same order.
    assert.deepEqual(
      replayed.layers.map((l) => l.name),
      manualRun().layers.map((l) => l.name)
    );
  });

  test('a step naming a missing layer fails the replay with the layer named', () => {
    const action = defineAction('bad-target', [{ op: 'invert', params: { layer: 'Nope' } }]);
    assert.throws(() => applyAction(patternProject(), action), /layer not found by name: 'Nope'/);
  });

  test('an invalid action fails before any pixel changes', () => {
    const project = patternProject();
    const before = Buffer.from(composite(project).data);
    const action = {
      name: 'sneaky',
      steps: [
        { op: 'invert', params: {} },
        { op: 'filter', params: { filter: 'box-blur', params: { radius: 500 } } }
      ]
    };
    assert.throws(() => applyAction(project, action as ImageAction), /Invalid action/);
    assert.ok(Buffer.from(composite(project).data).equals(before));
  });

  test('export steps snapshot the composite at their point in the sequence', () => {
    const project = patternProject();
    const { outputs } = applyAction(
      project,
      defineAction('snapshots', [
        { op: 'export', params: { format: 'png', name: 'before.png' } },
        { op: 'invert', params: {} },
        { op: 'export', params: { format: 'bmp' } }
      ])
    );
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].name, 'before.png');
    assert.equal(outputs[1].name, 'export-2.bmp');
    assert.equal(outputs[1].stepIndex, 2);
    // The first snapshot is the untouched pattern; the second is the
    // inverted composite (and BMP round-trips through the codec).
    assertImageBytesEqual(decodePng(outputs[0].buffer), patternImage(24, 16));
    const inverted = patternImage(24, 16);
    for (let i = 0; i < inverted.data.length; i += 4) {
      inverted.data[i] = 255 - inverted.data[i];
      inverted.data[i + 1] = 255 - inverted.data[i + 1];
      inverted.data[i + 2] = 255 - inverted.data[i + 2];
    }
    assertImageBytesEqual(decodeBmp(outputs[1].buffer), inverted);
  });

  test('flatten collapses the stack without changing the rendered image', () => {
    const project = manualRun();
    const before = composite(project);
    applyAction(project, defineAction('flat', [{ op: 'flatten', params: {} }]));
    assert.equal(project.layers.length, 1);
    assert.equal(project.groups.length, 0);
    assertImageBytesEqual(composite(project), before);
  });

  test('resize and rotate steps change the canvas through the engine', () => {
    const project = patternProject(24, 16);
    applyAction(
      project,
      defineAction('geometry', [
        { op: 'resize', params: { width: 10, height: 8 } },
        { op: 'rotate', params: { degrees: 90 } }
      ])
    );
    assert.equal(project.width, 8);
    assert.equal(project.height, 10);
  });
});

// ------------------------------------------------------------ recorder

describe('Phase 53: recorder', () => {
  test('a recording made by doing replays byte-identically on a fresh copy', () => {
    const live = patternProject();
    const recorder = new ActionRecorder(live, 'recorded');
    recorder.filter('box-blur', { radius: 1 });
    recorder.brightnessContrast(15, 5);
    const patch = recorder.addLayer('Patch');
    recorder.fillRect({ x: 3, y: 3, width: 5, height: 5 }, { r: 255, g: 0, b: 0, a: 160 }, patch.id);
    recorder.setOpacity(0.5);
    const snapshot = recorder.exportSnapshot('png', 'final.png');

    const action = recorder.action();
    assert.deepEqual(
      action.steps.map((s) => s.op),
      ['filter', 'brightness-contrast', 'add-layer', 'fill-rect', 'set-opacity', 'export']
    );
    // Steps target layers by name — the fill went to the added layer.
    assert.equal(action.steps[3].params.layer, 'Patch');
    assert.equal(action.steps[4].params.layer, 'Patch');
    // The snapshot the recorder returned is the live project's export.
    assertImageBytesEqual(decodePng(snapshot.buffer), composite(live));

    const fresh = patternProject();
    const { outputs } = applyAction(fresh, action);
    assertImageBytesEqual(composite(fresh), composite(live));
    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].buffer.equals(snapshot.buffer));
  });

  test('the recorder validates as it goes: a bad filter never reaches the recording', () => {
    const recorder = new ActionRecorder(patternProject(), 'guarded');
    assert.throws(() => recorder.filter('box-blur', { radius: 99 }), /out of range/);
    assert.equal(recorder.action().steps.length, 0);
  });
});

// --------------------------------------------------------------- batch

describe('Phase 53: batch processing', () => {
  const INVERT_ACTION = defineAction('invert-all', [{ op: 'invert', params: {} }]);

  function inverted(img: PixelImage): PixelImage {
    const out = createPixelImage(img.width, img.height);
    for (let i = 0; i < img.data.length; i += 4) {
      out.data[i] = 255 - img.data[i];
      out.data[i + 1] = 255 - img.data[i + 1];
      out.data[i + 2] = 255 - img.data[i + 2];
      out.data[i + 3] = img.data[i + 3];
    }
    return out;
  }

  test('runs one action over several real files and verifies every output', async () => {
    await withTmpDir(async (dir) => {
      const inputs = await writeFixturePngs(dir, 4);
      const outDir = path.join(dir, 'out');
      const snapshots: number[] = [];
      const job = startBatch({
        inputs,
        outputDir: outDir,
        action: INVERT_ACTION,
        onProgress: (p) => snapshots.push(p.settled)
      });
      const summary = await job.done;
      assert.deepEqual(
        { total: summary.total, done: summary.done, failed: summary.failed, cancelled: summary.cancelled },
        { total: 4, done: 4, failed: 0, cancelled: 0 }
      );
      // Progress was reported per file, settling one by one.
      assert.deepEqual(snapshots, [1, 2, 3, 4]);
      // Per-file results are individual and in input order.
      for (let i = 0; i < inputs.length; i++) {
        const result = summary.results[i];
        assert.equal(result.input, inputs[i]);
        assert.equal(result.status, 'done');
        assert.equal(result.error, null);
        assert.ok(result.output && result.output.endsWith(`in${i}.edited.png`));
        const written = decodePng(await fs.readFile(result.output));
        assertImageBytesEqual(written, inverted(patternImage(20, 12, i + 1)));
      }
    });
  });

  test('a corrupt input and a missing input fail individually; the batch completes', async () => {
    await withTmpDir(async (dir) => {
      const [good1, good2] = await writeFixturePngs(dir, 2);
      const corrupt = path.join(dir, 'corrupt.png');
      await fs.writeFile(corrupt, Buffer.from('this is not an image at all'));
      const missing = path.join(dir, 'missing.png');
      const job = startBatch({
        inputs: [good1, corrupt, missing, good2],
        outputDir: path.join(dir, 'out'),
        action: INVERT_ACTION
      });
      const summary = await job.done;
      assert.deepEqual(
        { done: summary.done, failed: summary.failed, cancelled: summary.cancelled },
        { done: 2, failed: 2, cancelled: 0 }
      );
      assert.deepEqual(
        summary.results.map((r) => r.status),
        ['done', 'failed', 'failed', 'done']
      );
      assert.ok(summary.results[1].error && summary.results[1].error.length > 0);
      assert.ok(summary.results[2].error && /ENOENT/.test(summary.results[2].error));
      assert.equal(summary.results[1].output, null);
      // The good files on both sides of the failures were written.
      for (const i of [0, 3]) {
        const out = summary.results[i].output;
        assert.ok(out);
        assertImageBytesEqual(decodePng(await fs.readFile(out)), inverted(patternImage(20, 12, i === 0 ? 1 : 2)));
      }
    });
  });

  test('cancellation stops new files from starting; finished files stay done', async () => {
    await withTmpDir(async (dir) => {
      const inputs = await writeFixturePngs(dir, 5);
      const outDir = path.join(dir, 'out');
      const job = startBatch({
        inputs,
        outputDir: outDir,
        action: INVERT_ACTION,
        concurrency: 1,
        onProgress: (p) => {
          if (p.done === 2) job.cancel();
        }
      });
      const summary = await job.done;
      assert.deepEqual(
        { done: summary.done, failed: summary.failed, cancelled: summary.cancelled },
        { done: 2, failed: 0, cancelled: 3 }
      );
      assert.deepEqual(
        summary.results.map((r) => r.status),
        ['done', 'done', 'cancelled', 'cancelled', 'cancelled']
      );
      assert.equal(summary.results[4].output, null);
      // Exactly the two finished outputs exist on disk.
      const written = (await fs.readdir(outDir)).sort();
      assert.deepEqual(written, ['in0.edited.png', 'in1.edited.png']);
      // The job's own progress view agrees with the summary.
      const p = job.progress();
      assert.deepEqual({ done: p.done, cancelled: p.cancelled }, { done: 2, cancelled: 3 });
    });
  });

  test('concurrency drains the queue with per-file results still in input order', async () => {
    await withTmpDir(async (dir) => {
      const inputs = await writeFixturePngs(dir, 4);
      const job = startBatch({
        inputs,
        outputDir: path.join(dir, 'out'),
        action: INVERT_ACTION,
        concurrency: 2
      });
      const summary = await job.done;
      assert.equal(summary.done, 4);
      assert.deepEqual(
        summary.results.map((r) => r.input),
        inputs
      );
      assert.ok(summary.results.every((r) => r.status === 'done'));
    });
  });

  test('an action with an export step drives the batch output format', async () => {
    await withTmpDir(async (dir) => {
      const inputs = await writeFixturePngs(dir, 2);
      const action = defineAction('to-bmp', [
        { op: 'grayscale', params: {} },
        { op: 'export', params: { format: 'bmp', name: 'fixed.bmp' } }
      ]);
      const summary = await startBatch({ inputs, outputDir: path.join(dir, 'out'), action }).done;
      assert.equal(summary.done, 2);
      // Names derive from the inputs (not the step's fixed name), so
      // the two files do not overwrite each other.
      assert.ok(summary.results[0].output?.endsWith('in0.edited.bmp'));
      assert.ok(summary.results[1].output?.endsWith('in1.edited.bmp'));
      const bytes = await fs.readFile(summary.results[0].output!);
      assert.equal(detectFormat(bytes), 'bmp');
      const decoded = decodeBmp(bytes);
      assert.equal(decoded.width, 20);
      assert.equal(decoded.height, 12);
      // Grayscale: every pixel has r === g === b.
      for (let i = 0; i < decoded.data.length; i += 4) {
        assert.equal(decoded.data[i], decoded.data[i + 1]);
        assert.equal(decoded.data[i + 1], decoded.data[i + 2]);
      }
    });
  });

  test('startBatch rejects an invalid action and bad options before starting', async () => {
    await withTmpDir(async (dir) => {
      const inputs = await writeFixturePngs(dir, 1);
      assert.throws(
        () => startBatch({ inputs, outputDir: path.join(dir, 'out'), action: { name: 'x', steps: [{ op: 'nope', params: {} }] } }),
        /Invalid action/
      );
      assert.throws(() => startBatch({ inputs, outputDir: path.join(dir, 'out'), action: INVERT_ACTION, concurrency: 0 }), /concurrency/);
    });
  });
});
