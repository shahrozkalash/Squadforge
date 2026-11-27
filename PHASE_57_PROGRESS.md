# Phase 57 Progress — Desktop Runtime and Workflow Testing (Graphics Editor)

Date: 2026-11-26
Baseline: local snapshot on top of Phase 56 (staged locally, not yet pushed)
Status: **Implemented and verified locally.** The generated desktop app's engine core and document model were separated from their GDI surface **in the generator**, and the separated core was compiled and **run** on this machine: a checked-in .NET harness executes real editing workflows against freshly generated sources — **14 scenarios, 136 assertions, 0 failures**. The WinForms GUI itself cannot start on this Linux VM (platform record below, with the exact errors) and was not run, clicked, or screenshotted; nothing about GUI interaction is claimed.

## The platform record (what cannot run here, with evidence)

- No display: `$DISPLAY` is empty. No wine/mono: `command -v wine wine64 mono csc` finds nothing; `/usr/lib/mono` and `~/.wine` do not exist.
- The generated app builds genuinely (below), but starting it fails in the two ways a Windows WinForms binary must fail here:
  - Executing `PixelForge.exe` directly: `cannot execute binary file: Exec format error` (`file` reports `PE32+ executable (GUI) x86-64, for MS Windows, 6 sections`).
  - `dotnet PixelForge.dll`: `You must install or update .NET to run this application. Framework: 'Microsoft.WindowsDesktop.App', version '8.0.0' (x64) … No frameworks were found.` — the app's runtimeconfig requires `Microsoft.WindowsDesktop.App`, for which no Linux build exists (the local NuGet cache holds only its *reference* pack, which is why the Windows-targeted compile works).
- Conclusion: GUI execution is impossible on this VM. The genuine runtime work is the headless harness over the UI-independent generated sources (below). No GUI evidence was fabricated: no screenshots, no claimed clicks.

## The seam finding, and the generator-level separation it produced

Phase 56's claim was "System.Drawing only at the boundary", but the boundary ran **through** the two core files, so neither could execute headless:

- `PixelEngine.cs`: `PixelImage.FromBitmap/ToBitmap/WriteTo` used `Bitmap`/`LockBits`/`Marshal` (System.Drawing.Common).
- `ImageDocument.cs`: `EditorLayer` owned a cached `Bitmap`; `Flatten()` returned a `Bitmap`; `Resize`/`RotateFlip` round-tripped every layer through GDI bitmaps (bilinear `Graphics.DrawImage`, `Bitmap.RotateFlip`); mask transforms went through bitmaps; `SaveProject`/`LoadProject` wrote and read PNGs via `Bitmap.Save`/`new Bitmap(path)`.

The separation (all changes in `server/imageEditor/imageProjectGenerator.ts`; generated output only ever regenerated):

