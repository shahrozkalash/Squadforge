// Phase 57 runtime harness.
//
// This console program is compiled together with the GENERATED
// PixelForge app's UI-independent sources — PixelEngine.cs and
// ImageDocument.cs from a fresh generation (see
// scripts/phase57-runtime-harness.ts, which regenerates the app and
// copies exactly those two files here), plus CrashDiagnostics.cs
// since Phase 60 — and runs real editing
// workflows against them: the same document/engine calls the
// WinForms shell makes from its menus, canvas and dialogs.
//
// The generated app's GDI boundary (PixelEngine.Drawing.cs,
// ImageDocument.Drawing.cs), its WinForms shell (MainForm,
// EditorCanvas, Dialogs, Workspace, Program) are NOT compiled here:
// System.Drawing.Common and System.Windows.Forms do not execute on
// Linux .NET 8, which is exactly the seam Phase 57 established.
// GUI interaction itself (mouse canvas events, panel rendering,
// visual layout) is therefore NOT exercised by this harness and
// remains unverified until the app runs on a Windows machine.
//
// Exit code 0 iff every executed assertion passes. Scenarios that
// cannot run headless (S09 undo/redo, S13 shortcuts) print a
// documented SKIPPED line with the reason instead of passing silently.

using System.Diagnostics;
using System.Drawing;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using PixelForge;

int checks = 0;
int failures = 0;
int scenarios = 0;
int skipped = 0;

void Check(bool cond, string what)
{
    checks++;
    if (!cond)
    {
        failures++;
        Console.WriteLine("  FAIL: " + what);
    }
}

void EqPx(PixelImage img, int x, int y, int r, int g, int b, int a, string what)
{
    int i = (y * img.Width + x) * 4;
    var actual = (img.Data[i], img.Data[i + 1], img.Data[i + 2], img.Data[i + 3]);
    Check(actual == (r, g, b, a),
        $"{what}: pixel ({x},{y}) expected ({r},{g},{b},{a}) got ({actual.Item1},{actual.Item2},{actual.Item3},{actual.Item4})");
}

void EqMask(byte[] mask, int w, int x, int y, int v, string what)
{
    Check(mask[y * w + x] == v, $"{what}: mask ({x},{y}) expected {v} got {mask[y * w + x]}");
}

void Throws<TEx>(Action body, string what, string messagePart) where TEx : Exception
{
    checks++;
    try
    {
        body();
        failures++;
        Console.WriteLine($"  FAIL: {what}: expected {typeof(TEx).Name}, nothing was thrown");
    }
    catch (TEx ex)
    {
        if (!ex.Message.Contains(messagePart))
        {
            failures++;
            Console.WriteLine($"  FAIL: {what}: {typeof(TEx).Name} message \"{ex.Message}\" does not contain \"{messagePart}\"");
        }
    }
    catch (Exception ex)
    {
        failures++;
        Console.WriteLine($"  FAIL: {what}: expected {typeof(TEx).Name}, got {ex.GetType().Name}: {ex.Message}");
    }
}

void Scenario(string name, Action body)
{
    scenarios++;
    var sw = Stopwatch.StartNew();
    int before = failures;
    try
    {
        body();
    }
    catch (Exception ex)
    {
        failures++;
        Console.WriteLine($"  EXCEPTION: {ex.GetType().Name}: {ex.Message}");
    }
    sw.Stop();
    Console.WriteLine($"{name}: {(failures == before ? "PASS" : "FAIL")} ({sw.ElapsedMilliseconds} ms)");
}

void Skipped(string name, string reason)
{
    scenarios++;
    skipped++;
    Console.WriteLine($"{name}: SKIPPED (documented) — {reason}");
}

PixelImage Filled(int w, int h, int r, int g, int b, int a = 255)
{
    var img = new PixelImage(w, h);
    img.Clear((byte)r, (byte)g, (byte)b, (byte)a);
    return img;
}

void SetPx(PixelImage img, int x, int y, int r, int g, int b, int a = 255)
{
    int i = (y * img.Width + x) * 4;
    img.Data[i] = (byte)r; img.Data[i + 1] = (byte)g; img.Data[i + 2] = (byte)b; img.Data[i + 3] = (byte)a;
}

var totalSw = Stopwatch.StartNew();

// ---------------------------------------------------------------- S00
Scenario("S00 environment and seam evidence", () =>
{
    Console.WriteLine("  runtime: " + RuntimeInformation.FrameworkDescription);
    Console.WriteLine("  os: " + RuntimeInformation.OSDescription + " / " + RuntimeInformation.OSArchitecture);
    var refs = typeof(PixelImage).Assembly.GetReferencedAssemblies().Select(a => a.Name).OrderBy(n => n).ToList();
    Console.WriteLine("  harness assembly references: " + string.Join(", ", refs));
    Check(!refs.Contains("System.Drawing.Common"), "the engine core must not reference System.Drawing.Common");
    Check(!refs.Contains("System.Windows.Forms"), "the engine core must not reference System.Windows.Forms");
    Check(refs.Contains("System.Drawing.Primitives"), "System.Drawing.Primitives (Color/Rectangle) is in-box and expected");
});

// ---------------------------------------------------------------- S01
Scenario("S01 create project, add/reorder/delete layers", () =>
{
    using var doc = new ImageDocument(64, 48);
    Check(doc.Layers.Count == 1, "a new document starts with exactly the Background layer");
    Check(doc.Layers[0].Name == "Background", "the first layer is named Background");
    EqPx(doc.Layers[0].Pixels, 0, 0, 255, 255, 255, 255, "Background starts opaque white");
    EqPx(doc.Layers[0].Pixels, 63, 47, 255, 255, 255, 255, "Background is white to the last pixel");

    var paint = doc.AddLayer("Paint");
    Check(doc.Layers.Count == 2 && doc.ActiveIndex == 1, "AddLayer appends on top and activates it");
    EqPx(paint.Pixels, 10, 10, 0, 0, 0, 0, "a new raster layer starts transparent");

    var top = doc.AddLayer("Top");
    Check(doc.Layers.Count == 3 && doc.ActiveIndex == 2, "a second AddLayer lands on top");
    doc.MoveLayer(2, -1);
    Check(doc.Layers[1] == top && doc.Layers[2] == paint && doc.ActiveIndex == 1,
        "MoveLayer swaps with the layer below and follows it");
    doc.MoveLayer(0, -1);
    Check(doc.Layers[0].Name == "Background", "MoveLayer past the bottom is a no-op");
    doc.MoveLayer(2, 1);
    Check(doc.Layers[2] == paint, "MoveLayer past the top is a no-op");

    doc.RemoveLayer(1);
    Check(doc.Layers.Count == 2 && doc.Layers[1] == paint, "RemoveLayer removes the middle layer");
    doc.RemoveLayer(1);
    Check(doc.Layers.Count == 1, "RemoveLayer removes down to one layer");
    doc.RemoveLayer(0);
    Check(doc.Layers.Count == 1, "the last layer cannot be removed");
});

