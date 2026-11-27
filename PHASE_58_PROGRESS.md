# Phase 58 Progress — Professional File Handling (Graphics Editor)

Date: 2026-11-27
Baseline: local snapshot on top of Phase 57 (staged locally, not yet pushed)
Status: **Implemented and verified locally.** The TS engine now imports and exports PNG, JPEG, BMP and TIFF by **content** (magic bytes, never the file name), reports one consistent metadata shape for every import, and refuses everything it cannot decode with a named, format-specific error. JPEG support is new (branch (a) of the brief — a real pure-JS codec, proven below); TIFF support is new (baseline decode/encode in a new module); PSD import/export is unchanged code with detection integrated. The generated desktop app validates imports by content with named user-facing errors and exports JPEG with an explicit quality setting. **24/24 new tests; 413/413 across Phase 19 + Phases 44–58 in one run; tsc clean; the generated app compiles genuinely (zero diagnostics) and the Phase 57 runtime harness passes with its new file-handling scenario (153 assertions, 0 failures).**

## Evidence gathered before deciding anything

- **JPEG availability (the brief's branch decision).** No JPEG codec existed in the codebase or `node_modules` (Phase 50's documented state, re-verified). npm *does* work in this environment: `jpeg-js@0.4.4` installed in ~2 s in a scratch directory, ships its own TypeScript types, and was verified genuine before adoption — its decode of ffmpeg's `testsrc` JPEG matched ffmpeg's own decode (max channel diff 3, mean 0.139), its encode at quality 92 decoded through ffmpeg (max diff 1), and a Pillow-written **progressive** JPEG decoded correctly. **Branch (a) was taken**: real JPEG decode + encode in the TS engine. `package.json`/`package-lock.json` gained exactly one dependency (`jpeg-js ^0.4.4`, pure JavaScript, no native code).
- **ffmpeg as the independent implementation.** ffmpeg 8.1.2 (`/usr/bin/ffmpeg`) generated the fixture corpus (PNG/BMP/JPEG/TIFF from `testsrc2`), and every engine decoder is judged against ffmpeg's decode of the same bytes; every engine encoder is read back through ffmpeg/ffprobe. Hand-built fixtures (layouts ffmpeg cannot write) are cross-checked through ffmpeg inside the same test before the engine is judged.
- **What ffmpeg's TIFF writer actually emits** (measured with a tag dumper, not assumed): multi-strip files with arbitrary `RowsPerStrip`, `Software: Lavc62.28.102`, `ExtraSamples [2]` (associated alpha) for gray+alpha/RGBA, a 16-bit ColorMap for palette, and compressions none/PackBits/LZW/deflate(32946). Pillow writes deflate as compression **8** — both deflate codes are named in the rejection path.
- **LZW code-width rule, calibrated empirically.** The TIFF LZW early-change rule is the classic off-by-one trap; two candidate bump points were tested against ffmpeg's LZW files. Bumping the width when the next code to be assigned equals `(1 << width) − 1` after adding a table entry reproduces ffmpeg's gray/RGB/RGB48/palette-LZW decodes **byte-exactly**; the neighbouring rule desynchronizes immediately. The shipped decoder uses the calibrated rule.
- **PackBits packet accounting.** A hand-built PackBits fixture whose literal packet spanned row boundaries decoded differently in ffmpeg (its decoder accounts PackBits packets per row) and in a continuous-stream reading. Real PackBits writers packetize per row; the fixture was rebuilt row-aligned — the interoperable form — and now decodes identically in ffmpeg and the engine. The engine decodes each strip as one continuous PackBits stream, which reads the row-aligned form exactly as written. Documented as a limitation note, not hidden.

## What was built

### Content-based detection and consistent errors (`server/imageEditor/imageCodec.ts`)

- `detectFormat` recognizes PNG, JPEG, BMP, TIFF and PSD by signature. The TIFF check accepts version 42 **and** 43 so a BigTIFF file reaches its named rejection instead of "unknown format". Content wins over file names everywhere: `importImage` takes bytes only and dispatches on the signature; PSD bytes route to a named error pointing at `importPsd` (layer preservation stays on the Phase 49 path, by design).
- `importImage` now dispatches png/bmp/jpeg/tiff. Unknown content fails with: "Unsupported image format: the data has no PNG, JPEG, BMP, TIFF or PSD signature (first bytes: XX XX XX XX). The file may be corrupt, truncated, or a format the engine does not read." — the message names what was looked for and shows the actual first bytes.
- `exportImage(img, format, options?)` dispatches png/bmp/jpeg/tiff with an optional JPEG quality; an unknown format is refused by name (previously the `/export` route silently turned any unknown format into PNG — see Defects).

### JPEG (new, branch (a))

