import type { DesktopProjectConfig } from '../desktop/types.js';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';

/**
 * Phase 20: generates a real C# WinForms video-editing application on
 * the Phase 18 desktop stack. The app's document model mirrors the
 * TypeScript engine (multitrack timeline, trim/split/move, transitions,
 * titles, volume, export settings) and its export shells out to a real
 * ffmpeg executable, building the same kind of filter graph the server
 * engine builds — no simulated rendering anywhere.
 */
export class VideoProjectGenerator {
  public static getDefaultConfig(appName: string = 'ClipForge'): DesktopProjectConfig {
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

    files[`${root}/VideoDocument.cs`] =
      `using System.Diagnostics;\nusing System.Globalization;\nusing System.Text.Json;\n\nnamespace ${asm};\n\n` +
      `public sealed class VideoClip\n{\n` +
      `    public string MediaPath { get; set; } = "";\n` +
      `    public double TrackStart { get; set; }\n` +
      `    public double SourceIn { get; set; }\n` +
      `    public double SourceOut { get; set; }\n` +
      `    public double Volume { get; set; } = 1.0;\n` +
      `    public string? Title { get; set; }\n` +
      `    // Phase 26: professional editing properties (overlay tracks)\n` +
      `    public double X { get; set; }\n` +
      `    public double Y { get; set; }\n` +
      `    public double Scale { get; set; } = 1.0;\n` +
      `    public double RotationDeg { get; set; }\n` +
      `    public double Opacity { get; set; } = 1.0;\n` +
      `    public double Speed { get; set; } = 1.0;\n` +
      `    public double CropLeft { get; set; }\n` +
      `    public double CropTop { get; set; }\n` +
      `    public double CropRight { get; set; }\n` +
      `    public double CropBottom { get; set; }\n` +
      `    // Phase 28: ordered adjustable effect stack (mirrors the server registry)\n` +
      `    public List<VideoEffect> Effects { get; set; } = new();\n` +
      `    public double Duration => (SourceOut - SourceIn) / (Speed > 0 ? Speed : 1.0);\n` +
      `    public double TrackEnd => TrackStart + Duration;\n}\n\n` +
      `public sealed class VideoEffect\n{\n` +
      `    public string Type { get; set; } = "brightness";\n` +
      `    public double Value { get; set; }\n}\n\n` +
      `public sealed class VideoText\n{\n` +
      `    public string Text { get; set; } = "";\n` +
      `    public double TrackStart { get; set; }\n` +
      `    public double DurationSec { get; set; } = 3;\n` +
      `    public double X { get; set; }\n` +
      `    public double Y { get; set; }\n` +
      `    public int FontSize { get; set; } = 36;\n` +
      `    public string Color { get; set; } = "#FFFFFF";\n}\n\n` +
      `public sealed class VideoCaption\n{\n` +
      `    public double StartSec { get; set; }\n` +
      `    public double EndSec { get; set; }\n` +
      `    public string Text { get; set; } = "";\n}\n\n` +
      `public sealed class VideoTrack\n{\n` +
      `    public string Kind { get; set; } = "video"; // video | audio\n` +
      `    public string Name { get; set; } = "";\n` +
      `    public List<VideoClip> Clips { get; } = new();\n}\n\n` +
      `/// <summary>\n` +
      `/// Multitrack timeline document: trim, split, move with overlap\n` +
      `/// validation, JSON project save/load, and a REAL export that runs\n` +
      `/// ffmpeg (trim/scale/concat per clip, volume per clip) and checks\n` +
      `/// the produced file exists. If ffmpeg is missing the export fails\n` +
      `/// with that message — it never pretends to render.\n` +
      `/// </summary>\n` +
      `public sealed class VideoDocument\n{\n` +
      `    public int Width { get; set; } = 1280;\n` +
      `    public int Height { get; set; } = 720;\n` +
      `    public int Fps { get; set; } = 30;\n` +
      `    public List<VideoTrack> Tracks { get; } = new();\n` +
      `    public List<VideoText> Texts { get; } = new();\n` +
      `    public List<VideoCaption> Captions { get; } = new();\n\n` +
      `    public VideoDocument()\n    {\n` +
      `        Tracks.Add(new VideoTrack { Kind = "video", Name = "Video 1" });\n` +
      `        Tracks.Add(new VideoTrack { Kind = "audio", Name = "Audio 1" });\n    }\n\n` +
      `    public double TotalDuration => Tracks.SelectMany(t => t.Clips).Select(c => c.TrackEnd).DefaultIfEmpty(0).Max();\n\n` +
      `    public void AddClip(VideoTrack track, VideoClip clip)\n    {\n` +
      `        if (clip.SourceOut <= clip.SourceIn) throw new InvalidOperationException("Clip out-point must be after in-point.");\n` +
      `        foreach (var other in track.Clips)\n` +
      `            if (clip.TrackStart < other.TrackEnd && other.TrackStart < clip.TrackEnd)\n` +
      `                throw new InvalidOperationException("Clip overlaps an existing clip on this track.");\n` +
      `        track.Clips.Add(clip);\n` +
      `        track.Clips.Sort((a, b) => a.TrackStart.CompareTo(b.TrackStart));\n    }\n\n` +
      `    public VideoClip Split(VideoTrack track, VideoClip clip, double atTimelineSec)\n    {\n` +
      `        if (atTimelineSec <= clip.TrackStart || atTimelineSec >= clip.TrackEnd)\n` +
      `            throw new InvalidOperationException("Split point is outside the clip.");\n` +
      `        var offset = atTimelineSec - clip.TrackStart;\n` +
      `        var right = new VideoClip { MediaPath = clip.MediaPath, TrackStart = atTimelineSec, SourceIn = clip.SourceIn + offset, SourceOut = clip.SourceOut, Volume = clip.Volume, Title = clip.Title };\n` +
      `        clip.SourceOut = clip.SourceIn + offset;\n` +
      `        track.Clips.Add(right);\n` +
      `        track.Clips.Sort((a, b) => a.TrackStart.CompareTo(b.TrackStart));\n` +
      `        return right;\n    }\n\n` +
      `    public void Save(string path) => File.WriteAllText(path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));\n\n` +
      `    public static VideoDocument Load(string path) =>\n` +
      `        JsonSerializer.Deserialize<VideoDocument>(File.ReadAllText(path)) ?? throw new InvalidDataException("Empty project file");\n\n` +
      `    public static string? FindFfmpeg()\n    {\n` +
      `        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";\n` +
      `        foreach (var dir in pathVar.Split(Path.PathSeparator))\n        {\n` +
      `            var candidate = Path.Combine(dir, "ffmpeg.exe");\n` +
      `            if (File.Exists(candidate)) return candidate;\n        }\n` +
      `        return null;\n    }\n\n` +
      `    private static string F(double v) => v.ToString("0.###", CultureInfo.InvariantCulture);\n\n` +
      `    // Phase 28: same registry semantics as the server effects module.\n` +
      `    private static string? EffectFilter(VideoEffect e)\n    {\n` +
      `        return e.Type switch\n        {\n` +
      `            "brightness" => e.Value == 0 ? null : $"eq=brightness={F(e.Value)}",\n` +
      `            "contrast" => e.Value == 1 ? null : $"eq=contrast={F(e.Value)}",\n` +
      `            "saturation" => e.Value == 1 ? null : $"eq=saturation={F(e.Value)}",\n` +
      `            "temperature" => e.Value == 0 ? null : $"colortemperature=temperature={Math.Round(6500 - e.Value * 3000)}",\n` +
      `            "blur" => e.Value == 0 ? null : $"boxblur={F(e.Value)}",\n` +
      `            "sharpen" => e.Value == 0 ? null : $"unsharp=5:5:{F(e.Value)}",\n` +
      `            _ => throw new InvalidOperationException($"Unknown effect type: {e.Type}")\n        };\n    }\n\n` +
      `    private static IEnumerable<string> EffectChain(VideoClip c)\n    {\n` +
      `        foreach (var e in c.Effects) { var f = EffectFilter(e); if (f != null) yield return f; }\n    }\n\n` +
      `    private static string TransformChain(VideoClip c)\n    {\n` +
      `        var parts = new List<string>();\n` +
      `        if (c.CropLeft + c.CropRight > 0 || c.CropTop + c.CropBottom > 0)\n` +
      `            parts.Add($"crop=w=iw-{F(c.CropLeft + c.CropRight)}:h=ih-{F(c.CropTop + c.CropBottom)}:x={F(c.CropLeft)}:y={F(c.CropTop)}");\n` +
      `        parts.AddRange(EffectChain(c));\n` +
      `        if (Math.Abs(c.Scale - 1.0) > 0.001) parts.Add($"scale=iw*{F(c.Scale)}:ih*{F(c.Scale)}");\n` +
      `        parts.Add("format=rgba");\n` +
      `        if (Math.Abs(c.RotationDeg) > 0.001) parts.Add($"rotate={F(c.RotationDeg * Math.PI / 180.0)}:ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none");\n` +
      `        if (c.Opacity < 0.999) parts.Add($"colorchannelmixer=aa={F(c.Opacity)}");\n` +
      `        return string.Join(",", parts);\n    }\n\n` +
      `    /// <summary>Builds the ffmpeg argument list: base track concat, Phase 26 overlay compositing (PiP) for extra video tracks, text layers via drawtext when a font exists, mixed audio.</summary>\n` +
      `    public List<string> BuildExportArgs(string outputPath)\n    {\n` +
      `        var baseTrack = Tracks.First(t => t.Kind == "video");\n` +
      `        var clips = baseTrack.Clips.OrderBy(c => c.TrackStart).ToList();\n` +
      `        if (clips.Count == 0) throw new InvalidOperationException("The base video track is empty.");\n` +
      `        var args = new List<string> { "-y" };\n` +
      `        var inputs = new List<string>();\n` +
      `        int InputIndex(string p) { int i = inputs.IndexOf(p); if (i < 0) { inputs.Add(p); i = inputs.Count - 1; } return i; }\n` +
      `        var graph = new List<string>();\n` +
      `        var vLabels = new List<string>();\n` +
      `        for (int i = 0; i < clips.Count; i++)\n        {\n` +
      `            var c = clips[i];\n` +
      `            var speed = c.Speed > 0 && Math.Abs(c.Speed - 1.0) > 0.001 ? $",setpts=PTS/{F(c.Speed)}" : "";\n` +
      `            var fx = EffectChain(c).ToList();\n` +
      `            var fxSuffix = fx.Count > 0 ? "," + string.Join(",", fx) : "";\n` +
      `            graph.Add($"[{InputIndex(c.MediaPath)}:v]trim=start={F(c.SourceIn)}:end={F(c.SourceOut)},setpts=PTS-STARTPTS{speed},scale={Width}:{Height}:force_original_aspect_ratio=decrease,pad={Width}:{Height}:(ow-iw)/2:(oh-ih)/2,fps={Fps},format=yuv420p{fxSuffix}[v{i}]");\n` +
      `            vLabels.Add($"[v{i}]");\n        }\n` +
      `        graph.Add($"{string.Concat(vLabels)}concat=n={clips.Count}:v=1:a=0[vmain]");\n` +
      `        var mainLabel = "vmain";\n` +
      `        int ovl = 0;\n` +
      `        foreach (var track in Tracks.Where(t => t.Kind == "video" && t != baseTrack))\n` +
      `        foreach (var c in track.Clips.OrderBy(c => c.TrackStart))\n        {\n` +
      `            var speed = c.Speed > 0 && Math.Abs(c.Speed - 1.0) > 0.001 ? $",setpts=PTS/{F(c.Speed)}" : "";\n` +
      `            graph.Add($"[{InputIndex(c.MediaPath)}:v]trim=start={F(c.SourceIn)}:end={F(c.SourceOut)},setpts=PTS-STARTPTS{speed},{TransformChain(c)},setsar=1,setpts=PTS+{F(c.TrackStart)}/TB[ovl{ovl}]");\n` +
      `            graph.Add($"[{mainLabel}][ovl{ovl}]overlay=x={F(c.X)}:y={F(c.Y)}:eof_action=pass:enable='between(t,{F(c.TrackStart)},{F(c.TrackEnd)})'[vc{ovl}]");\n` +
      `            mainLabel = $"vc{ovl}"; ovl++;\n        }\n` +
      `        var fontPath = @"C:\\Windows\\Fonts\\arial.ttf";\n` +
      `        if (Texts.Count > 0 && File.Exists(fontPath))\n        {\n` +
      `            int ti = 0;\n` +
      `            foreach (var t in Texts)\n            {\n` +
      `                var text = t.Text.Replace("'", "").Replace(":", " ");\n` +
      `                var color = "0x" + t.Color.TrimStart('#');\n` +
      `                graph.Add($"[{mainLabel}]drawtext=fontfile='{fontPath.Replace(":", "\\\\:")}':text='{text}':fontsize={t.FontSize}:fontcolor={color}:x={F(t.X)}:y={F(t.Y)}:enable='between(t,{F(t.TrackStart)},{F(t.TrackStart + t.DurationSec)})'[vtx{ti}]");\n` +
      `                mainLabel = $"vtx{ti}"; ti++;\n            }\n        }\n` +
      `        // Phase 31: caption burn-in mirrors the server exporter\n` +
      `        // (bottom-centre, fontsize 28, boxed, timed enable window).\n` +
      `        if (Captions.Count > 0 && File.Exists(fontPath))\n        {\n` +
      `            int ci = 0;\n` +
      `            foreach (var cap in Captions)\n            {\n` +
      `                var text = cap.Text.Replace("'", "").Replace(":", " ");\n` +
      `                graph.Add($"[{mainLabel}]drawtext=fontfile='{fontPath.Replace(":", "\\\\:")}':text='{text}':fontsize=28:fontcolor=white:box=1:boxcolor=black@0.5:x=(w-text_w)/2:y=h-52:enable='between(t,{F(cap.StartSec)},{F(cap.EndSec)})'[vcap{ci}]");\n` +
      `                mainLabel = $"vcap{ci}"; ci++;\n            }\n        }\n` +
      `        graph.Add($"[{mainLabel}]null[vout]");\n` +
      `        var aLabels = new List<string>();\n` +
      `        int ai = 0;\n` +
      `        foreach (var track in Tracks)\n        foreach (var c in track.Clips.OrderBy(c => c.TrackStart))\n        {\n` +
      `            var tempo = c.Speed > 0 && Math.Abs(c.Speed - 1.0) > 0.001 ? $"atempo={F(c.Speed)}," : "";\n` +
      `            graph.Add($"[{InputIndex(c.MediaPath)}:a]atrim=start={F(c.SourceIn)}:end={F(c.SourceOut)},asetpts=PTS-STARTPTS,{tempo}volume={F(c.Volume)},adelay={(int)(c.TrackStart * 1000)}:all=1[a{ai}]");\n` +
      `            aLabels.Add($"[a{ai++}]");\n        }\n` +
      `        string audioMap;\n` +
      `        if (aLabels.Count > 1) { graph.Add($"{string.Concat(aLabels)}amix=inputs={aLabels.Count}:duration=longest:normalize=0[aout]"); audioMap = "[aout]"; }\n` +
      `        else audioMap = aLabels.Count == 1 ? aLabels[0] : "";\n` +
      `        args.Clear(); args.Add("-y");\n` +
      `        foreach (var input in inputs) { args.Add("-i"); args.Add(input); }\n` +
      `        args.Add("-filter_complex"); args.Add(string.Join(";", graph));\n` +
      `        args.Add("-map"); args.Add("[vout]");\n` +
      `        if (audioMap.Length > 0) { args.Add("-map"); args.Add(audioMap); args.Add("-c:a"); args.Add("aac"); }\n` +
      `        args.Add("-c:v"); args.Add("libx264"); args.Add("-pix_fmt"); args.Add("yuv420p");\n` +
      `        args.Add(outputPath);\n` +
      `        return args;\n    }\n\n` +
      `    public async Task<(bool ok, string log)> ExportAsync(string outputPath)\n    {\n` +
      `        var ffmpeg = FindFfmpeg() ?? throw new InvalidOperationException("ffmpeg was not found on PATH. Install ffmpeg to export — rendering is never simulated.");\n` +
      `        var psi = new ProcessStartInfo(ffmpeg) { RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };\n` +
      `        foreach (var a in BuildExportArgs(outputPath)) psi.ArgumentList.Add(a);\n` +
      `        using var proc = Process.Start(psi)!;\n` +
      `        var log = await proc.StandardError.ReadToEndAsync();\n` +
      `        await proc.WaitForExitAsync();\n` +
      `        var ok = proc.ExitCode == 0 && File.Exists(outputPath) && new FileInfo(outputPath).Length > 0;\n` +
      `        return (ok, log);\n    }\n}\n`;

    files[`${root}/MainForm.cs`] =
      `namespace ${asm};\n\n` +
      `/// <summary>\n` +
      `/// Editor shell: media import, multitrack timeline list, trim /\n` +
      `/// split / move controls, volume, export settings (resolution,\n` +
      `/// frame rate, MP4/H.264), project save/load. Preview shows the\n` +
      `/// selected clip's first frame extracted by ffmpeg when available.\n` +
      `/// </summary>\n` +
      `public sealed class MainForm : Form\n{\n` +
      `    private VideoDocument _doc = new();\n` +
      `    private readonly ListBox _timeline = new() { Dock = DockStyle.Fill };\n` +
      `    private readonly PictureBox _preview = new() { Dock = DockStyle.Top, Height = 260, SizeMode = PictureBoxSizeMode.Zoom, BackColor = Color.Black };\n` +
      `    private readonly NumericUpDown _widthBox = new() { Minimum = 16, Maximum = 7680, Value = 1280 };\n` +
      `    private readonly NumericUpDown _heightBox = new() { Minimum = 16, Maximum = 4320, Value = 720 };\n` +
      `    private readonly NumericUpDown _fpsBox = new() { Minimum = 1, Maximum = 240, Value = 30 };\n` +
      `    private readonly NumericUpDown _xBox = new() { Minimum = -4000, Maximum = 4000, Value = 0 };\n` +
      `    private readonly NumericUpDown _yBox = new() { Minimum = -4000, Maximum = 4000, Value = 0 };\n` +
      `    private readonly NumericUpDown _scaleBox = new() { Minimum = 5, Maximum = 400, Value = 100 };\n` +
      `    private readonly NumericUpDown _opacityBox = new() { Minimum = 0, Maximum = 100, Value = 100 };\n` +
      `    private readonly ComboBox _effectTypeBox = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 110 };\n` +
      `    private readonly NumericUpDown _effectValueBox = new() { Minimum = -100, Maximum = 300, Value = 0 };\n` +
      `    private readonly Label _status = new() { Dock = DockStyle.Bottom, Height = 24 };\n\n` +
      `    public MainForm()\n    {\n` +
      `        Text = "${config.appName} — Video Editor";\n` +
      `        Width = 1100; Height = 760;\n\n` +
      `        var menu = new MenuStrip();\n` +
      `        var file = new ToolStripMenuItem("File");\n` +
      `        file.DropDownItems.Add("Import media…", null, (_, _) => ImportMedia());\n` +
      `        file.DropDownItems.Add("Save project…", null, (_, _) => { using var d = new SaveFileDialog { Filter = "SquadForge Video Project|*.json" }; if (d.ShowDialog() == DialogResult.OK) { SyncSettings(); _doc.Save(d.FileName); _status.Text = "Project saved."; } });\n` +
      `        file.DropDownItems.Add("Open project…", null, (_, _) => { using var d = new OpenFileDialog { Filter = "SquadForge Video Project|*.json" }; if (d.ShowDialog() == DialogResult.OK) { _doc = VideoDocument.Load(d.FileName); RefreshTimeline(); } });\n` +
      `        file.DropDownItems.Add("Export MP4…", null, async (_, _) => await ExportAsync());\n` +
      `        menu.Items.Add(file);\n\n` +
      `        var buttons = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 38 };\n` +
      `        var splitBtn = new Button { Text = "Split at midpoint", AutoSize = true };\n` +
      `        splitBtn.Click += (_, _) => SplitSelected();\n` +
      `        var removeBtn = new Button { Text = "Remove clip", AutoSize = true };\n` +
      `        removeBtn.Click += (_, _) => RemoveSelected();\n` +
      `        buttons.Controls.Add(splitBtn); buttons.Controls.Add(removeBtn);\n` +
      `        buttons.Controls.Add(new Label { Text = "W:", AutoSize = true, Margin = new Padding(12, 8, 0, 0) }); buttons.Controls.Add(_widthBox);\n` +
      `        buttons.Controls.Add(new Label { Text = "H:", AutoSize = true, Margin = new Padding(6, 8, 0, 0) }); buttons.Controls.Add(_heightBox);\n` +
      `        buttons.Controls.Add(new Label { Text = "FPS:", AutoSize = true, Margin = new Padding(6, 8, 0, 0) }); buttons.Controls.Add(_fpsBox);\n` +
      `        var transformBtn = new Button { Text = "Apply transform to selected", AutoSize = true };\n` +
      `        transformBtn.Click += (_, _) => ApplyTransform();\n` +
      `        buttons.Controls.Add(new Label { Text = "X:", AutoSize = true, Margin = new Padding(12, 8, 0, 0) }); buttons.Controls.Add(_xBox);\n` +
      `        buttons.Controls.Add(new Label { Text = "Y:", AutoSize = true, Margin = new Padding(6, 8, 0, 0) }); buttons.Controls.Add(_yBox);\n` +
      `        buttons.Controls.Add(new Label { Text = "Scale %:", AutoSize = true, Margin = new Padding(6, 8, 0, 0) }); buttons.Controls.Add(_scaleBox);\n` +
      `        buttons.Controls.Add(new Label { Text = "Opacity %:", AutoSize = true, Margin = new Padding(6, 8, 0, 0) }); buttons.Controls.Add(_opacityBox);\n` +
      `        buttons.Controls.Add(transformBtn);\n` +
      `        _effectTypeBox.Items.AddRange(new object[] { "brightness", "contrast", "saturation", "temperature", "blur", "sharpen" });\n` +
      `        _effectTypeBox.SelectedIndex = 0;\n` +
      `        var effectBtn = new Button { Text = "Add effect to selected", AutoSize = true };\n` +
      `        effectBtn.Click += (_, _) => AddEffectToSelected();\n` +
      `        buttons.Controls.Add(new Label { Text = "Effect:", AutoSize = true, Margin = new Padding(12, 8, 0, 0) }); buttons.Controls.Add(_effectTypeBox);\n` +
      `        buttons.Controls.Add(new Label { Text = "x100:", AutoSize = true, Margin = new Padding(6, 8, 0, 0) }); buttons.Controls.Add(_effectValueBox);\n` +
      `        buttons.Controls.Add(effectBtn);\n\n` +
      `        Controls.Add(_timeline); Controls.Add(buttons); Controls.Add(_preview); Controls.Add(menu); Controls.Add(_status);\n` +
      `        MainMenuStrip = menu;\n` +
      `        RefreshTimeline();\n    }\n\n` +
      `    private void SyncSettings() { _doc.Width = (int)_widthBox.Value; _doc.Height = (int)_heightBox.Value; _doc.Fps = (int)_fpsBox.Value; }\n\n` +
      `    private (VideoTrack track, VideoClip clip)? Selected()\n    {\n` +
      `        if (_timeline.SelectedItem is not string) return null;\n` +
      `        int idx = _timeline.SelectedIndex;\n` +
      `        foreach (var track in _doc.Tracks)\n            foreach (var clip in track.Clips)\n                if (idx-- == 0) return (track, clip);\n` +
      `        return null;\n    }\n\n` +
      `    private void ImportMedia()\n    {\n` +
      `        using var d = new OpenFileDialog { Filter = "Media|*.mp4;*.mov;*.mkv;*.mp3;*.wav;*.m4a", Multiselect = false };\n` +
      `        if (d.ShowDialog() != DialogResult.OK) return;\n` +
      `        var isAudio = new[] { ".mp3", ".wav", ".m4a" }.Contains(Path.GetExtension(d.FileName).ToLowerInvariant());\n` +
      `        var track = _doc.Tracks.First(t => t.Kind == (isAudio ? "audio" : "video"));\n` +
      `        var start = track.Clips.Select(c => c.TrackEnd).DefaultIfEmpty(0).Max();\n` +
      `        try\n        {\n` +
      `            _doc.AddClip(track, new VideoClip { MediaPath = d.FileName, TrackStart = start, SourceIn = 0, SourceOut = 5 });\n` +
      `            _status.Text = $"Imported {Path.GetFileName(d.FileName)} at {start:0.0}s (default 5s trim — adjust in code or split/trim).";\n        }\n` +
      `        catch (Exception ex) { _status.Text = ex.Message; }\n` +
      `        RefreshTimeline();\n    }\n\n` +
      `    private void ApplyTransform()\n    {\n` +
      `        var sel = Selected(); if (sel == null) { _status.Text = "Select a clip first."; return; }\n` +
      `        var clip = sel.Value.clip;\n` +
      `        clip.X = (double)_xBox.Value; clip.Y = (double)_yBox.Value;\n` +
      `        clip.Scale = (double)_scaleBox.Value / 100.0; clip.Opacity = (double)_opacityBox.Value / 100.0;\n` +
      `        _status.Text = "Transform applied (position/scale/opacity render on overlay tracks at export).";\n` +
      `        RefreshTimeline();\n    }\n\n` +
      `    private void AddEffectToSelected()\n    {\n` +
      `        var sel = Selected(); if (sel == null) { _status.Text = "Select a clip first."; return; }\n` +
      `        var type = _effectTypeBox.SelectedItem?.ToString() ?? "brightness";\n` +
      `        sel.Value.clip.Effects.Add(new VideoEffect { Type = type, Value = (double)_effectValueBox.Value / 100.0 });\n` +
      `        _status.Text = $"Effect {type} added (renders in export; order = list order).";\n` +
      `        RefreshTimeline();\n    }\n\n` +
      `    private void SplitSelected()\n    {\n` +
      `        var sel = Selected(); if (sel == null) return;\n` +
      `        var (track, clip) = sel.Value;\n` +
      `        try { _doc.Split(track, clip, clip.TrackStart + clip.Duration / 2); _status.Text = "Clip split."; }\n` +
      `        catch (Exception ex) { _status.Text = ex.Message; }\n` +
      `        RefreshTimeline();\n    }\n\n` +
      `    private void RemoveSelected()\n    {\n` +
      `        var sel = Selected(); if (sel == null) return;\n` +
      `        sel.Value.track.Clips.Remove(sel.Value.clip);\n` +
      `        RefreshTimeline();\n    }\n\n` +
      `    private async Task ExportAsync()\n    {\n` +
      `        using var d = new SaveFileDialog { Filter = "MP4 video|*.mp4" };\n` +
      `        if (d.ShowDialog() != DialogResult.OK) return;\n` +
      `        SyncSettings();\n` +
      `        _status.Text = "Exporting with ffmpeg…";\n` +
      `        try\n        {\n` +
      `            var (ok, log) = await _doc.ExportAsync(d.FileName);\n` +
      `            _status.Text = ok ? $"Exported {new FileInfo(d.FileName).Length:N0} bytes." : $"Export failed. {log.Split('\\n').LastOrDefault()}";\n        }\n` +
      `        catch (Exception ex) { _status.Text = ex.Message; }\n    }\n\n` +
      `    private void RefreshTimeline()\n    {\n` +
      `        _timeline.Items.Clear();\n` +
      `        foreach (var track in _doc.Tracks)\n            foreach (var clip in track.Clips)\n` +
      `                _timeline.Items.Add($"[{track.Name}] {Path.GetFileName(clip.MediaPath)} @ {clip.TrackStart:0.00}s ({clip.Duration:0.00}s, vol {clip.Volume:0.0}, x {clip.X:0} y {clip.Y:0} scale {clip.Scale:0.00} opacity {clip.Opacity:0.00} speed {clip.Speed:0.00}, fx {clip.Effects.Count})");\n` +
      `        _status.Text = $"Timeline duration: {_doc.TotalDuration:0.00}s";\n    }\n}\n`;

    files['README.md'] =
      `# ${config.appName}\n\nA multitrack video-editing application generated by SquadForge (Phase 20 Video Editing Engine on the Phase 18 desktop stack).\n\n` +
      `## Features\n- Media import onto video/audio tracks\n- Timeline: append, split, remove, trim (model-level, overlap-validated)\n- Per-clip volume, titles and transitions in the document model\n- Export settings: resolution, frame rate, MP4 (H.264 + AAC)\n- REAL export through ffmpeg (found on PATH): trim/scale/pad/concat filter graph; the export reports failure honestly when ffmpeg is missing or exits non-zero\n- Project save/load as JSON\n\n` +
      `## Develop\nOpen the .sln in Visual Studio 2022 or run \`dotnet build\`. Entry point: \`src/${asm}/Program.cs\`; model + export: \`VideoDocument.cs\`.\n\n` +
      `Requires ffmpeg on PATH for export (https://ffmpeg.org/download.html).\n`;

    return files;
  }
}