// ---------------------------------------------------------------- S02
Scenario("S02 brush strokes: hardness, flow, opacity cap, erase, alpha lock", () =>
{
    var settings = new BrushSettings { Size = 8, Hardness = 1, Flow = 1, Opacity = 1, Spacing = 0.25, Smoothing = 0 };

    // Full-strength hard stamp: exact color at the centre, sharp edge at the radius.
    var img = new PixelImage(32, 32);
    BrushEngine.PaintStroke(img, new List<StrokePoint> { new(16, 16) }, settings, Color.Red, false, null);
    EqPx(img, 16, 16, 255, 0, 0, 255, "hard stamp centre is the exact paint color");
    EqPx(img, 20, 16, 255, 0, 0, 255, "hard stamp still covers at distance = radius (profile 1 at nd = 1)");
    EqPx(img, 21, 16, 0, 0, 0, 0, "hard stamp leaves pixels beyond the radius untouched");

    // A walked stroke covers its whole path.
    var line = new PixelImage(64, 48);
    BrushEngine.PaintStroke(line, new List<StrokePoint> { new(8, 24), new(56, 24) }, settings, Color.Blue, false, null);
    EqPx(line, 32, 24, 0, 0, 255, 255, "stroke midpoint is painted (spacing walk)");
    EqPx(line, 32, 20, 0, 0, 255, 255, "stroke covers up to the radius above the path");
    EqPx(line, 32, 19, 0, 0, 0, 0, "stroke does not reach beyond the radius");

    // Flow 0.5: one stamp deposits half coverage — full color at half alpha over transparency.
    var flow = new PixelImage(32, 32);
    var flowSettings = new BrushSettings { Size = 8, Hardness = 1, Flow = 0.5, Opacity = 1, Spacing = 0.25, Smoothing = 0 };
    BrushEngine.PaintStroke(flow, new List<StrokePoint> { new(16, 16) }, flowSettings, Color.Red, false, null);
    EqPx(flow, 16, 16, 255, 0, 0, 128, "flow 0.5 gives full color at alpha 128 (round(0.5 x 255))");

    // Opacity is the stroke-level cap even at flow 1.
    var cap = new PixelImage(32, 32);
    var capSettings = new BrushSettings { Size = 8, Hardness = 1, Flow = 1, Opacity = 0.5, Spacing = 0.25, Smoothing = 0 };
    BrushEngine.PaintStroke(cap, new List<StrokePoint> { new(16, 16) }, capSettings, Color.Red, false, null);
    EqPx(cap, 16, 16, 255, 0, 0, 128, "opacity 0.5 caps the stroke at alpha 128");

    // Soft edge: hardness 0 falls off linearly — half coverage at nd = 0.5.
    var soft = new PixelImage(32, 32);
    var softSettings = new BrushSettings { Size = 8, Hardness = 0, Flow = 1, Opacity = 1, Spacing = 0.25, Smoothing = 0 };
    BrushEngine.PaintStroke(soft, new List<StrokePoint> { new(16, 16) }, softSettings, Color.Red, false, null);
    EqPx(soft, 16, 16, 255, 0, 0, 255, "soft brush centre is still full strength");
    EqPx(soft, 18, 16, 255, 0, 0, 128, "soft brush at nd = 0.5 deposits half coverage");

    // True alpha erase: full-strength erase zeroes the pixel (RGB too), partial erase scales alpha only.
    var erased = Filled(32, 32, 10, 20, 30);
    BrushEngine.EraseStroke(erased, new List<StrokePoint> { new(16, 16) }, settings, false, null);
    EqPx(erased, 16, 16, 0, 0, 0, 0, "full erase zeroes the pixel including RGB");
    EqPx(erased, 28, 16, 10, 20, 30, 255, "erase leaves pixels outside the radius untouched");
    var halfErased = Filled(32, 32, 10, 20, 30);
    BrushEngine.EraseStroke(halfErased, new List<StrokePoint> { new(16, 16) }, capSettings, false, null);
    EqPx(halfErased, 16, 16, 10, 20, 30, 128, "opacity 0.5 erase halves alpha and keeps RGB");

    // Alpha lock: erase is refused outright; paint never creates alpha but recolors opaque pixels.
    var locked = Filled(32, 32, 10, 20, 30);
    BrushEngine.EraseStroke(locked, new List<StrokePoint> { new(16, 16) }, settings, true, null);
    EqPx(locked, 16, 16, 10, 20, 30, 255, "erase under alpha lock is a no-op");
    var lockPaint = new PixelImage(32, 32);
    SetPx(lockPaint, 20, 16, 100, 100, 100, 255);
    BrushEngine.PaintStroke(lockPaint, new List<StrokePoint> { new(16, 16) }, settings, Color.FromArgb(200, 0, 0), true, null);
    EqPx(lockPaint, 16, 16, 0, 0, 0, 0, "paint under alpha lock never creates alpha on transparent pixels");
    EqPx(lockPaint, 20, 16, 200, 0, 0, 255, "paint under alpha lock recolors opaque pixels, alpha preserved");
});