1. **Core / Drawing split.** `PixelImage`, `EditorLayer` and `ImageDocument` are now `partial`. Two new emitted files carry the GDI surface: `PixelEngine.Drawing.cs` (the three Bitmap conversions, moved verbatim) and `ImageDocument.Drawing.cs` (the layer's cached `Bitmap` view + `ImageDocument.Flatten()`). The core's cache invalidation goes through a modifier-less partial-method hook (`InvalidateCachedBitmap`): when the Drawing part is not compiled, the calls are elided and invalidation is a no-op.
2. **A raw PNG codec in the core.** New emitted `PngCodec` (a port of the TS engine's Phase 50 codec scope): filter-0 RGBA encode; decode of 8-bit non-interlaced color types 0/2/3/4/6 with all five scanline filters and palette tRNS; 16-bit, sub-8-bit and interlaced files rejected with the TS decoder's named errors. Project save/load now uses it, so the app's own PNG IO no longer needs GDI either. (The Phase 19 app wrote its PNGs with GDI; those are ordinary 8-bit PNGs and the decoder reads them — proven at runtime by S11, including a hand-written Paeth-filtered fixture produced by an independent in-harness writer.)
3. **Raw geometry.** `Resize` is now the TS engine's bilinear resample (same `(x + 0.5) · scale − 0.5` edge-clamped sampling for pixels and masks — the GDI `HighQualityBilinear` it replaces was never pixel-specified, so this is also a determinism improvement); `RotateFlip` is an exact byte remap driven by a new engine enum `RotateFlipKind` whose 16 values mirror `System.Drawing.RotateFlipType`'s names and numeric order (value % 4 = clockwise quarter-turns, value / 4 = flip), so the shell's two call sites changed only the enum name.
4. The full Windows app still compiles genuinely with the split (below): restore + build exit 0, zero diagnostics, PE-verified; `PixelForge.dll` grew 129,536 → **135,680 B** (sha256 `2f854990…6aeea`), `PixelForge.exe` unchanged at 152,064 B (standard apphost, sha256 `ae2c6a1c…28d94`).

## The runtime harness

- Driver: `scripts/phase57-runtime-harness.ts` — regenerates the app fresh from the current generator (never trusts stale output), copies **only** `PixelEngine.cs` + `ImageDocument.cs` into a throwaway console project under the system temp dir, prints each excluded generated file with its reason, builds with the local .NET SDK 8.0.428 and runs the harness, propagating its exit code.
- Program: `scripts/phase57-runtime-harness/Program.cs` — a small assertion framework (per-scenario PASS/FAIL with timings; final `HARNESS SUMMARY` line; exit 0 iff no failures).
- S00 proves the seam at runtime: the harness assembly's references are `System.Collections, System.Console, System.Drawing.Primitives, System.IO.Compression, System.Linq, System.Runtime, System.Text.Json` — **no `System.Drawing.Common`, no `System.Windows.Forms`** (System.Drawing.Primitives — `Color`/`Rectangle` — is in-box in Microsoft.NETCore.App and cross-platform).

### Scenario results (final run: 136 assertions, 0 failures, 422 ms of workflow time)

| Scenario | Result | What it proves |
| :--- | :--- | :--- |
| S00 environment & seam | PASS | Runtime/OS recorded (.NET 8.0.34, Ubuntu 24.04 x64); core references no GDI/WinForms assemblies |
| S01 create/layers | PASS | New document shape; add/reorder/delete semantics incl. edge no-ops and the last-layer rule |
| S02 brush | PASS | Hard stamp exactness and radius edge; spacing-walked stroke coverage; flow 0.5 → alpha 128 at full color; opacity cap; soft-edge falloff; true alpha erase (full and partial); alpha lock (erase refused, paint never creates alpha, opaque recolor preserves alpha) |
| S03 blend/opacity | PASS | Multiply (31,47,39), screen (209,173,211) and normal-at-0.5 (120,110,125) composites equal the hand-computed W3C values; hidden layer contributes nothing |
| S04 masks | PASS | Create/paint (gray set outright in the disc)/invert/apply; mask 0 hides, 128 cross-fades to (128,0,127); apply bakes alpha (200→100 at mask 128) and removes the mask; maskless invert refuses |
| S05 filters | PASS | Invert exact; box blur r=1 impulse → 28 across the 3×3, nothing at distance 2; gaussian σ=1 centre concentrated (28 < c < 60); contrast 50 maps 100 → 86; sepia white → (255,255,239); threshold on luminance; seeded noise reproducible/seed-sensitive/bounded, amount 0 identity; selection-scoped apply; registry rejects unknown id/param and out-of-range values with named errors |
| S06 text/shape | PASS | 'A' renders at the glyph table's exact pixels; editing the data to 'B' and re-rendering moves pixels and clears 'A'-only pixels; rectangle fill bounds exact; moving the shape data re-renders at the new rect |
| S07 effect stacks | PASS | Stack renders at composite time with pristine pixels byte-untouched; disable restores the original; non-commuting pair gives 95 vs 215 in the two orders; bake writes pixels, clears the stack, composite byte-identical; baking an adjustment layer refuses with the TS message |
| S08 adjustment layers | PASS | Invert adjustment turns the blue backdrop yellow; an opaque layer above is unaffected; opacity 0.5 cross-fades to (128,128,128); no enabled effects = no change |
| S09 undo/redo | SKIPPED (documented) | Undo/redo lives in `MainForm` (`Stack<byte[]>` of PNG snapshots of the flattened composite) and encodes/decodes through `System.Drawing.Bitmap` in the Form — not part of the UI-independent core, cannot execute on Linux. The snapshot *primitive* (PNG encode/decode of a `PixelImage`) is the core's `PngCodec`, exercised by S10/S11 |
| S10 save/load round-trip | PASS | A five-layer document (multiply + painted mask + two-effect stack, text, shape, adjustment) saves (project.json + 5 layer PNGs + mask PNG) and reloads with every field intact — mask byte-exact, stack ids/flags/params, text and shape data — and composites **byte-identically** |
| S11 Phase 19 compat | PASS | A manifest whose layer entries carry only Name/Visible/Opacity/File loads with the documented defaults; a Paeth-filtered PNG written by an independent in-harness writer decodes correctly; the document composites as stored; a corrupt stored effect id rejects the load |
| S12 resize/rotate | PASS | Rotate 90° CW remaps all eight test pixels and the mask exactly and swaps dimensions; flip X mirrors pixels and mask; bilinear resize preserves corners exactly and resizes the mask; non-positive targets rejected |
| S13 shortcuts | SKIPPED (documented) | The generated `ShortcutResolver.Resolve` takes WinForms `KeyEventArgs`/`Keys` and cannot execute on Linux; the chord model it resolves is the TS workspace model, whose resolver the Phase 54 suite already covers — not duplicated |

## Defects found and fixed

- **Engine defects found by the runtime work: none.** Every workflow behaved as the Phase 56 port intended. The structural finding above (the GDI seam running through the core files) was a testability defect, fixed by the generator-level separation.
- Two harness expectations were wrong during development and were fixed in the harness, not the engine: (1) S06 first expected pixel (5,2) to clear when 'A' becomes 'B' — both glyphs paint that pixel (rows 0x0E/0x1E share cols 1–3); the witness moved to the genuinely differing pixel (row 3: 0x1F vs 0x1E). (2) S11 first expected (128,0,127) for red at opacity 0.5 over blue — at exactly sa = 0.5 both channels land on 127.5 and round to 128; (128,0,127) is the mask-128 case (sa = 128/255), which S04 asserts and passes.

## Test-needle migration (Phase 19)

`tests/phase19_image_editing_engine.test.ts` test 7.1 asserted `/public Bitmap Flatten\(\)/` against `ImageDocument.cs`. `Flatten()` moved to `ImageDocument.Drawing.cs` in the split, so the assertion now reads that file, with a migration comment in the test. The assertion itself is unchanged and no other Phase 19 needle was affected (`ExportImage(ImageFormat.Jpeg)` lives in MainForm, untouched).

## Verification

- Harness: `npx tsx scripts/phase57-runtime-harness.ts` → build succeeded (0 warnings, 0 errors), **14 scenarios (2 skipped-documented), 136 assertions, 0 failures**, exit 0.
- Full app build via `DesktopBuildPipeline` on the refactored generator: restore + build exit 0, zero diagnostics, PE-verified (artifacts above).
- TS suites in one run: Phase 57 **10/10** (seam pins + harness wiring) and the Phase 19 + 44–56 + 18 + 36 regression — **420/420 pass, 0 fail** total.
- `npx tsc --noEmit` clean.

## Limitations (deliberate, not hidden)

**GUI interaction itself — mouse canvas events, panel rendering, visual layout — remains unverified until the app is run on a Windows machine.** The harness exercises the document/engine calls the GUI makes, not the GUI: canvas mouse handling, dialog behavior, panel rendering, drag/drop, and the undo/redo interaction (Form-bound, S09) have never executed. The generated GUI has still never been run anywhere. Everything else Phase 56 listed as not exposed in the app (groups, raster tips/selections, PSD, 16-bit/ICC, acceleration, actions/batch, guides rendering) is unchanged by this phase.
