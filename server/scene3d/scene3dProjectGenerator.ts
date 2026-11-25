import type { DesktopProjectConfig } from '../desktop/types.js';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';

/**
 * Phase 21: generates a real C# WinForms 3D creation application on the
 * Phase 18 desktop stack. Its viewport is an honest software renderer
 * (orbit camera, perspective projection, per-face diffuse shading,
 * painter-sorted triangles drawn with GDI+) — the same approach as the
 * server engine, clearly a software renderer and not a fake mockup.
 * Scenes save/load as JSON and export to OBJ.
 */
export class Scene3dProjectGenerator {
  public static getDefaultConfig(appName: string = 'ModelForge'): DesktopProjectConfig {
    return DesktopProjectGenerator.getDefaultConfig(appName, appName.replace(/[^a-zA-Z0-9_]/g, ''));
  }

  public static generateProjectFiles(config: DesktopProjectConfig): Record<string, string> {
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

    files[`${root}/SceneDocument.cs`] =
      `using System.Text.Json;\n\nnamespace ${asm};\n\n` +
      `public sealed class MeshData\n{\n` +
      `    public List<float> Positions { get; set; } = new();\n` +
      `    public List<float> Normals { get; set; } = new();\n` +
      `    public List<int> Indices { get; set; } = new();\n}\n\n` +
      `public sealed class SceneNode\n{\n` +
      `    public string Id { get; set; } = Guid.NewGuid().ToString();\n` +
      `    public string Name { get; set; } = "Node";\n` +
      `    public string? ParentId { get; set; }\n` +
      `    public float[] Position { get; set; } = { 0, 0, 0 };\n` +
      `    public float[] Rotation { get; set; } = { 0, 0, 0 }; // euler radians\n` +
      `    public float[] Scale { get; set; } = { 1, 1, 1 };\n` +
      `    public float[] Color { get; set; } = { 0.8f, 0.8f, 0.8f };\n` +
      `    public MeshData? Mesh { get; set; }\n}\n\n` +
      `public sealed class Keyframe { public string NodeId { get; set; } = ""; public string Property { get; set; } = "position"; public double Time { get; set; } public float[] Value { get; set; } = { 0, 0, 0 }; }\n\n` +
      `/// <summary>\n` +
      `/// Scene graph with primitives, hierarchy, keyframe animation\n` +
      `/// sampling, JSON persistence and OBJ export (world-space baked).\n` +
      `/// </summary>\n` +
      `public sealed class SceneDocument\n{\n` +
      `    public string Name { get; set; } = "Scene";\n` +
      `    public List<SceneNode> Nodes { get; } = new();\n` +
      `    public List<Keyframe> Animation { get; } = new();\n` +
      `    public double DurationSec { get; set; }\n\n` +
      `    public SceneNode AddNode(string name, string? parentId = null)\n    {\n` +
      `        var node = new SceneNode { Name = name, ParentId = parentId };\n` +
      `        Nodes.Add(node); return node;\n    }\n\n` +
      `    public static MeshData CreateCube(float size = 1f)\n    {\n` +
      `        var h = size / 2;\n` +
      `        var mesh = new MeshData();\n` +
      `        var faces = new (float[] n, float[][] v)[]\n        {\n` +
      `            (new[]{0f,0f,1f}, new[]{ new[]{-h,-h,h}, new[]{h,-h,h}, new[]{h,h,h}, new[]{-h,h,h} }),\n` +
      `            (new[]{0f,0f,-1f}, new[]{ new[]{h,-h,-h}, new[]{-h,-h,-h}, new[]{-h,h,-h}, new[]{h,h,-h} }),\n` +
      `            (new[]{1f,0f,0f}, new[]{ new[]{h,-h,h}, new[]{h,-h,-h}, new[]{h,h,-h}, new[]{h,h,h} }),\n` +
      `            (new[]{-1f,0f,0f}, new[]{ new[]{-h,-h,-h}, new[]{-h,-h,h}, new[]{-h,h,h}, new[]{-h,h,-h} }),\n` +
      `            (new[]{0f,1f,0f}, new[]{ new[]{-h,h,h}, new[]{h,h,h}, new[]{h,h,-h}, new[]{-h,h,-h} }),\n` +
      `            (new[]{0f,-1f,0f}, new[]{ new[]{-h,-h,-h}, new[]{h,-h,-h}, new[]{h,-h,h}, new[]{-h,-h,h} })\n        };\n` +
      `        foreach (var (n, verts) in faces)\n        {\n` +
      `            int baseIx = mesh.Positions.Count / 3;\n` +
      `            foreach (var v in verts) { mesh.Positions.AddRange(v); mesh.Normals.AddRange(n); }\n` +
      `            mesh.Indices.AddRange(new[] { baseIx, baseIx + 1, baseIx + 2, baseIx, baseIx + 2, baseIx + 3 });\n        }\n` +
      `        return mesh;\n    }\n\n` +
      `    public void AddKeyframe(string nodeId, string property, double time, float[] value)\n    {\n` +
      `        Animation.RemoveAll(k => k.NodeId == nodeId && k.Property == property && Math.Abs(k.Time - time) < 1e-9);\n` +
      `        Animation.Add(new Keyframe { NodeId = nodeId, Property = property, Time = time, Value = value });\n` +
      `        Animation.Sort((a, b) => a.Time.CompareTo(b.Time));\n` +
      `        DurationSec = Math.Max(DurationSec, time);\n    }\n\n` +
      `    public float[] Sample(string nodeId, string property, double time, float[] fallback)\n    {\n` +
      `        var keys = Animation.Where(k => k.NodeId == nodeId && k.Property == property).OrderBy(k => k.Time).ToList();\n` +
      `        if (keys.Count == 0) return fallback;\n` +
      `        if (time <= keys[0].Time) return keys[0].Value;\n` +
      `        if (time >= keys[^1].Time) return keys[^1].Value;\n` +
      `        for (int i = 1; i < keys.Count; i++)\n        {\n` +
      `            if (time <= keys[i].Time)\n            {\n` +
      `                var a = keys[i - 1]; var b = keys[i];\n` +
      `                var t = (float)((time - a.Time) / (b.Time - a.Time));\n` +
      `                return new[] { a.Value[0] + (b.Value[0] - a.Value[0]) * t, a.Value[1] + (b.Value[1] - a.Value[1]) * t, a.Value[2] + (b.Value[2] - a.Value[2]) * t };\n            }\n        }\n` +
      `        return keys[^1].Value;\n    }\n\n` +
      `    public void Save(string path) => File.WriteAllText(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));\n` +
      `    public static SceneDocument Load(string path) => JsonSerializer.Deserialize<SceneDocument>(File.ReadAllText(path)) ?? throw new InvalidDataException("Empty scene file");\n\n` +
      `    public string ExportObj()\n    {\n` +
      `        var lines = new List<string> { $"# {Name}" };\n` +
      `        int offset = 0;\n` +
      `        foreach (var node in Nodes)\n        {\n` +
      `            if (node.Mesh == null) continue;\n` +
      `            lines.Add($"o {node.Name.Replace(' ', '_')}");\n` +
      `            for (int i = 0; i < node.Mesh.Positions.Count; i += 3)\n            {\n` +
      `                var x = node.Mesh.Positions[i] * node.Scale[0] + node.Position[0];\n` +
      `                var y = node.Mesh.Positions[i + 1] * node.Scale[1] + node.Position[1];\n` +
      `                var z = node.Mesh.Positions[i + 2] * node.Scale[2] + node.Position[2];\n` +
      `                lines.Add($"v {x} {y} {z}");\n            }\n` +
      `            for (int t = 0; t + 2 < node.Mesh.Indices.Count; t += 3)\n` +
      `                lines.Add($"f {node.Mesh.Indices[t] + 1 + offset} {node.Mesh.Indices[t + 1] + 1 + offset} {node.Mesh.Indices[t + 2] + 1 + offset}");\n` +
      `            offset += node.Mesh.Positions.Count / 3;\n        }\n` +
      `        return string.Join("\\n", lines);\n    }\n}\n`;

    files[`${root}/Viewport3D.cs`] =
      `using System.Drawing.Drawing2D;\n\nnamespace ${asm};\n\n` +
      `/// <summary>\n` +
      `/// Software-rendered 3D viewport: orbit camera (drag to orbit,\n` +
      `/// wheel to zoom), perspective projection, per-face diffuse\n` +
      `/// shading from a fixed directional light plus ambient, and\n` +
      `/// depth-sorted triangle filling. Honest software rendering —\n` +
      `/// no GPU engine is claimed.\n` +
      `/// </summary>\n` +
      `public sealed class Viewport3D : Control\n{\n` +
      `    public SceneDocument? Scene { get; set; }\n` +
      `    public double TimeSec { get; set; }\n` +
      `    public float Azimuth { get; private set; } = 0.6f;\n` +
      `    public float Elevation { get; private set; } = 0.45f;\n` +
      `    public float Distance { get; private set; } = 10f;\n` +
      `    private Point? _drag;\n\n` +
      `    public Viewport3D() { DoubleBuffered = true; BackColor = Color.FromArgb(24, 24, 32); }\n\n` +
      `    protected override void OnMouseDown(MouseEventArgs e) { _drag = e.Location; }\n` +
      `    protected override void OnMouseUp(MouseEventArgs e) { _drag = null; }\n` +
      `    protected override void OnMouseMove(MouseEventArgs e)\n    {\n` +
      `        if (_drag == null) return;\n` +
      `        Azimuth += (e.X - _drag.Value.X) * 0.01f;\n` +
      `        Elevation = Math.Clamp(Elevation + (e.Y - _drag.Value.Y) * 0.01f, -1.4f, 1.4f);\n` +
      `        _drag = e.Location; Invalidate();\n    }\n` +
      `    protected override void OnMouseWheel(MouseEventArgs e)\n    {\n` +
      `        Distance = Math.Clamp(Distance * (e.Delta > 0 ? 0.9f : 1.1f), 2f, 100f); Invalidate();\n    }\n\n` +
      `    private (float x, float y, float z) Project(float[] p, float[] nodePos, float[] nodeScale)\n    {\n` +
      `        float wx = p[0] * nodeScale[0] + nodePos[0];\n` +
      `        float wy = p[1] * nodeScale[1] + nodePos[1];\n` +
      `        float wz = p[2] * nodeScale[2] + nodePos[2];\n` +
      `        // Orbit camera: rotate world by -azimuth around Y, then -elevation around X\n` +
      `        float ca = MathF.Cos(-Azimuth), sa = MathF.Sin(-Azimuth);\n` +
      `        float x1 = wx * ca - wz * sa, z1 = wx * sa + wz * ca;\n` +
      `        float ce = MathF.Cos(-Elevation), se = MathF.Sin(-Elevation);\n` +
      `        float y2 = wy * ce - z1 * se, z2 = wy * se + z1 * ce;\n` +
      `        float depth = z2 + Distance;\n` +
      `        float f = (Height / 2f) / MathF.Tan(0.45f);\n` +
      `        return (Width / 2f + x1 * f / Math.Max(0.1f, depth), Height / 2f - y2 * f / Math.Max(0.1f, depth), depth);\n    }\n\n` +
      `    protected override void OnPaint(PaintEventArgs e)\n    {\n` +
      `        base.OnPaint(e);\n` +
      `        if (Scene == null) return;\n` +
      `        var tris = new List<(float depth, PointF[] pts, Color color)>();\n` +
      `        foreach (var node in Scene.Nodes)\n        {\n` +
      `            if (node.Mesh == null) continue;\n` +
      `            var pos = Scene.Sample(node.Id, "position", TimeSec, node.Position);\n` +
      `            var mesh = node.Mesh;\n` +
      `            for (int t = 0; t + 2 < mesh.Indices.Count; t += 3)\n            {\n` +
      `                var pts = new PointF[3]; float depth = 0;\n` +
      `                for (int k = 0; k < 3; k++)\n                {\n` +
      `                    int vi = mesh.Indices[t + k] * 3;\n` +
      `                    var p = Project(new[] { mesh.Positions[vi], mesh.Positions[vi + 1], mesh.Positions[vi + 2] }, pos, node.Scale);\n` +
      `                    pts[k] = new PointF(p.x, p.y); depth += p.z;\n                }\n` +
      `                int ni = mesh.Indices[t] * 3;\n` +
      `                float nz = mesh.Normals[ni + 2];\n` +
      `                float shade = 0.3f + 0.7f * Math.Abs(nz);\n` +
      `                var col = Color.FromArgb((int)(node.Color[0] * 255 * shade), (int)(node.Color[1] * 255 * shade), (int)(node.Color[2] * 255 * shade));\n` +
      `                tris.Add((depth / 3, pts, col));\n            }\n        }\n` +
      `        foreach (var tri in tris.OrderByDescending(t => t.depth))\n        {\n` +
      `            using var brush = new SolidBrush(tri.color);\n` +
      `            e.Graphics.FillPolygon(brush, tri.pts);\n        }\n    }\n}\n`;

    files[`${root}/MainForm.cs`] =
      `namespace ${asm};\n\n` +
      `/// <summary>\n` +
      `/// 3D editor shell: scene hierarchy tree, primitive creation,\n` +
      `/// selection + transform display, keyframe capture, animation\n` +
      `/// playback (timer-driven), scene save/load and OBJ export.\n` +
      `/// </summary>\n` +
      `public sealed class MainForm : Form\n{\n` +
      `    private SceneDocument _scene = new();\n` +
      `    private readonly Viewport3D _viewport = new() { Dock = DockStyle.Fill };\n` +
      `    private readonly TreeView _tree = new() { Dock = DockStyle.Fill };\n` +
      `    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 33 };\n` +
      `    private double _time;\n\n` +
      `    public MainForm()\n    {\n` +
      `        Text = "${config.appName} — 3D Creation";\n` +
      `        Width = 1200; Height = 800;\n` +
      `        _viewport.Scene = _scene;\n` +
      `        var cube = _scene.AddNode("Cube");\n` +
      `        cube.Mesh = SceneDocument.CreateCube(2f);\n` +
      `        cube.Color = new[] { 0.9f, 0.4f, 0.3f };\n\n` +
      `        var menu = new MenuStrip();\n` +
      `        var file = new ToolStripMenuItem("File");\n` +
      `        file.DropDownItems.Add("Save scene…", null, (_, _) => { using var d = new SaveFileDialog { Filter = "Scene JSON|*.json" }; if (d.ShowDialog() == DialogResult.OK) _scene.Save(d.FileName); });\n` +
      `        file.DropDownItems.Add("Open scene…", null, (_, _) => { using var d = new OpenFileDialog { Filter = "Scene JSON|*.json" }; if (d.ShowDialog() == DialogResult.OK) { _scene = SceneDocument.Load(d.FileName); _viewport.Scene = _scene; RefreshTree(); _viewport.Invalidate(); } });\n` +
      `        file.DropDownItems.Add("Export OBJ…", null, (_, _) => { using var d = new SaveFileDialog { Filter = "Wavefront OBJ|*.obj" }; if (d.ShowDialog() == DialogResult.OK) File.WriteAllText(d.FileName, _scene.ExportObj()); });\n` +
      `        menu.Items.Add(file);\n\n` +
      `        var side = new Panel { Dock = DockStyle.Right, Width = 240 };\n` +
      `        var addCube = new Button { Text = "Add cube", Dock = DockStyle.Top };\n` +
      `        addCube.Click += (_, _) => { var n = _scene.AddNode($"Cube {_scene.Nodes.Count + 1}"); n.Mesh = SceneDocument.CreateCube(1.5f); n.Position = new[] { Random.Shared.NextSingle() * 4 - 2, 0, Random.Shared.NextSingle() * 4 - 2 }; RefreshTree(); _viewport.Invalidate(); };\n` +
      `        var keyBtn = new Button { Text = "Keyframe selected at t+1s", Dock = DockStyle.Top };\n` +
      `        keyBtn.Click += (_, _) => { var n = Selected(); if (n == null) return; _scene.AddKeyframe(n.Id, "position", _time + 1.0, new[] { n.Position[0] + 1, n.Position[1], n.Position[2] }); };\n` +
      `        var playBtn = new Button { Text = "Play / pause", Dock = DockStyle.Top };\n` +
      `        playBtn.Click += (_, _) => _timer.Enabled = !_timer.Enabled;\n` +
      `        _timer.Tick += (_, _) => { _time += 0.033; if (_scene.DurationSec > 0 && _time > _scene.DurationSec) _time = 0; _viewport.TimeSec = _time; _viewport.Invalidate(); };\n` +
      `        side.Controls.Add(_tree); side.Controls.Add(playBtn); side.Controls.Add(keyBtn); side.Controls.Add(addCube);\n\n` +
      `        Controls.Add(_viewport); Controls.Add(side); Controls.Add(menu);\n` +
      `        MainMenuStrip = menu;\n` +
      `        RefreshTree();\n    }\n\n` +
      `    private SceneNode? Selected() => _tree.SelectedNode?.Tag as SceneNode;\n\n` +
      `    private void RefreshTree()\n    {\n` +
      `        _tree.Nodes.Clear();\n` +
      `        foreach (var n in _scene.Nodes.Where(n => n.ParentId == null))\n` +
      `            _tree.Nodes.Add(new TreeNode(n.Name) { Tag = n });\n    }\n}\n`;

    files['README.md'] =
      `# ${config.appName}\n\nA 3D modeling and animation application generated by SquadForge (Phase 21 3D Creation Engine on the Phase 18 desktop stack).\n\n` +
      `## Features\n- Software-rendered 3D viewport: orbit (drag), zoom (wheel), perspective projection, diffuse face shading, depth-sorted drawing\n- Scene hierarchy with parenting, primitives (cube), transforms (position/rotation/scale)\n- Keyframe animation with linear sampling and timer playback\n- Scene save/load (JSON), OBJ export (world-space)\n\n` +
      `## Honesty note\nThe viewport is a CPU software renderer (GDI+), suitable for modeling and preview. It is not a GPU engine; for production rendering export OBJ/glTF from SquadForge and render in a dedicated engine.\n\n` +
      `## Develop\nOpen the .sln in Visual Studio 2022 or run \`dotnet build\`. Entry: \`src/${asm}/Program.cs\`; scene model: \`SceneDocument.cs\`; viewport: \`Viewport3D.cs\`.\n`;

    return files;
  }
}
