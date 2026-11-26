# Phase 44 Acceptance Report — Advanced Layers and Masks

Date: 2026-11-26
Baseline: local snapshot (Phase 44 is staged locally, not yet pushed; the owner pushes in a batch)
Status: **Ready for owner acceptance.** Every requirement is backed by genuine pixel-level tests; limitations are stated, not hidden.

## Requirement-by-requirement

| # | Requirement | Evidence |
| :--- | :--- | :--- |
| 1 | Editable grayscale layer masks | `LayerMask` (single-channel, layer-sized) on `Layer.mask`; `createLayerMask`/`paintMask` (interpolated strokes, strength)/`applyLayerMask`/`removeLayerMask` in `imageCore.ts`. Mask scales effective alpha in compositing (tests 2.1–2.3, 2.5–2.6); masks stay aligned through crop (test 2.7). |
| 2 | Mask inversion | `invertLayerMask` (v → 255−v), verified on mask bytes and on the resulting composite (test 2.4). |
| 3 | Nested layer groups | `LayerGroup.parentId` nesting, isolated group buffers in `composite()`. Hiding any ancestor hides the subtree; group opacity scales the subtree (tests 3.1–3.2). Cycles and dangling references rejected (test 3.5); removal lifts or deletes contents (test 3.6). |
| 4 | Clipping | `Layer.clipped`: per-pixel alpha multiplication by the nearest non-clipped node below at the same level — layer base, mask-shaped base, consecutive clipped layers sharing a base, group as base, and the no-base case (tests 4.1–4.5). |
| 5 | Alpha locking | `Layer.alphaLock` enforced in every paint path via `blendPaint`: no alpha creation on transparent pixels, exact alpha preservation on opaque/semi-transparent pixels, eraser no-op while locked (tests 5.1–5.3). |
| 6 | Blend modes Multiply, Screen, Overlay, Darken, Lighten | W3C blend + composite formula in `blendComposite`; pixel-exact results for each mode and W3C mixing at partial opacity (tests 1.1–1.5); unknown modes rejected (test 1.6). Group blend modes apply to the flattened group buffer (tests 3.3–3.4). |
| 7 | Actual pixel compositing verified | All compositing claims above are asserted on real pixel buffers with exact or ±1 values — no structural/string assertions for rendering behavior. |
| 8 | Project persistence | Format v2 round-trip preserves masks (byte-exact), group nesting/opacity/blend, clipping, alpha lock and blend modes, with a pixel-identical composite after load (test 6.1); v1 files still load with defaults (6.2); corrupt mask/group/cycle data rejected (6.3); undo/redo carries the new state (6.4). |

## Test evidence

- Phase 44 suite: **31/31 pass** (`npx tsx --test tests/phase44_advanced_layers_masks.test.ts`)
- Phase 19 regression suite: **24/24 pass** (unchanged behavior)
- Lint/typecheck: `npx tsc --noEmit` ✅ clean
- Not run in this pass: the full repo test suite and the production web build (the change is confined to `server/imageEditor/` + one new test file; the focused suites and typecheck cover the touched surface).

## Known limitations

Group renders as a unit at its lowest member's stack position (interleaved membership is not reordered); groups have no masks and cannot themselves be clipped (they can be clipping bases); clipping is scoped to the same hierarchy level; the generated C# desktop app does not yet expose the Phase 44 features (the TS engine and its `/export` route do). Full detail in `PHASE_44_PROGRESS.md`.

## Acceptance

Pending the owner's review, per the repository's phase process.
