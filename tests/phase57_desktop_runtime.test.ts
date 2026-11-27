import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageProjectGenerator } from '../server/imageEditor/imageProjectGenerator.js';

/**
 * Phase 57: Desktop Runtime and Workflow Testing.
 *
 * The runtime evidence itself comes from the .NET harness
 * (scripts/phase57-runtime-harness.ts + scripts/phase57-runtime-harness/
 * Program.cs), which compiles the generated app's UI-independent
 * sources and executes real editing workflows against them. These
 * tests pin the seam that harness relies on, so it cannot silently
 * rot: the engine core (PixelEngine.cs) and the document model
 * (ImageDocument.cs) must stay free of System.Drawing.Common /
 * WinForms types, with the GDI surface isolated in the two
 * .Drawing.cs partials, and the harness must keep regenerating the
 * app fresh and compiling exactly the core sources.
 */

const files = ImageProjectGenerator.generateProjectFiles(ImageProjectGenerator.getDefaultConfig());
const engine = files['src/PixelForge/PixelEngine.cs'];
const engineDrawing = files['src/PixelForge/PixelEngine.Drawing.cs'];
const doc = files['src/PixelForge/ImageDocument.cs'];
const docDrawing = files['src/PixelForge/ImageDocument.Drawing.cs'];
const form = files['src/PixelForge/MainForm.cs'];
const workspace = files['src/PixelForge/Workspace.cs'];

const repoRoot = join(import.meta.dirname, '..');
const driverPath = join(repoRoot, 'scripts', 'phase57-runtime-harness.ts');
const harnessProgramPath = join(repoRoot, 'scripts', 'phase57-runtime-harness', 'Program.cs');

/**
 * Strip C# comments (// and /// lines, /* *\/ spans) so the absence
 * assertions below judge code, not prose: the core files' own doc
 * comments legitimately mention the Bitmap boundary they exclude.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('Phase 57 — the headless seam in the generated app', () => {
  test('57.1 the generator emits the core/Drawing split as separate files', () => {
    for (const name of ['PixelEngine.cs', 'PixelEngine.Drawing.cs', 'ImageDocument.cs', 'ImageDocument.Drawing.cs']) {
      assert.ok(files[`src/PixelForge/${name}`], `missing generated file ${name}`);
    }
    assert.match(engine, /public sealed partial class PixelImage/);
    assert.match(doc, /public sealed partial class ImageDocument/);
    assert.match(doc, /public sealed partial class EditorLayer/);
  });

  test('57.2 PixelEngine.cs has no GDI dependency (the harness compiles it on Linux)', () => {
    const code = codeOnly(engine);
    assert.doesNotMatch(code, /System\.Drawing\.Imaging/);
    assert.doesNotMatch(code, /\bBitmap\b/);
    assert.doesNotMatch(code, /\bGraphics\b/);
    assert.doesNotMatch(code, /\bMarshal\b/);
    assert.doesNotMatch(code, /System\.Windows\.Forms/);
    // The raw-buffer replacements that make the core self-sufficient:
    assert.match(engine, /public static class PngCodec/);
    assert.match(engine, /public enum RotateFlipKind/);
  });

  test('57.3 the Bitmap boundary lives in PixelEngine.Drawing.cs', () => {
    assert.match(engineDrawing, /using System\.Drawing\.Imaging;/);
    assert.match(engineDrawing, /public static PixelImage FromBitmap\(Bitmap bmp\)/);
    assert.match(engineDrawing, /public Bitmap ToBitmap\(\)/);
    assert.match(engineDrawing, /public void WriteTo\(Bitmap bmp\)/);
    assert.match(engineDrawing, /public sealed partial class PixelImage/);
  });

  test('57.4 ImageDocument.cs runs on raw buffers: PNG via PngCodec, geometry via RotateFlipKind', () => {
    const code = codeOnly(doc);
    assert.doesNotMatch(code, /\bBitmap\b/);
    assert.doesNotMatch(code, /\bGraphics\b/);
    assert.doesNotMatch(code, /ImageFormat/);
    assert.doesNotMatch(code, /RotateFlipType/);
    assert.match(doc, /PngCodec\.Encode\(l\.Pixels\)/);
    assert.match(doc, /PngCodec\.Decode\(File\.ReadAllBytes/);
    assert.match(doc, /public void RotateFlip\(RotateFlipKind kind\)/);
    // The cached-Bitmap invalidation is a partial-method hook: present
    // as a call, implemented only by the Drawing part.
    assert.match(doc, /partial void InvalidateCachedBitmap\(\);/);
  });

  test('57.5 the document GDI surface lives in ImageDocument.Drawing.cs', () => {
    assert.match(docDrawing, /public Bitmap Flatten\(\)/);
    assert.match(docDrawing, /public Bitmap Bitmap/);
    assert.match(docDrawing, /partial void InvalidateCachedBitmap\(\)/);
  });

  test('57.6 the shell drives the raw geometry API, never the GDI enum', () => {
    assert.match(form, /_doc\.RotateFlip\(RotateFlipKind\.Rotate90FlipNone\)/);
    assert.match(form, /_doc\.RotateFlip\(RotateFlipKind\.RotateNoneFlipX\)/);
    assert.doesNotMatch(form, /RotateFlipType/);
  });

  test('57.7 Workspace.cs stays WinForms-bound (the documented reason shortcuts are not in the harness)', () => {
    assert.match(workspace, /KeyEventArgs/);
    assert.match(workspace, /\bKeys\b/);
  });
});

describe('Phase 57 — the runtime harness deliverable', () => {
  test('57.8 the harness driver and program are checked in', () => {
    assert.ok(existsSync(driverPath), 'scripts/phase57-runtime-harness.ts exists');
    assert.ok(existsSync(harnessProgramPath), 'scripts/phase57-runtime-harness/Program.cs exists');
  });

  test('57.9 the driver regenerates the app fresh and compiles exactly the core sources', () => {
    const driver = readFileSync(driverPath, 'utf8');
    assert.match(driver, /generateProjectFiles/);
    assert.match(driver, /PHASE57_CORE_SOURCES = \['PixelEngine\.cs', 'ImageDocument\.cs'\]/);
    // The exclusions are named with reasons, not silently dropped.
    assert.match(driver, /'PixelEngine\.Drawing\.cs': 'GDI boundary/);
    assert.match(driver, /'Workspace\.cs': 'WinForms-bound shortcut resolver/);
  });

  test('57.10 the harness program covers the workflow scenarios and reports a summary', () => {
    const program = readFileSync(harnessProgramPath, 'utf8');
    for (const id of ['S00', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S10', 'S11', 'S12']) {
      assert.match(program, new RegExp(`Scenario\\("${id} `), `harness scenario ${id} present`);
    }
    // The two headless-impossible scenarios are documented skips, never silent passes.
    assert.match(program, /Skipped\("S09 undo\/redo"/);
    assert.match(program, /Skipped\("S13 keyboard shortcut resolution"/);
    assert.match(program, /HARNESS SUMMARY:/);
  });
});
