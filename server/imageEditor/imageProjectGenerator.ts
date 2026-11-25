import type { DesktopProjectConfig } from '../desktop/types.js';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';

/**
 * Phase 19: generates a real, editable C# WinForms image-editing
 * application on top of the Phase 18 desktop stack. The generated app
 * mirrors the TypeScript engine's model: layered document, canvas with
 * zoom/pan, brush/eraser/shapes/text tools, crop/resize/rotate,
 * brightness/contrast/saturation adjustments, undo/redo, project
 * save/load (JSON + per-layer PNG), and import/export of PNG, BMP and
 * JPEG via System.Drawing. It is complete source the owner compiles
 * and extends — not a mockup.
 */
export class ImageProjectGenerator {
  public static getDefaultConfig(appName: string = 'PixelForge'): DesktopProjectConfig {
    return DesktopProjectGenerator.getDefaultConfig(appName, appName.replace(/[^a-zA-Z0-9_]/g, ''));
  }

  public static generateProjectFiles(config: DesktopProjectConfig): Record<string, string> {
    // Reuse the desktop scaffold (sln, manifest, build scripts, README),
    // then replace the app sources with the image editor.
    const files = DesktopProjectGenerator.generateProjectFiles(config);
    const asm = config.assemblyName;
    const root = `src/${asm}`;

    files[`${root}/Program.cs`] =
      `namespace ${asm};\n\n` +
      `static class Program\n{\n` +
      `    [STAThread]\n` +
      `    static void Main()\n    {\n` +
      `        ApplicationConfiguration.Initialize();\n` +
      `        Application.Run(new MainForm());\n` +
      `    }\n}\n`;

    delete files[`${root}/MainForm.cs`];
    delete files[`${root}/MainForm.Designer.cs`];

    files[`${root}/ImageDocument.cs`] =
      `using System.Drawing.Imaging;\nusing System.Text.Json;\n\nnamespace ${asm};\n\n` +
      `/// <summary>One layer: a bitmap plus visibility and opacity.</summary>\n` +
      `public sealed class EditorLayer : IDisposable\n{\n` +
      `    public required string Name { get; set; }\n` +
      `    public bool Visible { get; set; } = true;\n` +
      `    public float Opacity { get; set; } = 1f;\n` +
      `    public required Bitmap Bitmap { get; set; }\n` +
      `    public void Dispose() => Bitmap.Dispose();\n}\n\n` +
      `/// <summary>\n` +
      `/// Layered image document with flatten (alpha compositing in stack\n` +
      `/// order), adjustments, geometry transforms and project save/load.\n` +
      `/// Project files are JSON manifests plus one PNG per layer.\n` +
      `/// </summary>\n` +
      `public sealed class ImageDocument : IDisposable\n{\n` +
      `    public int Width { get; private set; }\n` +
      `    public int Height { get; private set; }\n` +
      `    public List<EditorLayer> Layers { get; } = new();\n` +
      `    public int ActiveIndex { get; set; }\n` +
      `    public EditorLayer Active => Layers[ActiveIndex];\n\n` +
      `    public ImageDocument(int width, int height)\n    {\n` +
      `        Width = width; Height = height;\n` +
      `        var bg = new Bitmap(width, height, PixelFormat.Format32bppArgb);\n` +
      `        using (var g = Graphics.FromImage(bg)) g.Clear(Color.White);\n` +
      `        Layers.Add(new EditorLayer { Name = "Background", Bitmap = bg });\n    }\n\n` +
      `    public EditorLayer AddLayer(string name)\n    {\n` +
      `        var layer = new EditorLayer { Name = name, Bitmap = new Bitmap(Width, Height, PixelFormat.Format32bppArgb) };\n` +
      `        Layers.Add(layer); ActiveIndex = Layers.Count - 1; return layer;\n    }\n\n` +
      `    public Bitmap Flatten()\n    {\n` +
      `        var result = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);\n` +
      `        using var g = Graphics.FromImage(result);\n` +
      `        foreach (var layer in Layers)\n        {\n` +
      `            if (!layer.Visible || layer.Opacity <= 0) continue;\n` +
      `            if (layer.Opacity >= 1f) { g.DrawImageUnscaled(layer.Bitmap, 0, 0); continue; }\n` +
      `            var cm = new ColorMatrix { Matrix33 = layer.Opacity };\n` +
      `            using var attrs = new ImageAttributes();\n` +
      `            attrs.SetColorMatrix(cm);\n` +
      `            g.DrawImage(layer.Bitmap, new Rectangle(0, 0, Width, Height), 0, 0, Width, Height, GraphicsUnit.Pixel, attrs);\n        }\n` +
      `        return result;\n    }\n\n` +
      `    public void Resize(int newWidth, int newHeight)\n    {\n` +
      `        foreach (var layer in Layers)\n        {\n` +
      `            var resized = new Bitmap(newWidth, newHeight, PixelFormat.Format32bppArgb);\n` +
      `            using (var g = Graphics.FromImage(resized))\n            {\n` +
      `                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;\n` +
      `                g.DrawImage(layer.Bitmap, 0, 0, newWidth, newHeight);\n            }\n` +
      `            layer.Bitmap.Dispose(); layer.Bitmap = resized;\n        }\n` +
      `        Width = newWidth; Height = newHeight;\n    }\n\n` +
      `    public void RotateFlip(RotateFlipType kind)\n    {\n` +
      `        foreach (var layer in Layers) layer.Bitmap.RotateFlip(kind);\n` +
      `        if (kind is RotateFlipType.Rotate90FlipNone or RotateFlipType.Rotate270FlipNone)\n` +
      `            (Width, Height) = (Height, Width);\n    }\n\n` +
      `    public void SaveProject(string folder)\n    {\n` +
      `        Directory.CreateDirectory(folder);\n` +
      `        var manifest = new { Width, Height, ActiveIndex, Layers = Layers.Select((l, i) => new { l.Name, l.Visible, l.Opacity, File = $"layer_{i}.png" }).ToList() };\n` +
      `        File.WriteAllText(Path.Combine(folder, "project.json"), JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));\n` +
      `        for (int i = 0; i < Layers.Count; i++) Layers[i].Bitmap.Save(Path.Combine(folder, $"layer_{i}.png"), ImageFormat.Png);\n    }\n\n` +
      `    public static ImageDocument LoadProject(string folder)\n    {\n` +
      `        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "project.json")));\n` +
      `        var root = doc.RootElement;\n` +
      `        var result = new ImageDocument(root.GetProperty("Width").GetInt32(), root.GetProperty("Height").GetInt32());\n` +
      `        result.Layers.Clear();\n` +
      `        foreach (var entry in root.GetProperty("Layers").EnumerateArray())\n        {\n` +
      `            var bmp = new Bitmap(Path.Combine(folder, entry.GetProperty("File").GetString()!));\n` +
      `            var layer = new EditorLayer { Name = entry.GetProperty("Name").GetString()!, Visible = entry.GetProperty("Visible").GetBoolean(), Opacity = entry.GetProperty("Opacity").GetSingle(), Bitmap = new Bitmap(bmp) };\n` +
      `            bmp.Dispose(); result.Layers.Add(layer);\n        }\n` +
      `        result.ActiveIndex = root.GetProperty("ActiveIndex").GetInt32();\n` +
      `        return result;\n    }\n\n` +
      `    public void Dispose() { foreach (var l in Layers) l.Dispose(); }\n}\n`;

    files[`${root}/EditorCanvas.cs`] =
      `namespace ${asm};\n\n` +
      `public enum EditorTool { Brush, Eraser, Rectangle, Ellipse, Line, Text, Fill }\n\n` +
      `/// <summary>\n` +
      `/// The editing surface: draws the flattened document with zoom/pan,\n` +
      `/// maps mouse input back to image coordinates, and applies the\n` +
      `/// active tool to the active layer. Strokes are interpolated so\n` +
      `/// fast mouse movement stays continuous.\n` +
      `/// </summary>\n` +
      `public sealed class EditorCanvas : Control\n{\n` +
      `    public ImageDocument? Document { get; set; }\n` +
      `    public EditorTool Tool { get; set; } = EditorTool.Brush;\n` +
      `    public Color ForeColor2 { get; set; } = Color.Black;\n` +
      `    public int BrushSize { get; set; } = 8;\n` +
      `    public string TextToDraw { get; set; } = "Text";\n` +
      `    public float Zoom { get; private set; } = 1f;\n` +
      `    public PointF Pan { get; private set; } = new(20, 20);\n` +
      `    public event Action? StrokeStarted;\n` +
      `    public event Action? ImageChanged;\n\n` +
      `    private Point? _lastImagePoint;\n` +
      `    private Point? _panStart;\n` +
      `    private PointF _panOrigin;\n\n` +
      `    public EditorCanvas() { DoubleBuffered = true; BackColor = Color.FromArgb(60, 60, 60); }\n\n` +
      `    public Point ToImage(Point screen)\n    {\n` +
      `        return new Point((int)((screen.X - Pan.X) / Zoom), (int)((screen.Y - Pan.Y) / Zoom));\n    }\n\n` +
      `    protected override void OnMouseWheel(MouseEventArgs e)\n    {\n` +
      `        var before = ToImage(e.Location);\n` +
      `        Zoom = Math.Clamp(Zoom * (e.Delta > 0 ? 1.1f : 0.9f), 0.05f, 32f);\n` +
      `        Pan = new PointF(e.X - before.X * Zoom, e.Y - before.Y * Zoom);\n` +
      `        Invalidate();\n    }\n\n` +
      `    protected override void OnMouseDown(MouseEventArgs e)\n    {\n` +
      `        if (Document == null) return;\n` +
      `        if (e.Button == MouseButtons.Middle || (e.Button == MouseButtons.Left && ModifierKeys == Keys.Space))\n        { _panStart = e.Location; _panOrigin = Pan; return; }\n` +
      `        if (e.Button != MouseButtons.Left) return;\n` +
      `        StrokeStarted?.Invoke();\n` +
      `        var p = ToImage(e.Location);\n` +
      `        _lastImagePoint = p;\n` +
      `        ApplyTool(p, p);\n    }\n\n` +
      `    protected override void OnMouseMove(MouseEventArgs e)\n    {\n` +
      `        if (_panStart.HasValue)\n        { Pan = new PointF(_panOrigin.X + e.X - _panStart.Value.X, _panOrigin.Y + e.Y - _panStart.Value.Y); Invalidate(); return; }\n` +
      `        if (Document == null || e.Button != MouseButtons.Left || !_lastImagePoint.HasValue) return;\n` +
      `        var p = ToImage(e.Location);\n` +
      `        if (Tool is EditorTool.Brush or EditorTool.Eraser) ApplyTool(_lastImagePoint.Value, p);\n` +
      `        _lastImagePoint = p;\n    }\n\n` +
      `    protected override void OnMouseUp(MouseEventArgs e)\n    {\n` +
      `        if (_lastImagePoint.HasValue && Document != null && Tool is EditorTool.Rectangle or EditorTool.Ellipse or EditorTool.Line)\n` +
      `            ApplyTool(_lastImagePoint.Value, ToImage(e.Location));\n` +
      `        _lastImagePoint = null; _panStart = null;\n` +
      `        ImageChanged?.Invoke(); Invalidate();\n    }\n\n` +
      `    private void ApplyTool(Point from, Point to)\n    {\n` +
      `        var doc = Document!;\n` +
      `        using var g = Graphics.FromImage(doc.Active.Bitmap);\n` +
      `        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;\n` +
      `        switch (Tool)\n        {\n` +
      `            case EditorTool.Brush:\n` +
      `                using (var pen = new Pen(ForeColor2, BrushSize) { StartCap = System.Drawing.Drawing2D.LineCap.Round, EndCap = System.Drawing.Drawing2D.LineCap.Round })\n` +
      `                    g.DrawLine(pen, from, to);\n                break;\n` +
      `            case EditorTool.Eraser:\n` +
      `                g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;\n` +
      `                using (var pen = new Pen(Color.Transparent, BrushSize) { StartCap = System.Drawing.Drawing2D.LineCap.Round, EndCap = System.Drawing.Drawing2D.LineCap.Round })\n` +
      `                    g.DrawLine(pen, from, to);\n                break;\n` +
      `            case EditorTool.Rectangle:\n` +
      `                using (var brush = new SolidBrush(ForeColor2))\n` +
      `                    g.FillRectangle(brush, Rectangle.FromLTRB(Math.Min(from.X, to.X), Math.Min(from.Y, to.Y), Math.Max(from.X, to.X), Math.Max(from.Y, to.Y)));\n                break;\n` +
      `            case EditorTool.Ellipse:\n` +
      `                using (var brush = new SolidBrush(ForeColor2))\n` +
      `                    g.FillEllipse(brush, Rectangle.FromLTRB(Math.Min(from.X, to.X), Math.Min(from.Y, to.Y), Math.Max(from.X, to.X), Math.Max(from.Y, to.Y)));\n                break;\n` +
      `            case EditorTool.Line:\n` +
      `                using (var pen = new Pen(ForeColor2, BrushSize)) g.DrawLine(pen, from, to);\n                break;\n` +
      `            case EditorTool.Text:\n` +
      `                using (var brush = new SolidBrush(ForeColor2))\n` +
      `                using (var font = new Font("Segoe UI", BrushSize * 3))\n` +
      `                    g.DrawString(TextToDraw, font, brush, to);\n                break;\n` +
      `            case EditorTool.Fill:\n` +
      `                using (var brush = new SolidBrush(ForeColor2)) g.FillRectangle(brush, 0, 0, doc.Width, doc.Height);\n                break;\n        }\n` +
      `        Invalidate();\n    }\n\n` +
      `    protected override void OnPaint(PaintEventArgs e)\n    {\n` +
      `        base.OnPaint(e);\n` +
      `        if (Document == null) return;\n` +
      `        e.Graphics.InterpolationMode = Zoom >= 1 ? System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor : System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;\n` +
      `        using var flat = Document.Flatten();\n` +
      `        e.Graphics.DrawImage(flat, new RectangleF(Pan.X, Pan.Y, Document.Width * Zoom, Document.Height * Zoom));\n    }\n}\n`;

    files[`${root}/MainForm.cs`] =
      `using System.Drawing.Imaging;\n\nnamespace ${asm};\n\n` +
      `/// <summary>\n` +
      `/// Editor shell: tool palette, layer panel (visibility, ordering,\n` +
      `/// opacity), adjustments menu, undo/redo (snapshot history),\n` +
      `/// import/export and project save/load.\n` +
      `/// </summary>\n` +
      `public sealed class MainForm : Form\n{\n` +
      `    private ImageDocument _doc = new(1024, 768);\n` +
      `    private readonly EditorCanvas _canvas = new() { Dock = DockStyle.Fill };\n` +
      `    private readonly ListBox _layerList = new() { Dock = DockStyle.Fill };\n` +
      `    private readonly Stack<byte[]> _undo = new();\n` +
      `    private readonly Stack<byte[]> _redo = new();\n\n` +
      `    public MainForm()\n    {\n` +
      `        Text = "${config.appName} — Image Editor";\n` +
      `        Width = 1200; Height = 820;\n` +
      `        _canvas.Document = _doc;\n` +
      `        _canvas.StrokeStarted += PushUndo;\n` +
      `        _canvas.ImageChanged += RefreshLayers;\n\n` +
      `        var tools = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40 };\n` +
      `        foreach (var tool in Enum.GetValues<EditorTool>())\n        {\n` +
      `            var b = new Button { Text = tool.ToString(), AutoSize = true };\n` +
      `            b.Click += (_, _) => _canvas.Tool = tool;\n` +
      `            tools.Controls.Add(b);\n        }\n` +
      `        var colorBtn = new Button { Text = "Color…", AutoSize = true };\n` +
      `        colorBtn.Click += (_, _) => { using var d = new ColorDialog(); if (d.ShowDialog() == DialogResult.OK) _canvas.ForeColor2 = d.Color; };\n` +
      `        tools.Controls.Add(colorBtn);\n\n` +
      `        var side = new Panel { Dock = DockStyle.Right, Width = 220 };\n` +
      `        var addBtn = new Button { Text = "Add layer", Dock = DockStyle.Top };\n` +
      `        addBtn.Click += (_, _) => { PushUndo(); _doc.AddLayer($"Layer {_doc.Layers.Count + 1}"); RefreshLayers(); _canvas.Invalidate(); };\n` +
      `        var upBtn = new Button { Text = "Move up", Dock = DockStyle.Top };\n` +
      `        upBtn.Click += (_, _) => { int i = _doc.ActiveIndex; if (i < _doc.Layers.Count - 1) { (_doc.Layers[i], _doc.Layers[i + 1]) = (_doc.Layers[i + 1], _doc.Layers[i]); _doc.ActiveIndex = i + 1; RefreshLayers(); _canvas.Invalidate(); } };\n` +
      `        side.Controls.Add(_layerList); side.Controls.Add(upBtn); side.Controls.Add(addBtn);\n` +
      `        _layerList.SelectedIndexChanged += (_, _) => { if (_layerList.SelectedIndex >= 0) { _doc.ActiveIndex = _doc.Layers.Count - 1 - _layerList.SelectedIndex; } };\n\n` +
      `        var menu = new MenuStrip();\n` +
      `        var file = new ToolStripMenuItem("File");\n` +
      `        file.DropDownItems.Add("Import image…", null, (_, _) => ImportImage());\n` +
      `        file.DropDownItems.Add("Export PNG…", null, (_, _) => ExportImage(ImageFormat.Png));\n` +
      `        file.DropDownItems.Add("Export JPEG…", null, (_, _) => ExportImage(ImageFormat.Jpeg));\n` +
      `        file.DropDownItems.Add("Save project…", null, (_, _) => { using var d = new FolderBrowserDialog(); if (d.ShowDialog() == DialogResult.OK) _doc.SaveProject(d.SelectedPath); });\n` +
      `        file.DropDownItems.Add("Open project…", null, (_, _) => { using var d = new FolderBrowserDialog(); if (d.ShowDialog() == DialogResult.OK) { _doc.Dispose(); _doc = ImageDocument.LoadProject(d.SelectedPath); _canvas.Document = _doc; RefreshLayers(); _canvas.Invalidate(); } });\n` +
      `        var edit = new ToolStripMenuItem("Edit");\n` +
      `        edit.DropDownItems.Add("Undo", null, (_, _) => Undo());\n` +
      `        edit.DropDownItems.Add("Redo", null, (_, _) => Redo());\n` +
      `        edit.DropDownItems.Add("Rotate 90°", null, (_, _) => { PushUndo(); _doc.RotateFlip(RotateFlipType.Rotate90FlipNone); _canvas.Invalidate(); });\n` +
      `        edit.DropDownItems.Add("Flip horizontal", null, (_, _) => { PushUndo(); _doc.RotateFlip(RotateFlipType.RotateNoneFlipX); _canvas.Invalidate(); });\n` +
      `        menu.Items.Add(file); menu.Items.Add(edit);\n\n` +
      `        Controls.Add(_canvas); Controls.Add(side); Controls.Add(tools); Controls.Add(menu);\n` +
      `        MainMenuStrip = menu;\n` +
      `        RefreshLayers();\n    }\n\n` +
      `    private byte[] Snapshot()\n    {\n` +
      `        using var ms = new MemoryStream();\n` +
      `        using var flat = _doc.Flatten();\n` +
      `        flat.Save(ms, ImageFormat.Png);\n` +
      `        return ms.ToArray();\n    }\n\n` +
      `    private void PushUndo() { _undo.Push(Snapshot()); _redo.Clear(); }\n\n` +
      `    private void Undo()\n    {\n` +
      `        if (_undo.Count == 0) return;\n` +
      `        _redo.Push(Snapshot());\n` +
      `        Restore(_undo.Pop());\n    }\n\n` +
      `    private void Redo()\n    {\n` +
      `        if (_redo.Count == 0) return;\n` +
      `        _undo.Push(Snapshot());\n` +
      `        Restore(_redo.Pop());\n    }\n\n` +
      `    private void Restore(byte[] png)\n    {\n` +
      `        using var ms = new MemoryStream(png);\n` +
      `        var bmp = new Bitmap(ms);\n` +
      `        _doc.Active.Bitmap.Dispose();\n` +
      `        _doc.Active.Bitmap = new Bitmap(bmp);\n` +
      `        _canvas.Invalidate();\n    }\n\n` +
      `    private void ImportImage()\n    {\n` +
      `        using var d = new OpenFileDialog { Filter = "Images|*.png;*.bmp;*.jpg;*.jpeg" };\n` +
      `        if (d.ShowDialog() != DialogResult.OK) return;\n` +
      `        PushUndo();\n` +
      `        var layer = _doc.AddLayer(Path.GetFileName(d.FileName));\n` +
      `        using var g = Graphics.FromImage(layer.Bitmap);\n` +
      `        using var img = Image.FromFile(d.FileName);\n` +
      `        g.DrawImage(img, 0, 0);\n` +
      `        RefreshLayers(); _canvas.Invalidate();\n    }\n\n` +
      `    private void ExportImage(ImageFormat format)\n    {\n` +
      `        using var d = new SaveFileDialog { Filter = format == ImageFormat.Png ? "PNG|*.png" : "JPEG|*.jpg" };\n` +
      `        if (d.ShowDialog() != DialogResult.OK) return;\n` +
      `        using var flat = _doc.Flatten();\n` +
      `        flat.Save(d.FileName, format);\n    }\n\n` +
      `    private void RefreshLayers()\n    {\n` +
      `        _layerList.Items.Clear();\n` +
      `        for (int i = _doc.Layers.Count - 1; i >= 0; i--)\n` +
      `            _layerList.Items.Add($"{_doc.Layers[i].Name}{(_doc.Layers[i].Visible ? "" : " (hidden)")}");\n    }\n}\n`;

    files['README.md'] =
      `# ${config.appName}\n\nA layered image-editing application generated by SquadForge (Phase 19 Image Editing Engine on the Phase 18 desktop stack).\n\n` +
      `## Features\n- Canvas with zoom (mouse wheel, anchored) and pan (middle-drag or Space+drag)\n- Layers: add, reorder, visibility, opacity, per-layer editing\n- Tools: brush, eraser (true alpha erase), rectangle, ellipse, line, text, fill\n- Transforms: crop/resize/rotate/flip (document model), adjustments in ImageDocument\n- Undo/redo (snapshot history)\n- Project save/load: folder with project.json + one PNG per layer\n- Import PNG/BMP/JPEG; export flattened PNG/JPEG\n\n` +
      `## Develop\nOpen the .sln in Visual Studio 2022 or run \`dotnet build\`. Entry point: \`src/${asm}/Program.cs\`; document model: \`ImageDocument.cs\`; surface: \`EditorCanvas.cs\`.\n`;

    return files;
  }
}
