import type { DesktopProjectConfig } from '../desktop/types.js';
import { DesktopProjectGenerator } from '../desktop/desktopProjectGenerator.js';
import type { EditorWorkspace, PanelLayout } from './types.js';
import { BLEND_MODES } from './types.js';
import { createDefaultWorkspace, createFocusWorkspace, formatKeyChord } from './workspace.js';
import { BUILT_IN_BRUSH_PRESETS, DEFAULT_BRUSH_SETTINGS, listFilters } from './imageCore.js';
import { glyphRowsFor } from './bitmapFont.js';

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

// ------------------------------------------------------------ Phase 56 emission helpers
//
// The C# engine data below is generated FROM the TypeScript engine's
// own tables (the Phase 47 filter registry, the Phase 46 brush
// defaults/presets, the Phase 48 glyph tables, the Phase 44 blend
// mode list) at generation time, so the generated app can never drift
// from the engine it mirrors: change the TS table and the generated
// C# table changes with it. The Phase 56 tests pin this.

/** A JS number as a C# literal (integers stay plain; C# converts them to double where the field is double). */
function csNum(v: number): string {
  return String(v);
}

function csBool(b: boolean): string {
  return b ? 'true' : 'false';
}

/** The Phase 47 registry as C# FilterDescriptor initializers. */
function filterTableCSharp(): string {
  return listFilters()
    .map((d) => {
      const params = d.params
        .map((p) => `new("${p.name}", ${csNum(p.min)}, ${csNum(p.max)}, ${csNum(p.defaultValue)})`)
        .join(', ');
      return `        new("${d.id}", "${d.name}", new FilterParamSpec[] { ${params} })`;
    })
    .join(',\n');
}

/** The Phase 46 built-in presets as C# initializers (scalar settings; the Speckle Tip's raster tip is not carried — see Phase 56 docs). */
function brushPresetsCSharp(): string {
  return BUILT_IN_BRUSH_PRESETS.map((preset) => {
    const s = preset.settings;
    return (
      `        ("${preset.name}", new BrushSettings { Size = ${csNum(s.size)}, Hardness = ${csNum(s.hardness)}, ` +
      `Spacing = ${csNum(s.spacing)}, Opacity = ${csNum(s.opacity)}, Flow = ${csNum(s.flow)}, Smoothing = ${csNum(s.smoothing)}, ` +
      `PressureSize = ${csBool(s.pressureSize)}, PressureOpacity = ${csBool(s.pressureOpacity)} })`
    );
  }).join(',\n');
}

/** The characters the built-in bitmap fonts define (bitmapFont.ts GLYPHS keys). */
const GLYPH_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-_+:'()/";

/** One built-in font as a C# dictionary keyed by char code, generated from glyphRowsFor. */
function glyphTableCSharp(font: 'pixel' | 'pixel-bold'): string {
  return [...GLYPH_CHARS]
    .map((ch) => {
      const rows = glyphRowsFor(font, ch)
        .map((r) => '0x' + r.toString(16).toUpperCase().padStart(2, '0'))
        .join(', ');
      return `            { ${ch.charCodeAt(0)}, new[] { ${rows} } }`;
    })
    .join(',\n');
}

/** The hollow-box fallback rows of a font ('~' is not a defined glyph, so glyphRowsFor returns the fallback). */
function glyphFallbackCSharp(font: 'pixel' | 'pixel-bold'): string {
  return glyphRowsFor(font, '~')
    .map((r) => '0x' + r.toString(16).toUpperCase().padStart(2, '0'))
    .join(', ');
}

// ------------------------------------------------------------ Phase 56: the C# pixel engine
//
// PixelEngine.cs is the generated app's single pixel core: a raw RGBA
// buffer (PixelImage, the TS engine's exact layout) plus faithful C#
// ports of the TS engine's math — W3C blend compositing (Phase 44),
// the Phase 46 coverage brush, the Phase 47 filter registry, the
// Phase 48 bitmap-font text and vector shape renderers, and the
// Phase 52 effect-stack / adjustment-layer compositor. The WinForms
// shell (canvas, dialogs, menus) only ever calls this engine; there
// is no second implementation of any of it in the generated app.

function pixelEngineCSharp(asm: string): string {
  return pixelEnginePart1(asm) + filtersCSharp() + pixelEnginePart3(asm) + fileSupportCSharp();
}

/**
 * Phase 58: content-based image file support for the generated app,
 * emitted into PixelEngine.cs so it stays on the UI-independent side
 * of the Phase 57 seam (the runtime harness executes it). Detection
 * is by magic bytes — the same signatures the TS engine's
 * detectFormat uses — so a misnamed file is judged by its content,
 * and formats this app does not import (PSD, TIFF) are refused with
 * a clear, named message instead of the generic failure
 * System.Drawing raises for data it cannot decode.
 */
function fileSupportCSharp(): string {
  return `
/// <summary>The image formats ImageFileSupport can recognize by content.</summary>
public enum ImageFileKind
{
    Unknown,
    Png,
    Jpeg,
    Bmp,
    Tiff,
    Psd
}

/// <summary>
/// Phase 58: file-format detection and import validation for the
/// generated app, by content (magic bytes), never by file name —
/// the same signature set as the TypeScript engine's detectFormat.
/// The shell reads a candidate file's bytes and calls
/// EnsureImportable before handing anything to System.Drawing, so
/// PSD and TIFF files (which this app does not import) and data
/// with no image signature are refused with a clear, named message
/// instead of System.Drawing's misleading generic error. This class
/// is UI-independent: it lives in PixelEngine.cs and the Phase 57
/// runtime harness executes it headless.
/// </summary>
public static class ImageFileSupport
{
    /// <summary>Detect the format from the first bytes of a file.</summary>
    public static ImageFileKind Detect(ReadOnlySpan<byte> data)
    {
        if (data.Length >= 8 && data[0] == 137 && data[1] == 80 && data[2] == 78 && data[3] == 71 &&
            data[4] == 13 && data[5] == 10 && data[6] == 26 && data[7] == 10)
            return ImageFileKind.Png;
        if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF)
            return ImageFileKind.Jpeg;
        if (data.Length >= 4 &&
            ((data[0] == 0x49 && data[1] == 0x49 && (data[2] == 0x2A || data[2] == 0x2B) && data[3] == 0x00) ||
             (data[0] == 0x4D && data[1] == 0x4D && data[2] == 0x00 && (data[3] == 0x2A || data[3] == 0x2B))))
            return ImageFileKind.Tiff;
        if (data.Length >= 4 && data[0] == 0x38 && data[1] == 0x42 && data[2] == 0x50 && data[3] == 0x53)
            return ImageFileKind.Psd;
        if (data.Length >= 2 && data[0] == 0x42 && data[1] == 0x4D)
            return ImageFileKind.Bmp;
        return ImageFileKind.Unknown;
    }

    /// <summary>A display name for a detected kind ("PNG", "JPEG", ...).</summary>
    public static string KindName(ImageFileKind kind)
    {
        switch (kind)
        {
            case ImageFileKind.Png: return "PNG";
            case ImageFileKind.Jpeg: return "JPEG";
            case ImageFileKind.Bmp: return "BMP";
            case ImageFileKind.Tiff: return "TIFF";
            case ImageFileKind.Psd: return "PSD";
            default: return "unknown";
        }
    }

    /// <summary>
    /// The formats this app imports: PNG, JPEG and BMP (decoded by
    /// System.Drawing). Anything else throws an
    /// InvalidOperationException naming the detected format and what
    /// to use instead — the shell shows that message to the user.
    /// </summary>
    public static ImageFileKind EnsureImportable(ReadOnlySpan<byte> data, string fileName)
    {
        ImageFileKind kind = Detect(data);
        switch (kind)
        {
            case ImageFileKind.Png:
            case ImageFileKind.Jpeg:
            case ImageFileKind.Bmp:
                return kind;
            case ImageFileKind.Psd:
                throw new InvalidOperationException(
                    "'" + fileName + "' is a Photoshop (PSD) file. This app cannot open PSD files; " +
                    "import it with the SquadForge graphics engine (importPsd) instead.");
            case ImageFileKind.Tiff:
                throw new InvalidOperationException(
                    "'" + fileName + "' is a TIFF file. This app does not import TIFF; " +
                    "import it with the SquadForge graphics engine (importImage) instead.");
            default:
                throw new InvalidOperationException(
                    "'" + fileName + "' is not a recognized image file: its first bytes match no PNG, JPEG, BMP, TIFF or PSD signature. " +
                    "The file may be corrupt or in an unsupported format.");
        }
    }
}
`;
}

/**
 * Phase 57: the GDI boundary of the engine core, emitted as its own
 * file. PixelEngine.cs and ImageDocument.cs are raw-buffer code with
 * no System.Drawing.Common dependency, so they compile and run
 * anywhere .NET 8 runs (the Phase 57 runtime harness does exactly
 * that); the Bitmap conversions and the document's GDI surface live
 * here and in ImageDocument.Drawing.cs, compiled only into the
 * Windows app.
 */
/**
 * Phase 60: crash diagnostics for the generated app, emitted as its
 * own file so it stays on the UI-independent side of the Phase 57
 * seam (no System.Windows.Forms, no System.Drawing.Common — only
 * text formatting and file IO): the Phase 57 runtime harness
 * compiles and executes it headless. Program.cs routes unhandled
 * exceptions here; the report carries the app name/version (from
 * the project config, the same values the .csproj stamps), the OS
 * and runtime, and the full exception chain.
 */
