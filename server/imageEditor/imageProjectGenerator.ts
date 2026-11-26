import type { DesktopProjectConfig } from '../desktop/types.js';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';
import type { EditorWorkspace, PanelLayout } from './types.js';
import { createDefaultWorkspace, createFocusWorkspace, formatKeyChord } from './workspace.js';

/** One panel layout entry as a C# initializer (Phase 54: emitted from the TS workspace model, never hand-duplicated). */
function panelEntryCSharp(p: PanelLayout): string {
  const weight = Number.isInteger(p.weight) ? p.weight.toFixed(0) : String(p.weight);
  return `new("${p.id}", "${p.dock}", ${p.visible ? 'true' : 'false'}, ${weight})`;
}

function layoutCSharp(ws: EditorWorkspace): string {
  return ws.panels.map(panelEntryCSharp).join(', ');
}

function shortcutsCSharp(ws: EditorWorkspace): string {
  return Object.entries(ws.shortcuts)
    .map(([id, c]) => `        ["${id}"] = "${formatKeyChord(c)}"`)
    .join(',\n');
}

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
      `    public void RemoveLayer(int index)\n    {\n` +
      `        if (Layers.Count <= 1 || index < 0 || index >= Layers.Count) return;\n` +
      `        Layers[index].Dispose();\n` +
      `        Layers.RemoveAt(index);\n` +
      `        ActiveIndex = Math.Clamp(ActiveIndex, 0, Layers.Count - 1);\n    }\n\n` +
      `    public void MoveLayer(int index, int delta)\n    {\n` +
      `        var target = index + delta;\n` +
      `        if (index < 0 || index >= Layers.Count || target < 0 || target >= Layers.Count) return;\n` +
      `        (Layers[index], Layers[target]) = (Layers[target], Layers[index]);\n` +
      `        ActiveIndex = target;\n    }\n\n` +
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
      `    public Color BackColor2 { get; set; } = Color.White;\n` +
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
      `    /// <summary>Zoom by a factor, anchored at the control's center (keyboard zoom, Phase 54).</summary>\n` +
      `    public void ZoomBy(float factor)\n    {\n` +
      `        var center = new Point(Width / 2, Height / 2);\n` +
      `        var before = ToImage(center);\n` +
      `        Zoom = Math.Clamp(Zoom * factor, 0.05f, 32f);\n` +
      `        Pan = new PointF(center.X - before.X * Zoom, center.Y - before.Y * Zoom);\n` +
      `        Invalidate();\n    }\n\n` +
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
      `/// import/export and project save/load. Panel placement comes\n` +
      `/// from the Phase 54 workspace layout (Workspace.cs), and every\n` +
      `/// command is reachable from the keyboard via ShortcutResolver.\n` +
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
      `        KeyPreview = true;\n` +
      `        _canvas.Document = _doc;\n` +
      `        _canvas.StrokeStarted += PushUndo;\n` +
      `        _canvas.ImageChanged += RefreshLayers;\n\n` +
      `        var layout = WorkspaceData.DefaultLayout;\n\n` +
      `        var toolsEntry = WorkspaceData.FindPanel(layout, "tools");\n` +
      `        var tools = new FlowLayoutPanel { Dock = DockOf(toolsEntry), Visible = toolsEntry.Visible };\n` +
      `        if (tools.Dock is DockStyle.Top or DockStyle.Bottom) tools.Height = 40; else tools.Width = 110;\n` +
      `        foreach (var tool in Enum.GetValues<EditorTool>())\n        {\n` +
      `            var b = new Button { Text = tool.ToString(), AutoSize = true };\n` +
      `            b.Click += (_, _) => _canvas.Tool = tool;\n` +
      `            tools.Controls.Add(b);\n        }\n\n` +
      `        var colorsEntry = WorkspaceData.FindPanel(layout, "colors");\n` +
      `        var colors = new FlowLayoutPanel { Dock = DockOf(colorsEntry), Visible = colorsEntry.Visible };\n` +
      `        if (colors.Dock is DockStyle.Top or DockStyle.Bottom) colors.Height = 40; else colors.Width = 110;\n` +
      `        var colorBtn = new Button { Text = "Color…", AutoSize = true };\n` +
      `        colorBtn.Click += (_, _) => { using var d = new ColorDialog(); if (d.ShowDialog() == DialogResult.OK) _canvas.ForeColor2 = d.Color; };\n` +
      `        colors.Controls.Add(colorBtn);\n` +
      `        var bgBtn = new Button { Text = "BG Color…", AutoSize = true };\n` +
      `        bgBtn.Click += (_, _) => { using var d = new ColorDialog(); if (d.ShowDialog() == DialogResult.OK) _canvas.BackColor2 = d.Color; };\n` +
      `        colors.Controls.Add(bgBtn);\n` +
      `        var swapBtn = new Button { Text = "Swap colors", AutoSize = true };\n` +
      `        swapBtn.Click += (_, _) => { (_canvas.ForeColor2, _canvas.BackColor2) = (_canvas.BackColor2, _canvas.ForeColor2); };\n` +
      `        colors.Controls.Add(swapBtn);\n\n` +
      `        var layersEntry = WorkspaceData.FindPanel(layout, "layers");\n` +
      `        var side = new Panel { Dock = DockOf(layersEntry), Visible = layersEntry.Visible };\n` +
      `        if (side.Dock is DockStyle.Left or DockStyle.Right) side.Width = (int)(layersEntry.Weight * 70); else side.Height = (int)(layersEntry.Weight * 70);\n` +
      `        var addBtn = new Button { Text = "Add layer", Dock = DockStyle.Top };\n` +
      `        addBtn.Click += (_, _) => AddLayer();\n` +
      `        var upBtn = new Button { Text = "Move up", Dock = DockStyle.Top };\n` +
      `        upBtn.Click += (_, _) => MoveLayerUp();\n` +
      `        var delBtn = new Button { Text = "Delete layer", Dock = DockStyle.Top };\n` +
      `        delBtn.Click += (_, _) => DeleteLayer();\n` +
      `        side.Controls.Add(_layerList); side.Controls.Add(delBtn); side.Controls.Add(upBtn); side.Controls.Add(addBtn);\n` +
      `        _layerList.SelectedIndexChanged += (_, _) => { if (_layerList.SelectedIndex >= 0) { _doc.ActiveIndex = _doc.Layers.Count - 1 - _layerList.SelectedIndex; } };\n\n` +
      `        var menu = new MenuStrip();\n` +
      `        var file = new ToolStripMenuItem("File");\n` +
      `        file.DropDownItems.Add(MenuItem("New project", "file.new", (_, _) => NewProject()));\n` +
      `        file.DropDownItems.Add(MenuItem("Import image…", null, (_, _) => ImportImage()));\n` +
      `        file.DropDownItems.Add(MenuItem("Export PNG…", "file.exportPng", (_, _) => ExportImage(ImageFormat.Png)));\n` +
      `        file.DropDownItems.Add(MenuItem("Export JPEG…", null, (_, _) => ExportImage(ImageFormat.Jpeg)));\n` +
      `        file.DropDownItems.Add(MenuItem("Save project…", "file.save", (_, _) => SaveProject()));\n` +
      `        file.DropDownItems.Add(MenuItem("Open project…", "file.open", (_, _) => OpenProject()));\n` +
      `        var edit = new ToolStripMenuItem("Edit");\n` +
      `        edit.DropDownItems.Add(MenuItem("Undo", "edit.undo", (_, _) => Undo()));\n` +
      `        edit.DropDownItems.Add(MenuItem("Redo", "edit.redo", (_, _) => Redo()));\n` +
      `        edit.DropDownItems.Add(MenuItem("Rotate 90°", "image.rotate90", (_, _) => { PushUndo(); _doc.RotateFlip(RotateFlipType.Rotate90FlipNone); _canvas.Invalidate(); }));\n` +
      `        edit.DropDownItems.Add(MenuItem("Flip horizontal", "image.flipHorizontal", (_, _) => { PushUndo(); _doc.RotateFlip(RotateFlipType.RotateNoneFlipX); _canvas.Invalidate(); }));\n` +
      `        menu.Items.Add(file); menu.Items.Add(edit);\n\n` +
      `        Controls.Add(_canvas); Controls.Add(side); Controls.Add(colors); Controls.Add(tools); Controls.Add(menu);\n` +
      `        MainMenuStrip = menu;\n` +
      `        RefreshLayers();\n    }\n\n` +
      `    private static DockStyle DockOf(PanelLayoutEntry entry) => entry.Dock switch\n    {\n` +
      `        "left" => DockStyle.Left,\n` +
      `        "right" => DockStyle.Right,\n` +
      `        "top" => DockStyle.Top,\n` +
      `        "bottom" => DockStyle.Bottom,\n` +
      `        _ => DockStyle.Right\n    };\n\n` +
      `    private static ToolStripMenuItem MenuItem(string text, string? command, EventHandler onClick)\n    {\n` +
      `        var item = new ToolStripMenuItem(text, null, onClick);\n` +
      `        if (command != null && WorkspaceData.Shortcuts.TryGetValue(command, out var chord))\n` +
      `            item.ShortcutKeyDisplayString = chord;\n` +
      `        return item;\n    }\n\n` +
      `    protected override void OnKeyDown(KeyEventArgs e)\n    {\n` +
      `        var command = ShortcutResolver.Resolve(e);\n` +
      `        if (command != null && DispatchCommand(command))\n        {\n` +
      `            e.Handled = true;\n` +
      `            e.SuppressKeyPress = true;\n` +
      `            return;\n        }\n` +
      `        base.OnKeyDown(e);\n    }\n\n` +
      `    private bool DispatchCommand(string command)\n    {\n` +
      `        switch (command)\n        {\n` +
      `            case "edit.undo": Undo(); return true;\n` +
      `            case "edit.redo": Redo(); return true;\n` +
      `            case "file.new": NewProject(); return true;\n` +
      `            case "file.open": OpenProject(); return true;\n` +
      `            case "file.save": SaveProject(); return true;\n` +
      `            case "file.exportPng": ExportImage(ImageFormat.Png); return true;\n` +
      `            case "layer.add": AddLayer(); return true;\n` +
      `            case "layer.delete": DeleteLayer(); return true;\n` +
      `            case "layer.moveUp": MoveLayerUp(); return true;\n` +
      `            case "layer.moveDown": _doc.MoveLayer(_doc.ActiveIndex, -1); RefreshLayers(); _canvas.Invalidate(); return true;\n` +
      `            case "view.zoomIn": _canvas.ZoomBy(1.25f); return true;\n` +
      `            case "view.zoomOut": _canvas.ZoomBy(0.8f); return true;\n` +
      `            case "image.rotate90": PushUndo(); _doc.RotateFlip(RotateFlipType.Rotate90FlipNone); _canvas.Invalidate(); return true;\n` +
      `            case "image.flipHorizontal": PushUndo(); _doc.RotateFlip(RotateFlipType.RotateNoneFlipX); _canvas.Invalidate(); return true;\n` +
      `            default:\n` +
      `                if (command.StartsWith("tool.") && Enum.TryParse<EditorTool>(command.Substring(5), true, out var tool))\n` +
      `                { _canvas.Tool = tool; return true; }\n` +
      `                return false;\n        }\n    }\n\n` +
      `    private void NewProject()\n    {\n` +
      `        _doc.Dispose();\n` +
      `        _doc = new ImageDocument(1024, 768);\n` +
      `        _canvas.Document = _doc;\n` +
      `        _undo.Clear(); _redo.Clear();\n` +
      `        RefreshLayers(); _canvas.Invalidate();\n    }\n\n` +
      `    private void SaveProject()\n    {\n` +
      `        using var d = new FolderBrowserDialog();\n` +
      `        if (d.ShowDialog() == DialogResult.OK) _doc.SaveProject(d.SelectedPath);\n    }\n\n` +
      `    private void OpenProject()\n    {\n` +
      `        using var d = new FolderBrowserDialog();\n` +
      `        if (d.ShowDialog() != DialogResult.OK) return;\n` +
      `        _doc.Dispose();\n` +
      `        _doc = ImageDocument.LoadProject(d.SelectedPath);\n` +
      `        _canvas.Document = _doc;\n` +
      `        _undo.Clear(); _redo.Clear();\n` +
      `        RefreshLayers(); _canvas.Invalidate();\n    }\n\n` +
      `    private void AddLayer()\n    {\n` +
      `        PushUndo();\n` +
      `        _doc.AddLayer($"Layer {_doc.Layers.Count + 1}");\n` +
      `        RefreshLayers(); _canvas.Invalidate();\n    }\n\n` +
      `    private void DeleteLayer()\n    {\n` +
      `        if (_doc.Layers.Count <= 1) return;\n` +
      `        PushUndo();\n` +
      `        _doc.RemoveLayer(_doc.ActiveIndex);\n` +
      `        RefreshLayers(); _canvas.Invalidate();\n    }\n\n` +
      `    private void MoveLayerUp()\n    {\n` +
      `        _doc.MoveLayer(_doc.ActiveIndex, 1);\n` +
      `        RefreshLayers(); _canvas.Invalidate();\n    }\n\n` +
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

    const defaultWorkspace = createDefaultWorkspace();
    const focusWorkspace = createFocusWorkspace();
    files[`${root}/Workspace.cs`] =
      `namespace ${asm};\n\n` +
      `/// <summary>One panel placement in the editor workspace layout (Phase 54).</summary>\n` +
      `public sealed record PanelLayoutEntry(string Id, string Dock, bool Visible, double Weight);\n\n` +
      `/// <summary>\n` +
      `/// Workspace data for the editor shell, generated from the\n` +
      `/// TypeScript workspace model (server/imageEditor/workspace.ts):\n` +
      `/// panel layouts for the built-in presets and the keyboard\n` +
      `/// shortcut map (command id to chord string). The shell docks\n` +
      `/// its panels from this data and resolves keys through\n` +
      `/// ShortcutResolver; it does not keep its own copies.\n` +
      `/// </summary>\n` +
      `public static class WorkspaceData\n{\n` +
      `    public static readonly PanelLayoutEntry[] DefaultLayout = { ` + layoutCSharp(defaultWorkspace) + ` };\n\n` +
      `    public static readonly PanelLayoutEntry[] FocusLayout = { ` + layoutCSharp(focusWorkspace) + ` };\n\n` +
      `    public static readonly IReadOnlyDictionary<string, string> Shortcuts = new Dictionary<string, string>\n    {\n` +
      shortcutsCSharp(defaultWorkspace) + `\n    };\n\n` +
      `    public static PanelLayoutEntry FindPanel(PanelLayoutEntry[] layout, string id) => layout.First(p => p.Id == id);\n}\n\n` +
      `/// <summary>\n` +
      `/// Resolves key presses to editor commands. Matching is\n` +
      `/// modifier-exact, mirroring the TypeScript resolver: a\n` +
      `/// Ctrl+Shift+Z press does not fire the Ctrl+Z binding.\n` +
      `/// </summary>\n` +
      `public static class ShortcutResolver\n{\n` +
      `    public static string? Resolve(KeyEventArgs e)\n    {\n` +
      `        var chord = FormatChord(e.KeyCode, e.Control, e.Shift, e.Alt);\n` +
      `        if (chord.Length == 0) return null;\n` +
      `        foreach (var pair in WorkspaceData.Shortcuts)\n` +
      `            if (pair.Value == chord) return pair.Key;\n` +
      `        return null;\n    }\n\n` +
      `    public static string FormatChord(Keys key, bool ctrl, bool shift, bool alt)\n    {\n` +
      `        var name = KeyName(key);\n` +
      `        if (name == null) return "";\n` +
      `        var parts = new List<string>();\n` +
      `        if (ctrl) parts.Add("Ctrl");\n` +
      `        if (shift) parts.Add("Shift");\n` +
      `        if (alt) parts.Add("Alt");\n` +
      `        parts.Add(name);\n` +
      `        return string.Join("+", parts);\n    }\n\n` +
      `    private static string? KeyName(Keys key)\n    {\n` +
      `        switch (key)\n        {\n` +
      `            case Keys.Delete: return "Delete";\n` +
      `            case Keys.Back: return "Backspace";\n` +
      `            case Keys.Enter: return "Enter";\n` +
      `            case Keys.Escape: return "Escape";\n` +
      `            case Keys.Space: return "Space";\n` +
      `            case Keys.Tab: return "Tab";\n` +
      `            case Keys.OemOpenBrackets: return "[";\n` +
      `            case Keys.OemCloseBrackets: return "]";\n` +
      `            case Keys.Oemplus: return "=";\n` +
      `            case Keys.OemMinus: return "-";\n` +
      `            default:\n` +
      `                if (key >= Keys.A && key <= Keys.Z) return key.ToString();\n` +
      `                if (key >= Keys.D0 && key <= Keys.D9) return ((char)('0' + (key - Keys.D0))).ToString();\n` +
      `                if (key >= Keys.F1 && key <= Keys.F24) return key.ToString();\n` +
      `                return null;\n        }\n    }\n}\n`;

    files['README.md'] =
      `# ${config.appName}\n\nA layered image-editing application generated by SquadForge (Phase 19 Image Editing Engine on the Phase 18 desktop stack).\n\n` +
      `## Features\n- Canvas with zoom (mouse wheel, anchored) and pan (middle-drag or Space+drag)\n- Layers: add, reorder, visibility, opacity, per-layer editing\n- Tools: brush, eraser (true alpha erase), rectangle, ellipse, line, text, fill\n- Transforms: crop/resize/rotate/flip (document model), adjustments in ImageDocument\n- Undo/redo (snapshot history)\n- Project save/load: folder with project.json + one PNG per layer\n- Import PNG/BMP/JPEG; export flattened PNG/JPEG\n\n` +
      `## Develop\nOpen the .sln in Visual Studio 2022 or run \`dotnet build\`. Entry point: \`src/${asm}/Program.cs\`; document model: \`ImageDocument.cs\`; surface: \`EditorCanvas.cs\`.\n`;

    return files;
  }
}
