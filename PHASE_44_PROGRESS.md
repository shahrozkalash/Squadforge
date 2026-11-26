# Phase 44 Progress — Advanced Layers and Masks (Graphics Editor)

Date: 2026-11-26
Baseline: local snapshot after Phase 37 work (repo `main` at `2a5789a` for the last pushed commit; this phase is **not pushed** — it is staged locally for the owner's batched push)
Status: **Implemented and verified locally.** Extends the Phase 19 image engine in place (`server/imageEditor/`); no duplicate engine. Acceptance is the owner's decision.

## What was built

All in the existing engine — `types.ts` (model) and `imageCore.ts` (operations):

- **Blend modes** — `BlendMode` type: `normal` (unchanged source-over) plus **multiply, screen, overlay, darken, lighten**, implemented with the W3C compositing formula (`blendComposite`): per-channel blend function first, then alpha compositing, so modes mix correctly with layer opacity, masks and partial alpha. Settable per layer (`setLayerBlendMode`) and per group (`setGroupBlendMode`); unknown modes are rejected with the valid list.
- **Layer masks** — `Layer.mask`: a single-channel grayscale `LayerMask` the size of the layer. API: `createLayerMask` (fill 0–255, default 255 reveal-all), `getLayerMask`, `removeLayerMask`, `paintMask` (interpolated strokes like the brush, with 0..1 strength), `invertLayerMask` (v → 255−v), `applyLayerMask` (bakes the mask into the layer's alpha and removes it). The mask scales the layer's effective alpha during compositing. Masks are transformed with their layer by crop (exact), resize (bilinear) and rotate (exact 90° steps) so they stay aligned.
- **Nested layer groups** — `LayerGroup` records in `project.groups`, nested via `parentId`; layers point at their immediate group via `groupId`. API: `createGroup`, `getGroup`, `setGroupParent` (cycle-rejecting), `removeGroup` (lifts children by default; `deleteContents` removes the subtree, refused if it would remove the last layer), `setGroupVisibility/Opacity/BlendMode`, `setLayerGroup`. Compositing builds the hierarchy from the flat stack (children ordered by their lowest member) and renders each group into an **isolated buffer**, blended over the backdrop with the group's own opacity and blend mode — so child blend modes resolve inside the group, and hiding any ancestor hides the whole subtree.
- **Clipping** — `Layer.clipped`: a clipped layer's effective alpha is multiplied per-pixel by the alpha footprint of the nearest non-clipped node below it at the same hierarchy level (a layer, or a flattened group — a group's rendered alpha works as a base). Consecutive clipped layers share one base; the base's own mask shapes the footprint; a clipped layer with no base below contributes nothing.
- **Alpha lock** — `Layer.alphaLock`: all paint paths (brush, eraser, line, rectangle fill, ellipse, text) route through `blendPaint`, which on a locked layer never creates or changes alpha — transparent pixels are skipped, existing pixels are recolored with their alpha preserved exactly, and the eraser (an alpha-only operation) is a no-op. Adjustments already preserve alpha by construction.
- **Persistence (format v2)** — `serializeProject` now writes version 2: per layer `blendMode`, `alphaLock`, `clipped`, `groupId`, `maskBase64`; plus a `groups` array. `deserializeProject` accepts **both v1 and v2** (v1 loads with Phase 44 defaults) and validates the new data: mask byte length must equal width×height, group ids unique, parent references must exist, hierarchy must be acyclic, layer→group references must exist — corrupt data throws, as before. Undo/redo (`HistoryStack`) carries all of it automatically since it is snapshot-over-serialization.

## Genuine evidence

- **Phase 44 tests: 31/31 pass** (`tests/phase44_advanced_layers_masks.test.ts`) — pixel-exact blend results for all five new modes (incl. W3C mixing at 50% opacity), mask reveal/hide/gray values, mask painting + strength, inversion values and composite effect, mask apply/remove, mask-crop alignment, nested-group visibility/opacity, group blend on the flattened buffer, in-group blend isolation from the backdrop, cycle/missing-group rejection, group remove lift/delete, clipping footprint incl. mask-shaped and group bases and the no-base case, alpha lock across brush/fill/text/eraser incl. exact alpha preservation on a semi-transparent pixel, full v2 persistence round-trip with pixel-identical composite, v1 backward compatibility, corruption rejection, and undo carrying mask+group state.
- **Phase 19 regression: 24/24 pass** — the Phase 19 behavior (source-over compositing numbers, tools, codecs, generator structure) is unchanged.
- **Lint/typecheck: `npx tsc --noEmit` clean.**
- Commands run on this VM (focused files only, per its CPU limits): `npx tsx --test tests/phase44_advanced_layers_masks.test.ts`, `npx tsx --test tests/phase19_image_editing_engine.test.ts`, `npx tsc --noEmit`. The full suite and the production web build were **not** run in this pass.

## Limitations (stated honestly)

- **Group placement semantics:** a group renders as one isolated unit positioned at its lowest member in the flat stack. Interleaving a group's members with other layers does not error, but the group still renders as a unit — keep members contiguous for the least surprising result (the API does not reorder the flat stack).
- **Groups are not themselves clippable**, and a group's mask does not exist — masks are per-layer. A group can, however, serve as a clipping base.
- **Clipping base** is the nearest non-clipped node *at the same hierarchy level*; a clipped layer inside a group does not clip to a layer outside that group.
- **The generated C# desktop editor app** (`imageProjectGenerator.ts`, Phase 19) does not yet expose masks, groups, clipping, alpha lock or the new blend modes — Phase 44 covers the TypeScript engine (the same engine the `/export` route composites with). Its project files remain the v1 shape.
- Blend-mode math follows the W3C formula on non-premultiplied colors, matching Photoshop's normal-blend family for these five modes; exotic modes (soft-light, hue, etc.) are not implemented and are rejected rather than approximated.