// ---------------------------------------------------------------- S03
Scenario("S03 blend modes and opacity composite to hand-computed values", () =>
{
    // Backdrop (200,100,50) everywhere; the top layer is (40,120,200) opaque.
    ImageDocument DocWithTop(string mode, double opacity)
    {
        var d = new ImageDocument(8, 8);
        d.Layers[0].SetPixels(Filled(8, 8, 200, 100, 50));
        var topLayer = d.AddLayer("Top");
        topLayer.SetPixels(Filled(8, 8, 40, 120, 200));
        topLayer.BlendMode = mode;
        topLayer.Opacity = opacity;
        return d;
    }

    using (var d = DocWithTop("multiply", 1))
        EqPx(Compositor.Render(d), 3, 3, 31, 47, 39, 255, "multiply: (200x40/255, 100x120/255, 50x200/255) = (31,47,39)");
    using (var d = DocWithTop("screen", 1))
        EqPx(Compositor.Render(d), 3, 3, 209, 173, 211, 255, "screen: 255-(255-cb)(255-cs)/255 = (209,173,211)");
    using (var d = DocWithTop("normal", 0.5))
        EqPx(Compositor.Render(d), 3, 3, 120, 110, 125, 255, "normal at opacity 0.5 is the exact midpoint (120,110,125)");
    using (var d = DocWithTop("normal", 1))
    {
        d.Layers[1].Visible = false;
        EqPx(Compositor.Render(d), 3, 3, 200, 100, 50, 255, "a hidden layer contributes nothing");
    }
});

// ---------------------------------------------------------------- S04
Scenario("S04 masks: paint, gray value, invert, apply", () =>
{
    using var doc = new ImageDocument(20, 20);
    doc.Layers[0].SetPixels(Filled(20, 20, 0, 0, 255)); // blue backdrop
    var top = doc.AddLayer("Top");
    top.SetPixels(Filled(20, 20, 255, 0, 0)); // red
    doc.CreateMask(top); // fill 255: fully revealed
    EqPx(Compositor.Render(doc), 10, 10, 255, 0, 0, 255, "a fresh 255 mask reveals the layer fully");

    BrushEngine.PaintMaskStroke(top.Mask!, 20, 20, new List<StrokePoint> { new(10, 10) }, 3, 0, null);
    EqMask(top.Mask!, 20, 10, 10, 0, "painting gray 0 sets the mask value outright inside the disc");
    EqMask(top.Mask!, 20, 0, 0, 255, "mask paint leaves distant pixels at 255");
    EqPx(Compositor.Render(doc), 10, 10, 0, 0, 255, 255, "mask 0 hides the layer: the blue backdrop shows");
    EqPx(Compositor.Render(doc), 0, 0, 255, 0, 0, 255, "outside the painted disc the layer still shows");

    top.Mask![5 * 20 + 5] = 128;
    EqPx(Compositor.Render(doc), 5, 5, 128, 0, 127, 255, "mask 128 cross-fades red over blue to (128,0,127)");

    doc.InvertMask(top);
    EqMask(top.Mask!, 20, 0, 0, 0, "invert maps 255 to 0");
    EqMask(top.Mask!, 20, 10, 10, 255, "invert maps 0 to 255");
    EqPx(Compositor.Render(doc), 0, 0, 0, 0, 255, 255, "after invert the corner is hidden");

    // ApplyMask bakes the mask into alpha and removes it.
    using var doc2 = new ImageDocument(4, 4);
    var layer = doc2.AddLayer("L");
    layer.SetPixels(Filled(4, 4, 10, 20, 30, 200));
    doc2.CreateMask(layer, 255);
    layer.Mask![0] = 128;
    doc2.ApplyMask(layer);
    Check(layer.Mask == null, "ApplyMask removes the mask");
    EqPx(layer.Pixels, 0, 0, 10, 20, 30, 100, "ApplyMask scales alpha: round(200 x 128/255) = 100");
    EqPx(layer.Pixels, 1, 0, 10, 20, 30, 200, "ApplyMask leaves full-mask pixels at full alpha");
    Throws<InvalidOperationException>(() => doc2.InvertMask(layer), "InvertMask without a mask refuses", "has no mask");
});

// ---------------------------------------------------------------- S05
Scenario("S05 filters: exact pixel outcomes and registry validation", () =>
{
    var img = Filled(4, 4, 100, 150, 200);
    var inverted = Filters.Apply(img, "invert", null, null);
    EqPx(inverted, 1, 1, 155, 105, 55, 255, "invert maps (100,150,200) to (155,105,55)");
    EqPx(img, 1, 1, 100, 150, 200, 255, "filters never mutate their input");

    var impulse = new PixelImage(5, 5);
    for (int i = 0; i < impulse.Data.Length; i += 4) impulse.Data[i + 3] = 255;
    SetPx(impulse, 2, 2, 255, 255, 255, 255);
    var blurred = Filters.Apply(impulse, "box-blur", new Dictionary<string, double> { ["radius"] = 1 }, null);
    EqPx(blurred, 2, 2, 28, 28, 28, 255, "box blur r=1 spreads the impulse to 255/9 = 28 at the centre");
    EqPx(blurred, 1, 1, 28, 28, 28, 255, "box blur r=1 gives 28 across the whole 3x3");
    EqPx(blurred, 0, 0, 0, 0, 0, 255, "box blur r=1 does not reach distance 2");
    var gauss = Filters.Apply(impulse, "gaussian-blur", new Dictionary<string, double> { ["sigma"] = 1 }, null);
    int gaussCentre = gauss.Data[(2 * 5 + 2) * 4];
    Check(gaussCentre > 28 && gaussCentre < 60, $"gaussian sigma=1 centre ({gaussCentre}) is concentrated but spread (box gives 28)");

    var bc = Filters.Apply(Filled(2, 2, 100, 100, 100), "brightness-contrast",
        new Dictionary<string, double> { ["brightness"] = 0, ["contrast"] = 50 }, null);
    EqPx(bc, 0, 0, 86, 86, 86, 255, "contrast 50 maps 100 to 86 (factor 1.4822 about 128)");

    var sepia = Filters.Apply(Filled(2, 2, 255, 255, 255), "sepia", new Dictionary<string, double> { ["amount"] = 1 }, null);
    EqPx(sepia, 0, 0, 255, 255, 239, 255, "sepia at amount 1 maps white to (255,255,239)");

    var thr = Filters.Apply(Filled(2, 1, 255, 0, 0), "threshold", new Dictionary<string, double> { ["level"] = 128 }, null);
    EqPx(thr, 0, 0, 0, 0, 0, 255, "threshold: red luminance 76 < 128 gives black");
    var thr2 = Filters.Apply(Filled(2, 1, 255, 255, 255), "threshold", new Dictionary<string, double> { ["level"] = 128 }, null);
    EqPx(thr2, 0, 0, 255, 255, 255, 255, "threshold: white luminance 255 >= 128 gives white");

    var gray = Filled(8, 8, 120, 120, 120);
    var n1 = Filters.Apply(gray, "noise", new Dictionary<string, double> { ["amount"] = 25, ["seed"] = 42 }, null);
    var n2 = Filters.Apply(gray, "noise", new Dictionary<string, double> { ["amount"] = 25, ["seed"] = 42 }, null);
    var n3 = Filters.Apply(gray, "noise", new Dictionary<string, double> { ["amount"] = 25, ["seed"] = 7 }, null);
    Check(n1.Data.SequenceEqual(n2.Data), "noise with the same seed is byte-identical (mulberry32)");
    Check(!n1.Data.SequenceEqual(n3.Data), "noise with a different seed differs");
    bool bounded = true, anyChanged = false;
    for (int i = 0; i < gray.Data.Length; i++)
    {
        if (Math.Abs(n1.Data[i] - gray.Data[i]) > 25) bounded = false;
        if (n1.Data[i] != gray.Data[i]) anyChanged = true;
    }
    Check(bounded && anyChanged, "noise amount 25 changes pixels but never by more than 25");
    var n0 = Filters.Apply(gray, "noise", new Dictionary<string, double> { ["amount"] = 0, ["seed"] = 42 }, null);
    Check(n0.Data.SequenceEqual(gray.Data), "noise amount 0 is the identity");

    var scoped = Filters.Apply(img, "invert", null, new Rectangle(0, 0, 2, 2));
    EqPx(scoped, 1, 1, 155, 105, 55, 255, "a selection-scoped filter applies inside the rect");
    EqPx(scoped, 3, 3, 100, 150, 200, 255, "a selection-scoped filter leaves outside pixels identical");

    Throws<ArgumentException>(() => Filters.DescriptorFor("no-such-filter"), "unknown filter id is rejected", "Unknown filter: no-such-filter");
    Throws<ArgumentException>(() => Filters.Apply(img, "box-blur", new Dictionary<string, double> { ["bogus"] = 1 }, null),
        "an unknown parameter name is rejected", "Unknown parameter 'bogus'");
    Throws<ArgumentException>(() => Filters.Apply(img, "box-blur", new Dictionary<string, double> { ["radius"] = 99 }, null),
        "an out-of-range parameter is rejected", "out of range");
});

