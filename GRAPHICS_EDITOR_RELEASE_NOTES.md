# SquadForge Graphics Editor — Release Notes

**Version 1.0.0 — 2026-11-27**

This release ships two packages, both built with the existing
SquadForge desktop architecture (Phase 18/36 Desktop Development
Engine). They are different applications — read the package list
before downloading.

## Packages

### 1. PixelForge 1.0.0 for Windows (`PixelForge-1.0.0-win-x64.zip`)

The graphics editor: a layered image-editing application generated
by SquadForge (engine: Phase 19, extended by Phases 44–59).

- Canvas with zoom (mouse wheel, anchored) and pan; rectangular
  selection tool that scopes painting and filters
- Layers: add, reorder, delete, visibility, opacity, six blend
  modes (normal, multiply, screen, overlay, darken, lighten),
  alpha lock, clipping to the layer below
- Layer masks: create, paint with the brush, invert, apply, remove
- Brush: a coverage-accumulating engine (size, hardness, spacing,
  opacity, flow, smoothing) with the engine's built-in presets;
  the eraser is a true alpha erase on the same model
- Filters: the full 16-filter registry (brightness/contrast,
  saturation, hue rotate, sepia, grayscale, invert, box blur,
  Gaussian blur, sharpen, noise, edge detect, emboss, wave, swirl,
  posterize, threshold) with validated parameter dialogs
- Text and shape layers stored as editable data (built-in bitmap
  fonts `pixel` and `pixel-bold`; rectangle, ellipse, line,
  polygon and Bézier-path shapes), re-rendered from their data
- Non-destructive editing: per-layer effect stacks
  (add/toggle/edit/reorder), adjustment layers, and an explicit
  bake-into-pixels command
- Undo/redo (flatten-snapshot history)
- Workspace: docked panels from the layout model and a 21-command
  keyboard shortcut map
- Projects: save/load as a folder (`project.json` + one PNG per
  layer and mask); blend modes, masks, effect stacks and
  content-layer data round-trip; project folders written by the
  original Phase 19 app still load

### 2. SquadForgeApp 1.0.0 for Linux (`SquadForgeApp-1.0.0-linux-x64.tar.gz`)

The Desktop Development Engine's Linux application (Avalonia UI):
a main window with an editable message, a Save action, and
persistent state (launch count, last message) stored as JSON in
the per-user config directory. It also has a headless `--smoke`
diagnostics mode that exercises the state store without opening a
window.

**This package is not the image editor.** In the current
architecture the graphics editor's GUI is Windows-only (WinForms);
no Linux build of PixelForge exists, and none is claimed here.

## System requirements

- **Windows package:** 64-bit Windows 10 or 11, and the
  **.NET 8 Desktop Runtime** (free from Microsoft). The package is
  framework-dependent: it does not bundle the runtime. Unzip
  anywhere and run `PixelForge.exe`.
- **Linux package:** 64-bit Linux with the **.NET 8 Runtime**
  installed. Unzip, then run `./SquadForgeApp` (a display is
  needed for the window; `./SquadForgeApp --smoke` runs headless).
- Both packages are unsigned. Windows SmartScreen and Linux
  download quarantines may warn on first run; the packages carry a
  `SHA256SUMS` file so their contents can be verified.

## Supported formats

Format support below is the TypeScript engine's (the core the
desktop app is generated from), with the desktop app's own surface
called out separately. Everything unsupported is refused with a
named error — nothing is silently mis-decoded.

| Format | Engine (server / library) | PixelForge desktop app |
| :--- | :--- | :--- |
| PNG | Full: 8-bit and 16-bit, color types 0/2/3/4/6 (palette + tRNS expanded), grayscale encode, ICC profile carried byte-exact (never applied) | Import + export via System.Drawing |
| JPEG | Decode baseline **and** progressive; encode baseline at quality 1–100 (default 90). No alpha (a property of the format) | Import; export at pinned quality 90 |
| BMP | 24/32-bit uncompressed read/write | Import + export |
| TIFF | Decode classic TIFF (little/big endian): uncompressed, LZW and PackBits compression, predictor 2, grayscale / gray+alpha / RGB / RGBA / palette at 8-bit, 16-bit via the 16-bit path; multi-page files decode page 1 (count reported). Encode uncompressed | **Refused by name** — use the engine |
| PSD | Scoped genuine support: PSD v1 (8BPS), RGB, 8-bit — layer records, groups, masks, blend keys, RAW/RLE/ZIP channel data; unsupported features (text/effects/smart objects, …) are reported as import warnings, never dropped silently | **Refused by name** — use the engine |

