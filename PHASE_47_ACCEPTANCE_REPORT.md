# Phase 47 Acceptance Report — Professional Filters and Effects

Date: 2026-11-26
Baseline: local snapshot (Phase 47 is staged locally, not yet pushed; the owner pushes in a batch)
Status: **Ready for owner acceptance.** Every requirement is backed by genuine pixel-value tests; limitations are stated, not hidden.

## Requirement-by-requirement

| # | Requirement | Evidence |
| :--- | :--- | :--- |
| 1 | Blur, Gaussian blur, sharpen, noise, edge detection, emboss and distortions, each with configurable parameters | Box blur `radius` (impulse spreads to exactly 255/9 = 28; step edge gives exact 85/170 thirds; uniform image and alpha handled exactly — tests 2.1–2.5). Gaussian blur `sigma` + `radius` (kernel `exp(-i²/2σ²)` normalized: uniform image byte-unchanged; impulse response within 1 of the kernel values ≈41/≈25/≈15 at σ=1; radius truncates the kernel — 3.1–3.4). Sharpen `amount` (a 100→155 step becomes exactly 45/210 at amount 1 by the kernel arithmetic — 4.1). Noise `amount` + `seed` (mulberry32: same seed byte-identical, different seed differs, all channels within ±amount — 5.1–5.3). Sobel edge detection `strength` + `threshold` (a step of 100 yields exactly 400·strength at the edge columns; flat image → 0; threshold boundary inclusive — 6.1–6.4). Emboss `strength` + `angle` (flat → exactly 128; steps → exactly 192 at angles 0 and 90 — 7.1–7.3). Distortions: wave `amplitude`/`wavelength`/`phase` (a marker pixel relocates by exactly the sine displacement; phase 180 flips it — 8.1–8.3) and swirl `angle`/`radius` (exact 180° relocation at r = R/2 for angle 720, +90 direction pinned, centre and outside-radius pixels unmoved — 9.1–9.3). |
| 2 | Advanced color effects; existing ones not duplicated | Hue-rotate (new, HSL: red +120° = exactly green, +240° = blue, gray unmoved — 10.1), sepia (new: white → (255, 255, 239); (120, 60, 30) → (99, 88, 69); amount blend exact — 10.2), posterize (new: levels 2/4 quantize exactly — 10.3), threshold (new: splits on Rec.601 luminance — 10.4). Brightness/contrast, saturation, invert and grayscale are **not** reimplemented: the registry wraps the Phase 19 adjustments through a throwaway project, and byte-equality with direct calls is asserted (10.5–10.8). |
| 3 | Uniform filter API: registry/descriptor with parameter schema; validated application | `listFilters()` / `getFilterDescriptor()` return defensive copies of 16 descriptors whose defaults lie inside their ranges (1.1–1.2). `resolveFilterParams` fills defaults (1.5–1.6) and rejects unknown ids, unknown parameter names, non-finite and out-of-range values (1.3–1.4) — nothing is silently clamped. Every registry entry has a real implementation and tests; no placeholder effects exist. |
| 4 | Previews that do not mutate the original | `previewFilter` returns the would-be layer image; the project is byte-identical afterwards and the preview equals the `applyFilter` result (11.1). `previewFilterRegion` returns a region crop computed with full-layer context (a blur region at a step edge shows the exact 85/170 values), project untouched, invalid regions rejected (11.2–11.3). `applyFilterToImage` never mutates its input (1.7). |
| 5 | Respect for the existing model: layers, Phase 45 selections, Phase 44 masks | Filters apply to a layer's pixels through `applyFilter`. Raster-selection scoping weights per pixel by value/255 — a 128 pixel under invert lands exactly on the half-blend 128; rect scoping and combined scopes verified (12.1–12.3); a wrong-size selection is rejected (12.4). A layer's Phase 44 mask is preserved byte-for-byte and stays a live compositing control rather than being baked in (12.5). Missing layers rejected (12.6). |
| 6 | Filter tests with exact/expected values | The Phase 47 suite (51 tests) asserts mathematically derived values throughout: kernel arithmetic for blur/sharpen/Sobel, the normalized Gaussian kernel, the sepia matrix, posterize quantization steps, HSL hue rotation of primaries, sine/homography-free distortion geometry (wave displacement, swirl falloff `(1 − r/R)²`), seeded-noise reproducibility and bounds. |

## Test evidence

- Phase 47 suite: **51/51 pass** (`npx tsx --test tests/phase47_filters_effects.test.ts`)
- Regression in the same run: Phase 19 suite **24/24**, Phase 44 suite **31/31**, Phase 45 suite **40/40**, Phase 46 suite **33/33** — 179/179 total. The Phase 19 adjustments are untouched (the registry wraps them), and the project format stays v2.
- Lint/typecheck: `npx tsc --noEmit` ✅ clean
- Not run in this pass: the full repo test suite and the production web build (the change is confined to `server/imageEditor/` + one new test file; the focused suites and typecheck cover the touched surface).

## Known limitations

Only two distortions are implemented (wave, swirl) — bulge/pinch are absent from the registry rather than faked. Blur edges replicate (no mirror/wrap mode); sharpen has no radius control; noise is uniform per-channel only; edge detection is Sobel only. Filters follow the Phase 19 adjustment contract: they ignore the alpha lock and never bake the layer mask (mask-aware filtering is available today by scoping with a selection built from the mask). The Gaussian `radius` default 0 is the documented "auto (3σ)" sentinel. Filters are destructive operations on layer pixels (undo snapshots cover recovery); there is no non-destructive filter stack. The generated C# desktop app does not yet expose Phase 47 features. Full detail in `PHASE_47_PROGRESS.md`.

## Acceptance

Pending the owner's review, per the repository's phase process.