// ---------------------------------------------------------------- S06
Scenario("S06 text and shape layers: render, edit data, re-render", () =>
{
    using var doc = new ImageDocument(32, 24);
    var text = doc.AddTextLayer(new TextData
    {
        Text = "A", Font = "pixel", FontSize = 7, Color = Color.Red, OriginX = 2, OriginY = 2
    });
    Check(text.Kind == "text" && text.Text != null, "AddTextLayer stores editable text data");
    // 'A' in the pixel font, row 0 = 0x0E (cols 1-3), row 1 = 0x11 (cols 0 and 4).
    EqPx(text.Pixels, 3, 2, 255, 0, 0, 255, "text 'A' row 0 col 1 is painted");
    EqPx(text.Pixels, 5, 2, 255, 0, 0, 255, "text 'A' row 0 col 3 is painted");
    EqPx(text.Pixels, 2, 2, 0, 0, 0, 0, "text 'A' row 0 col 0 is empty");
    EqPx(text.Pixels, 2, 3, 255, 0, 0, 255, "text 'A' row 1 col 0 is painted");

    // Row 3 differs between the glyphs: 'A' has 0x1F (cols 0-4), 'B' has 0x1E (cols 0-3).
    EqPx(text.Pixels, 6, 5, 255, 0, 0, 255, "text 'A' row 3 col 4 is painted before the edit");
    text.Text!.Text = "B";
    doc.RenderContentLayer(text);
    // 'B' row 0 = 0x1E (cols 0-3): the col-0 pixel appears, and the 'A'-only pixel at row 3 col 4 clears.
    EqPx(text.Pixels, 2, 2, 255, 0, 0, 255, "after editing to 'B', row 0 col 0 is painted");
    EqPx(text.Pixels, 6, 5, 0, 0, 0, 0, "after editing to 'B', the 'A'-only pixel at row 3 col 4 is clear (stale render fully replaced)");

    var shape = doc.AddShapeLayer(new ShapeData
    {
        Kind = "rectangle", Rect = new RectangleF(4, 4, 6, 4), Fill = Color.Green
    });
    Check(shape.Kind == "shape" && shape.Shape != null, "AddShapeLayer stores editable shape data");
    EqPx(shape.Pixels, 5, 5, 0, 128, 0, 255, "rectangle fill paints the interior");
    EqPx(shape.Pixels, 9, 7, 0, 128, 0, 255, "rectangle fill reaches (x+w-1, y+h-1)");
    EqPx(shape.Pixels, 10, 7, 0, 0, 0, 0, "rectangle fill stops at x+w");
    EqPx(shape.Pixels, 3, 5, 0, 0, 0, 0, "rectangle fill stops before x");

    shape.Shape!.Rect = new RectangleF(20, 4, 6, 4);
    doc.RenderContentLayer(shape);
    EqPx(shape.Pixels, 5, 5, 0, 0, 0, 0, "moving the shape data clears the old render");
    EqPx(shape.Pixels, 21, 5, 0, 128, 0, 255, "moving the shape data re-renders at the new rect");
});

