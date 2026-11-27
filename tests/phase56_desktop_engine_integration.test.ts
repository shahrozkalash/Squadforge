import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';
import {
  BUILT_IN_BRUSH_PRESETS,
  DEFAULT_BRUSH_SETTINGS,
  listFilters
} from '../server/imageEditor/imageCore.js';
import { BLEND_MODES } from '../server/imageEditor/types.js';
import { glyphRowsFor } from '../server/imageEditor/bitmapFont.js';

/**
 * Phase 56: the generated C# desktop editor must carry the TS
 * graphics engine's real implementations, not placeholders. These
 * tests pin the generated sources against the engine's own data:
 * the emitted filter table must equal listFilters(), the emitted
 * glyph tables must equal glyphRowsFor(), the emitted brush
 * defaults/presets must equal the Phase 46 model, and the blend /
 * brush / noise code must contain the engine's actual formulas.
 * Wiring assertions then prove the shell calls those
 * implementations (menus, panels, canvas) rather than dead code.
 */

const files = ImageProjectGenerator.generateProjectFiles(ImageProjectGenerator.getDefaultConfig());
const engine = files['src/PixelForge/PixelEngine.cs'];
const doc = files['src/PixelForge/ImageDocument.cs'];
const canvas = files['src/PixelForge/EditorCanvas.cs'];
const form = files['src/PixelForge/MainForm.cs'];
const dialogs = files['src/PixelForge/Dialogs.cs'];

function num(s: string): number {
  return Number(s);
}

/** Extract the C# block starting at `marker` up to the next top-level `    };` or end marker. */
function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `end marker not found after: ${startMarker}`);
  return source.slice(start, end);
}

describe('56.1 generated file set', () => {
  test('the generator emits the engine core and dialogs alongside the Phase 19 files', () => {
    for (const expected of [
      'src/PixelForge/PixelEngine.cs',
      'src/PixelForge/Dialogs.cs',
      'src/PixelForge/ImageDocument.cs',
      'src/PixelForge/EditorCanvas.cs',
      'src/PixelForge/MainForm.cs',
      'src/PixelForge/Workspace.cs'
    ]) {
      assert.ok(files[expected], `missing ${expected}`);
    }
    // The scaffold's placeholder form must not survive.
    assert.ok(!files['src/PixelForge/MainForm.Designer.cs'], 'scaffold MainForm.Designer.cs removed');
  });
});