- `inspectJpeg` walks the marker stream: precision, dimensions, component count, progressive (SOF2) vs baseline, JFIF APP0, EXIF APP1 and ICC APP2 presence — with named `Corrupt JPEG` errors for truncated/malformed segment structure.
- `decodeJpeg` wraps the codec so every failure is a `JPEG decode failed: …` error. `encodeJpeg(img, quality)` validates quality as an integer 1..100 with a named error. JPEG has no alpha channel; RGBA input is encoded from its RGB channels (the format's property, stated in the docs and the metadata shape, not a silent surprise — alpha presence is reported as `hasAlpha: false`).

### TIFF (new module `server/imageEditor/tiff.ts`)

- `inspectTiff` returns a full metadata record (byte order, page count, dimensions, bits/sample, samples/pixel, photometric + name, compression + name, planar configuration, resolution, software, description, orientation, palette and alpha presence).
- `decodeTiff` (8-bit) and `decodeTiff16` (16-bit, through the Phase 50 `PixelImage16` model) support: classic TIFF, little- and big-endian; strips (chunky and planar configurations); compressions none, LZW, PackBits; horizontal predictor 2 at both depths; photometrics WhiteIsZero, BlackIsZero, RGB and palette (8- and 16-bit ColorMaps); gray, gray+alpha, RGB and RGBA; associated-alpha un-premultiply; multi-page files (page 1 decoded, page count reported). The 8- and 16-bit paths refuse each other's files **by name** rather than truncating.
- Named rejections, each with the offending value in the message: BigTIFF (43), Deflate (8/32946), JPEG compression (6/7), CCITT (3/4), tiled layout (tags 324/325), CMYK/YCbCr/CIELab photometrics, mixed bit depths, bit depths other than 8/16, float samples (SampleFormat 3), predictor 3, signed samples.
- Encoders: `encodeTiff` (RGBA), `encodeTiff16`, `encodeTiffGrayscale` — little-endian, uncompressed, single strip, word-aligned offsets, ExtraSamples and 72 dpi resolution tags. Every encoder's output was decoded back **byte-exactly by ffmpeg** in the tests, including an odd-sized 3×3 grayscale file (the word-alignment case).

### One metadata shape (`importImageWithMetadata`)

Additive — no existing signature changed. Returns `{ image, metadata }` where metadata is always `{ format, width, height, bitDepth, colorModel, hasAlpha, iccProfilePresent, iccProfileName }` plus format detail where present: `pngText` (new `extractPngTextChunks`: tEXt + zTXt), `jpeg` (the `JpegInfo`), `tiff` (the `TiffMetadata`). PSD imports keep their own richer report (Phase 49) and are not forced through this shape.

### Routes and batch

- `imageEditorRoutes.ts`: `/export` accepts png/bmp/jpeg/tiff with the correct Content-Type per format; an unknown format now returns **400 with a named error** (defect fix, below).
- Phase 53 batch processing needed no changes: it already routes through `importImage`/`exportImage`, so mixed PNG/JPEG/TIFF/BMP batches with per-file error recovery work — proven by test 58.23.

### Desktop app (generator only, Phase 57 seam intact)

- New emitted core fragment in `PixelEngine.cs`: `ImageFileKind` + `ImageFileSupport` — content detection by magic bytes (PNG/JPEG/BMP/TIFF/BigTIFF/PSD) living on the **headless side of the seam** (no GDI), with `EnsureImportable` throwing named `InvalidOperationException`s (PSD → use the engine's `importPsd`; TIFF → named not-imported message; unknown → "not a recognized image file").
- `MainForm.ImportImage` rewritten: per-format dialog filters; bytes are read with `File.ReadAllBytes` and validated by `EnsureImportable` **before** `Image.FromStream` decodes them; failures show a clear `MessageBox` instead of an unhandled exception; undo is pushed only after a successful decode. This also fixes the old `Image.FromFile` behaviour, which kept the source file locked for the image's lifetime.
- `MainForm.ExportImage` rewritten: `DefaultExt`/`AddExtension` set, and the chosen extension is corrected with `Path.ChangeExtension` so the saved file's extension always agrees with the encoded format; save failures are caught and reported. **JPEG export now sets an explicit quality** — `private const long JpegExportQuality = 90L` applied through `ImageCodecInfo` + `EncoderParameters` (the real GDI+ mechanism) — where previously the GDI+ default was used with no setting anywhere. An "Export BMP…" menu item was added (BMP export existed in the shell's code path but had no menu entry).
- The Phase 57 runtime harness gained scenario **S14** (file handling: detection of PNG/JPEG/BMP/TIFF-LE/TIFF-BE/PSD/unknown/truncated/empty content plus the three named refusal messages), executed against the freshly generated core: **PASS**.

## Defects found and fixed

1. **`/export` silently mis-encoded.** Any format string other than bmp/jpeg fell through to PNG while the response claimed success — a request for `webp` (or a typo) returned PNG bytes. Now: png/bmp/jpeg/tiff encode genuinely; anything else returns 400 with the named error. (Test 58.22 pins the engine-level refusal; the route change is a thin mapping over it.)
2. **Desktop import locked files and crashed on bad ones.** `Image.FromFile` keeps the file locked while the image lives, and unsupported/corrupt files threw unhandled exceptions out of the menu handler. Import now reads bytes, validates content first, decodes from a stream, and reports named errors in a dialog.
3. **Desktop JPEG export had no quality setting.** The GDI+ default applied silently. Export now pins quality 90 through encoder parameters.
4. **One justified needle migration** (Phase 56/57 pattern): a Phase 50 test pinned the old documented state "no JPEG codec exists" (`detectFormat(jpeg) === null`, `/no JPEG codec/`). JPEG support is this phase's headline change, so that one test now asserts `detectFormat(jpeg) === 'jpeg'` and that a header fragment fails as `/JPEG decode failed/` — with a "Phase 58 needle migration" comment in the test explaining exactly this. No other existing test was changed, and no assertion anywhere was weakened.

Development-side catches (recorded for honesty; none shipped): the test suite's hand-rolled TIFF assembler initially wrote its 32-bit fields big-endian in both modes (the byte-swapped IFD offset was found by dumping the fixture, and the fix made the little-endian fixtures genuine); the first embedded progressive-JPEG fixture was corrupted by a one-character transcription error in its base64 — both embedded fixtures are now inserted **mechanically** from the real files and byte-verified; and an early expectation that ffmpeg's "gray" JPEGs are 1-component was wrong (its encoder writes 3-component YCbCr with neutral chroma) — the genuine 1-component case is covered by a Pillow mode-L file instead.

## Verification (final state)

- New suite `tests/phase58_professional_file_handling.test.ts`: **24/24 pass**. Fixtures are generated by ffmpeg at test time (plus two mechanically embedded Pillow JPEGs, re-validated through ffmpeg in the tests); hand-built TIFF fixtures are cross-checked through ffmpeg before the engine is judged.
- One-run regression, Phase 19 + Phases 44–58 test files: **413/413 pass, 0 fail**.
- `npx tsc --noEmit`: clean.
- Generated app via `DesktopBuildPipeline`: **status success, zero diagnostics**; `PixelForge.dll` 139,264 B, sha256 `ff50be8d09be362cf085bac70a9ae58ce2dcb468e7a8403e552ef0454b2b6f3f`; `PixelForge.exe` 152,064 B, sha256 `ae2c6a1c8811aac5edf058e8bc282602e197e0cde221ce1576e370434bb28d94`; PE subsystem verified = 2 (Windows GUI). (Artifacts under `.desktop_artifacts/phase58check/`.)
- Phase 57 runtime harness re-run on the final generator: **15 scenarios (2 skipped-documented), 153 assertions, 0 failures, exit 0** — S14 PASS.
- Measured JPEG character (testsrc2, quality 95 round trip): max channel diff 17, mean 0.866, 14 of 12,288 channel values above 12, none above 25 — the suite pins those honest lossy bounds rather than a lossless claim.

## Limitations (all named, none silent)

- **TIFF decode** refuses by name: Deflate (8/32946), JPEG-in-TIFF (6/7), CCITT (3/4), tiled files, BigTIFF, CMYK/YCbCr/CIELab photometrics, float or signed samples, predictor 3, mixed bit depths, bit depths other than 8/16. The orientation tag is reported in metadata but not applied to pixels. Multi-page files decode page 1 (page count reported). TIFF **encode** is uncompressed-only. PackBits is decoded as one continuous stream per strip — the row-aligned packetization every real writer uses reads identically (see the evidence note above).
- **JPEG**: no alpha (a property of the format); CMYK JPEGs are not fixture-verified and are not claimed; EXIF/ICC are detected and reported as present, not parsed or applied. PNG **iTXt** chunks are not decoded (tEXt and zTXt are).
- **PSD**: codecs unchanged from Phase 49 (with its documented warnings model); `importImage` refuses PSD by name so layers are never silently flattened by the wrong entry point.
- **Desktop app**: imports PNG/JPEG/BMP through GDI+ after content validation; PSD and TIFF imports are refused **by name** in the app (the TS engine is the path for those); JPEG quality is a pinned constant (90), not a user-facing slider; the GUI remains compile-verified only and has never been run (no display on this VM — the standing Phase 56/57 caveat).
- One new runtime dependency: `jpeg-js@0.4.4` (pure JS, own types, no native code).