// ---------------------------------------------------------------- S07
Scenario("S07 effect stacks: non-destructive, toggle, reorder, bake", () =>
{
    using var doc = new ImageDocument(8, 8);
    var layer = doc.AddLayer("Fx");
    layer.SetPixels(Filled(8, 8, 100, 150, 200));
    layer.Effects.Add(new LayerEffect { FilterId = "invert", Params = Filters.ResolveParams(Filters.DescriptorFor("invert"), null) });
    EqPx(Compositor.Render(doc), 4, 4, 155, 105, 55, 255, "the stack renders invert at composite time");
    EqPx(layer.Pixels, 4, 4, 100, 150, 200, 255, "the stack leaves the layer's pristine pixels untouched");

    layer.Effects[0].Enabled = false;
    EqPx(Compositor.Render(doc), 4, 4, 100, 150, 200, 255, "disabling the only effect restores the original composite");
    layer.Effects[0].Enabled = true;

    // Non-commuting pair on gray 100: BC(+60) then invert = 95; invert then BC(+60) = 215.
    using var doc2 = new ImageDocument(4, 4);
    var l2 = doc2.AddLayer("Fx2");
    l2.SetPixels(Filled(4, 4, 100, 100, 100));
    var bcParams = new Dictionary<string, double> { ["brightness"] = 60, ["contrast"] = 0 };
    l2.Effects.Add(new LayerEffect { FilterId = "brightness-contrast", Params = Filters.ResolveParams(Filters.DescriptorFor("brightness-contrast"), bcParams) });
    l2.Effects.Add(new LayerEffect { FilterId = "invert", Params = Filters.ResolveParams(Filters.DescriptorFor("invert"), null) });
    EqPx(Compositor.Render(doc2), 2, 2, 95, 95, 95, 255, "stack order BC then invert gives 95");
    (l2.Effects[0], l2.Effects[1]) = (l2.Effects[1], l2.Effects[0]);
    EqPx(Compositor.Render(doc2), 2, 2, 215, 215, 215, 255, "reordered stack invert then BC gives 215");

    var before = Compositor.Render(doc);
    doc.BakeEffects(layer);
    Check(layer.Effects.Count == 0, "bake clears the stack");
    EqPx(layer.Pixels, 4, 4, 155, 105, 55, 255, "bake writes the rendered pixels into the layer");
    Check(Compositor.Render(doc).Data.SequenceEqual(before.Data), "the composite is byte-identical after baking");

    using var doc3 = new ImageDocument(4, 4);
    var adj = doc3.AddLayer("Adj", "adjustment");
    Throws<InvalidOperationException>(() => doc3.BakeEffects(adj), "baking an adjustment layer refuses", "no pixels of its own");
});

// ---------------------------------------------------------------- S08
Scenario("S08 adjustment layers affect only the backdrop below them", () =>
{
    using var doc = new ImageDocument(8, 8);
    doc.Layers[0].SetPixels(Filled(8, 8, 0, 0, 255)); // blue backdrop
    var adj = doc.AddLayer("Adj", "adjustment");
    adj.Effects.Add(new LayerEffect { FilterId = "invert", Params = Filters.ResolveParams(Filters.DescriptorFor("invert"), null) });
    EqPx(Compositor.Render(doc), 4, 4, 255, 255, 0, 255, "invert adjustment turns the blue backdrop yellow");

    var above = doc.AddLayer("Above");
    above.SetPixels(Filled(8, 8, 0, 255, 0)); // opaque green, above the adjustment
    EqPx(Compositor.Render(doc), 4, 4, 0, 255, 0, 255, "an opaque layer above the adjustment is unaffected by it");

    above.Visible = false;
    adj.Opacity = 0.5;
    EqPx(Compositor.Render(doc), 4, 4, 128, 128, 128, 255, "adjustment at opacity 0.5 cross-fades backdrop and filtered backdrop");

    adj.Opacity = 1;
    adj.Effects[0].Enabled = false;
    EqPx(Compositor.Render(doc), 4, 4, 0, 0, 255, 255, "an adjustment with no enabled effects leaves the backdrop alone");
});

// ---------------------------------------------------------------- S09
Skipped("S09 undo/redo", "the app's undo/redo lives in MainForm (Stack<byte[]> of PNG snapshots of the flattened composite) and is bound to System.Drawing Bitmap encode/decode in the Form — it is not part of the UI-independent core and cannot execute on Linux. What is testable headless is covered elsewhere: the snapshot primitive is a PNG encode/decode of a PixelImage (PngCodec, exercised by S10/S11 save/load), and document state transitions are asserted directly in S01. Undo/redo interaction remains unverified until the app runs on Windows.");

// ---------------------------------------------------------------- S10
Scenario("S10 save, reload, and verify the full Phase 56 state survives", () =>
{
    string folder = Path.Combine(Path.GetTempPath(), "phase57-roundtrip-" + Guid.NewGuid().ToString("N"));
    try
    {
        using var doc = new ImageDocument(24, 18);
        doc.Layers[0].SetPixels(Filled(24, 18, 200, 100, 50));
        var paint = doc.AddLayer("Paint");
        paint.SetPixels(Filled(24, 18, 40, 120, 200));
        paint.BlendMode = "multiply";
        paint.Opacity = 0.8;
        doc.CreateMask(paint);
        BrushEngine.PaintMaskStroke(paint.Mask!, 24, 18, new List<StrokePoint> { new(3, 3) }, 2, 0, null);
        paint.Effects.Add(new LayerEffect { FilterId = "invert", Enabled = true, Params = Filters.ResolveParams(Filters.DescriptorFor("invert"), null) });
        paint.Effects.Add(new LayerEffect { FilterId = "box-blur", Enabled = false, Params = Filters.ResolveParams(Filters.DescriptorFor("box-blur"), new Dictionary<string, double> { ["radius"] = 1 }) });
        doc.AddTextLayer(new TextData { Text = "A", Font = "pixel", FontSize = 7, Color = Color.Red, OriginX = 2, OriginY = 2 });
        doc.AddShapeLayer(new ShapeData { Kind = "rectangle", Rect = new RectangleF(1, 1, 6, 4), Fill = Color.Green });
        var adj = doc.AddLayer("Adj", "adjustment");
        adj.Effects.Add(new LayerEffect { FilterId = "invert", Params = Filters.ResolveParams(Filters.DescriptorFor("invert"), null) });

        var expectedComposite = Compositor.Render(doc).Data.ToArray();
        doc.SaveProject(folder);

        Check(File.Exists(Path.Combine(folder, "project.json")), "save writes project.json");
        for (int i = 0; i < 5; i++)
            Check(File.Exists(Path.Combine(folder, $"layer_{i}.png")), $"save writes layer_{i}.png");
        Check(File.Exists(Path.Combine(folder, "mask_1.png")), "save writes the mask PNG for the masked layer");

        using var loaded = ImageDocument.LoadProject(folder);
        Check(loaded.Width == 24 && loaded.Height == 18, "reload restores the canvas size");
        Check(loaded.Layers.Count == 5, "reload restores all five layers");
        var lp = loaded.Layers[1];
        Check(lp.Name == "Paint" && lp.BlendMode == "multiply" && lp.Opacity == 0.8 && lp.Kind == "raster",
            "reload restores name, blend mode, opacity and kind");
        Check(lp.Mask != null && lp.Mask.SequenceEqual(paint.Mask!), "reload restores the mask byte-exactly");
        Check(lp.Effects.Count == 2 && lp.Effects[0].FilterId == "invert" && lp.Effects[0].Enabled
            && lp.Effects[1].FilterId == "box-blur" && !lp.Effects[1].Enabled && lp.Effects[1].Params["radius"] == 1,
            "reload restores the effect stack (ids, enabled flags, resolved params)");
        var lt = loaded.Layers[2];
        Check(lt.Kind == "text" && lt.Text != null && lt.Text.Text == "A" && lt.Text.FontSize == 7 && lt.Text.OriginX == 2,
            "reload restores the text layer's editable data");
        var ls = loaded.Layers[3];
        Check(ls.Kind == "shape" && ls.Shape != null && ls.Shape.Kind == "rectangle" && ls.Shape.Rect == new RectangleF(1, 1, 6, 4),
            "reload restores the shape layer's editable data");
        Check(loaded.Layers[4].Kind == "adjustment" && loaded.Layers[4].Effects.Count == 1,
            "reload restores the adjustment layer and its stack");
        Check(Compositor.Render(loaded).Data.SequenceEqual(expectedComposite),
            "the reloaded document composites byte-identically to the original");
    }
    finally
    {
        if (Directory.Exists(folder)) Directory.Delete(folder, true);
    }
});