describe('56.2 filter registry carried into the generated app', () => {
  test('the emitted descriptor table equals listFilters() exactly', () => {
    const descriptors = listFilters();
    assert.equal(descriptors.length, 16);
    for (const d of descriptors) {
      const lineStart = engine.indexOf(`new("${d.id}", "${d.name}", new FilterParamSpec[] {`);
      assert.ok(lineStart >= 0, `descriptor emitted for ${d.id}`);
      const lineEnd = engine.indexOf('})', lineStart);
      const line = engine.slice(lineStart, lineEnd);
      const params = [...line.matchAll(/new\("([a-zA-Z]+)", (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)/g)].map((m) => ({
        name: m[1],
        min: num(m[2]),
        max: num(m[3]),
        def: num(m[4])
      }));
      assert.deepEqual(
        params,
        d.params.map((p) => ({ name: p.name, min: p.min, max: p.max, def: p.defaultValue })),
        `params for ${d.id}`
      );
      // Every registry filter has a real implementation behind the Apply switch.
      assert.ok(engine.includes(`"${d.id}" =>`), `Apply dispatch for ${d.id}`);
    }
  });

  test('filter kernels carry the engine math, not stubs', () => {
    // Seeded noise uses the same mulberry32 the TS engine uses.
    assert.ok(engine.includes('0x6D2B79F5'), 'mulberry32 increment present');
    // Brightness/contrast uses the Phase 19 contrast factor formula.
    assert.ok(engine.includes('259 * (contrast + 255) / (255 * (259 - contrast))'), 'contrast factor formula');
    // Gaussian blur builds a normalized kernel from sigma.
    assert.ok(engine.includes('Math.Exp(-(i * i) / (2 * sigma * sigma))'), 'gaussian kernel');
    // Sepia is the fixed matrix, posterize quantizes, threshold compares.
    assert.ok(engine.includes('0.393') && engine.includes('0.769') && engine.includes('0.189'), 'sepia matrix row');
  });

  test('ResolveParams validates like the TS registry (named errors, no silent clamping)', () => {
    assert.ok(engine.includes("Unknown parameter '"), 'unknown parameter rejected by name');
    assert.ok(engine.includes('out of range'), 'out-of-range rejected by name');
  });
});

describe('56.3 blend modes and compositing', () => {
  test('BlendModes.All equals the TS BLEND_MODES in order', () => {
    const m = engine.match(/public static readonly string\[\] All = \{ ([^}]+) \}/);
    assert.ok(m, 'BlendModes.All emitted');
    const modes = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    assert.deepEqual(modes, [...BLEND_MODES]);
  });

  test('the W3C blend formulas are the engine formulas', () => {
    assert.ok(engine.includes('"multiply" => cb * cs'), 'multiply');
    assert.ok(engine.includes('"screen" => 1 - (1 - cb) * (1 - cs)'), 'screen');
    assert.ok(engine.includes('"darken" => Math.Min(cb, cs)'), 'darken');
    assert.ok(engine.includes('"lighten" => Math.Max(cb, cs)'), 'lighten');
    assert.ok(engine.includes('cb <= 0.5 ? 2 * cb * cs'), 'overlay low branch');
    assert.ok(engine.includes('1 - 2 * (1 - cb) * (1 - cs)'), 'overlay high branch');
    // W3C composite: co = (as(1-ab)Cs + as·ab·B + (1-as)ab·Cb) / ao, ao = as + ab(1-as).
    assert.ok(engine.includes('double ao = sa + ab * (1 - sa)'), 'composite alpha');
    assert.ok(
      engine.includes('double co = (sa * (1 - ab) * src[c] + sa * ab * blended + (1 - sa) * ab * cb) / ao'),
      'W3C composite numerator'
    );
  });

  test('alpha lock is enforced in the paint path', () => {
    assert.ok(engine.includes('public static void BlendPaint'), 'BlendPaint exists');
    assert.ok(engine.includes('locked: never create or change alpha'), 'alpha-lock guard');
    assert.ok(engine.includes('the lock holds'), 'alpha channel preserved under lock');
  });

  test('the compositor renders effect stacks and adjustment layers', () => {
    assert.ok(engine.includes('class Compositor'), 'compositor emitted');
    assert.ok(engine.includes('EffectStack.Apply'), 'effect stacks applied at composite time');
    assert.ok(engine.includes('"adjustment"'), 'adjustment layers handled');
    assert.ok(engine.includes('clipBase'), 'clipping uses the base layer alpha map');
  });
});

describe('56.4 brush engine (Phase 46 model)', () => {
  test('emitted BrushSettings defaults equal DEFAULT_BRUSH_SETTINGS', () => {
    const cls = block(engine, 'public sealed class BrushSettings', 'public readonly struct StrokePoint');
    const grab = (name: string) => {
      const m = cls.match(new RegExp(`public double ${name} \\{ get; set; \\} = (-?[\\d.]+);`));
      assert.ok(m, `${name} initializer emitted`);
      return num(m[1]);
    };
    assert.equal(grab('Size'), DEFAULT_BRUSH_SETTINGS.size);
    assert.equal(grab('Hardness'), DEFAULT_BRUSH_SETTINGS.hardness);
    assert.equal(grab('Spacing'), DEFAULT_BRUSH_SETTINGS.spacing);
    assert.equal(grab('Opacity'), DEFAULT_BRUSH_SETTINGS.opacity);
    assert.equal(grab('Flow'), DEFAULT_BRUSH_SETTINGS.flow);
    assert.equal(grab('Smoothing'), DEFAULT_BRUSH_SETTINGS.smoothing);
  });

  test('emitted presets equal BUILT_IN_BRUSH_PRESETS scalar settings', () => {
    for (const preset of BUILT_IN_BRUSH_PRESETS) {
      const start = engine.indexOf(`("${preset.name}", new BrushSettings {`);
      assert.ok(start >= 0, `preset emitted: ${preset.name}`);
      const line = engine.slice(start, engine.indexOf('})', start));
      const grab = (name: string) => {
        const m = line.match(new RegExp(`${name} = (-?[\\d.]+)`));
        assert.ok(m, `${preset.name}.${name}`);
        return num(m[1]);
      };
      const s = preset.settings;
      assert.equal(grab('Size'), s.size, `${preset.name} size`);
      assert.equal(grab('Hardness'), s.hardness, `${preset.name} hardness`);
      assert.equal(grab('Spacing'), s.spacing, `${preset.name} spacing`);
      assert.equal(grab('Opacity'), s.opacity, `${preset.name} opacity`);
      assert.equal(grab('Flow'), s.flow, `${preset.name} flow`);
      assert.equal(grab('Smoothing'), s.smoothing, `${preset.name} smoothing`);
      assert.ok(line.includes(`PressureSize = ${s.pressureSize ? 'true' : 'false'}`), `${preset.name} pressureSize`);
      assert.ok(line.includes(`PressureOpacity = ${s.pressureOpacity ? 'true' : 'false'}`), `${preset.name} pressureOpacity`);
    }
  });

  test('the coverage build-up is the Phase 46 accumulation formula', () => {
    assert.ok(
      engine.includes('cov[idx] = (float)(cov[idx] + deposit * (1 - cov[idx]));'),
      'coverage accumulates as cov += deposit * (1 - cov)'
    );
    // Smoothing is the EMA k = 1 - amount * 0.9 from the TS engine.
    assert.ok(engine.includes('1 - amount * 0.9'), 'EMA smoothing factor');
    // Erasing scales alpha by the same coverage (true alpha erase).
    assert.ok(engine.includes('public static void EraseStroke'), 'EraseStroke exists');
  });
});

