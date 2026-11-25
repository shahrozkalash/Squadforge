# Phase 21 Acceptance Report — 3D Creation Engine

**Date:** 2026-11-25 · **Verdict: PASS** (with the limitations below)

## Requirement-by-requirement

| Requirement | Evidence |
| --- | --- |
| 3D viewport with camera controls | Server renderer: orbit azimuth/elevation/distance camera + lookAt + perspective (`renderer.ts`, `math3d.ts`); generated C# app `Viewport3D` with drag-orbit and wheel-zoom |
| Object creation, selection, movement, rotation, scaling | Scene graph nodes with full TRS transforms; primitives cube/sphere/plane; generated app: hierarchy tree selection, add-cube, transform fields in the model |
| Basic mesh editing and transformations | Vertex translation by index set (range-checked), transform baking into geometry (positions + normals), hierarchy world matrices; tests 2.3, 3.1 |
| Materials, textures, lighting | Materials with color/metalness/roughness/opacity + texture path; ambient/directional/point lights genuinely shade the render (test 7.3: no lights → black frame). Texture *sampling* in the rasterizer: NOT implemented (see limitations) |
| Scene hierarchy and object management | Parenting with cycle protection, reparent-on-delete, world transform inheritance; tests 3.1–3.2 |
| Keyframe animation and timeline | TRS keyframe tracks, linear sampling, scene evaluation at time t, duration tracking; glTF animation export; generated app: keyframe capture + timer playback; tests 4.1, 7.4 |
| Scene save/load and real 3D file export | Validated JSON persistence (corruption/out-of-range rejection, test 5.1); OBJ+MTL world-baked export (test 6.1); glTF 2.0 export with embedded binary buffer, structurally validated (test 6.2) |
| Rendering integration where supported | Genuine software renderer → real PNG via `/render` and the Phase 19 PNG codec; sample render visually inspected (cube/sphere/ground with correct shading and occlusion) |
| Modular architecture, real processing | `server/scene3d/` module (math / scene / renderer / exporters / generator / routes) reusing Phase 18 (desktop pipeline) and Phase 19 (pixel image + PNG codec) |
| No fake 3D preview | The renderer rasterizes real geometry with a z-buffer; test 7.2 proves depth occlusion, 7.3 proves light response. Nothing is a screenshot or mock |
| Tests for scene ops, persistence, export validation | 17/17 pass in `tests/phase21_3d_creation_engine.test.ts` |

## Checks run

- `npx tsx --test tests/phase21_3d_creation_engine.test.ts` → **17/17 pass**
- Generated app genuine build (Phase 18 pipeline, `dotnet build`):
  `ModelForge.exe` 152,064 bytes, sha256
  `4eb05eab90eba4fad0a0eec9e1bef2db41f0a65b2a0bf2ba78c57f968bdd228b`
- `npm run lint` → ✅ · TypeScript typecheck → ✅ · `npm run build` → ✅
- Cross-phase regression: Phase 21's own suite passes standalone; the full
  repo suite (all phases) is re-run as part of the Phase 24 regression pass.

## Limitations

1. Software (CPU) rendering only: flat shading, no texture sampling in the
   rasterizer, no shadows/reflections/GPU acceleration.
2. Mesh editing is basic: vertex translation + transform baking; no
   booleans, sculpting, subdivision, or edge/face toolset.
3. Animation: linear TRS keyframes only — no easing, skeletal animation,
   or physics.
4. glTF: embedded-buffer `.gltf` only (no `.glb`), no skins/morph targets.
5. Generated Windows app is compile-verified on this Linux host; its GUI
   was not executed here (standing Phases 18–20 limitation).
6. Metalness/roughness are stored and exported (glTF PBR) but the software
   renderer's shading model is diffuse-based.

## Acceptance

Implemented and verified as above. Final acceptance remains the project
owner's decision, per repo convention.