// ---------------------------------------------------------------- S11
Scenario("S11 Phase 19-format saves load with defaults (backward compatibility)", () =>
{
    string folder = Path.Combine(Path.GetTempPath(), "phase19-compat-" + Guid.NewGuid().ToString("N"));
    try
    {
        Directory.CreateDirectory(folder);
        // Layer entries carry only the Phase 19 fields (Name/Visible/Opacity/File).
        File.WriteAllText(Path.Combine(folder, "project.json"),
            "{\n" +
            "  \"Width\": 8, \"Height\": 8, \"ActiveIndex\": 1,\n" +
            "  \"Layers\": [\n" +
            "    { \"Name\": \"Background\", \"Visible\": true, \"Opacity\": 1.0, \"File\": \"layer_0.png\" },\n" +
            "    { \"Name\": \"Sketch\", \"Visible\": true, \"Opacity\": 0.5, \"File\": \"layer_1.png\" }\n" +
            "  ]\n" +
            "}");
        // layer_0 written by the engine codec (filter 0); layer_1 hand-written with Paeth
        // filtering (filter 4), as a GDI-era encoder might produce — the decoder must read both.
        File.WriteAllBytes(Path.Combine(folder, "layer_0.png"), PngCodec.Encode(Filled(8, 8, 0, 0, 255)));
        File.WriteAllBytes(Path.Combine(folder, "layer_1.png"), WriteSolidPngWithFilter4(8, 8, 255, 0, 0, 255));

        using var doc = ImageDocument.LoadProject(folder);
        Check(doc.Layers.Count == 2, "the Phase 19 manifest loads both layers");
        var sketch = doc.Layers[1];
        Check(sketch.Name == "Sketch" && sketch.Opacity == 0.5, "stored name and opacity are honored");
        Check(sketch.BlendMode == "normal" && sketch.Kind == "raster" && !sketch.AlphaLock && !sketch.Clipped
            && sketch.Mask == null && sketch.Effects.Count == 0 && sketch.Text == null && sketch.Shape == null,
            "fields the old format lacks fall back to the documented defaults");
        EqPx(sketch.Pixels, 4, 4, 255, 0, 0, 255, "the Paeth-filtered PNG decodes to the right pixels");
        EqPx(Compositor.Render(doc), 4, 4, 128, 0, 128, 255, "the old document composites as red at opacity 0.5 over blue (127.5 rounds to 128 on both channels)");

        // A stored effect with an unknown id must reject the file, not load silently.
        string bad = Path.Combine(folder, "bad.json");
        File.WriteAllText(Path.Combine(folder, "project.json"),
            "{\n" +
            "  \"Width\": 8, \"Height\": 8, \"ActiveIndex\": 0,\n" +
            "  \"Layers\": [\n" +
            "    { \"Name\": \"Background\", \"Visible\": true, \"Opacity\": 1.0, \"File\": \"layer_0.png\",\n" +
            "      \"Effects\": [ { \"FilterId\": \"no-such-filter\", \"Params\": {}, \"Enabled\": true } ] }\n" +
            "  ]\n" +
            "}");
        Throws<ArgumentException>(() => ImageDocument.LoadProject(folder), "a corrupt stored effect id rejects the load", "Unknown filter");
        File.Delete(bad);
    }
    finally
    {
        if (Directory.Exists(folder)) Directory.Delete(folder, true);
    }
});

// ---------------------------------------------------------------- S12
Scenario("S12 resize and rotate/flip on raw buffers", () =>
{
    using var doc = new ImageDocument(4, 2);
    var px = doc.Layers[0].Pixels;
    // Eight distinct pixels: A B C D / E F G H by red channel 10..80.
    int v = 10;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 4; x++) { SetPx(px, x, y, v, 0, 0); v += 10; }
    doc.CreateMask(doc.Layers[0], 255);
    doc.Layers[0].Mask![0] = 77;

    doc.RotateFlip(RotateFlipKind.Rotate90FlipNone);
    Check(doc.Width == 2 && doc.Height == 4, "rotate 90 swaps the canvas dimensions");
    var rp = doc.Layers[0].Pixels;
    // (x,y) -> (h-1-y, x): E A / F B / G C / H D.
    EqPx(rp, 0, 0, 50, 0, 0, 255, "rotate 90: E lands at (0,0)");
    EqPx(rp, 1, 0, 10, 0, 0, 255, "rotate 90: A lands at (1,0)");
    EqPx(rp, 0, 1, 60, 0, 0, 255, "rotate 90: F lands at (0,1)");
    EqPx(rp, 1, 1, 20, 0, 0, 255, "rotate 90: B lands at (1,1)");
    EqPx(rp, 0, 3, 80, 0, 0, 255, "rotate 90: H lands at (0,3)");
    EqPx(rp, 1, 3, 40, 0, 0, 255, "rotate 90: D lands at (1,3)");
    EqMask(doc.Layers[0].Mask!, 2, 1, 0, 77, "the mask rotates with the layer (77 follows A to (1,0))");

    doc.RotateFlip(RotateFlipKind.RotateNoneFlipX);
    EqPx(doc.Layers[0].Pixels, 0, 0, 10, 0, 0, 255, "flip X mirrors the columns (A back to (0,0))");
    EqPx(doc.Layers[0].Pixels, 1, 3, 80, 0, 0, 255, "flip X mirrors the columns (H to (1,3))");
    EqMask(doc.Layers[0].Mask!, 2, 0, 0, 77, "the mask flips with the layer");

    using var doc2 = new ImageDocument(4, 2);
    var px2 = doc2.Layers[0].Pixels;
    v = 10;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 4; x++) { SetPx(px2, x, y, v, 0, 0); v += 10; }
    doc2.CreateMask(doc2.Layers[0], 200);
    doc2.Resize(8, 4);
    Check(doc2.Width == 8 && doc2.Height == 4, "resize updates the canvas size");
    EqPx(doc2.Layers[0].Pixels, 0, 0, 10, 0, 0, 255, "bilinear resize preserves the top-left corner exactly");
    EqPx(doc2.Layers[0].Pixels, 7, 0, 40, 0, 0, 255, "bilinear resize preserves the top-right corner exactly");
    EqPx(doc2.Layers[0].Pixels, 0, 3, 50, 0, 0, 255, "bilinear resize preserves the bottom-left corner exactly");
    EqPx(doc2.Layers[0].Pixels, 7, 3, 80, 0, 0, 255, "bilinear resize preserves the bottom-right corner exactly");
    Check(doc2.Layers[0].Mask!.Length == 32 && doc2.Layers[0].Mask!.All(m => m == 200), "the mask resizes with the layer, values intact");
    Throws<ArgumentException>(() => doc2.Resize(0, 5), "a non-positive resize target is rejected", "Invalid resize target");
});