describe('56.5 typography and vectors (Phase 48)', () => {
  function glyphTable(marker: string): Map<number, number[]> {
    const start = engine.indexOf(marker);
    assert.ok(start >= 0, `${marker} emitted`);
    const body = engine.slice(start, engine.indexOf('};', start));
    const table = new Map<number, number[]>();
    for (const m of body.matchAll(/\{\s*(\d+), new\[\] \{ ([^}]+) \} \}/g)) {
      table.set(Number(m[1]), m[2].split(',').map((h) => parseInt(h.trim(), 16)));
    }
    return table;
  }

  test('emitted glyph tables equal glyphRowsFor for both fonts', () => {
    const pixel = glyphTable('PixelGlyphs = new()');
    const bold = glyphTable('PixelBoldGlyphs = new()');
    assert.equal(pixel.size, 49, 'pixel charset size');
    assert.equal(bold.size, 49, 'pixel-bold charset size');
    for (const ch of ['A', 'B', 'M', 'Z', '0', '5', '9', '.', ',', '!', '(', '/']) {
      assert.deepEqual(pixel.get(ch.charCodeAt(0)), glyphRowsFor('pixel', ch), `pixel glyph ${ch}`);
      assert.deepEqual(bold.get(ch.charCodeAt(0)), glyphRowsFor('pixel-bold', ch), `pixel-bold glyph ${ch}`);
    }
    // The fallback (for characters outside the charset) matches too.
    const fb = engine.match(/PixelFallback = \{ ([^}]+) \}/);
    assert.ok(fb, 'pixel fallback emitted');
    assert.deepEqual(fb[1].split(',').map((h) => parseInt(h.trim(), 16)), glyphRowsFor('pixel', '~'));
  });

  test('text scale snaps to the 7px glyph grid like the TS engine', () => {
    assert.ok(engine.includes('Math.Max(1, Px.Round(fontSize / 7))'), 'scale = max(1, round(size/7))');
  });

  test('shapes rasterize through real geometry (even-odd fill, Bezier flattening)', () => {
    assert.ok(engine.includes('PointInPolygon'), 'even-odd polygon fill');
    assert.ok(engine.includes('FlattenBezierSegment'), 'Bezier flattening');
    assert.ok(engine.includes('CubicBezierPoint'), 'cubic Bezier formula');
  });
});

describe('56.6 document model and persistence', () => {
  test('the save manifest carries the Phase 44-52 state', () => {
    for (const field of ['BlendMode', 'AlphaLock', 'Clipped', 'Kind', 'MaskFile', 'Effects', 'Text', 'Shape']) {
      assert.ok(doc.includes(`"${field}"`), `manifest field ${field}`);
    }
  });

  test('old (Phase 19) saves still load: new fields are read with defaults', () => {
    // Scalar fields go through tolerant helpers built on TryGetProperty.
    assert.ok(doc.includes('el.TryGetProperty(name, out var v)'), 'tolerant property reader');
    assert.ok(doc.includes('GetString(entry, "BlendMode", "normal")'), 'blend mode defaults to normal');
    assert.ok(doc.includes('TryGetProperty("Effects"'), 'effects read tolerantly');
    assert.ok(doc.includes('TryGetProperty("Text"'), 'text data read tolerantly');
  });

  test('stored effects are validated on load through the registry', () => {
    assert.ok(doc.includes('Filters.ResolveParams('), 'load validates effect params via ResolveParams');
    assert.ok(doc.includes('Filters.DescriptorFor('), 'load resolves effect ids via the registry');
  });

  test('bake is the explicit destructive commit with the TS refusals', () => {
    assert.ok(doc.includes('BakeEffects'), 'BakeEffects exists');
    assert.ok(doc.includes('it has no pixels of its own to bake into'), 'adjustment bake refused like TS');
    assert.ok(doc.includes('render cache of its editable data'), 'content-layer bake refused like TS');
  });
});

