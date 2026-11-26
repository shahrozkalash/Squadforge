# Phase 46 Acceptance Report — Advanced Brush and Painting Engine

Date: 2026-11-26
Baseline: local snapshot (Phase 46 is staged locally, not yet pushed; the owner pushes in a batch)
Status: **Ready for owner acceptance.** Every requirement is backed by genuine pixel-value tests; limitations are stated, not hidden.

## Requirement-by-requirement

| # | Requirement | Evidence |
| :--- | :--- | :--- |
| 1 | Adjustable brush size, hardness, spacing, opacity and flow — each measurably changing rendered pixels | `BrushSettings` + `createBrushSettings`/`assertBrushSettings` validation in `types.ts`/`imageCore.ts`; stamps walk the path at `spacing × size` intervals and deposit `shape × flow` coverage by the build-up rule `cov += deposit × (1 − cov)`, applied once at `opacity`. Size footprint (test 1.1); hardness falloff with exact alphas — shape 0.4 → 102, 0.8 → 204 (1.2); spacing 3× diameter leaves the inter-stamp midpoint at alpha 0 while 0.5× covers it (1.3); opacity caps a saturated stroke at exactly 128 (1.4); flow build-up 0.5 → 128, two deposits → 191, 0.25 → 64 (1.5); defaults/overrides/validation (1.6). |
| 2 | Pressure-input support where available, honest about its source | `StrokePoint.pressure` is input data (0..1, clamped; absent/non-finite → full 1 — no hardware reading is fabricated; no device API exists in the repo yet, stated in the progress doc). `pressureSize` scales stamp diameter (0.25 pressure on size 20 → r 2.5 footprint, test 2.1); `pressureOpacity` scales strength (0.5 → alpha 128, absent → 255; 2.2); ignored when both routes are off (2.3); zero pressure leaves no mark on either route (2.4); pressure interpolates along the path so the footprint grows from nothing to full width (2.5). |
| 3 | Brush presets: named, serializable, storable/loadable/appliable, with built-ins | `BrushPreset`/`SerializedBrushPreset`; five built-ins (Hard Round, Soft Round, Airbrush, Speckle Tip with a raster tip, Pen Pressure Pen) in `BUILT_IN_BRUSH_PRESETS`; `getBrushPreset` returns defensive copies (3.1); JSON round-trip is lossless including tip bytes (3.2); a loaded preset paints pixel-identically to the original (3.3); corrupt format/version/tip-length/range data is rejected (3.4). |
| 4 | Smoothing that measurably reduces jitter | `smoothStrokePoints` (EMA stabilizer, anchored at the first point, pressure smoothed too; amount 0 is an exact copy). Total deviation from the stroke line drops from 44 (raw zigzag) to under 22 (2× bound; measured ~17) in test 4.2; rendered with smoothing 0.9, jitter peak/valley pixels stay at alpha 0 while the centreline paints, and the unsmoothed stroke paints the peaks (4.3); amount validated (4.4). |
| 5 | Custom brush tips from a grayscale raster, reproduced in strokes | `BrushTip` (single-channel raster, the engine's mask/selection representation); `createBrushTip` (validated), `brushTipFromImage`/`brushTipFromLayer` (luminance × alpha). A 4×4 half-empty tip stamps texel-exactly at matching size (5.1); an image-derived tip marks only its one opaque-white texel (5.2); tips scale bilinearly to other brush sizes (5.3); invalid tip data rejected and `roundBrushTip` follows the round profile exactly (5.4). |
| 6 | Color sampling, composited and per-layer, with averaged radius sampling | `sampleColor` samples the full `composite()` (half-alpha red over opaque blue returns exactly (128, 0, 127, 255), test 6.1); `sampleLayerColor` returns the layer's own (255, 0, 0, 128) (6.2); radius averaging is exact ((0+0+255)/3 = 85) and clips at edges (6.3); bounds/radius/layer validated (6.4). |
| 7 | Stroke rendering verified; performance measured on a large canvas | Exact-value assertions throughout sections 1–7 of the suite (centre opacity, edge falloff, flow build-up, spacing gaps, alpha-lock recolor with alpha preserved exactly, raster/rect selection scoping, advanced eraser). Performance (test 8.1): a serpentine stroke of ~3,570 stamps (size 24) on a 1024×1024 canvas rendered in **204.5 ms** on this 1.5-CPU VM; the test asserts a generous 10 s bound and logs the measured time. |
| — | Existing behavior preserved (Phase 44 alpha lock/masks, Phase 45 selections) | Strokes apply through the shared `blendPaint` (alpha lock recolors with alpha exact and creates no alpha on locked layers, 7.1); Phase 45 raster selections scope and scale strokes, including a half-selected pixel landing at alpha 128 (7.2); Phase 19 rect scoping works (7.3); regression suites Phase 19 + 44 + 45 pass 95/95. |

## Test evidence

- Phase 46 suite: **33/33 pass** (`npx tsx --test tests/phase46_advanced_brush_painting.test.ts`)
- Regression: Phase 19 suite **24/24**, Phase 44 suite **31/31**, Phase 45 suite **40/40** (95/95 in one run) — the Phase 19 brush/eraser are untouched and the project format stays v2.
- Lint/typecheck: `npx tsc --noEmit` ✅ clean
- Performance: ~3,570 stamps of a size-24 brush on 1024×1024 in **204.5 ms** (this VM); test bound 10 s.
- Not run in this pass: the full repo test suite and the production web build (the change is confined to `server/imageEditor/` + one new test file; the focused suites and typecheck cover the touched surface).

## Known limitations

Pressure is modeled as input data — no Pointer Events/device wiring exists in this phase, and absent pressure honestly defaults to full. The EMA stabilizer lags at high amounts (stroke ends short, corners cut). Flow/opacity follow the engine's documented build-up/cap model, applied in one pass (no mid-stroke color feedback/smudge). Custom-tip stamps snap to an integer footprint. Presets live outside the project file (serialized JSON is their storage form). The generated C# desktop app does not yet expose Phase 46 features. Full detail in `PHASE_46_PROGRESS.md`.

## Acceptance

Pending the owner's review, per the repository's phase process.