// ---------------------------------------------------------------- S13
Skipped("S13 keyboard shortcut resolution", "the generated Workspace.cs ShortcutResolver.Resolve takes WinForms KeyEventArgs and Keys, so it cannot execute on Linux .NET 8; the chord model it resolves (the 21-command map, modifier-exact matching) is the TS workspace model, whose resolver is covered by the Phase 54 suite. Not duplicated here.");

// ---------------------------------------------------------------- S14
// Phase 58: content-based file handling in the generated app. The
// detection/validation core (ImageFileSupport, emitted into
// PixelEngine.cs) is UI-independent, so it executes here; the shell
// behavior around it (dialogs, MessageBox) is WinForms and remains
// compile-verified only, like the rest of the GUI.
Scenario("S14 file handling: content detection and named import refusals", () =>
{
    // Real signatures, judged by content: a genuine PNG produced by
    // this harness's own independent writer, and the documented
    // magic bytes of the other formats.
    byte[] png = WriteSolidPngWithFilter4(2, 2, 9, 8, 7, 255);
    Check(ImageFileSupport.Detect(png) == ImageFileKind.Png, "real PNG bytes detect as Png");
    Check(ImageFileSupport.EnsureImportable(png, "photo.jpg") == ImageFileKind.Png,
        "PNG content named .jpg still imports as PNG (content wins over extension)");
    byte[] jpeg = { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00 };
    Check(ImageFileSupport.Detect(jpeg) == ImageFileKind.Jpeg, "JFIF header detects as Jpeg");
    Check(ImageFileSupport.EnsureImportable(jpeg, "x.png") == ImageFileKind.Jpeg, "JPEG content imports as Jpeg");
    byte[] bmp = { 0x42, 0x4D, 0x36, 0x00, 0x00, 0x00 };
    Check(ImageFileSupport.Detect(bmp) == ImageFileKind.Bmp, "BM header detects as Bmp");
    Check(ImageFileSupport.EnsureImportable(bmp, "x.bmp") == ImageFileKind.Bmp, "BMP content imports as Bmp");
    byte[] tiffLe = { 0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00 };
    byte[] tiffBe = { 0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08 };
    Check(ImageFileSupport.Detect(tiffLe) == ImageFileKind.Tiff, "little-endian TIFF header detects as Tiff");
    Check(ImageFileSupport.Detect(tiffBe) == ImageFileKind.Tiff, "big-endian TIFF header detects as Tiff");
    byte[] psd = { 0x38, 0x42, 0x50, 0x53, 0x00, 0x01 };
    Check(ImageFileSupport.Detect(psd) == ImageFileKind.Psd, "8BPS header detects as Psd");
    Check(ImageFileSupport.Detect(new byte[] { 0x25, 0x50, 0x44, 0x46 }) == ImageFileKind.Unknown,
        "PDF bytes detect as Unknown");
    Check(ImageFileSupport.Detect(new byte[] { 0x89 }) == ImageFileKind.Unknown,
        "a truncated signature detects as Unknown, never as a format");
    Check(ImageFileSupport.Detect(Array.Empty<byte>()) == ImageFileKind.Unknown, "empty input detects as Unknown");
    // Named refusals: the exact guidance the shell shows the user.
    Throws<InvalidOperationException>(() => ImageFileSupport.EnsureImportable(psd, "art.psd"),
        "PSD refused by name", "Photoshop (PSD) file");
    Throws<InvalidOperationException>(() => ImageFileSupport.EnsureImportable(psd, "art.psd"),
        "PSD refusal points at the engine importer", "importPsd");
    Throws<InvalidOperationException>(() => ImageFileSupport.EnsureImportable(tiffLe, "scan.tif"),
        "TIFF refused by name", "TIFF file");
    Throws<InvalidOperationException>(() => ImageFileSupport.EnsureImportable(new byte[] { 1, 2, 3 }, "notes.txt"),
        "unrecognized data refused by name", "not a recognized image file");
    Check(ImageFileSupport.KindName(ImageFileKind.Tiff) == "TIFF" && ImageFileSupport.KindName(ImageFileKind.Unknown) == "unknown",
        "kind display names");
});