describe('56.7 shell wiring (no dead controls)', () => {
  test('the Filters menu is built from the generated registry and applies through Filters.Apply', () => {
    assert.ok(form.includes('foreach (var descriptor in Filters.Descriptors)'), 'menu built from registry');
    assert.ok(form.includes('Filters.Apply(layer.Pixels, descriptor.Id'), 'menu applies the filter');
    assert.ok(form.includes('_canvas.Selection'), 'application is selection-scoped');
    assert.ok(form.includes('new FilterParamsDialog(descriptor'), 'parameters come from the descriptor dialog');
  });

  test('the layer panel binds the real layer state', () => {
    assert.ok(form.includes('_blendBox.Items.AddRange(BlendModes.All)'), 'blend combo from BlendModes.All');
    assert.ok(form.includes('_doc.Active.BlendMode = mode'), 'blend selection writes the layer');
    assert.ok(form.includes('_doc.Active.Opacity = '), 'opacity writes the layer');
    assert.ok(form.includes('_doc.Active.AlphaLock = '), 'alpha lock writes the layer');
    assert.ok(form.includes('_doc.Active.Clipped = '), 'clipping writes the layer');
    assert.ok(form.includes('_doc.CreateMask(_doc.Active)'), 'mask add wired');
    assert.ok(form.includes('_doc.InvertMask(_doc.Active)'), 'mask invert wired');
    assert.ok(form.includes('_doc.ApplyMask(_doc.Active)'), 'mask apply wired');
    assert.ok(form.includes('_doc.RemoveMask(_doc.Active)'), 'mask remove wired');
    assert.ok(form.includes('PaintMaskMode = _maskPaintCheck.Checked'), 'paint-mask toggle wired to the canvas');
  });

  test('non-destructive editing is reachable: effects dialog, adjustment layers, bake', () => {
    assert.ok(form.includes('new EffectsDialog(layer.Name, layer.Effects)'), 'effects dialog opens on the active layer');
    assert.ok(form.includes('"adjustment"'), 'adjustment layer creation wired');
    assert.ok(form.includes('_doc.BakeEffects(layer)'), 'bake wired');
    assert.ok(dialogs.includes('Filters.ResolveParams(descriptor'), 'effects dialog validates params via the registry');
  });

  test('content layers are created and edited as data', () => {
    assert.ok(form.includes('new TextLayerDialog('), 'text dialog wired');
    assert.ok(form.includes('new ShapeLayerDialog('), 'shape dialog wired');
    assert.ok(form.includes('_doc.AddTextLayer(dialog.Data)'), 'text layer created from data');
    assert.ok(form.includes('_doc.AddShapeLayer(dialog.Data)'), 'shape layer created from data');
    assert.ok(form.includes('_doc.RenderContentLayer(layer)'), 'edits re-render from data');
    assert.ok(canvas.includes('TextToolClicked'), 'text tool click reaches the shell');
  });

  test('the canvas paints through the brush engine, including mask painting', () => {
    assert.ok(canvas.includes('BrushEngine.PaintStroke('), 'brush tool uses the coverage engine');
    assert.ok(canvas.includes('BrushEngine.EraseStroke('), 'eraser uses the coverage engine');
    assert.ok(canvas.includes('BrushEngine.PaintMaskStroke('), 'mask painting uses the coverage engine');
    assert.ok(form.includes('BrushEngine.Presets'), 'preset picker is fed by the engine presets');
    assert.ok(form.includes('_canvas.Brush.Size = '), 'size control writes the brush model');
    assert.ok(form.includes('_canvas.Brush.Hardness = '), 'hardness control writes the brush model');
    assert.ok(form.includes('_canvas.Brush.Flow = '), 'flow control writes the brush model');
  });
});