function crashDiagnosticsCSharp(asm: string, appName: string, version: string): string {
  const safeName = appName.replace(/["\\]/g, '');
  const safeVersion = version.replace(/["\\]/g, '');
  return `using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace ${asm};

/// <summary>
/// Phase 60: crash diagnostics. When an unhandled exception escapes
/// the app, Program.Main routes it here and a plain-text report is
/// written to a "crashes" folder next to the executable (see
/// DefaultReportDirectory) — a location the user can open and send
/// with a bug report. The UI-thread handler also shows the user a
/// message naming the report file. This class is UI-independent on
/// purpose (no System.Windows.Forms, no System.Drawing.Common):
/// the Phase 57 runtime harness compiles and executes it headless.
/// </summary>
public static class CrashDiagnostics
{
    /// <summary>The application name stamped into every report (from the project config).</summary>
    public const string AppName = "${safeName}";

    /// <summary>The release version stamped into every report (the project config's version — the same value the .csproj carries).</summary>
    public const string AppVersion = "${safeVersion}";

    /// <summary>
    /// The folder crash reports are written to by default: a
    /// "crashes" folder next to the executable
    /// (AppContext.BaseDirectory), so reports sit beside the app the
    /// user actually ran.
    /// </summary>
    public static string DefaultReportDirectory => Path.Combine(AppContext.BaseDirectory, "crashes");

    /// <summary>
    /// Builds the plain-text crash report for an exception. Pure —
    /// no IO — so the exact text can be inspected by callers and
    /// tests. The chain of inner exceptions is included (bounded,
    /// so a pathological chain cannot flood the file).
    /// </summary>
    public static string BuildReport(Exception exception, string context, DateTimeOffset timestamp)
    {
        ArgumentNullException.ThrowIfNull(exception);
        var sb = new StringBuilder();
        sb.AppendLine(AppName + " crash report");
        sb.AppendLine("App: " + AppName + " " + AppVersion);
        sb.AppendLine("Timestamp (UTC): " + timestamp.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture));
        sb.AppendLine("Context: " + (string.IsNullOrWhiteSpace(context) ? "(unspecified)" : context));
        sb.AppendLine("OS: " + RuntimeInformation.OSDescription + " (" + RuntimeInformation.OSArchitecture + ")");
        sb.AppendLine("Runtime: " + RuntimeInformation.FrameworkDescription);
        sb.AppendLine("Process architecture: " + RuntimeInformation.ProcessArchitecture);
        AppendException(sb, exception, "Exception");
        var inner = exception.InnerException;
        var depth = 0;
        while (inner != null && depth < 8)
        {
            depth++;
            AppendException(sb, inner, "Inner exception " + depth);
            inner = inner.InnerException;
        }
        return sb.ToString();
    }

    private static void AppendException(StringBuilder sb, Exception exception, string label)
    {
        sb.AppendLine();
        sb.AppendLine(label + ": " + exception.GetType().FullName);
        sb.AppendLine("Message: " + exception.Message);
        sb.AppendLine("Stack trace:");
        sb.AppendLine(exception.StackTrace ?? "(no stack trace recorded)");
    }

    /// <summary>
    /// Writes a crash report into the given directory (created if
    /// needed) and returns the full path of the file. The file name
    /// is crash-<UTC timestamp>.log; collisions within the same
    /// millisecond get a numeric suffix rather than overwriting.
    /// </summary>
    public static string WriteReport(Exception exception, string context, string directory)
    {
        ArgumentNullException.ThrowIfNull(exception);
        if (string.IsNullOrWhiteSpace(directory))
            throw new ArgumentException("A report directory is required.", nameof(directory));
        Directory.CreateDirectory(directory);
        var now = DateTimeOffset.UtcNow;
        var stamp = now.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture);
        var path = Path.Combine(directory, "crash-" + stamp + ".log");
        var suffix = 1;
        while (File.Exists(path))
        {
            suffix++;
            path = Path.Combine(directory, "crash-" + stamp + "-" + suffix + ".log");
        }
        File.WriteAllText(path, BuildReport(exception, context, now));
        return path;
    }

    /// <summary>
    /// WriteReport into DefaultReportDirectory, but never throws: a
    /// crash handler must not itself crash. Returns the report
    /// path, or null when the report could not be written (the
    /// caller still tells the user an error occurred).
    /// </summary>
    public static string? TryWriteReport(Exception exception, string context)
    {
        try
        {
            return WriteReport(exception, context, DefaultReportDirectory);
        }
        catch
        {
            return null;
        }
    }
}
`;
}

function pixelEngineDrawingCSharp(asm: string): string {
  return `using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace ${asm};

/// <summary>
/// The GDI boundary of PixelImage: conversions between the engine's
/// raw RGBA buffer and System.Drawing bitmaps, for display, import
/// and export in the Windows shell. This file is the only part of
/// the engine core that touches System.Drawing.Common types.
/// </summary>
public sealed partial class PixelImage
{
    public static PixelImage FromBitmap(Bitmap bmp)
    {
        var img = new PixelImage(bmp.Width, bmp.Height);
        var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        var bits = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int stride = bits.Stride;
            var raw = new byte[Math.Abs(stride) * bmp.Height];
            Marshal.Copy(bits.Scan0, raw, 0, raw.Length);
            for (int y = 0; y < img.Height; y++)
            {
                int srcRow = stride >= 0 ? y * stride : (img.Height - 1 - y) * -stride;
                int dstRow = y * img.Width * 4;
                for (int x = 0; x < img.Width; x++)
                {
                    int s = srcRow + x * 4;
                    int t = dstRow + x * 4;
                    img.Data[t] = raw[s + 2];     // BGRA -> RGBA
                    img.Data[t + 1] = raw[s + 1];
                    img.Data[t + 2] = raw[s];
                    img.Data[t + 3] = raw[s + 3];
                }
            }
        }
        finally { bmp.UnlockBits(bits); }
        return img;
    }

    public Bitmap ToBitmap()
    {
        var bmp = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
        WriteTo(bmp);
        return bmp;
    }

    public void WriteTo(Bitmap bmp)
    {
        if (bmp.Width != Width || bmp.Height != Height) throw new ArgumentException("Bitmap size does not match the pixel image");
        var rect = new Rectangle(0, 0, Width, Height);
        var bits = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            int stride = bits.Stride;
            var raw = new byte[Math.Abs(stride) * Height];
            for (int y = 0; y < Height; y++)
            {
                int dstRow = stride >= 0 ? y * stride : (Height - 1 - y) * -stride;
                int srcRow = y * Width * 4;
                for (int x = 0; x < Width; x++)
                {
                    int s = srcRow + x * 4;
                    int t = dstRow + x * 4;
                    raw[t] = Data[s + 2];         // RGBA -> BGRA
                    raw[t + 1] = Data[s + 1];
                    raw[t + 2] = Data[s];
                    raw[t + 3] = Data[s + 3];
                }
            }
            Marshal.Copy(raw, 0, bits.Scan0, raw.Length);
        }
        finally { bmp.UnlockBits(bits); }
    }
}
`;
}

/**
 * Phase 57: the GDI surface of the document model, emitted as its
 * own file: EditorLayer's cached Bitmap view and
 * ImageDocument.Flatten(). The rest of ImageDocument.cs is
 * raw-buffer code (Phase 57 separation — see PixelEngine.Drawing.cs).
 */
function imageDocumentDrawingCSharp(asm: string): string {
  return `using System.Drawing;

namespace ${asm};

/// <summary>
/// The GDI surface of EditorLayer: a cached Bitmap view of the
/// layer's pixels for the Windows shell's display. The cache is
/// dropped through the core file's InvalidateBitmap(), whose hook
/// lands here; in headless builds that compile ImageDocument.cs
/// without this file, no cache exists and the hook is a no-op.
/// </summary>
public sealed partial class EditorLayer
{
    private Bitmap? _bitmap;

    /// <summary>A cached GDI view of Pixels, regenerated after edits (call InvalidateBitmap).</summary>
    public Bitmap Bitmap
    {
        get
        {
            _bitmap ??= Pixels.ToBitmap();
            return _bitmap;
        }
    }

    partial void InvalidateCachedBitmap()
    {
        _bitmap?.Dispose();
        _bitmap = null;
    }
}

/// <summary>The GDI surface of ImageDocument: flattening to a Bitmap for display and export.</summary>
public sealed partial class ImageDocument
{
    /// <summary>Flatten the document to a GDI bitmap (the raw-buffer flatten is Compositor.Render).</summary>
    public Bitmap Flatten()
    {
        return Compositor.Render(this).ToBitmap();
    }
}
`;
}

function pixelEnginePart1(asm: string): string {
  const d = DEFAULT_BRUSH_SETTINGS;
  return `using System.Drawing;
using System.IO.Compression;
using System.Text;

namespace ${asm};

/// <summary>
/// An RGBA pixel buffer, row-major — the same layout as the
/// TypeScript engine's PixelImage. All engine math in the generated
/// app runs on this buffer; System.Drawing bitmaps are only a
/// display/import/export surface, converted at the boundary (the
/// Bitmap conversions live in PixelEngine.Drawing.cs, so this file
/// has no System.Drawing.Common dependency and runs anywhere
/// .NET 8 runs — Phase 57).
/// </summary>
public sealed partial class PixelImage
{
    public int Width { get; }
    public int Height { get; }
    public byte[] Data { get; }

    public PixelImage(int width, int height)
    {
        Width = width;
        Height = height;
        Data = new byte[width * height * 4];
    }

    public PixelImage Clone()
    {
        var copy = new PixelImage(Width, Height);
        Array.Copy(Data, copy.Data, Data.Length);
        return copy;
    }

    public void Clear(byte r, byte g, byte b, byte a)
    {
        for (int i = 0; i < Data.Length; i += 4)
        {
            Data[i] = r; Data[i + 1] = g; Data[i + 2] = b; Data[i + 3] = a;
        }
    }

    // The Bitmap conversions (FromBitmap / ToBitmap / WriteTo) live
    // in PixelEngine.Drawing.cs — see the class summary above.
}

/// <summary>
/// PNG encode/decode on raw pixel buffers — a port of the TS
/// engine's imageCodec (Phase 50) scope. The encoder writes 8-bit
/// RGBA, filter 0 per scanline, zlib. The decoder reads 8-bit
/// non-interlaced PNGs of color types 0 (grayscale), 2 (RGB),
/// 3 (palette), 4 (grayscale+alpha) and 6 (RGBA) with all five
/// scanline filters, applying a palette's tRNS alpha (RGB and
/// grayscale tRNS are not applied, as in the TS decoder). 16-bit
/// files, sub-8-bit depths and interlaced files are rejected with
/// named errors. This codec is what lets project save/load run on
/// the raw buffers without GDI: System.Drawing appears only at the
/// display/import/export boundary (Phase 57).
/// </summary>
public static class PngCodec
{
    private static readonly byte[] Signature = { 137, 80, 78, 71, 13, 10, 26, 10 };

    public static byte[] Encode(PixelImage img)
    {
        var raw = new byte[img.Height * (1 + img.Width * 4)];
        for (int y = 0; y < img.Height; y++)
        {
            int rowStart = y * (1 + img.Width * 4);
            raw[rowStart] = 0; // filter: none
            Array.Copy(img.Data, y * img.Width * 4, raw, rowStart + 1, img.Width * 4);
        }
        byte[] idat;
        using (var ms = new MemoryStream())
        {
            using (var zs = new ZLibStream(ms, CompressionLevel.Optimal, leaveOpen: true)) zs.Write(raw, 0, raw.Length);
            idat = ms.ToArray();
        }
        using var outMs = new MemoryStream();
        outMs.Write(Signature, 0, Signature.Length);
        var ihdr = new byte[13];
        WriteBe32(ihdr, 0, img.Width);
        WriteBe32(ihdr, 4, img.Height);
        ihdr[8] = 8;  // bit depth
        ihdr[9] = 6;  // color type RGBA
        ihdr[10] = 0; // compression
        ihdr[11] = 0; // filter method
        ihdr[12] = 0; // interlace: none
        WriteChunk(outMs, "IHDR", ihdr);
        WriteChunk(outMs, "IDAT", idat);
        WriteChunk(outMs, "IEND", Array.Empty<byte>());
        return outMs.ToArray();
    }

    public static PixelImage Decode(byte[] bytes)
    {
        if (bytes.Length < 8) throw new InvalidDataException("Not a PNG file (too short for a signature)");
        for (int i = 0; i < 8; i++)
            if (bytes[i] != Signature[i]) throw new InvalidDataException("Not a PNG file (bad signature)");
        byte[]? ihdr = null;
        byte[]? plte = null;
        byte[]? trns = null;
        var idat = new List<byte>();
        int pos = 8;
        while (pos + 12 <= bytes.Length)
        {
            int len = ReadBe32(bytes, pos);
            if (len < 0 || pos + 12 + len > bytes.Length) throw new InvalidDataException("Corrupt PNG (a chunk overruns the file)");
            string type = Encoding.ASCII.GetString(bytes, pos + 4, 4);
            if (type == "IHDR") ihdr = Slice(bytes, pos + 8, len);
            else if (type == "PLTE") plte = Slice(bytes, pos + 8, len);
            else if (type == "tRNS") trns = Slice(bytes, pos + 8, len);
            else if (type == "IDAT") idat.AddRange(Slice(bytes, pos + 8, len));
            pos += 12 + len;
            if (type == "IEND") break;
        }
        if (ihdr == null || ihdr.Length < 13) throw new InvalidDataException("PNG has no IHDR chunk");
        int width = ReadBe32(ihdr, 0);
        int height = ReadBe32(ihdr, 4);
        int bitDepth = ihdr[8];
        int colorType = ihdr[9];
        int interlace = ihdr[12];
        if (width <= 0 || height <= 0) throw new InvalidDataException("PNG has invalid dimensions " + width + "x" + height);
        if (bitDepth != 8) throw new InvalidDataException("Unsupported PNG bit depth: " + bitDepth + " (only 8 supported)");
        if (interlace != 0) throw new InvalidDataException("Interlaced PNGs are not supported");
        int channels = colorType switch { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4, _ => -1 };
        if (channels < 0) throw new InvalidDataException("Unsupported PNG color type: " + colorType + " (only grayscale=0, RGB=2, palette=3, grayscale+alpha=4 and RGBA=6 supported)");
        if (colorType == 3 && (plte == null || plte.Length < 3)) throw new InvalidDataException("Palette PNG has no PLTE chunk");
        byte[] raw;
        using (var input = new MemoryStream(idat.ToArray()))
        using (var zs = new ZLibStream(input, CompressionMode.Decompress))
        using (var outMs = new MemoryStream())
        {
            zs.CopyTo(outMs);
            raw = outMs.ToArray();
        }
        int stride = width * channels;
        if (raw.Length < height * (stride + 1)) throw new InvalidDataException("Corrupt PNG (the image data is truncated)");
        var recon = Unfilter(raw, height, stride, channels);
        var img = new PixelImage(width, height);
        for (int px = 0, s = 0, d = 0; px < width * height; px++, d += 4)
        {
            switch (colorType)
            {
                case 0:
                    img.Data[d] = recon[s]; img.Data[d + 1] = recon[s]; img.Data[d + 2] = recon[s];
                    img.Data[d + 3] = 255;
                    s += 1;
                    break;
                case 2:
                    img.Data[d] = recon[s]; img.Data[d + 1] = recon[s + 1]; img.Data[d + 2] = recon[s + 2];
                    img.Data[d + 3] = 255;
                    s += 3;
                    break;
                case 3:
                    int pidx = recon[s];
                    if ((pidx + 1) * 3 > plte!.Length) throw new InvalidDataException("Palette PNG index out of range: " + pidx);
                    img.Data[d] = plte[pidx * 3]; img.Data[d + 1] = plte[pidx * 3 + 1]; img.Data[d + 2] = plte[pidx * 3 + 2];
                    img.Data[d + 3] = trns != null && pidx < trns.Length ? trns[pidx] : (byte)255;
                    s += 1;
                    break;
                case 4:
                    img.Data[d] = recon[s]; img.Data[d + 1] = recon[s]; img.Data[d + 2] = recon[s];
                    img.Data[d + 3] = recon[s + 1];
                    s += 2;
                    break;
                default: // 6
                    img.Data[d] = recon[s]; img.Data[d + 1] = recon[s + 1]; img.Data[d + 2] = recon[s + 2]; img.Data[d + 3] = recon[s + 3];
                    s += 4;
                    break;
            }
        }
        return img;
    }

    /// <summary>Undo PNG scanline filtering; bpp is the filter's "left" distance in bytes, as in the TS codec.</summary>
    private static byte[] Unfilter(byte[] raw, int height, int stride, int bpp)
    {
        var recon = new byte[height * stride];
        for (int y = 0; y < height; y++)
        {
            int filter = raw[y * (stride + 1)];
            int rowStart = y * (stride + 1) + 1;
            int outRow = y * stride;
            int prevRow = outRow - stride;
            for (int i = 0; i < stride; i++)
            {
                int a = i >= bpp ? recon[outRow + i - bpp] : 0;
                int b = y > 0 ? recon[prevRow + i] : 0;
                int c = y > 0 && i >= bpp ? recon[prevRow + i - bpp] : 0;
                int v = raw[rowStart + i];
                recon[outRow + i] = filter switch
                {
                    0 => (byte)v,
                    1 => (byte)(v + a),
                    2 => (byte)(v + b),
                    3 => (byte)(v + (a + b) / 2),
                    4 => (byte)(v + Paeth(a, b, c)),
                    _ => throw new InvalidDataException("Unknown PNG filter type: " + filter)
                };
            }
        }
        return recon;
    }

    private static int Paeth(int a, int b, int c)
    {
        int p = a + b - c;
        int pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }

    private static void WriteChunk(Stream outStream, string type, byte[] data)
    {
        var lenBytes = new byte[4];
        WriteBe32(lenBytes, 0, data.Length);
        outStream.Write(lenBytes, 0, 4);
        var typeBytes = Encoding.ASCII.GetBytes(type);
        outStream.Write(typeBytes, 0, 4);
        outStream.Write(data, 0, data.Length);
        var crcBytes = new byte[4];
        WriteBe32(crcBytes, 0, (int)Crc32(typeBytes, data));
        outStream.Write(crcBytes, 0, 4);
    }

    private static uint Crc32(byte[] typeBytes, byte[] data)
    {
        uint crc = 0xFFFFFFFF;
        foreach (byte b in typeBytes) crc = CrcStep(crc, b);
        foreach (byte b in data) crc = CrcStep(crc, b);
        return crc ^ 0xFFFFFFFF;
    }

    private static uint CrcStep(uint crc, byte b)
    {
        uint c = crc ^ b;
        for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }

    private static void WriteBe32(byte[] buf, int offset, int value)
    {
        buf[offset] = (byte)(value >> 24);
        buf[offset + 1] = (byte)(value >> 16);
        buf[offset + 2] = (byte)(value >> 8);
        buf[offset + 3] = (byte)value;
    }

    private static int ReadBe32(byte[] buf, int offset) =>
        (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];

    private static byte[] Slice(byte[] buf, int offset, int length)
    {
        var outArr = new byte[length];
        Array.Copy(buf, offset, outArr, 0, length);
        return outArr;
    }
}

/// <summary>
/// Rotation/flip operations for ImageDocument.RotateFlip, mirroring
/// the names and numeric order of System.Drawing.RotateFlipType
/// (quarter-turns clockwise, then a horizontal (X) and/or vertical
/// (Y) mirror) so document geometry runs on raw buffers without
/// GDI: value % 4 is the clockwise quarter-turn count, value / 4 is
/// the flip (0 none, 1 X, 2 Y, 3 XY).
/// </summary>
public enum RotateFlipKind
{
    RotateNoneFlipNone = 0,
    Rotate90FlipNone = 1,
    Rotate180FlipNone = 2,
    Rotate270FlipNone = 3,
    RotateNoneFlipX = 4,
    Rotate90FlipX = 5,
    Rotate180FlipX = 6,
    Rotate270FlipX = 7,
    RotateNoneFlipY = 8,
    Rotate90FlipY = 9,
    Rotate180FlipY = 10,
    Rotate270FlipY = 11,
    RotateNoneFlipXY = 12,
    Rotate90FlipXY = 13,
    Rotate180FlipXY = 14,
    Rotate270FlipXY = 15
}

/// <summary>Rounding helpers mirroring the TS engine's JS semantics.</summary>
internal static class Px
{
    /// <summary>JS Math.round: halves round toward +infinity (C# Math.Round would banker's-round).</summary>
    public static int Round(double v) => (int)Math.Floor(v + 0.5);

    /// <summary>The TS clamp255: round, then clamp into 0..255.</summary>
    public static int Clamp255(double v) => Math.Min(255, Math.Max(0, Round(v)));

    public static int ClampIndex(int v, int size) => Math.Min(size - 1, Math.Max(0, v));

    /// <summary>Rec.601 luminance, the weights the TS engine uses throughout.</summary>
    public static double Luminance(double r, double g, double b) => 0.299 * r + 0.587 * g + 0.114 * b;
}

/// <summary>
/// Phase 44 blend compositing, ported from the TS engine: per-channel
/// W3C blend functions, then the W3C alpha-compositing formula. For
/// 'normal' this reduces exactly to source-over.
/// </summary>
public static class BlendModes
{
    public static readonly string[] All = { ${BLEND_MODES.map((m) => `"${m}"`).join(', ')} };

    public static double BlendChannel(string mode, double cb, double cs) => mode switch
    {
        "multiply" => cb * cs,
        "screen" => 1 - (1 - cb) * (1 - cs),
        "overlay" => cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs),
        "darken" => Math.Min(cb, cs),
        "lighten" => Math.Max(cb, cs),
        _ => cs // normal
    };

    /// <summary>Source-over one pixel onto dst at byte index i; sa is the effective source alpha 0..1.</summary>
    public static void BlendOver(byte[] dst, int i, int sr, int sg, int sb, double sa)
    {
        double da = dst[i + 3] / 255.0;
        double outA = sa + da * (1 - sa);
        if (outA <= 0)
        {
            dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
            return;
        }
        dst[i] = (byte)Px.Round((sr * sa + dst[i] * da * (1 - sa)) / outA);
        dst[i + 1] = (byte)Px.Round((sg * sa + dst[i + 1] * da * (1 - sa)) / outA);
        dst[i + 2] = (byte)Px.Round((sb * sa + dst[i + 2] * da * (1 - sa)) / outA);
        dst[i + 3] = (byte)Px.Round(outA * 255);
    }

    /// <summary>Composite one pixel with a blend mode (W3C formula; see the TS blendComposite).</summary>
    public static void BlendComposite(byte[] dst, int i, int sr, int sg, int sb, double sa, string mode)
    {
        if (mode == "normal")
        {
            BlendOver(dst, i, sr, sg, sb, sa);
            return;
        }
        double ab = dst[i + 3] / 255.0;
        double ao = sa + ab * (1 - sa);
        if (ao <= 0)
        {
            dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
            return;
        }
        var src = new[] { sr / 255.0, sg / 255.0, sb / 255.0 };
        for (int c = 0; c < 3; c++)
        {
            double cb = dst[i + c] / 255.0;
            double blended = BlendChannel(mode, cb, src[c]);
            double co = (sa * (1 - ab) * src[c] + sa * ab * blended + (1 - sa) * ab * cb) / ao;
            dst[i + c] = (byte)Px.Round(co * 255);
        }
        dst[i + 3] = (byte)Px.Round(ao * 255);
    }

    /// <summary>
    /// Paint one pixel into a layer's own buffer: normal source-over,
    /// except on an alpha-locked layer, where the destination alpha is
    /// preserved exactly and transparent pixels are left untouched.
    /// </summary>
    public static void BlendPaint(byte[] dst, int i, int sr, int sg, int sb, double sa, bool alphaLock)
    {
        if (!alphaLock)
        {
            BlendOver(dst, i, sr, sg, sb, sa);
            return;
        }
        double da = dst[i + 3] / 255.0;
        if (da <= 0 || sa <= 0) return; // locked: never create or change alpha
        dst[i] = (byte)Px.Round(sr * sa + dst[i] * (1 - sa));
        dst[i + 1] = (byte)Px.Round(sg * sa + dst[i + 1] * (1 - sa));
        dst[i + 2] = (byte)Px.Round(sb * sa + dst[i + 2] * (1 - sa));
        // dst[i + 3] unchanged — the lock holds.
    }
}

/// <summary>Phase 52: one entry of a layer's non-destructive effect stack (a Phase 47 registry filter + resolved params + enabled flag).</summary>
public sealed class LayerEffect
{
    public required string FilterId { get; set; }
    public Dictionary<string, double> Params { get; set; } = new();
    public bool Enabled { get; set; } = true;

    public LayerEffect Clone() => new() { FilterId = FilterId, Params = new Dictionary<string, double>(Params), Enabled = Enabled };
}

/// <summary>
/// Phase 48: the editable data of a text layer. Rendering is
/// deterministic: the built-in bitmap fonts at an integer scale
/// derived from FontSize. Outline width 0 means no outline.
/// </summary>
public sealed class TextData
{
    public string Text { get; set; } = "";
    public string Font { get; set; } = "pixel";
    public double FontSize { get; set; } = 14;
    public string Align { get; set; } = "left";
    public double LetterSpacing { get; set; }
    public double LineSpacing { get; set; }
    public Color Color { get; set; } = Color.Black;
    public int OutlineWidth { get; set; }
    public Color OutlineColor { get; set; } = Color.Black;
    public bool HasShadow { get; set; }
    public double ShadowOffsetX { get; set; }
    public double ShadowOffsetY { get; set; }
    public double ShadowBlur { get; set; }
    public Color ShadowColor { get; set; } = Color.Black;
    public double OriginX { get; set; }
    public double OriginY { get; set; }
    public double BlockWidth { get; set; }

    public TextData Clone() => (TextData)MemberwiseClone();
}

/// <summary>A point with double coordinates (the TS engine's Point/Rect geometry).</summary>
public readonly struct DPoint
{
    public double X { get; }
    public double Y { get; }
    public DPoint(double x, double y) { X = x; Y = y; }
}

/// <summary>Phase 48: one cubic Bezier segment of a vector path.</summary>
public sealed class BezierSegment
{
    public DPoint P0 { get; set; }
    public DPoint C1 { get; set; }
    public DPoint C2 { get; set; }
    public DPoint P1 { get; set; }
}

/// <summary>
/// Phase 48: the editable data of a vector shape layer. Geometry is
/// stored per kind; fill applies to closed shapes, stroke is drawn
/// along the outline. A null Fill/Stroke (or StrokeWidth 0) omits
/// that paint.
/// </summary>
public sealed class ShapeData
{
    public string Kind { get; set; } = "rectangle";
    public RectangleF Rect { get; set; }
    public DPoint From { get; set; }
    public DPoint To { get; set; }
    public List<DPoint> Points { get; set; } = new();
    public List<BezierSegment> Segments { get; set; } = new();
    public bool Closed { get; set; }
    public Color? Fill { get; set; }
    public Color? Stroke { get; set; }
    public double StrokeWidth { get; set; }

    public ShapeData Clone()
    {
        var copy = (ShapeData)MemberwiseClone();
        copy.Points = new List<DPoint>(Points);
        copy.Segments = new List<BezierSegment>(Segments);
        return copy;
    }
}
`;
}

/** The Filters class fragment of PixelEngine.cs: the Phase 47 registry, data generated from listFilters(). */
function filtersCSharp(): string {
  return `
/// <summary>One numeric parameter of a filter: name, accepted range, default (Phase 47 FilterParamSpec).</summary>
public sealed record FilterParamSpec(string Name, double Min, double Max, double DefaultValue);

/// <summary>One filter in the registry: id, display name, parameter schema (Phase 47 FilterDescriptor).</summary>
public sealed record FilterDescriptor(string Id, string Name, FilterParamSpec[] Params);

/// <summary>
/// Phase 47: the professional filter registry, ported from the TS
/// engine. Every filter is a pure function PixelImage -> PixelImage.
/// The descriptor table below is generated from the TS registry at
/// generation time, and parameters are validated against it exactly
/// as the TS resolveFilterParams validates: unknown ids, unknown
/// parameter names, non-finite and out-of-range values all throw —
/// nothing is silently clamped. Alpha handling matches the TS
/// engine: point color effects preserve alpha; the blurs convolve
/// all four channels; sharpen/noise/edge/emboss compute RGB and
/// preserve alpha; the distortions resample all four channels.
/// </summary>
public static class Filters
{
    public static readonly FilterDescriptor[] Descriptors =
    {
${filterTableCSharp()}
    };

    public static FilterDescriptor DescriptorFor(string id)
    {
        foreach (var d in Descriptors) if (d.Id == id) return d;
        throw new ArgumentException("Unknown filter: " + id);
    }

    /// <summary>Validate caller parameters against a filter's schema and fill in defaults (TS resolveFilterParams).</summary>
    public static Dictionary<string, double> ResolveParams(FilterDescriptor descriptor, IReadOnlyDictionary<string, double>? supplied)
    {
        var result = new Dictionary<string, double>();
        foreach (var p in descriptor.Params) result[p.Name] = p.DefaultValue;
        if (supplied != null)
        {
            foreach (var kv in supplied)
            {
                FilterParamSpec? spec = null;
                foreach (var p in descriptor.Params) if (p.Name == kv.Key) spec = p;
                if (spec == null) throw new ArgumentException("Unknown parameter '" + kv.Key + "' for filter '" + descriptor.Id + "' (expected one of " + string.Join(", ", Array.ConvertAll(descriptor.Params, p => p.Name)) + ")");
                if (!double.IsFinite(kv.Value) || kv.Value < spec.Min || kv.Value > spec.Max)
                    throw new ArgumentException("Parameter '" + kv.Key + "' out of range for filter '" + descriptor.Id + "': " + kv.Value + " (expected " + spec.Min + ".." + spec.Max + ")");
                result[kv.Key] = kv.Value;
            }
        }
        return result;
    }

    /// <summary>
    /// Apply a filter to an image. With a selection rectangle, the
    /// filtered image is blended with the original per pixel by the
    /// rect scope weight (1 inside, 0 outside) — the TS applyFilter
    /// scoping rule for rect selections.
    /// </summary>
    public static PixelImage Apply(PixelImage img, string id, IReadOnlyDictionary<string, double>? supplied, Rectangle? selection)
    {
        var descriptor = DescriptorFor(id);
        var p = ResolveParams(descriptor, supplied);
        var filtered = ApplyCore(img, id, p);
        if (selection == null) return filtered;
        var rect = selection.Value;
        var outImg = img.Clone();
        int x0 = Math.Max(0, rect.X), y0 = Math.Max(0, rect.Y);
        int x1 = Math.Min(img.Width, rect.X + rect.Width), y1 = Math.Min(img.Height, rect.Y + rect.Height);
        for (int y = y0; y < y1; y++)
        {
            for (int x = x0; x < x1; x++)
            {
                int i = (y * img.Width + x) * 4;
                outImg.Data[i] = filtered.Data[i];
                outImg.Data[i + 1] = filtered.Data[i + 1];
                outImg.Data[i + 2] = filtered.Data[i + 2];
                outImg.Data[i + 3] = filtered.Data[i + 3];
            }
        }
        return outImg;
    }

    private static PixelImage ApplyCore(PixelImage img, string id, Dictionary<string, double> p) => id switch
    {
        "box-blur" => BoxBlur(img, p),
        "gaussian-blur" => GaussianBlur(img, p),
        "sharpen" => Sharpen(img, p),
        "noise" => Noise(img, p),
        "edge-detect" => EdgeDetect(img, p),
        "emboss" => Emboss(img, p),
        "wave" => Wave(img, p),
        "swirl" => Swirl(img, p),
        "brightness-contrast" => BrightnessContrast(img, p),
        "saturation" => Saturation(img, p["amount"]),
        "hue-rotate" => HueRotate(img, p),
        "invert" => MapPixels(img, (r, g, b, a) => (255 - r, 255 - g, 255 - b, a)),
        "grayscale" => Saturation(img, -1),
        "sepia" => Sepia(img, p),
        "posterize" => Posterize(img, p),
        "threshold" => Threshold(img, p),
        _ => throw new ArgumentException("Unknown filter: " + id)
    };

    private static PixelImage MapPixels(PixelImage img, Func<int, int, int, int, (int, int, int, int)> fn)
    {
        var outImg = new PixelImage(img.Width, img.Height);
        for (int i = 0; i < img.Data.Length; i += 4)
        {
            var c = fn(img.Data[i], img.Data[i + 1], img.Data[i + 2], img.Data[i + 3]);
            outImg.Data[i] = (byte)c.Item1;
            outImg.Data[i + 1] = (byte)c.Item2;
            outImg.Data[i + 2] = (byte)c.Item3;
            outImg.Data[i + 3] = (byte)c.Item4;
        }
        return outImg;
    }

    /// <summary>Separable convolution of all four channels with a symmetric kernel (edge pixels replicate; float intermediate, rounded once).</summary>
    private static PixelImage SeparableConvolve(PixelImage img, double[] kernel)
    {
        int r = (kernel.Length - 1) / 2;
        int w = img.Width, h = img.Height;
        var tmp = new float[w * h * 4];
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                for (int c = 0; c < 4; c++)
                {
                    double sum = 0;
                    for (int k = 0; k < kernel.Length; k++)
                        sum += kernel[k] * img.Data[(y * w + Px.ClampIndex(x + k - r, w)) * 4 + c];
                    tmp[(y * w + x) * 4 + c] = (float)sum;
                }
            }
        }
        var outImg = new PixelImage(w, h);
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                for (int c = 0; c < 4; c++)
                {
                    double sum = 0;
                    for (int k = 0; k < kernel.Length; k++)
                        sum += kernel[k] * tmp[(Px.ClampIndex(y + k - r, h) * w + x) * 4 + c];
                    outImg.Data[(y * w + x) * 4 + c] = (byte)Px.Clamp255(sum);
                }
            }
        }
        return outImg;
    }

    /// <summary>3x3 convolution of the RGB channels (edge pixels replicate); alpha is copied unchanged.</summary>
    private static PixelImage Convolve3x3Rgb(PixelImage img, double[] kernel)
    {
        int w = img.Width, h = img.Height;
        var outImg = new PixelImage(w, h);
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int o = (y * w + x) * 4;
                for (int c = 0; c < 3; c++)
                {
                    double sum = 0;
                    for (int ky = 0; ky < 3; ky++)
                        for (int kx = 0; kx < 3; kx++)
                            sum += kernel[ky * 3 + kx] * img.Data[(Px.ClampIndex(y + ky - 1, h) * w + Px.ClampIndex(x + kx - 1, w)) * 4 + c];
                    outImg.Data[o + c] = (byte)Px.Clamp255(sum);
                }
                outImg.Data[o + 3] = img.Data[o + 3];
            }
        }
        return outImg;
    }

    private static PixelImage BoxBlur(PixelImage img, Dictionary<string, double> p)
    {
        int radius = Px.Round(p["radius"]);
        if (radius <= 0) return img.Clone();
        var kernel = new double[2 * radius + 1];
        Array.Fill(kernel, 1.0 / (2 * radius + 1));
        return SeparableConvolve(img, kernel);
    }

    private static double[] GaussianKernel(double sigma, double radiusParam)
    {
        int radius = radiusParam > 0 ? Px.Round(radiusParam) : Math.Max(1, (int)Math.Ceiling(3 * sigma));
        var kernel = new double[2 * radius + 1];
        double sum = 0;
        for (int i = -radius; i <= radius; i++)
        {
            double wgt = Math.Exp(-(i * i) / (2 * sigma * sigma));
            kernel[i + radius] = wgt;
            sum += wgt;
        }
        for (int i = 0; i < kernel.Length; i++) kernel[i] /= sum;
        return kernel;
    }

    private static PixelImage GaussianBlur(PixelImage img, Dictionary<string, double> p)
    {
        double sigma = p["sigma"];
        if (sigma <= 0) return img.Clone();
        return SeparableConvolve(img, GaussianKernel(sigma, p["radius"]));
    }

    private static PixelImage Sharpen(PixelImage img, Dictionary<string, double> p)
    {
        double a = p["amount"];
        if (a == 0) return img.Clone();
        return Convolve3x3Rgb(img, new[] { 0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0 });
    }

    /// <summary>mulberry32: the same deterministic PRNG the TS noise filter uses; the seed drives it identically.</summary>
    private sealed class Mulberry32
    {
        private uint _a;
        public Mulberry32(uint seed) { _a = seed; }
        public double Next()
        {
            unchecked
            {
                _a += 0x6D2B79F5u;
                uint t = _a;
                t = (t ^ (t >> 15)) * (t | 1u);
                t ^= t + (t ^ (t >> 7)) * (t | 61u);
                return (t ^ (t >> 14)) / 4294967296.0;
            }
        }
    }

    private static PixelImage Noise(PixelImage img, Dictionary<string, double> p)
    {
        double amount = p["amount"];
        if (amount == 0) return img.Clone();
        var rand = new Mulberry32(unchecked((uint)(long)Math.Floor(p["seed"])));
        return MapPixels(img, (r, g, b, a) => (
            Px.Clamp255(r + Px.Round((rand.Next() * 2 - 1) * amount)),
            Px.Clamp255(g + Px.Round((rand.Next() * 2 - 1) * amount)),
            Px.Clamp255(b + Px.Round((rand.Next() * 2 - 1) * amount)),
            a));
    }

    private static float[] LuminanceMap(PixelImage img)
    {
        var lum = new float[img.Width * img.Height];
        for (int i = 0; i < lum.Length; i++)
            lum[i] = (float)Px.Luminance(img.Data[i * 4], img.Data[i * 4 + 1], img.Data[i * 4 + 2]);
        return lum;
    }

    private static PixelImage EdgeDetect(PixelImage img, Dictionary<string, double> p)
    {
        int w = img.Width, h = img.Height;
        var lum = LuminanceMap(img);
        double At(int x, int y) => lum[Px.ClampIndex(y, h) * w + Px.ClampIndex(x, w)];
        var outImg = new PixelImage(w, h);
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                double gx = At(x + 1, y - 1) + 2 * At(x + 1, y) + At(x + 1, y + 1) - (At(x - 1, y - 1) + 2 * At(x - 1, y) + At(x - 1, y + 1));
                double gy = At(x - 1, y + 1) + 2 * At(x, y + 1) + At(x + 1, y + 1) - (At(x - 1, y - 1) + 2 * At(x, y - 1) + At(x + 1, y - 1));
                double mag = Math.Sqrt(gx * gx + gy * gy) * p["strength"];
                if (mag < p["threshold"]) mag = 0;
                int o = (y * w + x) * 4;
                var v = (byte)Px.Clamp255(mag);
                outImg.Data[o] = v;
                outImg.Data[o + 1] = v;
                outImg.Data[o + 2] = v;
                outImg.Data[o + 3] = img.Data[o + 3];
            }
        }
        return outImg;
    }

    private static PixelImage Emboss(PixelImage img, Dictionary<string, double> p)
    {
        int w = img.Width, h = img.Height;
        var lum = LuminanceMap(img);
        double At(int x, int y) => lum[Px.ClampIndex(y, h) * w + Px.ClampIndex(x, w)];
        double rad = p["angle"] * Math.PI / 180;
        double cos = Math.Cos(rad), sin = Math.Sin(rad);
        var outImg = new PixelImage(w, h);
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                double gx = At(x + 1, y) - At(x - 1, y);
                double gy = At(x, y + 1) - At(x, y - 1);
                var v = (byte)Px.Clamp255(128 + (gx * cos + gy * sin) * p["strength"]);
                int o = (y * w + x) * 4;
                outImg.Data[o] = v;
                outImg.Data[o + 1] = v;
                outImg.Data[o + 2] = v;
                outImg.Data[o + 3] = img.Data[o + 3];
            }
        }
        return outImg;
    }

    /// <summary>Bilinear sample of an RGBA image at a fractional point; outside the image counts as transparent black.</summary>
    internal static double[] SampleBilinearZero(PixelImage img, double sx, double sy)
    {
        int x0 = (int)Math.Floor(sx), y0 = (int)Math.Floor(sy);
        double fx = sx - x0, fy = sy - y0;
        var acc = new double[4];
        var corners = new[] { (x0, y0, (1 - fx) * (1 - fy)), (x0 + 1, y0, fx * (1 - fy)), (x0, y0 + 1, (1 - fx) * fy), (x0 + 1, y0 + 1, fx * fy) };
        foreach (var (cx, cy, wgt) in corners)
        {
            if (wgt == 0 || cx < 0 || cy < 0 || cx >= img.Width || cy >= img.Height) continue;
            int i = (cy * img.Width + cx) * 4;
            acc[0] += img.Data[i] * wgt;
            acc[1] += img.Data[i + 1] * wgt;
            acc[2] += img.Data[i + 2] * wgt;
            acc[3] += img.Data[i + 3] * wgt;
        }
        return acc;
    }

    private static PixelImage Wave(PixelImage img, Dictionary<string, double> p)
    {
        double phaseRad = p["phase"] * Math.PI / 180;
        var outImg = new PixelImage(img.Width, img.Height);
        for (int y = 0; y < img.Height; y++)
        {
            for (int x = 0; x < img.Width; x++)
            {
                double sy = y + p["amplitude"] * Math.Sin(2 * Math.PI * x / p["wavelength"] + phaseRad);
                var s = SampleBilinearZero(img, x, sy);
                int o = (y * img.Width + x) * 4;
                outImg.Data[o] = (byte)Px.Clamp255(s[0]);
                outImg.Data[o + 1] = (byte)Px.Clamp255(s[1]);
                outImg.Data[o + 2] = (byte)Px.Clamp255(s[2]);
                outImg.Data[o + 3] = (byte)Px.Clamp255(s[3]);
            }
        }
        return outImg;
    }

    /// <summary>Snap cos/sin to exact 0/+1/-1 near multiples of 90 degrees (the TS snapTrig).</summary>
    internal static double SnapTrig(double v)
    {
        if (Math.Abs(v) < 1e-12) return 0;
        if (Math.Abs(v - 1) < 1e-12) return 1;
        if (Math.Abs(v + 1) < 1e-12) return -1;
        return v;
    }

    private static PixelImage Swirl(PixelImage img, Dictionary<string, double> p)
    {
        int w = img.Width, h = img.Height;
        double cx = (w - 1) / 2.0, cy = (h - 1) / 2.0;
        double radius = p["radius"] > 0 ? p["radius"] : Math.Min(w, h) / 2.0;
        if (radius <= 0 || p["angle"] == 0) return img.Clone();
        var outImg = new PixelImage(w, h);
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                double dx = x - cx, dy = y - cy;
                double r = Math.Sqrt(dx * dx + dy * dy);
                double sx = x, sy = y;
                if (r < radius && r > 0)
                {
                    double factor = (1 - r / radius) * (1 - r / radius);
                    double rot = p["angle"] * factor * Math.PI / 180;
                    double cos = SnapTrig(Math.Cos(rot)), sin = SnapTrig(Math.Sin(rot));
                    sx = cx + cos * dx + sin * dy;
                    sy = cy - sin * dx + cos * dy;
                }
                var s = SampleBilinearZero(img, sx, sy);
                int o = (y * w + x) * 4;
                outImg.Data[o] = (byte)Px.Clamp255(s[0]);
                outImg.Data[o + 1] = (byte)Px.Clamp255(s[1]);
                outImg.Data[o + 2] = (byte)Px.Clamp255(s[2]);
                outImg.Data[o + 3] = (byte)Px.Clamp255(s[3]);
            }
        }
        return outImg;
    }

    private static PixelImage BrightnessContrast(PixelImage img, Dictionary<string, double> p)
    {
        double brightness = p["brightness"], contrast = p["contrast"];
        double factor = 259 * (contrast + 255) / (255 * (259 - contrast));
        return MapPixels(img, (r, g, b, a) => (
            Px.Clamp255(factor * (r - 128) + 128 + brightness),
            Px.Clamp255(factor * (g - 128) + 128 + brightness),
            Px.Clamp255(factor * (b - 128) + 128 + brightness),
            a));
    }

    private static PixelImage Saturation(PixelImage img, double amount)
    {
        double f = 1 + amount;
        return MapPixels(img, (r, g, b, a) =>
        {
            double gray = Px.Luminance(r, g, b);
            return (Px.Clamp255(gray + (r - gray) * f), Px.Clamp255(gray + (g - gray) * f), Px.Clamp255(gray + (b - gray) * f), a);
        });
    }

    private static (double, double, double) RgbToHsl(int r0, int g0, int b0)
    {
        double r = r0 / 255.0, g = g0 / 255.0, b = b0 / 255.0;
        double max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b));
        double l = (max + min) / 2;
        if (max == min) return (0, 0, l);
        double d = max - min;
        double s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        double h;
        if (max == r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max == g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        return (h * 60, s, l);
    }

    private static (double, double, double) HslToRgb(double h, double s, double l)
    {
        h = ((h % 360) + 360) % 360;
        double c = (1 - Math.Abs(2 * l - 1)) * s;
        double x = c * (1 - Math.Abs((h / 60) % 2 - 1));
        double m = l - c / 2;
        (double, double, double) rgb;
        if (h < 60) rgb = (c, x, 0);
        else if (h < 120) rgb = (x, c, 0);
        else if (h < 180) rgb = (0, c, x);
        else if (h < 240) rgb = (0, x, c);
        else if (h < 300) rgb = (x, 0, c);
        else rgb = (c, 0, x);
        return ((rgb.Item1 + m) * 255, (rgb.Item2 + m) * 255, (rgb.Item3 + m) * 255);
    }

    private static PixelImage HueRotate(PixelImage img, Dictionary<string, double> p)
    {
        if (p["degrees"] == 0) return img.Clone();
        return MapPixels(img, (r, g, b, a) =>
        {
            var (h, s, l) = RgbToHsl(r, g, b);
            var (rr, gg, bb) = HslToRgb(h + p["degrees"], s, l);
            return (Px.Clamp255(rr), Px.Clamp255(gg), Px.Clamp255(bb), a);
        });
    }

    private static PixelImage Sepia(PixelImage img, Dictionary<string, double> p)
    {
        double a = p["amount"];
        if (a == 0) return img.Clone();
        return MapPixels(img, (r, g, b, alpha) =>
        {
            double sr = 0.393 * r + 0.769 * g + 0.189 * b;
            double sg = 0.349 * r + 0.686 * g + 0.168 * b;
            double sb = 0.272 * r + 0.534 * g + 0.131 * b;
            return (Px.Clamp255(r * (1 - a) + sr * a), Px.Clamp255(g * (1 - a) + sg * a), Px.Clamp255(b * (1 - a) + sb * a), alpha);
        });
    }

    private static PixelImage Posterize(PixelImage img, Dictionary<string, double> p)
    {
        int levels = Px.Round(p["levels"]);
        int Quantize(int v) => Px.Round(Px.Round((v / 255.0) * (levels - 1)) * 255.0 / (levels - 1));
        return MapPixels(img, (r, g, b, a) => (Quantize(r), Quantize(g), Quantize(b), a));
    }

    private static PixelImage Threshold(PixelImage img, Dictionary<string, double> p)
    {
        return MapPixels(img, (r, g, b, a) =>
        {
            int v = Px.Luminance(r, g, b) >= p["level"] ? 255 : 0;
            return (v, v, v, a);
        });
    }
}
`;
}

/** Part 3 of PixelEngine.cs: brush engine, immediate tools, content renderers, effect stack, compositor. */
function pixelEnginePart3(asm: string): string {
  const d = DEFAULT_BRUSH_SETTINGS;
  return `
/// <summary>
/// Phase 46: the advanced brush model. Painting accumulates a
/// coverage map over the stroke: each stamp deposits shape x flow x
/// pressure coverage with the build-up rule cov += deposit x (1 -
/// cov), and the finished stroke is applied once at Opacity — opacity
/// is the stroke-level cap, flow the per-stamp rate. Pressure is
/// input data: a point without a pressure reading counts as full
/// pressure (the desktop mouse reports none, so strokes here run at
/// full pressure unless a caller supplies readings). Custom raster
/// tips are not carried into the generated app in this phase; the
/// round tip below is the TS engine's profile exactly.
/// </summary>
public sealed class BrushSettings
{
    /// <summary>Stamp diameter in pixels (&gt; 0).</summary>
    public double Size { get; set; } = ${csNum(d.size)};
    /// <summary>0..1, round-tip edge profile.</summary>
    public double Hardness { get; set; } = ${csNum(d.hardness)};
    /// <summary>Stamp interval as a fraction of Size (&gt;= 0).</summary>
    public double Spacing { get; set; } = ${csNum(d.spacing)};
    /// <summary>0..1, stroke-level alpha cap.</summary>
    public double Opacity { get; set; } = ${csNum(d.opacity)};
    /// <summary>0..1, per-stamp build-up rate.</summary>
    public double Flow { get; set; } = ${csNum(d.flow)};
    /// <summary>0..1, stroke stabilization strength.</summary>
    public double Smoothing { get; set; } = ${csNum(d.smoothing)};
    /// <summary>When true, per-point pressure scales the stamp diameter.</summary>
    public bool PressureSize { get; set; } = ${csBool(d.pressureSize)};
    /// <summary>When true, per-point pressure scales the stamp strength.</summary>
    public bool PressureOpacity { get; set; } = ${csBool(d.pressureOpacity)};

    public BrushSettings Clone() => (BrushSettings)MemberwiseClone();
}

/// <summary>One point of a brush stroke; Pressure is null when the device reported none (counts as full pressure).</summary>
public readonly struct StrokePoint
{
    public double X { get; }
    public double Y { get; }
    public double? Pressure { get; }
    public StrokePoint(double x, double y, double? pressure = null) { X = x; Y = y; Pressure = pressure; }
}

public static class BrushEngine
{
    /// <summary>The TS engine's built-in presets, generated from its table (scalar settings; the Speckle Tip preset's raster tip is not carried).</summary>
    public static readonly (string Name, BrushSettings Settings)[] Presets =
    {
${brushPresetsCSharp()}
    };

    /// <summary>The round tip's edge profile: 1 inside the hardness radius, linear falloff to 0 at the rim, hard disc at hardness 1.</summary>
    public static double RoundProfile(double nd, double hardness)
    {
        if (nd > 1) return 0;
        if (hardness >= 1) return 1;
        if (nd <= hardness) return 1;
        return (1 - nd) / (1 - hardness);
    }

    private static double PointPressure(StrokePoint p) =>
        p.Pressure is double v && double.IsFinite(v) ? Math.Min(1, Math.Max(0, v)) : 1;

    /// <summary>Stroke stabilization: an exponential moving average over the input points, anchored at the first point.</summary>
    public static List<StrokePoint> SmoothStrokePoints(IReadOnlyList<StrokePoint> points, double amount)
    {
        var outPts = new List<StrokePoint>();
        if (points.Count == 0 || amount == 0)
        {
            foreach (var p in points) outPts.Add(p);
            return outPts;
        }
        double k = 1 - amount * 0.9;
        double px = points[0].X, py = points[0].Y, pp = PointPressure(points[0]);
        outPts.Add(new StrokePoint(px, py, pp));
        for (int i = 1; i < points.Count; i++)
        {
            px += (points[i].X - px) * k;
            py += (points[i].Y - py) * k;
            pp += (PointPressure(points[i]) - pp) * k;
            outPts.Add(new StrokePoint(px, py, pp));
        }
        return outPts;
    }

    /// <summary>
    /// Accumulate a stroke's coverage map (values 0..1, before the
    /// opacity cap). Stamps are placed every Spacing x Size pixels
    /// along the path with the leftover distance carried across
    /// segments, and pressure is interpolated between path points.
    /// </summary>
    public static float[] StrokeCoverage(int width, int height, IReadOnlyList<StrokePoint> points, BrushSettings settings)
    {
        var cov = new float[width * height];
        if (points.Count == 0) return cov;
        IReadOnlyList<StrokePoint> path = settings.Smoothing > 0 ? SmoothStrokePoints(points, settings.Smoothing) : points;
        double step = Math.Max(settings.Spacing * settings.Size, 0.5);

        void StampAt(double cx, double cy, double pressure)
        {
            double diameter = settings.Size * (settings.PressureSize ? pressure : 1);
            double r = diameter / 2;
            if (r < 0.25) return; // pressure (or size) too small to leave a mark
            double strength = settings.Flow * (settings.PressureOpacity ? pressure : 1);
            if (strength <= 0) return;
            int x0 = (int)Math.Floor(cx - r), x1 = (int)Math.Ceiling(cx + r);
            int y0 = (int)Math.Floor(cy - r), y1 = (int)Math.Ceiling(cy + r);
            for (int y = y0; y <= y1; y++)
            {
                if (y < 0 || y >= height) continue;
                for (int x = x0; x <= x1; x++)
                {
                    if (x < 0 || x >= width) continue;
                    double shape = RoundProfile(Math.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / r, settings.Hardness);
                    if (shape <= 0) continue;
                    int idx = y * width + x;
                    double deposit = shape * strength;
                    cov[idx] = (float)(cov[idx] + deposit * (1 - cov[idx]));
                }
            }
        }

        var prev = path[0];
        double prevPressure = PointPressure(prev);
        StampAt(prev.X, prev.Y, prevPressure);
        double carry = 0; // distance traveled since the last stamp
        for (int s = 1; s < path.Count; s++)
        {
            var cur = path[s];
            double curPressure = PointPressure(cur);
            double segLen = Math.Sqrt((cur.X - prev.X) * (cur.X - prev.X) + (cur.Y - prev.Y) * (cur.Y - prev.Y));
            if (segLen > 0)
            {
                double dist = step - carry;
                while (dist <= segLen)
                {
                    double t = dist / segLen;
                    StampAt(prev.X + (cur.X - prev.X) * t, prev.Y + (cur.Y - prev.Y) * t, prevPressure + (curPressure - prevPressure) * t);
                    dist += step;
                }
                carry = segLen - dist + step;
            }
            prev = cur;
            prevPressure = curPressure;
        }
        return cov;
    }

    private static bool InSelection(int x, int y, Rectangle? selection) =>
        selection == null || (x >= selection.Value.X && y >= selection.Value.Y && x < selection.Value.X + selection.Value.Width && y < selection.Value.Y + selection.Value.Height);

    /// <summary>Paint an advanced-brush stroke through the shared paint path (Phase 44 alpha lock honored).</summary>
    public static void PaintStroke(PixelImage img, IReadOnlyList<StrokePoint> points, BrushSettings settings, Color color, bool alphaLock, Rectangle? selection)
    {
        var cov = StrokeCoverage(img.Width, img.Height, points, settings);
        for (int y = 0; y < img.Height; y++)
        {
            for (int x = 0; x < img.Width; x++)
            {
                int idx = y * img.Width + x;
                if (cov[idx] <= 0 || !InSelection(x, y, selection)) continue;
                double a = cov[idx] * settings.Opacity;
                if (a <= 0) continue;
                BlendModes.BlendPaint(img.Data, idx * 4, color.R, color.G, color.B, a, alphaLock);
            }
        }
    }

    /// <summary>
    /// Erase with the advanced brush: alpha is scaled by
    /// (1 - Opacity x coverage) along the stroke — a true alpha
    /// erase, never a paint-over. An alpha-locked layer is untouched.
    /// </summary>
    public static void EraseStroke(PixelImage img, IReadOnlyList<StrokePoint> points, BrushSettings settings, bool alphaLock, Rectangle? selection)
    {
        if (alphaLock) return;
        var cov = StrokeCoverage(img.Width, img.Height, points, settings);
        for (int y = 0; y < img.Height; y++)
        {
            for (int x = 0; x < img.Width; x++)
            {
                int idx = y * img.Width + x;
                if (cov[idx] <= 0 || !InSelection(x, y, selection)) continue;
                double a = cov[idx] * settings.Opacity;
                if (a <= 0) continue;
                int p = idx * 4;
                img.Data[p + 3] = (byte)Px.Round(img.Data[p + 3] * (1 - a));
                if (img.Data[p + 3] == 0) img.Data[p] = img.Data[p + 1] = img.Data[p + 2] = 0;
            }
        }
    }

    /// <summary>Paint a grayscale value into a layer mask along a polyline (Phase 44 paintMask; strength 1 sets the value outright inside the disc).</summary>
    public static void PaintMaskStroke(byte[] mask, int width, int height, IReadOnlyList<StrokePoint> points, double radius, int gray, Rectangle? selection)
    {
        if (points.Count == 0) return;
        PaintMaskDot(mask, width, height, points[0].X, points[0].Y, radius, gray, selection);
        for (int s = 1; s < points.Count; s++)
        {
            var prev = points[s - 1];
            var cur = points[s];
            double dist = Math.Sqrt((cur.X - prev.X) * (cur.X - prev.X) + (cur.Y - prev.Y) * (cur.Y - prev.Y));
            int steps = Math.Max(1, (int)Math.Ceiling(dist / Math.Max(1, radius / 2)));
            for (int k = 1; k <= steps; k++)
                PaintMaskDot(mask, width, height, prev.X + (cur.X - prev.X) * k / steps, prev.Y + (cur.Y - prev.Y) * k / steps, radius, gray, selection);
        }
    }

    private static void PaintMaskDot(byte[] mask, int width, int height, double cx, double cy, double radius, int gray, Rectangle? selection)
    {
        double r = Math.Max(0.5, radius);
        int x0 = (int)Math.Floor(cx - r), x1 = (int)Math.Ceiling(cx + r);
        int y0 = (int)Math.Floor(cy - r), y1 = (int)Math.Ceiling(cy + r);
        for (int y = y0; y <= y1; y++)
        {
            for (int x = x0; x <= x1; x++)
            {
                if (x < 0 || y < 0 || x >= width || y >= height) continue;
                if (!InSelection(x, y, selection)) continue;
                if (Math.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) > r) continue;
                mask[y * width + x] = (byte)gray;
            }
        }
    }

    /// <summary>Paint one disc of color (the dot behind line and shape strokes).</summary>
    public static void PaintDot(PixelImage img, double cx, double cy, double radius, Color color, Rectangle? selection, bool alphaLock)
    {
        double r = Math.Max(0.5, radius);
        int x0 = (int)Math.Floor(cx - r), x1 = (int)Math.Ceiling(cx + r);
        int y0 = (int)Math.Floor(cy - r), y1 = (int)Math.Ceiling(cy + r);
        for (int y = y0; y <= y1; y++)
        {
            for (int x = x0; x <= x1; x++)
            {
                if (x < 0 || y < 0 || x >= img.Width || y >= img.Height) continue;
                if (!InSelection(x, y, selection)) continue;
                if (Math.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) > r) continue;
                BlendModes.BlendPaint(img.Data, (y * img.Width + x) * 4, color.R, color.G, color.B, color.A / 255.0, alphaLock);
            }
        }
    }

    /// <summary>Stroke a polyline with interpolated discs, so fast strokes stay continuous (the TS paintStroke).</summary>
    public static void PaintStrokeDots(PixelImage img, IReadOnlyList<DPoint> points, double radius, Color color, Rectangle? selection, bool alphaLock)
    {
        if (points.Count == 0) return;
        PaintDot(img, points[0].X, points[0].Y, radius, color, selection, alphaLock);
        for (int s = 1; s < points.Count; s++)
        {
            var prev = points[s - 1];
            var cur = points[s];
            double dist = Math.Sqrt((cur.X - prev.X) * (cur.X - prev.X) + (cur.Y - prev.Y) * (cur.Y - prev.Y));
            int steps = Math.Max(1, (int)Math.Ceiling(dist / Math.Max(1, radius / 2)));
            for (int k = 1; k <= steps; k++)
                PaintDot(img, prev.X + (cur.X - prev.X) * k / steps, prev.Y + (cur.Y - prev.Y) * k / steps, radius, color, selection, alphaLock);
        }
    }
}

/// <summary>
/// The immediate canvas tools, ported from the TS engine's Phase 19
/// tool functions (fillRect, drawEllipse, drawLine, drawText) so the
/// canvas paints through the same engine as everything else.
/// </summary>
public static class Tools
{
    private static bool InSelection(int x, int y, Rectangle? selection) =>
        selection == null || (x >= selection.Value.X && y >= selection.Value.Y && x < selection.Value.X + selection.Value.Width && y < selection.Value.Y + selection.Value.Height);

    public static void FillRect(PixelImage img, Rectangle rect, Color color, Rectangle? selection, bool alphaLock)
    {
        for (int y = rect.Y; y < rect.Y + rect.Height; y++)
        {
            for (int x = rect.X; x < rect.X + rect.Width; x++)
            {
                if (x < 0 || y < 0 || x >= img.Width || y >= img.Height) continue;
                if (!InSelection(x, y, selection)) continue;
                BlendModes.BlendPaint(img.Data, (y * img.Width + x) * 4, color.R, color.G, color.B, color.A / 255.0, alphaLock);
            }
        }
    }

    public static void DrawEllipse(PixelImage img, Rectangle rect, Color color, Rectangle? selection, bool alphaLock)
    {
        double cx = rect.X + rect.Width / 2.0, cy = rect.Y + rect.Height / 2.0;
        double rx = rect.Width / 2.0, ry = rect.Height / 2.0;
        if (rx <= 0 || ry <= 0) return;
        for (int y = (int)Math.Floor((double)rect.Y); y < rect.Y + rect.Height; y++)
        {
            for (int x = (int)Math.Floor((double)rect.X); x < rect.X + rect.Width; x++)
            {
                double nx = (x - cx) / rx, ny = (y - cy) / ry;
                if (nx * nx + ny * ny > 1) continue;
                if (x < 0 || y < 0 || x >= img.Width || y >= img.Height) continue;
                if (!InSelection(x, y, selection)) continue;
                BlendModes.BlendPaint(img.Data, (y * img.Width + x) * 4, color.R, color.G, color.B, color.A / 255.0, alphaLock);
            }
        }
    }

    public static void DrawLine(PixelImage img, DPoint from, DPoint to, double width, Color color, Rectangle? selection, bool alphaLock)
    {
        BrushEngine.PaintStrokeDots(img, new[] { from, to }, width / 2, color, selection, alphaLock);
    }

    /// <summary>Rasterize text with the built-in 5x7 bitmap font (the TS drawText tool).</summary>
    public static void DrawText(PixelImage img, DPoint origin, string text, double scale, Color color, Rectangle? selection, bool alphaLock)
    {
        int sc = Math.Max(1, (int)Math.Floor(scale));
        double cursorX = origin.X;
        foreach (char rawCh in text)
        {
            var rows = ContentRender.GlyphRows("pixel", rawCh);
            for (int row = 0; row < 7; row++)
            {
                int bits = rows[row];
                for (int col = 0; col < 5; col++)
                {
                    if ((bits & (0x10 >> col)) == 0) continue;
                    for (int dy = 0; dy < sc; dy++)
                    {
                        for (int dx = 0; dx < sc; dx++)
                        {
                            int x = (int)(cursorX + col * sc + dx), y = (int)(origin.Y + row * sc + dy);
                            if (x < 0 || y < 0 || x >= img.Width || y >= img.Height) continue;
                            if (!InSelection(x, y, selection)) continue;
                            BlendModes.BlendPaint(img.Data, (y * img.Width + x) * 4, color.R, color.G, color.B, color.A / 255.0, alphaLock);
                        }
                    }
                }
            }
            cursorX += 6 * sc;
        }
    }
}

/// <summary>
/// Phase 48 content renderers: text layers and vector shape layers
/// are rendered from their editable data into a pixel cache. The
/// glyph tables are generated from the TS engine's bitmapFont tables
/// at generation time — the same 5x7 glyphs, both built-in fonts.
/// </summary>
public static class ContentRender
{
    private static readonly Dictionary<int, int[]> PixelGlyphs = new()
    {
${glyphTableCSharp('pixel')}
    };

    private static readonly Dictionary<int, int[]> PixelBoldGlyphs = new()
    {
${glyphTableCSharp('pixel-bold')}
    };

    private static readonly int[] PixelFallback = { ${glyphFallbackCSharp('pixel')} };
    private static readonly int[] PixelBoldFallback = { ${glyphFallbackCSharp('pixel-bold')} };

    /// <summary>The 7 rows (5 bits each, MSB = leftmost column) of one character in a built-in font; lookup folds to uppercase, unknown characters give the hollow-box fallback.</summary>
    public static int[] GlyphRows(string font, char ch)
    {
        var table = font == "pixel-bold" ? PixelBoldGlyphs : PixelGlyphs;
        var fallback = font == "pixel-bold" ? PixelBoldFallback : PixelFallback;
        return table.TryGetValue(char.ToUpperInvariant(ch), out var rows) ? rows : fallback;
    }

    /// <summary>The integer bitmap scale for a nominal font size: max(1, round(fontSize / 7)).</summary>
    public static int TextScaleFor(double fontSize) => Math.Max(1, Px.Round(fontSize / 7));

    private static double TextLineWidth(string line, int scale, double letterSpacing)
    {
        int n = line.Length;
        return n == 0 ? 0 : n * 6 * scale - scale + (n - 1) * letterSpacing;
    }

    /// <summary>Source-over a color through a 0..1 coverage map.</summary>
    private static void PaintCoverage(PixelImage img, float[] cov, Color color)
    {
        double a0 = color.A / 255.0;
        if (a0 <= 0) return;
        for (int px = 0, p = 0; px < cov.Length; px++, p += 4)
        {
            double a = cov[px] * a0;
            if (a > 0) BlendModes.BlendOver(img.Data, p, color.R, color.G, color.B, a);
        }
    }

    /// <summary>Separable box blur of a float channel, edge-replicating.</summary>
    private static float[] BoxBlurFloatChannel(float[] src, int width, int height, int radius)
    {
        var cur = (float[])src.Clone();
        int size = 2 * radius + 1;
        foreach (bool horizontal in new[] { true, false })
        {
            var next = new float[cur.Length];
            int lines = horizontal ? height : width;
            int len = horizontal ? width : height;
            for (int line = 0; line < lines; line++)
            {
                for (int pos = 0; pos < len; pos++)
                {
                    double sum = 0;
                    for (int dd = -radius; dd <= radius; dd++)
                    {
                        int q = Math.Min(len - 1, Math.Max(0, pos + dd));
                        sum += horizontal ? cur[line * width + q] : cur[q * width + line];
                    }
                    double v = sum / size;
                    if (horizontal) next[line * width + pos] = (float)v;
                    else next[pos * width + line] = (float)v;
                }
            }
            cur = next;
        }
        return cur;
    }

    /// <summary>Separable max filter (the dilation behind text outlines).</summary>
    private static byte[] ExpandGray(byte[] src, int width, int height, int n)
    {
        var cur = (byte[])src.Clone();
        foreach (bool horizontal in new[] { true, false })
        {
            var next = new byte[cur.Length];
            int lines = horizontal ? height : width;
            int len = horizontal ? width : height;
            for (int line = 0; line < lines; line++)
            {
                for (int pos = 0; pos < len; pos++)
                {
                    int best = 0;
                    for (int dd = -n; dd <= n; dd++)
                    {
                        int q = Math.Min(len - 1, Math.Max(0, pos + dd));
                        int v = horizontal ? cur[line * width + q] : cur[q * width + line];
                        if (v > best) best = v;
                    }
                    if (horizontal) next[line * width + pos] = (byte)best;
                    else next[pos * width + line] = (byte)best;
                }
            }
            cur = next;
        }
        return cur;
    }

    /// <summary>Rasterize text layer data into a fresh transparent-sized image region (shadow, then outline, then fill) — the TS renderTextInto.</summary>
    public static void RenderText(PixelImage img, TextData data)
    {
        int w = img.Width, h = img.Height;
        int scale = TextScaleFor(data.FontSize);
        var lines = data.Text.Split('\\n');
        double blockW = data.BlockWidth;
        if (blockW <= 0)
        {
            blockW = 0;
            foreach (var line in lines) blockW = Math.Max(blockW, TextLineWidth(line, scale, data.LetterSpacing));
        }
        var cov = new float[w * h];
        int originX = Px.Round(data.OriginX), originY = Px.Round(data.OriginY);
        for (int li = 0; li < lines.Length; li++)
        {
            string line = lines[li];
            double lw = TextLineWidth(line, scale, data.LetterSpacing);
            double xOff = data.Align == "center" ? Px.Round((blockW - lw) / 2) : data.Align == "right" ? blockW - lw : 0;
            double cursorX = originX + xOff;
            double lineY = originY + li * (7 * scale + data.LineSpacing);
            foreach (char ch in line)
            {
                var rows = GlyphRows(data.Font, ch);
                for (int row = 0; row < 7; row++)
                {
                    int bits = rows[row];
                    for (int col = 0; col < 5; col++)
                    {
                        if ((bits & (0x10 >> col)) == 0) continue;
                        for (int dy = 0; dy < scale; dy++)
                        {
                            for (int dx = 0; dx < scale; dx++)
                            {
                                int x = (int)(cursorX + col * scale + dx);
                                int y = (int)(lineY + row * scale + dy);
                                if (x >= 0 && y >= 0 && x < w && y < h) cov[y * w + x] = 1;
                            }
                        }
                    }
                }
                cursorX += 6 * scale + data.LetterSpacing;
            }
        }
        if (data.HasShadow)
        {
            var scov = new float[cov.Length];
            int ox = Px.Round(data.ShadowOffsetX), oy = Px.Round(data.ShadowOffsetY);
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    float v = cov[y * w + x];
                    if (v <= 0) continue;
                    int nx = x + ox, ny = y + oy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    if (v > scov[ny * w + nx]) scov[ny * w + nx] = v;
                }
            }
            int blurRadius = Px.Round(data.ShadowBlur);
            if (blurRadius > 0) scov = BoxBlurFloatChannel(scov, w, h, blurRadius);
            PaintCoverage(img, scov, data.ShadowColor);
        }
        if (data.OutlineWidth > 0)
        {
            var sel = new byte[cov.Length];
            for (int px = 0; px < cov.Length; px++) sel[px] = cov[px] > 0 ? (byte)255 : (byte)0;
            var expanded = ExpandGray(sel, w, h, data.OutlineWidth);
            var ocov = new float[cov.Length];
            for (int px = 0; px < cov.Length; px++) ocov[px] = Math.Max(0, (expanded[px] - sel[px]) / 255f);
            PaintCoverage(img, ocov, data.OutlineColor);
        }
        PaintCoverage(img, cov, data.Color);
    }

    private static bool PointInPolygon(double px, double py, IReadOnlyList<DPoint> points)
    {
        bool inside = false;
        for (int i = 0, j = points.Count - 1; i < points.Count; j = i++)
        {
            double xi = points[i].X, yi = points[i].Y;
            double xj = points[j].X, yj = points[j].Y;
            if ((yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    private static byte[]? FillMaskFor(ShapeData shape, int w, int h)
    {
        switch (shape.Kind)
        {
            case "rectangle":
            {
                var mask = new byte[w * h];
                int x0 = Math.Max(0, (int)shape.Rect.X), y0 = Math.Max(0, (int)shape.Rect.Y);
                int x1 = Math.Min(w, (int)(shape.Rect.X + shape.Rect.Width)), y1 = Math.Min(h, (int)(shape.Rect.Y + shape.Rect.Height));
                for (int y = y0; y < y1; y++)
                    for (int x = x0; x < x1; x++)
                        mask[y * w + x] = 255;
                return mask;
            }
            case "ellipse":
            {
                var mask = new byte[w * h];
                var rect = shape.Rect;
                if (rect.Width <= 0 || rect.Height <= 0) return mask;
                double cx = rect.X + rect.Width / 2, cy = rect.Y + rect.Height / 2;
                double rx = rect.Width / 2, ry = rect.Height / 2;
                for (int y = 0; y < h; y++)
                {
                    for (int x = 0; x < w; x++)
                    {
                        double nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
                        if (nx * nx + ny * ny <= 1) mask[y * w + x] = 255;
                    }
                }
                return mask;
            }
            case "polygon":
            {
                if (shape.Points.Count < 3) return null;
                var mask = new byte[w * h];
                for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++)
                        if (PointInPolygon(x + 0.5, y + 0.5, shape.Points)) mask[y * w + x] = 255;
                return mask;
            }
            case "path":
            {
                if (!shape.Closed || shape.Segments.Count == 0) return null;
                var pts = FlattenPath(shape.Segments);
                if (pts.Count < 3) return null;
                var mask = new byte[w * h];
                for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++)
                        if (PointInPolygon(x + 0.5, y + 0.5, pts)) mask[y * w + x] = 255;
                return mask;
            }
            default:
                return null;
        }
    }

    /// <summary>Evaluate a cubic Bezier segment at t in [0, 1] with the real cubic formula.</summary>
    public static DPoint CubicBezierPoint(BezierSegment seg, double t)
    {
        double u = 1 - t;
        double w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        return new DPoint(
            w0 * seg.P0.X + w1 * seg.C1.X + w2 * seg.C2.X + w3 * seg.P1.X,
            w0 * seg.P0.Y + w1 * seg.C1.Y + w2 * seg.C2.Y + w3 * seg.P1.Y);
    }

    /// <summary>Flatten one Bezier segment to a polyline of steps + 1 points (endpoints included).</summary>
    public static List<DPoint> FlattenBezierSegment(BezierSegment seg, int steps = 16)
    {
        var pts = new List<DPoint>();
        for (int k = 0; k <= steps; k++) pts.Add(CubicBezierPoint(seg, (double)k / steps));
        return pts;
    }

    /// <summary>Flatten a whole path (joint points between consecutive segments appear once).</summary>
    public static List<DPoint> FlattenPath(IReadOnlyList<BezierSegment> segments, int stepsPerSegment = 16)
    {
        var pts = new List<DPoint>();
        for (int i = 0; i < segments.Count; i++)
        {
            var flat = FlattenBezierSegment(segments[i], stepsPerSegment);
            for (int k = i == 0 ? 0 : 1; k < flat.Count; k++) pts.Add(flat[k]);
        }
        return pts;
    }

    /// <summary>Rasterize shape layer data into an image (fill through the selection rasterizers, stroke through the dot-stroke path) — the TS renderShapeInto.</summary>
    public static void RenderShape(PixelImage img, ShapeData shape)
    {
        int w = img.Width, h = img.Height;
        var fillMask = FillMaskFor(shape, w, h);
        if (shape.Fill is Color fill && fillMask != null)
        {
            double a = fill.A / 255.0;
            if (a > 0)
            {
                for (int px = 0, p = 0; px < fillMask.Length; px++, p += 4)
                    if (fillMask[px] > 0) BlendModes.BlendOver(img.Data, p, fill.R, fill.G, fill.B, a);
            }
        }
        if (shape.Stroke is Color stroke && shape.StrokeWidth > 0)
        {
            var polylines = new List<List<DPoint>>();
            switch (shape.Kind)
            {
                case "rectangle":
                {
                    var r = shape.Rect;
                    polylines.Add(new List<DPoint>
                    {
                        new(r.X, r.Y), new(r.X + r.Width - 1, r.Y), new(r.X + r.Width - 1, r.Y + r.Height - 1),
                        new(r.X, r.Y + r.Height - 1), new(r.X, r.Y)
                    });
                    break;
                }
                case "ellipse":
                {
                    var r = shape.Rect;
                    double cx = r.X + r.Width / 2 - 0.5, cy = r.Y + r.Height / 2 - 0.5;
                    int steps = Math.Max(24, (int)Math.Ceiling(Math.PI * Math.Max(r.Width, r.Height)));
                    var pts = new List<DPoint>();
                    for (int k = 0; k <= steps; k++)
                    {
                        double th = 2 * Math.PI * k / steps;
                        pts.Add(new DPoint(cx + r.Width / 2 * Math.Cos(th), cy + r.Height / 2 * Math.Sin(th)));
                    }
                    polylines.Add(pts);
                    break;
                }
                case "line":
                    polylines.Add(new List<DPoint> { shape.From, shape.To });
                    break;
                case "polygon":
                {
                    if (shape.Points.Count > 0)
                    {
                        var pts = new List<DPoint>(shape.Points) { shape.Points[0] };
                        polylines.Add(pts);
                    }
                    break;
                }
                case "path":
                {
                    foreach (var seg in shape.Segments) polylines.Add(FlattenBezierSegment(seg));
                    if (shape.Closed && shape.Segments.Count > 0)
                        polylines.Add(new List<DPoint> { shape.Segments[shape.Segments.Count - 1].P1, shape.Segments[0].P0 });
                    break;
                }
            }
            foreach (var pts in polylines)
                if (pts.Count >= 2) BrushEngine.PaintStrokeDots(img, pts, shape.StrokeWidth / 2, stroke, null, false);
        }
    }
}

/// <summary>
/// Phase 52: apply a stack's enabled effects, in stack order, to an
/// image. Pure: the input is never mutated, and with no enabled
/// effects the input itself is returned. Every effect goes through
/// the Phase 47 registry, so parameters are re-validated on render.
/// </summary>
public static class EffectStack
{
    public static PixelImage Apply(PixelImage img, IReadOnlyList<LayerEffect> effects)
    {
        var outImg = img;
        foreach (var effect in effects)
        {
            if (!effect.Enabled) continue;
            outImg = Filters.Apply(outImg, effect.FilterId, effect.Params, null);
        }
        return outImg;
    }
}

/// <summary>
/// The compositor: flatten visible layers (bottom to top) into a
/// single image, honoring per-layer blend modes, grayscale masks,
/// clipping to the nearest non-clipped layer below, opacity, Phase
/// 52 effect stacks (rendered from pristine pixels at composite
/// time) and adjustment layers (their stack filters the accumulated
/// backdrop, cross-faded by opacity x mask). Layer groups are not
/// part of the generated app's model in this phase — see the Phase
/// 56 acceptance report.
/// </summary>
public static class Compositor
{
    public static PixelImage Render(ImageDocument doc)
    {
        var outImg = new PixelImage(doc.Width, doc.Height);
        float[]? clipBase = null;
        foreach (var layer in doc.Layers)
        {
            if (!layer.Visible || layer.Opacity <= 0) continue;
            if (layer.Kind == "adjustment")
            {
                ApplyAdjustmentLayer(layer, outImg);
                continue;
            }
            if (layer.Clipped && clipBase == null) continue; // nothing below to clip to: contributes nothing
            var view = layer.Effects.Count > 0 ? EffectStack.Apply(layer.Pixels, layer.Effects) : layer.Pixels;
            var src = view.Data;
            var mask = layer.Mask;
            for (int px = 0, p = 0; px < doc.Width * doc.Height; px++, p += 4)
            {
                double sa = src[p + 3] / 255.0 * layer.Opacity;
                if (sa <= 0) continue;
                if (mask != null)
                {
                    sa *= mask[px] / 255.0;
                    if (sa <= 0) continue;
                }
                if (layer.Clipped && clipBase != null)
                {
                    sa *= clipBase[px];
                    if (sa <= 0) continue;
                }
                BlendModes.BlendComposite(outImg.Data, p, src[p], src[p + 1], src[p + 2], sa, layer.BlendMode);
            }
            if (!layer.Clipped) clipBase = AlphaMap(view, layer);
        }
        return outImg;
    }

    private static float[] AlphaMap(PixelImage view, EditorLayer layer)
    {
        var map = new float[view.Width * view.Height];
        var d = view.Data;
        var mask = layer.Mask;
        for (int px = 0, p = 0; px < map.Length; px++, p += 4)
        {
            double a = d[p + 3] / 255.0 * layer.Opacity;
            if (mask != null) a *= mask[px] / 255.0;
            map[px] = (float)a;
        }
        return map;
    }

    private static void ApplyAdjustmentLayer(EditorLayer layer, PixelImage outImg)
    {
        bool anyEnabled = false;
        foreach (var e in layer.Effects) if (e.Enabled) { anyEnabled = true; break; }
        if (!anyEnabled) return;
        var filtered = EffectStack.Apply(outImg, layer.Effects);
        var mask = layer.Mask;
        for (int px = 0, p = 0; px < outImg.Width * outImg.Height; px++, p += 4)
        {
            double wgt = layer.Opacity;
            if (mask != null) wgt *= mask[px] / 255.0;
            if (wgt <= 0) continue;
            if (wgt >= 1)
            {
                outImg.Data[p] = filtered.Data[p];
                outImg.Data[p + 1] = filtered.Data[p + 1];
                outImg.Data[p + 2] = filtered.Data[p + 2];
                outImg.Data[p + 3] = filtered.Data[p + 3];
            }
            else
            {
                for (int c = 0; c < 4; c++)
                    outImg.Data[p + c] = (byte)Px.Round(outImg.Data[p + c] * (1 - wgt) + filtered.Data[p + c] * wgt);
            }
        }
    }
}
`;
}

/** ImageDocument.cs: the layered document model on the PixelEngine core, with Phase 44–52 layer state and v2-compatible save/load. */
function imageDocumentCSharp(asm: string): string {
  return `using System.Drawing;
using System.Text.Json;

namespace ${asm};

/// <summary>
/// One layer: engine pixels plus the Phase 44–52 layer state —
/// blend mode, grayscale mask, alpha lock, clipping, kind (raster /
/// text / shape / adjustment), editable content data for text and
/// shape layers, and the non-destructive effect stack. Pixels are
/// the source of truth; the Bitmap is a cached GDI view of them
/// (the cache itself lives in ImageDocument.Drawing.cs, so this
/// file has no System.Drawing.Common dependency — Phase 57).
/// For text/shape layers the pixels are a render cache of Text /
/// Shape, regenerated by ImageDocument.RenderContentLayer.
/// </summary>
public sealed partial class EditorLayer : IDisposable
{
    public required string Name { get; set; }
    public bool Visible { get; set; } = true;
    public double Opacity { get; set; } = 1;
    public string BlendMode { get; set; } = "normal";
    public bool AlphaLock { get; set; }
    public bool Clipped { get; set; }
    public string Kind { get; set; } = "raster";
    /// <summary>Grayscale mask bytes (width x height), or null. 255 reveals, 0 hides.</summary>
    public byte[]? Mask { get; set; }
    public List<LayerEffect> Effects { get; } = new();
    public TextData? Text { get; set; }
    public ShapeData? Shape { get; set; }
    public required PixelImage Pixels { get; set; }

    public void SetPixels(PixelImage pixels)
    {
        Pixels = pixels;
        InvalidateBitmap();
    }

    /// <summary>
    /// Drop the cached GDI view of Pixels, if one exists. The cache
    /// lives in ImageDocument.Drawing.cs; in headless builds that
    /// compile this file without the Drawing part there is no cache
    /// and the hook below has no implementation, so this is a no-op.
    /// </summary>
    public void InvalidateBitmap() => InvalidateCachedBitmap();

    partial void InvalidateCachedBitmap();

    public void Dispose() => InvalidateCachedBitmap();
}

/// <summary>
/// Layered image document. Flatten runs the Phase 56 compositor
/// (blend modes, masks, clipping, effect stacks, adjustment layers)
/// over the engine pixel buffers. Project files are JSON manifests
/// plus one PNG per layer (and one per mask): the manifest carries
/// the Phase 44–52 layer state; manifests written by the Phase 19
/// app (name/visible/opacity/file only) still load, with defaults.
/// </summary>
public sealed partial class ImageDocument : IDisposable
{
    public int Width { get; private set; }
    public int Height { get; private set; }
    public List<EditorLayer> Layers { get; } = new();
    public int ActiveIndex { get; set; }
    public EditorLayer Active => Layers[ActiveIndex];

    public ImageDocument(int width, int height)
    {
        Width = width; Height = height;
        var bg = new PixelImage(width, height);
        bg.Clear(255, 255, 255, 255);
        Layers.Add(new EditorLayer { Name = "Background", Pixels = bg });
    }

    public EditorLayer AddLayer(string name) => AddLayer(name, "raster");

    public EditorLayer AddLayer(string name, string kind)
    {
        var layer = new EditorLayer { Name = name, Kind = kind, Pixels = new PixelImage(Width, Height) };
        Layers.Add(layer);
        ActiveIndex = Layers.Count - 1;
        return layer;
    }

    public EditorLayer AddTextLayer(TextData data)
    {
        var layer = AddLayer("Text " + (Layers.Count + 1), "text");
        layer.Text = data;
        RenderContentLayer(layer);
        return layer;
    }

    public EditorLayer AddShapeLayer(ShapeData data)
    {
        var layer = AddLayer("Shape " + (Layers.Count + 1), "shape");
        layer.Shape = data;
        RenderContentLayer(layer);
        return layer;
    }

    /// <summary>Re-render a content layer's pixel cache from its editable data (no-op for raster/adjustment layers).</summary>
    public void RenderContentLayer(EditorLayer layer)
    {
        if (layer.Kind == "text" && layer.Text != null)
        {
            var img = new PixelImage(Width, Height);
            ContentRender.RenderText(img, layer.Text);
            layer.SetPixels(img);
        }
        else if (layer.Kind == "shape" && layer.Shape != null)
        {
            var img = new PixelImage(Width, Height);
            ContentRender.RenderShape(img, layer.Shape);
            layer.SetPixels(img);
        }
    }

    // Flatten() (to a GDI Bitmap) lives in ImageDocument.Drawing.cs;
    // the raw-buffer flatten is Compositor.Render(this).

    public void RemoveLayer(int index)
    {
        if (Layers.Count <= 1 || index < 0 || index >= Layers.Count) return;
        Layers[index].Dispose();
        Layers.RemoveAt(index);
        ActiveIndex = Math.Clamp(ActiveIndex, 0, Layers.Count - 1);
    }

    public void MoveLayer(int index, int delta)
    {
        var target = index + delta;
        if (index < 0 || index >= Layers.Count || target < 0 || target >= Layers.Count) return;
        (Layers[index], Layers[target]) = (Layers[target], Layers[index]);
        ActiveIndex = target;
    }

    // ---------------------------------------------------------- masks (Phase 44)

    /// <summary>Attach a fresh grayscale mask filled with fill (255 = reveal all, the usual default).</summary>
    public void CreateMask(EditorLayer layer, byte fill = 255)
    {
        var mask = new byte[Width * Height];
        Array.Fill(mask, fill);
        layer.Mask = mask;
    }

    /// <summary>Invert the mask: every value v becomes 255 - v.</summary>
    public void InvertMask(EditorLayer layer)
    {
        if (layer.Mask == null) throw new InvalidOperationException("Layer \\"" + layer.Name + "\\" has no mask");
        for (int i = 0; i < layer.Mask.Length; i++) layer.Mask[i] = (byte)(255 - layer.Mask[i]);
    }

    /// <summary>Bake the mask into the layer's alpha channel and remove the mask.</summary>
    public void ApplyMask(EditorLayer layer)
    {
        if (layer.Mask == null) throw new InvalidOperationException("Layer \\"" + layer.Name + "\\" has no mask");
        if (layer.Kind == "adjustment")
            throw new InvalidOperationException("Layer \\"" + layer.Name + "\\" is an adjustment layer; its mask modulates its effect and cannot be applied to pixels");
        var d = layer.Pixels.Data;
        var mask = layer.Mask;
        for (int px = 0, p = 0; px < mask.Length; px++, p += 4)
            d[p + 3] = (byte)Px.Round(d[p + 3] * mask[px] / 255.0);
        layer.Mask = null;
        layer.InvalidateBitmap();
    }

    public void RemoveMask(EditorLayer layer) => layer.Mask = null;

    // ---------------------------------------------------------- effects (Phase 52)

    /// <summary>
    /// DESTRUCTIVE: bake a raster layer's effect stack into its
    /// pixels and clear the stack. Rendering is unchanged by baking.
    /// Adjustment layers have no pixels and content layers' pixels
    /// are a render cache, so both refuse, as in the TS engine.
    /// </summary>
    public void BakeEffects(EditorLayer layer)
    {
        if (layer.Kind == "adjustment")
            throw new InvalidOperationException("Layer \\"" + layer.Name + "\\" is an adjustment layer; it has no pixels of its own to bake into");
        if (layer.Kind != "raster")
            throw new InvalidOperationException("Layer \\"" + layer.Name + "\\" is a " + layer.Kind + " layer; its pixels are a render cache of its editable data and cannot hold a bake");
        layer.SetPixels(EffectStack.Apply(layer.Pixels, layer.Effects));
        layer.Effects.Clear();
    }

    // ---------------------------------------------------------- geometry
    //
    // Phase 57: geometry runs on the raw buffers — the TS engine's
    // bilinear resizeImage/resizeMask sampling and exact
    // quarter-turn remapping — not on GDI bitmaps, so the document
    // model has no System.Drawing.Common dependency. (Before Phase
    // 57, Resize/RotateFlip round-tripped every layer through
    // System.Drawing, which also made them Windows-only at runtime.)

    public void Resize(int newWidth, int newHeight)
    {
        if (newWidth <= 0 || newHeight <= 0) throw new ArgumentException("Invalid resize target " + newWidth + "x" + newHeight);
        foreach (var layer in Layers)
        {
            layer.SetPixels(ResizePixels(layer.Pixels, newWidth, newHeight));
            if (layer.Mask != null) layer.Mask = ResizeMaskBytes(layer.Mask, Width, Height, newWidth, newHeight);
        }
        Width = newWidth; Height = newHeight;
    }

    /// <summary>Bilinear resample of one image: the TS resizeImage sampling convention ((x + 0.5) * scale - 0.5, edge-clamped, rounded once).</summary>
    private static PixelImage ResizePixels(PixelImage img, int newWidth, int newHeight)
    {
        var outImg = new PixelImage(newWidth, newHeight);
        double xScale = (double)img.Width / newWidth;
        double yScale = (double)img.Height / newHeight;
        for (int y = 0; y < newHeight; y++)
        {
            for (int x = 0; x < newWidth; x++)
            {
                double sx = (x + 0.5) * xScale - 0.5;
                double sy = (y + 0.5) * yScale - 0.5;
                int x0 = (int)Math.Floor(sx);
                int y0 = (int)Math.Floor(sy);
                double fx = sx - x0;
                double fy = sy - y0;
                int o = (y * newWidth + x) * 4;
                for (int c = 0; c < 4; c++)
                {
                    double v = SampleChannel(img, x0, y0, c) * (1 - fx) * (1 - fy)
                        + SampleChannel(img, x0 + 1, y0, c) * fx * (1 - fy)
                        + SampleChannel(img, x0, y0 + 1, c) * (1 - fx) * fy
                        + SampleChannel(img, x0 + 1, y0 + 1, c) * fx * fy;
                    outImg.Data[o + c] = (byte)Px.Round(v);
                }
            }
        }
        return outImg;
    }

    private static int SampleChannel(PixelImage img, int x, int y, int c) =>
        img.Data[(Px.ClampIndex(y, img.Height) * img.Width + Px.ClampIndex(x, img.Width)) * 4 + c];

    /// <summary>Bilinear resample of a grayscale mask (the TS resizeMask, same sampling convention).</summary>
    private static byte[] ResizeMaskBytes(byte[] mask, int width, int height, int newWidth, int newHeight)
    {
        int SampleMask(int xx, int yy) => mask[Px.ClampIndex(yy, height) * width + Px.ClampIndex(xx, width)];
        var outMask = new byte[newWidth * newHeight];
        double xScale = (double)width / newWidth;
        double yScale = (double)height / newHeight;
        for (int y = 0; y < newHeight; y++)
        {
            for (int x = 0; x < newWidth; x++)
            {
                double sx = (x + 0.5) * xScale - 0.5;
                double sy = (y + 0.5) * yScale - 0.5;
                int x0 = (int)Math.Floor(sx);
                int y0 = (int)Math.Floor(sy);
                double fx = sx - x0;
                double fy = sy - y0;
                double v = SampleMask(x0, y0) * (1 - fx) * (1 - fy)
                    + SampleMask(x0 + 1, y0) * fx * (1 - fy)
                    + SampleMask(x0, y0 + 1) * (1 - fx) * fy
                    + SampleMask(x0 + 1, y0 + 1) * fx * fy;
                outMask[y * newWidth + x] = (byte)Px.Round(v);
            }
        }
        return outMask;
    }

    public void RotateFlip(RotateFlipKind kind)
    {
        foreach (var layer in Layers)
        {
            var rotated = RotateFlipBytes(layer.Pixels.Data, Width, Height, 4, kind, out int nw, out int nh);
            var img = new PixelImage(nw, nh);
            Array.Copy(rotated, img.Data, rotated.Length);
            layer.SetPixels(img);
            if (layer.Mask != null) layer.Mask = RotateFlipBytes(layer.Mask, Width, Height, 1, kind, out _, out _);
        }
        if ((int)kind % 4 is 1 or 3) (Width, Height) = (Height, Width);
    }

    /// <summary>
    /// Exact rotate/flip of a packed buffer (bpp bytes per pixel):
    /// clockwise quarter-turns first, then the X/Y mirrors — the
    /// RotateFlipKind decomposition. No resampling, so no error.
    /// </summary>
    private static byte[] RotateFlipBytes(byte[] src, int width, int height, int bpp, RotateFlipKind kind, out int newWidth, out int newHeight)
    {
        int turns = (int)kind % 4;
        int flip = (int)kind / 4; // 0 none, 1 X, 2 Y, 3 XY
        var cur = src;
        int cw = width, ch = height;
        for (int t = 0; t < turns; t++)
        {
            var next = new byte[cur.Length];
            for (int y = 0; y < ch; y++)
            {
                for (int x = 0; x < cw; x++)
                {
                    int s = (y * cw + x) * bpp;
                    int d = (x * ch + (ch - 1 - y)) * bpp;
                    for (int b = 0; b < bpp; b++) next[d + b] = cur[s + b];
                }
            }
            cur = next;
            (cw, ch) = (ch, cw);
        }
        if (flip != 0)
        {
            bool flipX = flip is 1 or 3;
            bool flipY = flip is 2 or 3;
            var next = new byte[cur.Length];
            for (int y = 0; y < ch; y++)
            {
                for (int x = 0; x < cw; x++)
                {
                    int dx = flipX ? cw - 1 - x : x;
                    int dy = flipY ? ch - 1 - y : y;
                    int s = (y * cw + x) * bpp;
                    int d = (dy * cw + dx) * bpp;
                    for (int b = 0; b < bpp; b++) next[d + b] = cur[s + b];
                }
            }
            cur = next;
        }
        newWidth = cw; newHeight = ch;
        return cur;
    }

    private static PixelImage MaskToPixelImage(byte[] mask, int width, int height)
    {
        var img = new PixelImage(width, height);
        for (int px = 0, p = 0; px < mask.Length; px++, p += 4)
        {
            img.Data[p] = mask[px];
            img.Data[p + 1] = mask[px];
            img.Data[p + 2] = mask[px];
            img.Data[p + 3] = 255;
        }
        return img;
    }

    private static byte[] PixelImageToMask(PixelImage img)
    {
        var mask = new byte[img.Width * img.Height];
        for (int px = 0, p = 0; px < mask.Length; px++, p += 4) mask[px] = img.Data[p];
        return mask;
    }

    // ---------------------------------------------------------- project save/load

    private static Dictionary<string, object?> ColorJson(Color c) => new()
    {
        ["r"] = c.R, ["g"] = c.G, ["b"] = c.B, ["a"] = c.A
    };

    private static Dictionary<string, object?> PointJson(DPoint p) => new()
    {
        ["x"] = p.X, ["y"] = p.Y
    };

    private static Dictionary<string, object?>? TextJson(TextData? t)
    {
        if (t == null) return null;
        return new Dictionary<string, object?>
        {
            ["text"] = t.Text,
            ["font"] = t.Font,
            ["fontSize"] = t.FontSize,
            ["align"] = t.Align,
            ["letterSpacing"] = t.LetterSpacing,
            ["lineSpacing"] = t.LineSpacing,
            ["color"] = ColorJson(t.Color),
            ["outline"] = t.OutlineWidth > 0
                ? new Dictionary<string, object?> { ["width"] = t.OutlineWidth, ["color"] = ColorJson(t.OutlineColor) }
                : null,
            ["shadow"] = t.HasShadow
                ? new Dictionary<string, object?> { ["offsetX"] = t.ShadowOffsetX, ["offsetY"] = t.ShadowOffsetY, ["blur"] = t.ShadowBlur, ["color"] = ColorJson(t.ShadowColor) }
                : null,
            ["origin"] = PointJson(new DPoint(t.OriginX, t.OriginY)),
            ["blockWidth"] = t.BlockWidth
        };
    }

    private static Dictionary<string, object?>? ShapeJson(ShapeData? s)
    {
        if (s == null) return null;
        return new Dictionary<string, object?>
        {
            ["kind"] = s.Kind,
            ["rect"] = (s.Kind == "rectangle" || s.Kind == "ellipse")
                ? new Dictionary<string, object?> { ["x"] = (double)s.Rect.X, ["y"] = (double)s.Rect.Y, ["width"] = (double)s.Rect.Width, ["height"] = (double)s.Rect.Height }
                : null,
            ["from"] = s.Kind == "line" ? PointJson(s.From) : null,
            ["to"] = s.Kind == "line" ? PointJson(s.To) : null,
            ["points"] = s.Points.Select(p => (object?)PointJson(p)).ToList(),
            ["segments"] = s.Segments.Select(seg => (object?)new Dictionary<string, object?>
            {
                ["p0"] = PointJson(seg.P0), ["c1"] = PointJson(seg.C1), ["c2"] = PointJson(seg.C2), ["p1"] = PointJson(seg.P1)
            }).ToList(),
            ["closed"] = s.Closed,
            ["fill"] = s.Fill is Color f ? ColorJson(f) : null,
            ["stroke"] = s.Stroke is Color st ? ColorJson(st) : null,
            ["strokeWidth"] = s.StrokeWidth
        };
    }

    public void SaveProject(string folder)
    {
        Directory.CreateDirectory(folder);
        var layers = new List<object?>();
        for (int i = 0; i < Layers.Count; i++)
        {
            var l = Layers[i];
            string? maskFile = null;
            if (l.Mask != null)
            {
                maskFile = "mask_" + i + ".png";
                File.WriteAllBytes(Path.Combine(folder, maskFile), PngCodec.Encode(MaskToPixelImage(l.Mask, Width, Height)));
            }
            File.WriteAllBytes(Path.Combine(folder, "layer_" + i + ".png"), PngCodec.Encode(l.Pixels));
            layers.Add(new Dictionary<string, object?>
            {
                ["Name"] = l.Name,
                ["Visible"] = l.Visible,
                ["Opacity"] = l.Opacity,
                ["BlendMode"] = l.BlendMode,
                ["AlphaLock"] = l.AlphaLock,
                ["Clipped"] = l.Clipped,
                ["Kind"] = l.Kind,
                ["File"] = "layer_" + i + ".png",
                ["MaskFile"] = maskFile,
                ["Effects"] = l.Effects.Select(e => (object?)new Dictionary<string, object?>
                {
                    ["FilterId"] = e.FilterId,
                    ["Params"] = e.Params,
                    ["Enabled"] = e.Enabled
                }).ToList(),
                ["Text"] = TextJson(l.Text),
                ["Shape"] = ShapeJson(l.Shape)
            });
        }
        var manifest = new Dictionary<string, object?>
        {
            ["Width"] = Width,
            ["Height"] = Height,
            ["ActiveIndex"] = ActiveIndex,
            ["Layers"] = layers
        };
        File.WriteAllText(Path.Combine(folder, "project.json"), JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static string GetString(JsonElement el, string name, string fallback) =>
        el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : fallback;

    private static bool GetBool(JsonElement el, string name, bool fallback) =>
        el.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : fallback;

    private static double GetDouble(JsonElement el, string name, double fallback) =>
        el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : fallback;

    private static Color ParseColor(JsonElement el) => Color.FromArgb(
        (int)GetDouble(el, "a", 255), (int)GetDouble(el, "r", 0), (int)GetDouble(el, "g", 0), (int)GetDouble(el, "b", 0));

    private static DPoint ParsePoint(JsonElement el) => new(GetDouble(el, "x", 0), GetDouble(el, "y", 0));

    private static TextData? ParseText(JsonElement entry)
    {
        if (!entry.TryGetProperty("Text", out var el) || el.ValueKind != JsonValueKind.Object) return null;
        var data = new TextData
        {
            Text = GetString(el, "text", ""),
            Font = GetString(el, "font", "pixel"),
            FontSize = GetDouble(el, "fontSize", 14),
            Align = GetString(el, "align", "left"),
            LetterSpacing = GetDouble(el, "letterSpacing", 0),
            LineSpacing = GetDouble(el, "lineSpacing", 0),
            BlockWidth = GetDouble(el, "blockWidth", 0)
        };
        if (el.TryGetProperty("color", out var colorEl) && colorEl.ValueKind == JsonValueKind.Object) data.Color = ParseColor(colorEl);
        if (el.TryGetProperty("origin", out var originEl) && originEl.ValueKind == JsonValueKind.Object)
        {
            var origin = ParsePoint(originEl);
            data.OriginX = origin.X;
            data.OriginY = origin.Y;
        }
        if (el.TryGetProperty("outline", out var outlineEl) && outlineEl.ValueKind == JsonValueKind.Object)
        {
            data.OutlineWidth = (int)GetDouble(outlineEl, "width", 0);
            if (outlineEl.TryGetProperty("color", out var oc) && oc.ValueKind == JsonValueKind.Object) data.OutlineColor = ParseColor(oc);
        }
        if (el.TryGetProperty("shadow", out var shadowEl) && shadowEl.ValueKind == JsonValueKind.Object)
        {
            data.HasShadow = true;
            data.ShadowOffsetX = GetDouble(shadowEl, "offsetX", 0);
            data.ShadowOffsetY = GetDouble(shadowEl, "offsetY", 0);
            data.ShadowBlur = GetDouble(shadowEl, "blur", 0);
            if (shadowEl.TryGetProperty("color", out var sc) && sc.ValueKind == JsonValueKind.Object) data.ShadowColor = ParseColor(sc);
        }
        return data;
    }

    private static ShapeData? ParseShape(JsonElement entry)
    {
        if (!entry.TryGetProperty("Shape", out var el) || el.ValueKind != JsonValueKind.Object) return null;
        var data = new ShapeData
        {
            Kind = GetString(el, "kind", "rectangle"),
            Closed = GetBool(el, "closed", false),
            StrokeWidth = GetDouble(el, "strokeWidth", 0)
        };
        if (el.TryGetProperty("rect", out var rectEl) && rectEl.ValueKind == JsonValueKind.Object)
            data.Rect = new RectangleF((float)GetDouble(rectEl, "x", 0), (float)GetDouble(rectEl, "y", 0), (float)GetDouble(rectEl, "width", 0), (float)GetDouble(rectEl, "height", 0));
        if (el.TryGetProperty("from", out var fromEl) && fromEl.ValueKind == JsonValueKind.Object) data.From = ParsePoint(fromEl);
        if (el.TryGetProperty("to", out var toEl) && toEl.ValueKind == JsonValueKind.Object) data.To = ParsePoint(toEl);
        if (el.TryGetProperty("points", out var pointsEl) && pointsEl.ValueKind == JsonValueKind.Array)
            foreach (var pEl in pointsEl.EnumerateArray()) data.Points.Add(ParsePoint(pEl));
        if (el.TryGetProperty("segments", out var segsEl) && segsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var segEl in segsEl.EnumerateArray())
            {
                var seg = new BezierSegment();
                if (segEl.TryGetProperty("p0", out var p0) && p0.ValueKind == JsonValueKind.Object) seg.P0 = ParsePoint(p0);
                if (segEl.TryGetProperty("c1", out var c1) && c1.ValueKind == JsonValueKind.Object) seg.C1 = ParsePoint(c1);
                if (segEl.TryGetProperty("c2", out var c2) && c2.ValueKind == JsonValueKind.Object) seg.C2 = ParsePoint(c2);
                if (segEl.TryGetProperty("p1", out var p1) && p1.ValueKind == JsonValueKind.Object) seg.P1 = ParsePoint(p1);
                data.Segments.Add(seg);
            }
        }
        if (el.TryGetProperty("fill", out var fillEl) && fillEl.ValueKind == JsonValueKind.Object) data.Fill = ParseColor(fillEl);
        if (el.TryGetProperty("stroke", out var strokeEl) && strokeEl.ValueKind == JsonValueKind.Object) data.Stroke = ParseColor(strokeEl);
        return data;
    }

    public static ImageDocument LoadProject(string folder)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "project.json")));
        var root = doc.RootElement;
        var result = new ImageDocument(root.GetProperty("Width").GetInt32(), root.GetProperty("Height").GetInt32());
        result.Layers[0].Dispose();
        result.Layers.Clear();
        foreach (var entry in root.GetProperty("Layers").EnumerateArray())
        {
            // PNG IO goes through the engine's own PngCodec (Phase 57):
            // the same raw-buffer codec writes these files in
            // SaveProject, and its decoder also reads PNGs written by
            // the Phase 19 app (8-bit, any of the five filters).
            var layer = new EditorLayer
            {
                Name = entry.GetProperty("Name").GetString()!,
                Visible = entry.GetProperty("Visible").GetBoolean(),
                Opacity = entry.GetProperty("Opacity").GetDouble(),
                BlendMode = GetString(entry, "BlendMode", "normal"),
                AlphaLock = GetBool(entry, "AlphaLock", false),
                Clipped = GetBool(entry, "Clipped", false),
                Kind = GetString(entry, "Kind", "raster"),
                Pixels = PngCodec.Decode(File.ReadAllBytes(Path.Combine(folder, entry.GetProperty("File").GetString()!)))
            };
            if (entry.TryGetProperty("MaskFile", out var maskFileEl) && maskFileEl.ValueKind == JsonValueKind.String)
            {
                var maskPath = Path.Combine(folder, maskFileEl.GetString()!);
                if (File.Exists(maskPath))
                {
                    layer.Mask = PixelImageToMask(PngCodec.Decode(File.ReadAllBytes(maskPath)));
                }
            }
            if (entry.TryGetProperty("Effects", out var effectsEl) && effectsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var eEl in effectsEl.EnumerateArray())
                {
                    var effect = new LayerEffect
                    {
                        FilterId = GetString(eEl, "FilterId", "invert"),
                        Enabled = GetBool(eEl, "Enabled", true)
                    };
                    if (eEl.TryGetProperty("Params", out var paramsEl) && paramsEl.ValueKind == JsonValueKind.Object)
                        foreach (var prop in paramsEl.EnumerateObject()) effect.Params[prop.Name] = prop.Value.GetDouble();
                    // Like the TS loader, stored effects are validated
                    // against the registry and stored resolved — an
                    // unknown id or bad params reject the file.
                    effect.Params = Filters.ResolveParams(Filters.DescriptorFor(effect.FilterId), effect.Params);
                    layer.Effects.Add(effect);
                }
            }
            layer.Text = ParseText(entry);
            layer.Shape = ParseShape(entry);
            result.Layers.Add(layer);
            if (layer.Kind == "text" || layer.Kind == "shape") result.RenderContentLayer(layer);
        }
        result.ActiveIndex = Math.Clamp(root.GetProperty("ActiveIndex").GetInt32(), 0, Math.Max(0, result.Layers.Count - 1));
        return result;
    }

    public void Dispose() { foreach (var l in Layers) l.Dispose(); }
}
`;
}

/** EditorCanvas.cs: the editing surface — engine-driven tools, selection, mask painting, zoom/pan. */
function editorCanvasCSharp(asm: string): string {
  return `namespace ${asm};

public enum EditorTool { Select, Brush, Eraser, Rectangle, Ellipse, Line, Text, Fill }

/// <summary>
/// The editing surface: draws the flattened document with zoom/pan,
/// maps mouse input back to image coordinates, and applies the
/// active tool to the active layer through the PixelEngine core —
/// the Phase 46 coverage brush (and its eraser), the Phase 19 tool
/// rasterizers for shapes/lines/text, mask painting, and a
/// rectangular selection that scopes tools and filters. A brush
/// stroke is re-rendered from its full point list over the
/// stroke-start snapshot on every mouse move, so the coverage model
/// (spacing, flow build-up, smoothing) applies to the whole stroke,
/// not per segment. The mouse reports no pressure, so stroke points
/// carry none and count as full pressure, per the engine's rule.
/// </summary>
public sealed class EditorCanvas : Control
{
    public ImageDocument? Document { get; set; }
    public EditorTool Tool { get; set; } = EditorTool.Brush;
    public Color ForeColor2 { get; set; } = Color.Black;
    public Color BackColor2 { get; set; } = Color.White;
    public int BrushSize { get; set; } = 8;
    public string TextToDraw { get; set; } = "Text";
    public float Zoom { get; private set; } = 1f;
    public PointF Pan { get; private set; } = new(20, 20);
    /// <summary>The Phase 46 brush settings driving the Brush and Eraser tools.</summary>
    public BrushSettings Brush { get; } = new();
    /// <summary>When true (and the active layer has a mask), brush strokes paint the mask instead of pixels.</summary>
    public bool PaintMaskMode { get; set; }
    /// <summary>The rectangular selection in image coordinates, or null. Scopes tools and filters (the TS rect selection).</summary>
    public Rectangle? Selection { get; private set; }
    public event Action? StrokeStarted;
    public event Action? ImageChanged;
    /// <summary>Raised when the Text tool clicks: the shell opens the text-layer dialog for this image point.</summary>
    public event Action<Point>? TextToolClicked;

    private Point? _lastImagePoint;
    private Point? _panStart;
    private PointF _panOrigin;
    private Point? _dragStart;
    private List<StrokePoint>? _stroke;
    private PixelImage? _strokeBase;
    private Point? _lastStrokePoint;

    public EditorCanvas() { DoubleBuffered = true; BackColor = Color.FromArgb(60, 60, 60); }

    public Point ToImage(Point screen)
    {
        return new Point((int)((screen.X - Pan.X) / Zoom), (int)((screen.Y - Pan.Y) / Zoom));
    }

    public void ClearSelection()
    {
        Selection = null;
        Invalidate();
    }

    /// <summary>Select the whole canvas.</summary>
    public void SelectAll()
    {
        if (Document == null) return;
        Selection = new Rectangle(0, 0, Document.Width, Document.Height);
        Invalidate();
    }

    /// <summary>Zoom by a factor, anchored at the control's center (keyboard zoom, Phase 54).</summary>
    public void ZoomBy(float factor)
    {
        var center = new Point(Width / 2, Height / 2);
        var before = ToImage(center);
        Zoom = Math.Clamp(Zoom * factor, 0.05f, 32f);
        Pan = new PointF(center.X - before.X * Zoom, center.Y - before.Y * Zoom);
        Invalidate();
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        var before = ToImage(e.Location);
        Zoom = Math.Clamp(Zoom * (e.Delta > 0 ? 1.1f : 0.9f), 0.05f, 32f);
        Pan = new PointF(e.X - before.X * Zoom, e.Y - before.Y * Zoom);
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (Document == null) return;
        if (e.Button == MouseButtons.Middle || (e.Button == MouseButtons.Left && ModifierKeys == Keys.Space))
        { _panStart = e.Location; _panOrigin = Pan; return; }
        if (e.Button != MouseButtons.Left) return;
        var p = ToImage(e.Location);
        _lastImagePoint = p;
        switch (Tool)
        {
            case EditorTool.Select:
                _dragStart = p;
                Selection = new Rectangle(p.X, p.Y, 0, 0);
                Invalidate();
                return;
            case EditorTool.Text:
                TextToolClicked?.Invoke(p);
                return;
            case EditorTool.Fill:
            {
                if (!BeginEdit()) return;
                var layer = Document.Active;
                Tools.FillRect(layer.Pixels, new Rectangle(0, 0, Document.Width, Document.Height), ForeColor2, Selection, layer.AlphaLock);
                layer.InvalidateBitmap();
                ImageChanged?.Invoke();
                Invalidate();
                return;
            }
            case EditorTool.Brush:
            case EditorTool.Eraser:
            {
                if (!BeginEdit()) return;
                var layer = Document.Active;
                _stroke = new List<StrokePoint> { new(p.X, p.Y) };
                _lastStrokePoint = p;
                if (PaintMaskMode && layer.Mask != null)
                {
                    _strokeBase = null;
                    PaintMaskSegment(p, p);
                }
                else
                {
                    _strokeBase = layer.Pixels.Clone();
                    ApplyStroke();
                }
                Invalidate();
                return;
            }
            default: // Rectangle, Ellipse, Line: applied on mouse-up from the drag rectangle
                if (!BeginEdit()) return;
                _dragStart = p;
                return;
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (_panStart.HasValue)
        { Pan = new PointF(_panOrigin.X + e.X - _panStart.Value.X, _panOrigin.Y + e.Y - _panStart.Value.Y); Invalidate(); return; }
        if (Document == null || e.Button != MouseButtons.Left || !_lastImagePoint.HasValue) return;
        var p = ToImage(e.Location);
        if (Tool == EditorTool.Select && _dragStart.HasValue)
        {
            Selection = NormalizeRect(_dragStart.Value, p);
            Invalidate();
        }
        else if (_stroke != null && (Tool is EditorTool.Brush or EditorTool.Eraser))
        {
            _stroke.Add(new StrokePoint(p.X, p.Y));
            var layer = Document.Active;
            if (PaintMaskMode && layer.Mask != null && _lastStrokePoint.HasValue) PaintMaskSegment(_lastStrokePoint.Value, p);
            else ApplyStroke();
            _lastStrokePoint = p;
            Invalidate();
        }
        _lastImagePoint = p;
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (Document != null && _dragStart.HasValue && Tool is EditorTool.Rectangle or EditorTool.Ellipse or EditorTool.Line)
        {
            var layer = Document.Active;
            var to = ToImage(e.Location);
            if (Tool == EditorTool.Rectangle)
                Tools.FillRect(layer.Pixels, NormalizeRect(_dragStart.Value, to), ForeColor2, Selection, layer.AlphaLock);
            else if (Tool == EditorTool.Ellipse)
                Tools.DrawEllipse(layer.Pixels, NormalizeRect(_dragStart.Value, to), ForeColor2, Selection, layer.AlphaLock);
            else
                Tools.DrawLine(layer.Pixels, new DPoint(_dragStart.Value.X, _dragStart.Value.Y), new DPoint(to.X, to.Y), BrushSize, ForeColor2, Selection, layer.AlphaLock);
            layer.InvalidateBitmap();
        }
        bool wasEditing = _stroke != null || _dragStart.HasValue;
        _stroke = null;
        _strokeBase = null;
        _lastStrokePoint = null;
        _dragStart = null;
        _lastImagePoint = null;
        _panStart = null;
        if (wasEditing && Tool != EditorTool.Select) ImageChanged?.Invoke();
        Invalidate();
    }

    /// <summary>
    /// Start an undoable edit on the active layer. Adjustment layers
    /// have no pixels of their own — the TS engine refuses to paint
    /// them, and so does the canvas.
    /// </summary>
    private bool BeginEdit()
    {
        if (Document == null) return false;
        if (Document.Active.Kind == "adjustment") return false;
        StrokeStarted?.Invoke();
        return true;
    }

    private void ApplyStroke()
    {
        if (Document == null || _stroke == null || _strokeBase == null) return;
        var layer = Document.Active;
        var img = _strokeBase.Clone();
        if (Tool == EditorTool.Brush)
            BrushEngine.PaintStroke(img, _stroke, Brush, ForeColor2, layer.AlphaLock, Selection);
        else
            BrushEngine.EraseStroke(img, _stroke, Brush, layer.AlphaLock, Selection);
        layer.SetPixels(img);
    }

    /// <summary>Paint one mask segment: the foreground color's luminance is the gray value (Phase 44 paintMask).</summary>
    private void PaintMaskSegment(Point from, Point to)
    {
        if (Document == null) return;
        var layer = Document.Active;
        if (layer.Mask == null) return;
        int gray = Px.Round(Px.Luminance(ForeColor2.R, ForeColor2.G, ForeColor2.B));
        var points = new List<StrokePoint> { new(from.X, from.Y), new(to.X, to.Y) };
        BrushEngine.PaintMaskStroke(layer.Mask, Document.Width, Document.Height, points, Brush.Size / 2, gray, Selection);
    }

    private static Rectangle NormalizeRect(Point a, Point b) =>
        Rectangle.FromLTRB(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y));

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        if (Document == null) return;
        e.Graphics.InterpolationMode = Zoom >= 1 ? System.Drawing.Drawing2D.InterpolationMode.NearestNeighbor : System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
        using var flat = Document.Flatten();
        e.Graphics.DrawImage(flat, new RectangleF(Pan.X, Pan.Y, Document.Width * Zoom, Document.Height * Zoom));
        if (Selection is Rectangle sel && sel.Width > 0 && sel.Height > 0)
        {
            using var pen = new Pen(Color.DeepSkyBlue) { DashStyle = System.Drawing.Drawing2D.DashStyle.Dash };
            e.Graphics.DrawRectangle(pen, sel.X * Zoom + Pan.X, sel.Y * Zoom + Pan.Y, sel.Width * Zoom, sel.Height * Zoom);
        }
    }
}
`;
}

/** Dialogs.cs: parameter, effect-stack, text-layer and shape-layer dialogs — all wired to engine data. */
function dialogsCSharp(asm: string): string {
  return `using System.Globalization;

namespace ${asm};

/// <summary>Small layout helpers shared by the editor dialogs.</summary>
internal static class DialogUi
{
    public static Panel Row(string label, Control input)
    {
        var panel = new Panel { Width = 420, Height = 30 };
        var l = new Label { Text = label, Left = 0, Top = 5, Width = 115 };
        input.Left = 120;
        input.Top = 2;
        panel.Controls.Add(l);
        panel.Controls.Add(input);
        return panel;
    }

    public static NumericUpDown Num(double min, double max, double value, int decimals = 0)
    {
        var box = new NumericUpDown
        {
            Minimum = (decimal)min,
            Maximum = (decimal)max,
            DecimalPlaces = decimals,
            Width = 130
        };
        box.Value = (decimal)Math.Min(max, Math.Max(min, value));
        return box;
    }

    /// <summary>A button whose BackColor is the chosen color; clicking opens the color picker.</summary>
    public static Button ColorButton(Color initial)
    {
        var b = new Button { Width = 60, Height = 23, BackColor = initial, Text = "" };
        b.Click += (_, _) =>
        {
            using var d = new ColorDialog { Color = b.BackColor };
            if (d.ShowDialog() == DialogResult.OK) b.BackColor = d.Color;
        };
        return b;
    }

    public static FlowLayoutPanel Buttons(EventHandler onOk)
    {
        var row = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, Width = 420, Height = 36 };
        var ok = new Button { Text = "OK", Width = 90 };
        ok.Click += onOk;
        var cancel = new Button { Text = "Cancel", Width = 90, DialogResult = DialogResult.Cancel };
        row.Controls.Add(ok);
        row.Controls.Add(cancel);
        return row;
    }
}

/// <summary>
/// Edit one filter's parameters. The fields are built from the
/// filter's registry descriptor (name, range, default), so the
/// dialog can never offer a parameter the engine does not have; the
/// engine validates again on apply.
/// </summary>
public sealed class FilterParamsDialog : Form
{
    private readonly List<(FilterParamSpec Spec, NumericUpDown Box)> _boxes = new();
    public Dictionary<string, double> Result { get; } = new();

    public FilterParamsDialog(FilterDescriptor descriptor, IReadOnlyDictionary<string, double>? current)
    {
        Text = descriptor.Name;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        foreach (var spec in descriptor.Params)
        {
            double value = current != null && current.TryGetValue(spec.Name, out var v) ? v : spec.DefaultValue;
            int decimals = spec.Max - spec.Min > 10000 ? 0 : 2;
            var box = DialogUi.Num(spec.Min, spec.Max, value, decimals);
            _boxes.Add((spec, box));
            flow.Controls.Add(DialogUi.Row(spec.Name, box));
        }
        flow.Controls.Add(DialogUi.Buttons((_, _) =>
        {
            foreach (var (spec, box) in _boxes) Result[spec.Name] = (double)box.Value;
            DialogResult = DialogResult.OK;
            Close();
        }));
        Controls.Add(flow);
    }
}

/// <summary>
/// Edit a layer's Phase 52 effect stack: add registry filters,
/// toggle them, edit their parameters (through FilterParamsDialog),
/// reorder and remove them. The dialog edits a working copy; the
/// shell commits it to the layer only on OK.
/// </summary>
public sealed class EffectsDialog : Form
{
    private readonly List<LayerEffect> _effects;
    private readonly ListBox _list = new() { Width = 404, Height = 170 };
    private readonly CheckBox _enabled = new() { Text = "Enabled", AutoSize = true };
    private readonly ComboBox _addBox = new() { Width = 220, DropDownStyle = ComboBoxStyle.DropDownList };
    private bool _syncing;

    /// <summary>The edited stack (a working copy), valid when the dialog returns OK.</summary>
    public List<LayerEffect> Result => _effects;

    public EffectsDialog(string layerName, List<LayerEffect> effects)
    {
        Text = "Effects — " + layerName;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        _effects = effects.Select(e => e.Clone()).ToList();

        var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        flow.Controls.Add(_list);
        var tools = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, Width = 420, Height = 34 };
        _enabled.CheckedChanged += (_, _) =>
        {
            if (_syncing || Selected == null) return;
            Selected.Enabled = _enabled.Checked;
            RefreshList();
        };
        tools.Controls.Add(_enabled);
        tools.Controls.Add(MakeButton("Parameters…", (_, _) => EditParams()));
        tools.Controls.Add(MakeButton("Remove", (_, _) => { if (Selected != null) { _effects.Remove(Selected); RefreshList(); } }));
        tools.Controls.Add(MakeButton("Up", (_, _) => MoveEffect(-1)));
        tools.Controls.Add(MakeButton("Down", (_, _) => MoveEffect(1)));
        flow.Controls.Add(tools);
        foreach (var d in Filters.Descriptors) _addBox.Items.Add(d.Name);
        _addBox.SelectedIndex = 0;
        var addRow = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, Width = 420, Height = 34 };
        addRow.Controls.Add(_addBox);
        addRow.Controls.Add(MakeButton("Add effect", (_, _) => AddEffect()));
        flow.Controls.Add(addRow);
        flow.Controls.Add(DialogUi.Buttons((_, _) => { DialogResult = DialogResult.OK; Close(); }));
        Controls.Add(flow);
        _list.SelectedIndexChanged += (_, _) => SyncEnabled();
        RefreshList();
    }

    private LayerEffect? Selected => _list.SelectedIndex >= 0 && _list.SelectedIndex < _effects.Count ? _effects[_list.SelectedIndex] : null;

    private static Button MakeButton(string text, EventHandler onClick)
    {
        var b = new Button { Text = text, AutoSize = true };
        b.Click += onClick;
        return b;
    }

    private void RefreshList()
    {
        int keep = _list.SelectedIndex;
        _list.Items.Clear();
        foreach (var e in _effects)
        {
            string name;
            try { name = Filters.DescriptorFor(e.FilterId).Name; }
            catch (ArgumentException) { name = e.FilterId; }
            _list.Items.Add((e.Enabled ? "" : "(off) ") + name);
        }
        if (keep >= 0 && keep < _list.Items.Count) _list.SelectedIndex = keep;
        SyncEnabled();
    }

    private void SyncEnabled()
    {
        _syncing = true;
        _enabled.Checked = Selected?.Enabled ?? false;
        _enabled.Enabled = Selected != null;
        _syncing = false;
    }

    private void EditParams()
    {
        if (Selected == null) return;
        var descriptor = Filters.DescriptorFor(Selected.FilterId);
        if (descriptor.Params.Length == 0)
        {
            MessageBox.Show(descriptor.Name + " has no parameters.", "Effects", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        using var dialog = new FilterParamsDialog(descriptor, Selected.Params);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            Selected.Params = Filters.ResolveParams(descriptor, dialog.Result);
        }
        catch (ArgumentException ex)
        {
            MessageBox.Show(ex.Message, "Effects", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void AddEffect()
    {
        if (_addBox.SelectedIndex < 0) return;
        var descriptor = Filters.Descriptors[_addBox.SelectedIndex];
        var effect = new LayerEffect
        {
            FilterId = descriptor.Id,
            Params = Filters.ResolveParams(descriptor, null),
            Enabled = true
        };
        _effects.Add(effect);
        RefreshList();
        _list.SelectedIndex = _effects.Count - 1;
    }

    private void MoveEffect(int delta)
    {
        int i = _list.SelectedIndex;
        int j = i + delta;
        if (i < 0 || j < 0 || j >= _effects.Count) return;
        (_effects[i], _effects[j]) = (_effects[j], _effects[i]);
        RefreshList();
        _list.SelectedIndex = j;
    }
}

/// <summary>Create or edit a text layer's data (Phase 48 TextData).</summary>
public sealed class TextLayerDialog : Form
{
    private readonly TextBox _text = new() { Multiline = true, Width = 260, Height = 56 };
    private readonly ComboBox _font = new() { Width = 130, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly NumericUpDown _size;
    private readonly ComboBox _align = new() { Width = 130, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly NumericUpDown _letter;
    private readonly NumericUpDown _line;
    private readonly NumericUpDown _originX;
    private readonly NumericUpDown _originY;
    private readonly NumericUpDown _block;
    private readonly Button _color;
    private readonly NumericUpDown _outlineWidth;
    private readonly Button _outlineColor;
    private readonly CheckBox _shadow = new() { Text = "Shadow", AutoSize = true };
    private readonly NumericUpDown _shadowX;
    private readonly NumericUpDown _shadowY;
    private readonly NumericUpDown _shadowBlur;
    private readonly Button _shadowColor;

    public TextData Data { get; private set; }

    public TextLayerDialog(TextData? initial, Point origin, Color defaultColor)
    {
        Text = "Text layer";
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        var t = initial;
        _text.Text = t?.Text ?? "Text";
        _font.Items.AddRange(new object[] { "pixel", "pixel-bold" });
        _font.SelectedItem = t?.Font ?? "pixel";
        _size = DialogUi.Num(1, 500, t?.FontSize ?? 14);
        _align.Items.AddRange(new object[] { "left", "center", "right" });
        _align.SelectedItem = t?.Align ?? "left";
        _letter = DialogUi.Num(0, 100, t?.LetterSpacing ?? 0, 1);
        _line = DialogUi.Num(0, 100, t?.LineSpacing ?? 0, 1);
        _originX = DialogUi.Num(-10000, 10000, t?.OriginX ?? origin.X);
        _originY = DialogUi.Num(-10000, 10000, t?.OriginY ?? origin.Y);
        _block = DialogUi.Num(0, 10000, t?.BlockWidth ?? 0);
        _color = DialogUi.ColorButton(t?.Color ?? defaultColor);
        _outlineWidth = DialogUi.Num(0, 64, t?.OutlineWidth ?? 0);
        _outlineColor = DialogUi.ColorButton(t?.OutlineColor ?? Color.Black);
        _shadow.Checked = t?.HasShadow ?? false;
        _shadowX = DialogUi.Num(-500, 500, t?.ShadowOffsetX ?? 2);
        _shadowY = DialogUi.Num(-500, 500, t?.ShadowOffsetY ?? 2);
        _shadowBlur = DialogUi.Num(0, 100, t?.ShadowBlur ?? 0);
        _shadowColor = DialogUi.ColorButton(t?.ShadowColor ?? Color.Black);
        Data = t?.Clone() ?? new TextData();

        var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        flow.Controls.Add(DialogUi.Row("Text", _text));
        flow.Controls.Add(DialogUi.Row("Font", _font));
        flow.Controls.Add(DialogUi.Row("Font size", _size));
        flow.Controls.Add(DialogUi.Row("Align", _align));
        flow.Controls.Add(DialogUi.Row("Letter spacing", _letter));
        flow.Controls.Add(DialogUi.Row("Line spacing", _line));
        flow.Controls.Add(DialogUi.Row("Origin X", _originX));
        flow.Controls.Add(DialogUi.Row("Origin Y", _originY));
        flow.Controls.Add(DialogUi.Row("Block width (0 = auto)", _block));
        flow.Controls.Add(DialogUi.Row("Color", _color));
        flow.Controls.Add(DialogUi.Row("Outline width", _outlineWidth));
        flow.Controls.Add(DialogUi.Row("Outline color", _outlineColor));
        flow.Controls.Add(DialogUi.Row("", _shadow));
        flow.Controls.Add(DialogUi.Row("Shadow offset X", _shadowX));
        flow.Controls.Add(DialogUi.Row("Shadow offset Y", _shadowY));
        flow.Controls.Add(DialogUi.Row("Shadow blur", _shadowBlur));
        flow.Controls.Add(DialogUi.Row("Shadow color", _shadowColor));
        flow.Controls.Add(DialogUi.Buttons((_, _) =>
        {
            Data = new TextData
            {
                Text = _text.Text,
                Font = (string)_font.SelectedItem!,
                FontSize = (double)_size.Value,
                Align = (string)_align.SelectedItem!,
                LetterSpacing = (double)_letter.Value,
                LineSpacing = (double)_line.Value,
                OriginX = (double)_originX.Value,
                OriginY = (double)_originY.Value,
                BlockWidth = (double)_block.Value,
                Color = _color.BackColor,
                OutlineWidth = (int)_outlineWidth.Value,
                OutlineColor = _outlineColor.BackColor,
                HasShadow = _shadow.Checked,
                ShadowOffsetX = (double)_shadowX.Value,
                ShadowOffsetY = (double)_shadowY.Value,
                ShadowBlur = (double)_shadowBlur.Value,
                ShadowColor = _shadowColor.BackColor
            };
            DialogResult = DialogResult.OK;
            Close();
        }));
        Controls.Add(flow);
    }
}

/// <summary>Create or edit a shape layer's data (Phase 48 ShapeData).</summary>
public sealed class ShapeLayerDialog : Form
{
    private readonly ComboBox _kind = new() { Width = 130, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly NumericUpDown _rx, _ry, _rw, _rh;
    private readonly NumericUpDown _fx, _fy, _tx, _ty;
    private readonly TextBox _points = new() { Width = 260 };
    private readonly TextBox _segments = new() { Width = 260 };
    private readonly CheckBox _closed = new() { Text = "Closed (fill the path)", AutoSize = true };
    private readonly CheckBox _fill = new() { Text = "Fill", AutoSize = true };
    private readonly Button _fillColor;
    private readonly CheckBox _stroke = new() { Text = "Stroke", AutoSize = true };
    private readonly Button _strokeColor;
    private readonly NumericUpDown _strokeWidth;
    private readonly List<(string Kind, Panel Row)> _kindRows = new();

    public ShapeData Data { get; private set; }

    public ShapeLayerDialog(ShapeData? initial, Color defaultFill, Color defaultStroke)
    {
        Text = "Shape layer";
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        var s = initial;
        _kind.Items.AddRange(new object[] { "rectangle", "ellipse", "line", "polygon", "path" });
        _kind.SelectedItem = s?.Kind ?? "rectangle";
        _rx = DialogUi.Num(-10000, 10000, s != null ? s.Rect.X : 40);
        _ry = DialogUi.Num(-10000, 10000, s != null ? s.Rect.Y : 40);
        _rw = DialogUi.Num(0, 10000, s != null ? s.Rect.Width : 160);
        _rh = DialogUi.Num(0, 10000, s != null ? s.Rect.Height : 120);
        _fx = DialogUi.Num(-10000, 10000, s?.From.X ?? 40);
        _fy = DialogUi.Num(-10000, 10000, s?.From.Y ?? 40);
        _tx = DialogUi.Num(-10000, 10000, s?.To.X ?? 200);
        _ty = DialogUi.Num(-10000, 10000, s?.To.Y ?? 160);
        _points.Text = s != null ? string.Join("; ", s.Points.Select(p => Fmt(p.X) + "," + Fmt(p.Y))) : "40,40; 200,40; 120,160";
        _segments.Text = s != null
            ? string.Join("; ", s.Segments.Select(seg => string.Join(" ", new[] { seg.P0, seg.C1, seg.C2, seg.P1 }.Select(p => Fmt(p.X) + "," + Fmt(p.Y)))))
            : "40,160 90,40 170,40 220,160";
        _closed.Checked = s?.Closed ?? false;
        _fill.Checked = s?.Fill != null || s == null;
        _fillColor = DialogUi.ColorButton(s?.Fill ?? defaultFill);
        _stroke.Checked = s?.Stroke != null;
        _strokeColor = DialogUi.ColorButton(s?.Stroke ?? defaultStroke);
        _strokeWidth = DialogUi.Num(0, 100, s?.StrokeWidth ?? 2, 1);
        Data = s?.Clone() ?? new ShapeData();

        var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        flow.Controls.Add(DialogUi.Row("Kind", _kind));
        AddKindRow(flow, "rectangle,ellipse", "Rect X", _rx);
        AddKindRow(flow, "rectangle,ellipse", "Rect Y", _ry);
        AddKindRow(flow, "rectangle,ellipse", "Rect width", _rw);
        AddKindRow(flow, "rectangle,ellipse", "Rect height", _rh);
        AddKindRow(flow, "line", "From X", _fx);
        AddKindRow(flow, "line", "From Y", _fy);
        AddKindRow(flow, "line", "To X", _tx);
        AddKindRow(flow, "line", "To Y", _ty);
        AddKindRow(flow, "polygon", "Points (x,y; ...)", _points);
        AddKindRow(flow, "path", "Segments (4 pts each)", _segments);
        AddKindRow(flow, "path", "", _closed);
        flow.Controls.Add(DialogUi.Row("Fill", _fill));
        flow.Controls.Add(DialogUi.Row("Fill color", _fillColor));
        flow.Controls.Add(DialogUi.Row("Stroke", _stroke));
        flow.Controls.Add(DialogUi.Row("Stroke color", _strokeColor));
        flow.Controls.Add(DialogUi.Row("Stroke width", _strokeWidth));
        flow.Controls.Add(DialogUi.Buttons((_, _) =>
        {
            try
            {
                Data = BuildData();
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "Shape layer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }));
        Controls.Add(flow);
        _kind.SelectedIndexChanged += (_, _) => UpdateKindRows();
        UpdateKindRows();
    }

    private static string Fmt(double v) => v.ToString(CultureInfo.InvariantCulture);

    private void AddKindRow(FlowLayoutPanel flow, string kinds, string label, Control input)
    {
        var row = DialogUi.Row(label, input);
        foreach (var kind in kinds.Split(',')) _kindRows.Add((kind, row));
        flow.Controls.Add(row);
    }

    private void UpdateKindRows()
    {
        var kind = (string)_kind.SelectedItem!;
        foreach (var (rowKind, row) in _kindRows) row.Visible = rowKind == kind;
    }

    private static DPoint ParsePoint(string text)
    {
        var parts = text.Split(',');
        if (parts.Length != 2) throw new FormatException("Expected a point as x,y, got: " + text);
        return new DPoint(
            double.Parse(parts[0].Trim(), CultureInfo.InvariantCulture),
            double.Parse(parts[1].Trim(), CultureInfo.InvariantCulture));
    }

    private static List<DPoint> ParsePoints(string text)
    {
        var points = new List<DPoint>();
        foreach (var part in text.Split(';'))
        {
            var trimmed = part.Trim();
            if (trimmed.Length > 0) points.Add(ParsePoint(trimmed));
        }
        return points;
    }

    private ShapeData BuildData()
    {
        var kind = (string)_kind.SelectedItem!;
        var data = new ShapeData
        {
            Kind = kind,
            Rect = new RectangleF((float)_rx.Value, (float)_ry.Value, (float)_rw.Value, (float)_rh.Value),
            From = new DPoint((double)_fx.Value, (double)_fy.Value),
            To = new DPoint((double)_tx.Value, (double)_ty.Value),
            Closed = _closed.Checked,
            Fill = _fill.Checked ? _fillColor.BackColor : null,
            Stroke = _stroke.Checked ? _strokeColor.BackColor : null,
            StrokeWidth = (double)_strokeWidth.Value
        };
        if (kind == "polygon")
        {
            data.Points = ParsePoints(_points.Text);
            if (data.Points.Count < 3) throw new FormatException("A polygon needs at least 3 points.");
        }
        if (kind == "path")
        {
            foreach (var part in _segments.Text.Split(';'))
            {
                var trimmed = part.Trim();
                if (trimmed.Length == 0) continue;
                var pts = trimmed.Split(new[] { ' ', '\\t' }, StringSplitOptions.RemoveEmptyEntries).Select(ParsePoint).ToList();
                if (pts.Count != 4) throw new FormatException("Each path segment needs exactly 4 points (start, control 1, control 2, end).");
                data.Segments.Add(new BezierSegment { P0 = pts[0], C1 = pts[1], C2 = pts[2], P1 = pts[3] });
            }
            if (data.Segments.Count == 0) throw new FormatException("A path needs at least 1 segment.");
        }
        return data;
    }
}
`;
}

/** MainForm.cs: the editor shell — workspace-docked panels, layer panel with Phase 44–52 controls, filters menu, dialogs. */
function mainFormCSharp(asm: string, appName: string): string {
  return `using System.Drawing.Imaging;

namespace ${asm};

/// <summary>
/// Editor shell: tool palette, layer panel (visibility, ordering,
/// opacity, blend mode, alpha lock, clipping, masks, effect
/// stacks), colors, a brush options bar driven by the Phase 46
/// settings model, filters and layer menus wired to the PixelEngine
/// core, undo/redo (snapshot history), import/export and project
/// save/load. Panel placement comes from the Phase 54 workspace
/// layout (Workspace.cs), and every command is reachable from the
/// keyboard via ShortcutResolver.
/// </summary>
public sealed class MainForm : Form
{
    private ImageDocument _doc = new(1024, 768);
    private readonly EditorCanvas _canvas = new() { Dock = DockStyle.Fill };
    private readonly ListBox _layerList = new() { Dock = DockStyle.Fill };
    private readonly Stack<byte[]> _undo = new();
    private readonly Stack<byte[]> _redo = new();

    // Layer panel controls (Phase 56).
    private readonly NumericUpDown _opacityBox = new() { Minimum = 0, Maximum = 100, Width = 70 };
    private readonly ComboBox _blendBox = new() { Width = 110, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly CheckBox _visibleCheck = new() { Text = "Visible", AutoSize = true };
    private readonly CheckBox _alphaLockCheck = new() { Text = "Alpha lock", AutoSize = true };
    private readonly CheckBox _clippedCheck = new() { Text = "Clipped", AutoSize = true };
    private readonly Button _maskAddBtn = new() { Text = "Add", AutoSize = true };
    private readonly Button _maskInvertBtn = new() { Text = "Invert", AutoSize = true };
    private readonly Button _maskApplyBtn = new() { Text = "Apply", AutoSize = true };
    private readonly Button _maskRemoveBtn = new() { Text = "Remove", AutoSize = true };
    private readonly CheckBox _maskPaintCheck = new() { Text = "Paint mask", Appearance = Appearance.Button, AutoSize = true };
    private readonly Label _layerStatus = new() { Dock = DockStyle.Bottom, Height = 20, TextAlign = ContentAlignment.MiddleLeft };

    // Brush options bar controls (Phase 56).
    private readonly ComboBox _presetBox = new() { Width = 130, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly NumericUpDown _brushSizeBox = new() { Minimum = 1, Maximum = 500, Width = 60 };
    private readonly NumericUpDown _brushHardBox = new() { Minimum = 0, Maximum = 100, Width = 55 };
    private readonly NumericUpDown _brushOpacityBox = new() { Minimum = 0, Maximum = 100, Width = 55 };
    private readonly NumericUpDown _brushFlowBox = new() { Minimum = 0, Maximum = 100, Width = 55 };

    private bool _syncing;

    public MainForm()
    {
        Text = "${appName} — Image Editor";
        Width = 1200; Height = 820;
        KeyPreview = true;
        _canvas.Document = _doc;
        _canvas.StrokeStarted += PushUndo;
        _canvas.ImageChanged += RefreshLayers;
        _canvas.TextToolClicked += p => AddTextLayer(p);

        var layout = WorkspaceData.DefaultLayout;

        var toolsEntry = WorkspaceData.FindPanel(layout, "tools");
        var tools = new FlowLayoutPanel { Dock = DockOf(toolsEntry), Visible = toolsEntry.Visible };
        if (tools.Dock is DockStyle.Top or DockStyle.Bottom) tools.Height = 40; else tools.Width = 110;
        foreach (var tool in Enum.GetValues<EditorTool>())
        {
            var b = new Button { Text = tool.ToString(), AutoSize = true };
            b.Click += (_, _) => _canvas.Tool = tool;
            tools.Controls.Add(b);
        }

        var colorsEntry = WorkspaceData.FindPanel(layout, "colors");
        var colors = new FlowLayoutPanel { Dock = DockOf(colorsEntry), Visible = colorsEntry.Visible };
        if (colors.Dock is DockStyle.Top or DockStyle.Bottom) colors.Height = 40; else colors.Width = 110;
        var colorBtn = new Button { Text = "Color…", AutoSize = true };
        colorBtn.Click += (_, _) => { using var d = new ColorDialog(); if (d.ShowDialog() == DialogResult.OK) _canvas.ForeColor2 = d.Color; };
        colors.Controls.Add(colorBtn);
        var bgBtn = new Button { Text = "BG Color…", AutoSize = true };
        bgBtn.Click += (_, _) => { using var d = new ColorDialog(); if (d.ShowDialog() == DialogResult.OK) _canvas.BackColor2 = d.Color; };
        colors.Controls.Add(bgBtn);
        var swapBtn = new Button { Text = "Swap colors", AutoSize = true };
        swapBtn.Click += (_, _) => { (_canvas.ForeColor2, _canvas.BackColor2) = (_canvas.BackColor2, _canvas.ForeColor2); };
        colors.Controls.Add(swapBtn);

        var layersEntry = WorkspaceData.FindPanel(layout, "layers");
        var side = new Panel { Dock = DockOf(layersEntry), Visible = layersEntry.Visible };
        if (side.Dock is DockStyle.Left or DockStyle.Right) side.Width = (int)(layersEntry.Weight * 70); else side.Height = (int)(layersEntry.Weight * 70);
        var addBtn = new Button { Text = "Add layer", Dock = DockStyle.Top };
        addBtn.Click += (_, _) => AddLayer();
        var upBtn = new Button { Text = "Move up", Dock = DockStyle.Top };
        upBtn.Click += (_, _) => MoveLayerUp();
        var delBtn = new Button { Text = "Delete layer", Dock = DockStyle.Top };
        delBtn.Click += (_, _) => DeleteLayer();
        var effectsBtn = new Button { Text = "Effects…", Dock = DockStyle.Top };
        effectsBtn.Click += (_, _) => EditEffects();
        var adjustBtn = new Button { Text = "Add adjustment layer", Dock = DockStyle.Top };
        adjustBtn.Click += (_, _) => AddAdjustmentLayer();

        var propsPanel = new Panel { Dock = DockStyle.Top, Height = 108 };
        var opacityLabel = new Label { Text = "Opacity %", Left = 4, Top = 6, Width = 70 };
        _opacityBox.Left = 78; _opacityBox.Top = 3;
        _opacityBox.ValueChanged += (_, _) => { if (!_syncing) { _doc.Active.Opacity = (double)_opacityBox.Value / 100.0; _canvas.Invalidate(); } };
        var blendLabel = new Label { Text = "Blend", Left = 4, Top = 33, Width = 70 };
        _blendBox.Left = 78; _blendBox.Top = 30;
        _blendBox.Items.AddRange(BlendModes.All);
        _blendBox.SelectedIndexChanged += (_, _) => { if (!_syncing && _blendBox.SelectedItem is string mode) { _doc.Active.BlendMode = mode; _canvas.Invalidate(); } };
        var flagsRow = new FlowLayoutPanel { Left = 2, Top = 58, Width = 250, Height = 26 };
        _visibleCheck.CheckedChanged += (_, _) => { if (!_syncing) { _doc.Active.Visible = _visibleCheck.Checked; RefreshLayers(); _canvas.Invalidate(); } };
        _alphaLockCheck.CheckedChanged += (_, _) => { if (!_syncing) _doc.Active.AlphaLock = _alphaLockCheck.Checked; };
        _clippedCheck.CheckedChanged += (_, _) => { if (!_syncing) { _doc.Active.Clipped = _clippedCheck.Checked; _canvas.Invalidate(); } };
        flagsRow.Controls.Add(_visibleCheck);
        flagsRow.Controls.Add(_alphaLockCheck);
        flagsRow.Controls.Add(_clippedCheck);
        propsPanel.Controls.Add(opacityLabel);
        propsPanel.Controls.Add(_opacityBox);
        propsPanel.Controls.Add(blendLabel);
        propsPanel.Controls.Add(_blendBox);
        propsPanel.Controls.Add(flagsRow);

        var maskPanel = new Panel { Dock = DockStyle.Top, Height = 58 };
        var maskLabel = new Label { Text = "Mask", Left = 4, Top = 4, Width = 200 };
        var maskRow = new FlowLayoutPanel { Left = 2, Top = 24, Width = 260, Height = 30 };
        _maskAddBtn.Click += (_, _) => MaskOp(() => { if (_doc.Active.Mask == null) _doc.CreateMask(_doc.Active); }, false);
        _maskInvertBtn.Click += (_, _) => MaskOp(() => _doc.InvertMask(_doc.Active), true);
        _maskApplyBtn.Click += (_, _) => MaskOp(() => _doc.ApplyMask(_doc.Active), true);
        _maskRemoveBtn.Click += (_, _) => MaskOp(() => _doc.RemoveMask(_doc.Active), true);
        _maskPaintCheck.CheckedChanged += (_, _) => _canvas.PaintMaskMode = _maskPaintCheck.Checked;
        maskRow.Controls.Add(_maskAddBtn);
        maskRow.Controls.Add(_maskInvertBtn);
        maskRow.Controls.Add(_maskApplyBtn);
        maskRow.Controls.Add(_maskRemoveBtn);
        maskRow.Controls.Add(_maskPaintCheck);
        maskPanel.Controls.Add(maskLabel);
        maskPanel.Controls.Add(maskRow);

        side.Controls.Add(_layerList);
        side.Controls.Add(adjustBtn);
        side.Controls.Add(effectsBtn);
        side.Controls.Add(maskPanel);
        side.Controls.Add(propsPanel);
        side.Controls.Add(delBtn);
        side.Controls.Add(upBtn);
        side.Controls.Add(addBtn);
        side.Controls.Add(_layerStatus);
        _layerList.SelectedIndexChanged += (_, _) => { if (_layerList.SelectedIndex >= 0) { _doc.ActiveIndex = _doc.Layers.Count - 1 - _layerList.SelectedIndex; RefreshLayerPanel(); _canvas.Invalidate(); } };

        var optionsBar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 36, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
        optionsBar.Controls.Add(new Label { Text = "Brush preset", AutoSize = true, Padding = new Padding(4, 8, 0, 0) });
        _presetBox.Items.Add("Custom");
        foreach (var (name, _) in BrushEngine.Presets) _presetBox.Items.Add(name);
        _presetBox.SelectedIndex = 0;
        _presetBox.SelectedIndexChanged += (_, _) =>
        {
            if (_syncing || _presetBox.SelectedIndex <= 0) return;
            var preset = BrushEngine.Presets[_presetBox.SelectedIndex - 1].Settings;
            _canvas.Brush.Size = preset.Size;
            _canvas.Brush.Hardness = preset.Hardness;
            _canvas.Brush.Spacing = preset.Spacing;
            _canvas.Brush.Opacity = preset.Opacity;
            _canvas.Brush.Flow = preset.Flow;
            _canvas.Brush.Smoothing = preset.Smoothing;
            _canvas.Brush.PressureSize = preset.PressureSize;
            _canvas.Brush.PressureOpacity = preset.PressureOpacity;
            SyncBrushBar();
        };
        optionsBar.Controls.Add(_presetBox);
        optionsBar.Controls.Add(new Label { Text = "Size", AutoSize = true, Padding = new Padding(8, 8, 0, 0) });
        _brushSizeBox.ValueChanged += (_, _) => { if (!_syncing) { _canvas.Brush.Size = (double)_brushSizeBox.Value; _canvas.BrushSize = (int)_brushSizeBox.Value; } };
        optionsBar.Controls.Add(_brushSizeBox);
        optionsBar.Controls.Add(new Label { Text = "Hardness %", AutoSize = true, Padding = new Padding(8, 8, 0, 0) });
        _brushHardBox.ValueChanged += (_, _) => { if (!_syncing) _canvas.Brush.Hardness = (double)_brushHardBox.Value / 100.0; };
        optionsBar.Controls.Add(_brushHardBox);
        optionsBar.Controls.Add(new Label { Text = "Opacity %", AutoSize = true, Padding = new Padding(8, 8, 0, 0) });
        _brushOpacityBox.ValueChanged += (_, _) => { if (!_syncing) _canvas.Brush.Opacity = (double)_brushOpacityBox.Value / 100.0; };
        optionsBar.Controls.Add(_brushOpacityBox);
        optionsBar.Controls.Add(new Label { Text = "Flow %", AutoSize = true, Padding = new Padding(8, 8, 0, 0) });
        _brushFlowBox.ValueChanged += (_, _) => { if (!_syncing) _canvas.Brush.Flow = (double)_brushFlowBox.Value / 100.0; };
        optionsBar.Controls.Add(_brushFlowBox);
        SyncBrushBar();

        var menu = new MenuStrip();
        var file = new ToolStripMenuItem("File");
        file.DropDownItems.Add(MenuItem("New project", "file.new", (_, _) => NewProject()));
        file.DropDownItems.Add(MenuItem("Import image…", null, (_, _) => ImportImage()));
        file.DropDownItems.Add(MenuItem("Export PNG…", "file.exportPng", (_, _) => ExportImage(ImageFormat.Png)));
        file.DropDownItems.Add(MenuItem("Export JPEG…", null, (_, _) => ExportImage(ImageFormat.Jpeg)));
        file.DropDownItems.Add(MenuItem("Export BMP…", null, (_, _) => ExportImage(ImageFormat.Bmp)));
        file.DropDownItems.Add(MenuItem("Save project…", "file.save", (_, _) => SaveProject()));
        file.DropDownItems.Add(MenuItem("Open project…", "file.open", (_, _) => OpenProject()));
        var edit = new ToolStripMenuItem("Edit");
        edit.DropDownItems.Add(MenuItem("Undo", "edit.undo", (_, _) => Undo()));
        edit.DropDownItems.Add(MenuItem("Redo", "edit.redo", (_, _) => Redo()));
        edit.DropDownItems.Add(MenuItem("Rotate 90°", "image.rotate90", (_, _) => { PushUndo(); _doc.RotateFlip(RotateFlipKind.Rotate90FlipNone); _canvas.Invalidate(); }));
        edit.DropDownItems.Add(MenuItem("Flip horizontal", "image.flipHorizontal", (_, _) => { PushUndo(); _doc.RotateFlip(RotateFlipKind.RotateNoneFlipX); _canvas.Invalidate(); }));
        var layerMenu = new ToolStripMenuItem("Layer");
        layerMenu.DropDownItems.Add(MenuItem("Add layer", "layer.add", (_, _) => AddLayer()));
        layerMenu.DropDownItems.Add(new ToolStripMenuItem("Add text layer…", null, (_, _) => AddTextLayer(null)));
        layerMenu.DropDownItems.Add(new ToolStripMenuItem("Add shape layer…", null, (_, _) => AddShapeLayer()));
        layerMenu.DropDownItems.Add(new ToolStripMenuItem("Add adjustment layer", null, (_, _) => AddAdjustmentLayer()));
        layerMenu.DropDownItems.Add(new ToolStripMenuItem("Edit content…", null, (_, _) => EditContent()));
        layerMenu.DropDownItems.Add(new ToolStripSeparator());
        layerMenu.DropDownItems.Add(new ToolStripMenuItem("Bake effects into pixels", null, (_, _) => BakeEffects()));
        layerMenu.DropDownItems.Add(new ToolStripSeparator());
        layerMenu.DropDownItems.Add(MenuItem("Move up", "layer.moveUp", (_, _) => MoveLayerUp()));
        layerMenu.DropDownItems.Add(MenuItem("Move down", "layer.moveDown", (_, _) => { _doc.MoveLayer(_doc.ActiveIndex, -1); RefreshLayers(); _canvas.Invalidate(); }));
        layerMenu.DropDownItems.Add(MenuItem("Delete layer", "layer.delete", (_, _) => DeleteLayer()));
        var filtersMenu = new ToolStripMenuItem("Filters");
        foreach (var descriptor in Filters.Descriptors)
        {
            var captured = descriptor;
            filtersMenu.DropDownItems.Add(new ToolStripMenuItem(captured.Name, null, (_, _) => ApplyFilter(captured)));
        }
        var selectMenu = new ToolStripMenuItem("Select");
        selectMenu.DropDownItems.Add(new ToolStripMenuItem("Select all", null, (_, _) => _canvas.SelectAll()));
        selectMenu.DropDownItems.Add(new ToolStripMenuItem("Clear selection", null, (_, _) => _canvas.ClearSelection()));
        menu.Items.Add(file); menu.Items.Add(edit); menu.Items.Add(layerMenu); menu.Items.Add(filtersMenu); menu.Items.Add(selectMenu);

        Controls.Add(_canvas); Controls.Add(side); Controls.Add(colors); Controls.Add(tools); Controls.Add(optionsBar); Controls.Add(menu);
        MainMenuStrip = menu;
        RefreshLayers();
    }

    private static DockStyle DockOf(PanelLayoutEntry entry) => entry.Dock switch
    {
        "left" => DockStyle.Left,
        "right" => DockStyle.Right,
        "top" => DockStyle.Top,
        "bottom" => DockStyle.Bottom,
        _ => DockStyle.Right
    };

    private static ToolStripMenuItem MenuItem(string text, string? command, EventHandler onClick)
    {
        var item = new ToolStripMenuItem(text, null, onClick);
        if (command != null && WorkspaceData.Shortcuts.TryGetValue(command, out var chord))
            item.ShortcutKeyDisplayString = chord;
        return item;
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        var command = ShortcutResolver.Resolve(e);
        if (command != null && DispatchCommand(command))
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            return;
        }
        base.OnKeyDown(e);
    }

    private bool DispatchCommand(string command)
    {
        switch (command)
        {
            case "edit.undo": Undo(); return true;
            case "edit.redo": Redo(); return true;
            case "file.new": NewProject(); return true;
            case "file.open": OpenProject(); return true;
            case "file.save": SaveProject(); return true;
            case "file.exportPng": ExportImage(ImageFormat.Png); return true;
            case "layer.add": AddLayer(); return true;
            case "layer.delete": DeleteLayer(); return true;
            case "layer.moveUp": MoveLayerUp(); return true;
            case "layer.moveDown": _doc.MoveLayer(_doc.ActiveIndex, -1); RefreshLayers(); _canvas.Invalidate(); return true;
            case "view.zoomIn": _canvas.ZoomBy(1.25f); return true;
            case "view.zoomOut": _canvas.ZoomBy(0.8f); return true;
            case "image.rotate90": PushUndo(); _doc.RotateFlip(RotateFlipKind.Rotate90FlipNone); _canvas.Invalidate(); return true;
            case "image.flipHorizontal": PushUndo(); _doc.RotateFlip(RotateFlipKind.RotateNoneFlipX); _canvas.Invalidate(); return true;
            default:
                if (command.StartsWith("tool.") && Enum.TryParse<EditorTool>(command.Substring(5), true, out var tool))
                { _canvas.Tool = tool; return true; }
                return false;
        }
    }

    private void NewProject()
    {
        _doc.Dispose();
        _doc = new ImageDocument(1024, 768);
        _canvas.Document = _doc;
        _undo.Clear(); _redo.Clear();
        RefreshLayers(); _canvas.Invalidate();
    }

    private void SaveProject()
    {
        using var d = new FolderBrowserDialog();
        if (d.ShowDialog() == DialogResult.OK) _doc.SaveProject(d.SelectedPath);
    }

    private void OpenProject()
    {
        using var d = new FolderBrowserDialog();
        if (d.ShowDialog() != DialogResult.OK) return;
        ImageDocument loaded;
        try
        {
            loaded = ImageDocument.LoadProject(d.SelectedPath);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not open project: " + ex.Message, "Open project", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        _doc.Dispose();
        _doc = loaded;
        _canvas.Document = _doc;
        _undo.Clear(); _redo.Clear();
        RefreshLayers(); _canvas.Invalidate();
    }

    private void AddLayer()
    {
        PushUndo();
        _doc.AddLayer("Layer " + (_doc.Layers.Count + 1));
        RefreshLayers(); _canvas.Invalidate();
    }

    private void DeleteLayer()
    {
        if (_doc.Layers.Count <= 1) return;
        PushUndo();
        _doc.RemoveLayer(_doc.ActiveIndex);
        RefreshLayers(); _canvas.Invalidate();
    }

    private void MoveLayerUp()
    {
        _doc.MoveLayer(_doc.ActiveIndex, 1);
        RefreshLayers(); _canvas.Invalidate();
    }

    private void AddAdjustmentLayer()
    {
        PushUndo();
        _doc.AddLayer("Adjustment " + (_doc.Layers.Count + 1), "adjustment");
        RefreshLayers(); _canvas.Invalidate();
    }

    private void AddTextLayer(Point? origin)
    {
        using var dialog = new TextLayerDialog(null, origin ?? new Point(_doc.Width / 2 - 60, _doc.Height / 2 - 10), _canvas.ForeColor2);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        PushUndo();
        _doc.AddTextLayer(dialog.Data);
        RefreshLayers(); _canvas.Invalidate();
    }

    private void AddShapeLayer()
    {
        using var dialog = new ShapeLayerDialog(null, _canvas.ForeColor2, _canvas.BackColor2);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        PushUndo();
        _doc.AddShapeLayer(dialog.Data);
        RefreshLayers(); _canvas.Invalidate();
    }

    private void EditContent()
    {
        var layer = _doc.Active;
        if (layer.Kind == "text" && layer.Text != null)
        {
            using var dialog = new TextLayerDialog(layer.Text, new Point((int)layer.Text.OriginX, (int)layer.Text.OriginY), _canvas.ForeColor2);
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            PushUndo();
            layer.Text = dialog.Data;
            _doc.RenderContentLayer(layer);
            RefreshLayers(); _canvas.Invalidate();
        }
        else if (layer.Kind == "shape" && layer.Shape != null)
        {
            using var dialog = new ShapeLayerDialog(layer.Shape, _canvas.ForeColor2, _canvas.BackColor2);
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            PushUndo();
            layer.Shape = dialog.Data;
            _doc.RenderContentLayer(layer);
            RefreshLayers(); _canvas.Invalidate();
        }
        else
        {
            MessageBox.Show("The active layer has no editable content. Text and shape layers carry editable data; raster layers are pixels.", "Edit content", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private void EditEffects()
    {
        var layer = _doc.Active;
        using var dialog = new EffectsDialog(layer.Name, layer.Effects);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        PushUndo();
        layer.Effects.Clear();
        foreach (var effect in dialog.Result) layer.Effects.Add(effect.Clone());
        RefreshLayers(); _canvas.Invalidate();
    }

    private void BakeEffects()
    {
        var layer = _doc.Active;
        var snapshot = Snapshot();
        try
        {
            _doc.BakeEffects(layer);
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(ex.Message, "Bake effects", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        _undo.Push(snapshot);
        _redo.Clear();
        RefreshLayers(); _canvas.Invalidate();
    }

    private void ApplyFilter(FilterDescriptor descriptor)
    {
        var layer = _doc.Active;
        if (layer.Kind == "adjustment")
        {
            MessageBox.Show("Adjustment layers take filters through their effect stack — use Effects… on the layer panel.", "Filters", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Dictionary<string, double>? filterParams = null;
        if (descriptor.Params.Length > 0)
        {
            using var dialog = new FilterParamsDialog(descriptor, null);
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            filterParams = dialog.Result;
        }
        PushUndo();
        try
        {
            layer.SetPixels(Filters.Apply(layer.Pixels, descriptor.Id, filterParams, _canvas.Selection));
        }
        catch (ArgumentException ex)
        {
            MessageBox.Show(ex.Message, "Filters", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        RefreshLayers(); _canvas.Invalidate();
    }

    private void MaskOp(Action op, bool undoable)
    {
        try
        {
            if (undoable) PushUndo();
            op();
        }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(ex.Message, "Mask", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        RefreshLayers(); _canvas.Invalidate();
    }

    private void SyncBrushBar()
    {
        _syncing = true;
        _brushSizeBox.Value = (decimal)Math.Min(500, Math.Max(1, _canvas.Brush.Size));
        _brushHardBox.Value = (decimal)Math.Min(100, Math.Max(0, _canvas.Brush.Hardness * 100));
        _brushOpacityBox.Value = (decimal)Math.Min(100, Math.Max(0, _canvas.Brush.Opacity * 100));
        _brushFlowBox.Value = (decimal)Math.Min(100, Math.Max(0, _canvas.Brush.Flow * 100));
        _canvas.BrushSize = (int)_canvas.Brush.Size;
        _syncing = false;
    }

    private byte[] Snapshot()
    {
        using var ms = new MemoryStream();
        using var flat = _doc.Flatten();
        flat.Save(ms, ImageFormat.Png);
        return ms.ToArray();
    }

    private void PushUndo() { _undo.Push(Snapshot()); _redo.Clear(); }

    private void Undo()
    {
        if (_undo.Count == 0) return;
        _redo.Push(Snapshot());
        Restore(_undo.Pop());
    }

    private void Redo()
    {
        if (_redo.Count == 0) return;
        _undo.Push(Snapshot());
        Restore(_redo.Pop());
    }

    private void Restore(byte[] png)
    {
        using var ms = new MemoryStream(png);
        var bmp = new Bitmap(ms);
        _doc.Active.SetPixels(PixelImage.FromBitmap(bmp));
        bmp.Dispose();
        _canvas.Invalidate();
    }

    private void ImportImage()
    {
        using var d = new OpenFileDialog
        {
            Filter = "Image files|*.png;*.jpg;*.jpeg;*.bmp|PNG|*.png|JPEG|*.jpg;*.jpeg|BMP|*.bmp",
            Title = "Import image"
        };
        if (d.ShowDialog() != DialogResult.OK) return;
        string name = Path.GetFileName(d.FileName);
        byte[] bytes;
        try { bytes = File.ReadAllBytes(d.FileName); }
        catch (Exception ex)
        {
            MessageBox.Show("Could not read '" + name + "': " + ex.Message, "Import image", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        // Phase 58: judge the file by its content, not its name, and
        // refuse PSD/TIFF/corrupt data with the named message from
        // ImageFileSupport instead of System.Drawing's generic error.
        try { ImageFileSupport.EnsureImportable(bytes, name); }
        catch (InvalidOperationException ex)
        {
            MessageBox.Show(ex.Message, "Import image", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        PixelImage pixels;
        try
        {
            // FromStream over the bytes already read: the file is not
            // kept locked the way Image.FromFile would keep it.
            using var ms = new MemoryStream(bytes);
            using var img = Image.FromStream(ms);
            using var bmp = new Bitmap(_doc.Width, _doc.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp)) g.DrawImage(img, 0, 0);
            pixels = PixelImage.FromBitmap(bmp);
        }
        catch (Exception ex)
        {
            MessageBox.Show("'" + name + "' could not be decoded as an image (" + ex.Message + "). The file may be corrupt.", "Import image", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        PushUndo();
        var layer = _doc.AddLayer(name);
        layer.SetPixels(pixels);
        RefreshLayers(); _canvas.Invalidate();
    }

    /// <summary>Phase 58: the explicit JPEG export quality (0-100), applied through GDI+ encoder parameters in SaveJpeg.</summary>
    private const long JpegExportQuality = 90L;

    private void ExportImage(ImageFormat format)
    {
        string ext = format == ImageFormat.Png ? "png" : format == ImageFormat.Jpeg ? "jpg" : "bmp";
        string filter = format == ImageFormat.Png ? "PNG image|*.png" : format == ImageFormat.Jpeg ? "JPEG image|*.jpg" : "BMP image|*.bmp";
        using var d = new SaveFileDialog { Filter = filter, DefaultExt = ext, AddExtension = true, FileName = "export." + ext };
        if (d.ShowDialog() != DialogResult.OK) return;
        string path = d.FileName;
        // Extension/format agreement: the bytes written are always
        // the chosen format, so a name typed with a different
        // extension is corrected instead of producing a mislabeled
        // file.
        if (!string.Equals(Path.GetExtension(path), "." + ext, StringComparison.OrdinalIgnoreCase))
            path = Path.ChangeExtension(path, ext);
        using var flat = _doc.Flatten();
        try
        {
            if (format == ImageFormat.Jpeg) SaveJpeg(flat, path, JpegExportQuality);
            else flat.Save(path, format);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Could not export to '" + Path.GetFileName(path) + "': " + ex.Message, "Export", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>Save a bitmap as JPEG at an explicit quality, via the GDI+ JPEG codec's encoder parameters.</summary>
    private static void SaveJpeg(Bitmap bmp, string path, long quality)
    {
        ImageCodecInfo? codec = null;
        foreach (var candidate in ImageCodecInfo.GetImageEncoders())
        {
            if (candidate.FormatID == ImageFormat.Jpeg.Guid) { codec = candidate; break; }
        }
        if (codec == null) { bmp.Save(path, ImageFormat.Jpeg); return; }
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
        bmp.Save(path, codec, parameters);
    }

    private void RefreshLayers()
    {
        _layerList.Items.Clear();
        for (int i = _doc.Layers.Count - 1; i >= 0; i--)
        {
            var l = _doc.Layers[i];
            var suffix = "";
            if (l.Kind != "raster") suffix += " [" + l.Kind + "]";
            if (l.Mask != null) suffix += " [mask]";
            if (l.Effects.Count > 0) suffix += " [fx " + l.Effects.Count + "]";
            if (!l.Visible) suffix += " (hidden)";
            _layerList.Items.Add(l.Name + suffix);
        }
        RefreshLayerPanel();
    }

    private void RefreshLayerPanel()
    {
        if (_doc.Layers.Count == 0) return;
        var layer = _doc.Active;
        _syncing = true;
        _opacityBox.Value = (decimal)Math.Min(100, Math.Max(0, layer.Opacity * 100));
        _blendBox.SelectedItem = layer.BlendMode;
        _visibleCheck.Checked = layer.Visible;
        _alphaLockCheck.Checked = layer.AlphaLock;
        _clippedCheck.Checked = layer.Clipped;
        bool hasMask = layer.Mask != null;
        _maskInvertBtn.Enabled = hasMask;
        _maskApplyBtn.Enabled = hasMask;
        _maskRemoveBtn.Enabled = hasMask;
        _maskPaintCheck.Enabled = hasMask;
        if (!hasMask && _maskPaintCheck.Checked) _maskPaintCheck.Checked = false;
        _layerStatus.Text = layer.Kind + " layer" + (hasMask ? " · mask" : "") + (layer.Effects.Count > 0 ? " · " + layer.Effects.Count + " effect(s)" : "");
        _syncing = false;
    }
}
`;
}

/** Workspace.cs: Phase 54 workspace data + shortcut resolver (unchanged in Phase 56). */
function workspaceCSharp(asm: string): string {
  const defaultWorkspace = createDefaultWorkspace();
  const focusWorkspace = createFocusWorkspace();
  return (
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
    `    public static readonly PanelLayoutEntry[] DefaultLayout = { ` +
    layoutCSharp(defaultWorkspace) +
    ` };\n\n` +
    `    public static readonly PanelLayoutEntry[] FocusLayout = { ` +
    layoutCSharp(focusWorkspace) +
    ` };\n\n` +
    `    public static readonly IReadOnlyDictionary<string, string> Shortcuts = new Dictionary<string, string>\n    {\n` +
    shortcutsCSharp(defaultWorkspace) +
    `\n    };\n\n` +
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
    `                return null;\n        }\n    }\n}\n`
  );
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
 *
 * Phase 56: the generated app now runs on a genuine C# port of the
 * TS graphics engine (PixelEngine.cs): the Phase 44 blend modes,
 * masks, alpha lock and clipping in the compositor; the Phase 46
 * coverage brush with its settings model and presets; the full
 * Phase 47 filter registry (descriptor table generated from the TS
 * registry) behind a Filters menu and parameter dialog; Phase 48
 * text and shape layers stored as editable data and rendered with
 * the engine's own bitmap fonts and rasterizers; and Phase 52
 * non-destructive editing — per-layer effect stacks, adjustment
 * layers, and an explicit bake. Project save/load round-trips all
 * of it and still loads Phase 19 manifests.
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
      `        // Phase 60: an unhandled error must never die silently.\n` +
      `        // UI-thread exceptions are caught here, written to a crash\n` +
      `        // report next to the executable (CrashDiagnostics), and\n` +
      `        // shown to the user with the report's path. Exceptions on\n` +
      `        // background threads are fatal, so they are recorded the\n` +
      `        // same way on their way out.\n` +
      `        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);\n` +
      `        Application.ThreadException += (sender, e) =>\n` +
      `        {\n` +
      `            var reportPath = CrashDiagnostics.TryWriteReport(e.Exception, "WinForms UI thread");\n` +
      `            MessageBox.Show(\n` +
      `                reportPath != null\n` +
      `                    ? "${config.appName} hit an unexpected error. A crash report was written to:\\n\\n" + reportPath + "\\n\\nThe error may have interrupted the current operation; save your work and restart if anything looks wrong."\n` +
      `                    : "${config.appName} hit an unexpected error, and the crash report could not be written. The error may have interrupted the current operation; save your work and restart if anything looks wrong.",\n` +
      `                "${config.appName} - unexpected error",\n` +
      `                MessageBoxButtons.OK,\n` +
      `                MessageBoxIcon.Error);\n` +
      `        };\n` +
      `        AppDomain.CurrentDomain.UnhandledException += (sender, e) =>\n` +
      `        {\n` +
      `            if (e.ExceptionObject is Exception ex)\n` +
      `                CrashDiagnostics.TryWriteReport(ex, "background thread (fatal)");\n` +
      `        };\n` +
      `        Application.Run(new MainForm());\n` +
      `    }\n}\n`;

    delete files[`${root}/MainForm.cs`];
    delete files[`${root}/MainForm.Designer.cs`];

    files[`${root}/CrashDiagnostics.cs`] = crashDiagnosticsCSharp(asm, config.appName, config.version);
    files[`${root}/PixelEngine.cs`] = pixelEngineCSharp(asm);
    files[`${root}/PixelEngine.Drawing.cs`] = pixelEngineDrawingCSharp(asm);
    files[`${root}/ImageDocument.cs`] = imageDocumentCSharp(asm);
    files[`${root}/ImageDocument.Drawing.cs`] = imageDocumentDrawingCSharp(asm);
    files[`${root}/EditorCanvas.cs`] = editorCanvasCSharp(asm);
    files[`${root}/Dialogs.cs`] = dialogsCSharp(asm);
    files[`${root}/MainForm.cs`] = mainFormCSharp(asm, config.appName);
    files[`${root}/Workspace.cs`] = workspaceCSharp(asm);

    files['README.md'] =
      `# ${config.appName}\n\nA layered image-editing application generated by SquadForge (Phase 19 Image Editing Engine on the Phase 18 desktop stack; Phase 56 connects the full graphics engine).\n\n` +
      `## Features\n- Canvas with zoom (mouse wheel, anchored) and pan (middle-drag or Space+drag), rectangular selection tool\n` +
      `- Layers: add, reorder, delete, visibility, opacity, six blend modes (normal/multiply/screen/overlay/darken/lighten), alpha lock, clipping\n` +
      `- Masks: add, paint (with the brush), invert, apply, remove — grayscale masks modulate compositing\n` +
      `- Brush: the Phase 46 coverage engine (size, hardness, spacing, opacity, flow, smoothing) with the engine's built-in presets; eraser is a true alpha erase on the same model\n` +
      `- Filters: the full Phase 47 registry (16 filters) with validated parameter dialogs, scoped by the selection; includes brightness/contrast, saturation, hue rotate, sepia, blurs, sharpen, noise, edge detect, emboss, wave, swirl, posterize, threshold\n` +
      `- Text and shape layers stored as editable data, rendered with the engine's built-in bitmap fonts (pixel, pixel-bold) and vector rasterizers (rectangle, ellipse, line, polygon, Bezier path)\n` +
      `- Non-destructive editing: per-layer effect stacks (add/toggle/edit/reorder), adjustment layers, and an explicit bake-into-pixels command\n` +
      `- Undo/redo (flatten-snapshot history)\n` +
      `- Project save/load: folder with project.json + one PNG per layer and mask; blend modes, masks, effect stacks and content-layer data round-trip; Phase 19 project folders still load\n` +
      `- Import PNG/BMP/JPEG (detected by content; PSD/TIFF refused with a named message); export flattened PNG/JPEG (explicit quality 90)/BMP with extension/format agreement\n` +
      `- Crash reports (Phase 60): an unhandled error writes a plain-text report (app name/version ${config.version}, OS, runtime, exception and stack trace) to a \`crashes\` folder next to the executable, and the user is shown the report's path\n\n` +
      `## Develop\nOpen the .sln in Visual Studio 2022 or run \`dotnet build\`. Entry point: \`src/${asm}/Program.cs\`; engine core: \`PixelEngine.cs\` (raw-buffer; \`PixelEngine.Drawing.cs\` is its GDI boundary); document model: \`ImageDocument.cs\` (\`ImageDocument.Drawing.cs\` holds its GDI surface); surface: \`EditorCanvas.cs\`; shell: \`MainForm.cs\`; dialogs: \`Dialogs.cs\`; crash diagnostics: \`CrashDiagnostics.cs\` (UI-independent). The engine core and document model have no System.Drawing.Common dependency and run headless on any .NET 8 platform.\n`;

    return files;
  }
}