// ---------------------------------------------------------------- S15
// Phase 60: crash diagnostics. CrashDiagnostics is emitted into the
// generated app as UI-independent code (text formatting + file IO
// only — it sits on the core side of the Phase 57 seam), so the
// writer itself executes here: a real thrown exception is turned
// into a report file whose contents are verified field by field.
// The shell-side wiring (Program.Main's ThreadException /
// AppDomain handlers and the MessageBox naming the report) is
// WinForms and remains compile-verified only, like the rest of the
// GUI.
Scenario("S15 crash diagnostics: report writer executes and records the exception", () =>
{
    var dir = Path.Combine(Path.GetTempPath(), "pixelforge-harness-s15-" + Guid.NewGuid().ToString("N"));
    try
    {
        Exception thrown;
        try
        {
            throw new InvalidOperationException("harness S15 synthetic failure", new FormatException("inner detail 42"));
        }
        catch (Exception ex)
        {
            thrown = ex;
        }
        var path = CrashDiagnostics.WriteReport(thrown, "harness S15", dir);
        Check(File.Exists(path), "crash report file was written");
        Check(Path.GetFileName(path).StartsWith("crash-") && path.EndsWith(".log"), "report file name is crash-<timestamp>.log");
        var text = File.ReadAllText(path);
        Check(text.Contains("PixelForge crash report"), "report header names the app");
        Check(text.Contains("App: " + CrashDiagnostics.AppName + " " + CrashDiagnostics.AppVersion), "report stamps app name and version");
        Check(CrashDiagnostics.AppVersion == "1.0.0", "generated app version is the release version 1.0.0");
        Check(text.Contains("Context: harness S15"), "report records the context");
        Check(text.Contains("Timestamp (UTC):"), "report records a UTC timestamp");
        Check(text.Contains("OS: ") && text.Contains("Runtime: "), "report records OS and runtime");
        Check(text.Contains("Exception: System.InvalidOperationException"), "report names the exception type");
        Check(text.Contains("harness S15 synthetic failure"), "report carries the exception message");
        Check(text.Contains("Inner exception 1: System.FormatException"), "report includes the inner exception");
        Check(text.Contains("inner detail 42"), "report carries the inner message");
        Check(text.Contains("Stack trace:"), "report has a stack trace section");
        // A second report in the same directory must not overwrite the first.
        var path2 = CrashDiagnostics.WriteReport(thrown, "harness S15 again", dir);
        Check(path2 != path && File.Exists(path2), "a second report gets its own file");
        // BuildReport is pure: same exception + timestamp, same text.
        var fixedTime = new DateTimeOffset(2026, 11, 27, 0, 0, 0, TimeSpan.Zero);
        Check(CrashDiagnostics.BuildReport(thrown, "ctx", fixedTime) == CrashDiagnostics.BuildReport(thrown, "ctx", fixedTime),
            "BuildReport is deterministic for a fixed timestamp");
        Check(CrashDiagnostics.BuildReport(thrown, "ctx", fixedTime).Contains("Timestamp (UTC): 2026-11-27T00:00:00.000Z"),
            "BuildReport formats the supplied timestamp");
    }
    finally
    {
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }
    // TryWriteReport — the never-throws entry Program.Main uses —
    // writes next to the executable and reports the path.
    var defaultPath = CrashDiagnostics.TryWriteReport(new Exception("harness S15 default-dir probe"), "harness S15");
    Check(defaultPath != null && File.Exists(defaultPath), "TryWriteReport writes into the default crashes folder");
    Check(defaultPath != null && Path.GetDirectoryName(defaultPath) == CrashDiagnostics.DefaultReportDirectory,
        "the default report location is the crashes folder next to the executable");
    if (defaultPath != null) File.Delete(defaultPath);
});

// ---------------------------------------------------------------- local helpers

// A minimal independent PNG writer (zlib + CRC32 written from the
// spec here, not via PngCodec) producing Paeth-filtered scanlines
// for a solid image — an encoder-diversity fixture for the decoder.
static byte[] WriteSolidPngWithFilter4(int w, int h, byte r, byte g, byte b, byte a)
{
    var raw = new List<byte>();
    var prevRow = new byte[w * 4];
    for (int y = 0; y < h; y++)
    {
        var row = new byte[w * 4];
        for (int x = 0; x < w; x++)
        {
            row[x * 4] = r; row[x * 4 + 1] = g; row[x * 4 + 2] = b; row[x * 4 + 3] = a;
        }
        raw.Add(4); // filter: Paeth
        for (int i = 0; i < row.Length; i++)
        {
            int left = i >= 4 ? row[i - 4] : 0;
            int up = prevRow[i];
            int upLeft = i >= 4 ? prevRow[i - 4] : 0;
            int p = left + up - upLeft;
            int pa = Math.Abs(p - left), pb = Math.Abs(p - up), pc = Math.Abs(p - upLeft);
            int pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            raw.Add((byte)(row[i] - pred));
        }
        prevRow = row;
    }
    byte[] idat;
    using (var ms = new MemoryStream())
    {
        using (var zs = new ZLibStream(ms, CompressionLevel.Optimal, leaveOpen: true)) zs.Write(raw.ToArray(), 0, raw.Count);
        idat = ms.ToArray();
    }
    using var outMs = new MemoryStream();
    outMs.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
    var ihdr = new byte[13];
    ihdr[0] = (byte)(w >> 24); ihdr[1] = (byte)(w >> 16); ihdr[2] = (byte)(w >> 8); ihdr[3] = (byte)w;
    ihdr[4] = (byte)(h >> 24); ihdr[5] = (byte)(h >> 16); ihdr[6] = (byte)(h >> 8); ihdr[7] = (byte)h;
    ihdr[8] = 8; ihdr[9] = 6;
    WriteChunk(outMs, "IHDR", ihdr);
    WriteChunk(outMs, "IDAT", idat);
    WriteChunk(outMs, "IEND", Array.Empty<byte>());
    return outMs.ToArray();
}

static void WriteChunk(Stream s, string type, byte[] data)
{
    var len = new byte[4];
    len[0] = (byte)(data.Length >> 24); len[1] = (byte)(data.Length >> 16); len[2] = (byte)(data.Length >> 8); len[3] = (byte)data.Length;
    s.Write(len, 0, 4);
    var typeBytes = Encoding.ASCII.GetBytes(type);
    s.Write(typeBytes, 0, 4);
    s.Write(data, 0, data.Length);
    uint crc = 0xFFFFFFFF;
    foreach (byte by in typeBytes.Concat(data))
    {
        crc ^= by;
        for (int k = 0; k < 8; k++) crc = (crc & 1) != 0 ? 0xEDB88320 ^ (crc >> 1) : crc >> 1;
    }
    crc ^= 0xFFFFFFFF;
    var crcBytes = new byte[] { (byte)(crc >> 24), (byte)(crc >> 16), (byte)(crc >> 8), (byte)crc };
    s.Write(crcBytes, 0, 4);
}

totalSw.Stop();
Console.WriteLine($"HARNESS SUMMARY: {scenarios} scenarios ({skipped} skipped-documented), {checks} assertions, {failures} failures, {totalSw.ElapsedMilliseconds} ms total");
return failures == 0 ? 0 : 1;
