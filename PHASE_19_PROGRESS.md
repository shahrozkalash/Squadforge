# Phase 19 Progress — Image Editing Engine

Date: 2026-11-25
Baseline: `34b5d117` (main, after Phase 18)
Status: **Implemented and verified.** The TypeScript engine performs real pixel operations with a full test suite, and the generated C# editor application compiles genuinely through the Phase 18 pipeline. Acceptance is the owner's decision.

## What was built

`server/imageEditor/`:

- `types.ts` — RGBA `PixelImage`, `Layer`, `ImageProject`, selection/tool/viewport types, serialized project format.
- `imageCore.ts` — the editing engine, all real math on real buffers:
  - **Layers**: add/remove/reorder, visibility, opacity; `composite()` flattens bottom→top with source-over alpha blending (50% blue over red composites to purple — verified numerically).
  - **Canvas model**: viewport zoom (anchored, clamped 0.05–32×), pan, screen↔image conversions.
  - **Tools**: brush (interpolated strokes), eraser (true alpha reduction), rectangle, ellipse, line, fill, and text via the built-in bitmap font. A rectangular **selection** scopes every tool and adjustment.
  - **Transforms**: crop (validated bounds), bilinear resize, exact 90°/180°/270° rotation, flip.
  - **Adjustments**: brightness/contrast (standard factor curve), saturation (luma-based), grayscale, invert.
  - **Undo/redo**: bounded snapshot history (30 states).
  - **Persistence**: project serialize/deserialize (JSON manifest + base64 layer pixels) with size/format validation — corrupt data is rejected, never silently loaded.
- `bitmapFont.ts` — a built-in 5×7 bitmap font (A–Z, 0–9, punctuation) so text rasterizes real glyphs with zero external font dependencies.
- `imageCodec.ts` — real import/export: PNG encoder + decoder (8-bit RGB/RGBA, all five scanline filters, CRC-checked chunks, zlib via Node built-ins) and BMP 24/32-bit read/write. Format detection is by signature.
- `imageProjectGenerator.ts` — generates a complete C# WinForms image editor on the Phase 18 stack: `ImageDocument.cs` (layers, flatten with opacity via ColorMatrix, resize/rotate, project save/load as JSON + per-layer PNGs), `EditorCanvas.cs` (zoom/pan surface, all tools, true alpha erase via `CompositingMode.SourceCopy`), `MainForm.cs` (tool palette, layer panel, undo/redo, import PNG/BMP/JPEG, export PNG/JPEG).
- `imageEditorRoutes.ts` — `/api/builds/:id/image-editor` (generate the app source into the build's files; export: composite a posted project and return a real PNG/BMP), mounted in `server.ts` with the same auth + ownership dependencies as Phases 17/18.

## Genuine evidence

- **Engine tests: 24/24 pass** (`tests/phase19_image_editing_engine.test.ts`) — compositing math, layer ops, tools incl. selection scoping and glyph rasterization, transforms, exact adjustment values, undo/redo, persistence round-trip and corruption rejection, PNG/BMP round-trips byte-checked, viewport math, generator structure.
- **Generated app compiles**: driven through the Phase 18 `DesktopBuildPipeline` — `dotnet build` exit 0, producing `PixelForge.exe` (152,064 bytes, sha256 `ae2c6a1c8811aac5edf058e8bc282602e197e0cde221ce1576e370434bb28d94`, PE-verified x64 Windows GUI) and `PixelForge.dll` (25,600 bytes of editor code).
- Lint (`tsc --noEmit`) ✅ · production web build ✅.

## Limitations (stated honestly)

- **JPEG**: the TypeScript engine does not encode/decode JPEG — there is no pure-TS JPEG codec here, so JPEG is reported as unsupported rather than simulated. The generated desktop app does support JPEG through System.Drawing.
- PNG decode covers 8-bit RGB/RGBA, non-interlaced (the engine's own exports and the common import case); palette/gray/16-bit PNGs are rejected with a clear error.
- Rotation is exact 90° steps; arbitrary-angle rotation is future work.
- Text uses the built-in 5×7 bitmap font in the TS engine (the generated app uses system fonts via GDI+).
- Undo history is snapshot-based: simple and correct, memory-bounded at 30 states.