Named refusals (detected and rejected with the reason, in the
engine): TIFF with Deflate or JPEG compression, CCITT, tiled
layout, BigTIFF, CMYK/YCbCr/CIELab photometrics, float or signed
samples, predictor 3, bit depths other than 8/16; PSD in PSB
format, non-RGB color modes, 16/32-bit depth; PNG at sub-8-bit
depths (except the documented palette/grayscale handling) and
interlaced PNG. CMYK JPEG files are not verified and are not
claimed. In the desktop app, format detection is **by content**
(magic bytes), never by file name — a misnamed file is judged by
what it is.

The engine also provides, beyond the desktop app's surface:
free-form selections and transforms (Phase 45), actions and batch
processing (Phase 53), a 16-bit working representation (Phase 50),
and an opt-in parallel CPU compute provider (Phases 51/59 —
serial CPU remains the default everywhere).

## Crash reports

PixelForge does not die silently. If an unhandled error occurs:

- a plain-text crash report is written to a **`crashes` folder
  next to `PixelForge.exe`**, named `crash-<UTC timestamp>.log`;
- the report contains the app name and version, the timestamp, the
  OS and .NET runtime, the context (UI thread vs. background
  thread), and the exception type, message and stack trace
  (including inner exceptions);
- for errors on the UI thread, a message box tells you an error
  occurred and names the report file, so you can attach it to a
  bug report. Background-thread errors are fatal; their report is
  written on the way out.

## Known limitations

- **The PixelForge GUI has never been run on a Windows machine by
  the SquadForge team.** It is compile-verified (genuine .NET
  builds, zero diagnostics), and its engine core and document
  model — the code every menu, tool and dialog calls — have been
  executed headless on Linux across the full editing workflow
  surface (16 scenarios, 171 assertions, 0 failures). The window
  itself — mouse canvas events, panel rendering, visual layout,
  the undo/redo interaction — is unverified until its first run on
  a real Windows machine, which remains an owner-side check.
- **No GPU acceleration exists.** This was investigated directly
  (Phase 59): the development environment has no GPU, no WebGPU
  and no software Vulkan driver. The compute-provider
  architecture admits a future GPU backend without engine
  changes; today every pixel is CPU-rendered.
- Desktop app scope: no layer groups inside the app (the engine
  has them; the app's layer model is flat), rectangle selections
  only, the Speckle Tip brush preset paints with a round tip,
  brush pressure is modelled input rather than sensed from a
  tablet, JPEG export quality is pinned at 90 rather than a
  slider, and guides/grid are data + snapping logic without a
  rendered overlay.
- Serial compositing performance is unchanged by the Phase 59
  optimization pass (its measured wins are the blur/convolution
  filters at ~2.1×, effect-stack rendering at ~1.44×, localized
  brush strokes at ~3.7×, and the rebuilt parallel transport —
  all with byte-identical output).

## Verification for this release

- Release builds produced by the project's own
  `DesktopBuildPipeline` in Release configuration; the Windows
  executable is PE-verified and the Linux apphost ELF-verified.
- The Linux package was extracted into a fresh directory on the
  build machine and its apphost run twice with `--smoke`: the
  launch count persisted across runs (1, then 2).
- The Windows package's contents were verified file-by-file
  against the build output (manifest diff) — every file the
  apphost needs (`PixelForge.exe`, `PixelForge.dll`,
  `PixelForge.deps.json`, `PixelForge.runtimeconfig.json`) is
  present and byte-identical to the build.
- Final regression: all graphics-editor suites (Phases 19, 44–60)
  plus the desktop suites (Phases 18, 36) pass in one run; the
  runtime harness passes 16 scenarios / 171 assertions.
  Full-repository CI confirmation comes with the owner's push.
- Full detail: `PHASE_60_ACCEPTANCE_REPORT.md` in the SquadForge
  repository.
