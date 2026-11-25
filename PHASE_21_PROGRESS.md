# Phase 21 Progress — 3D Creation Engine

**Status: IMPLEMENTED AND VERIFIED (2026-11-25)** — server-side 3D scene
engine with a genuine software renderer, real OBJ/glTF 2.0 export, and a
generated C# desktop 3D application that compiles via the Phase 18
pipeline. Limitations are listed honestly at the end.

## What was built

New module `server/scene3d/` (wired at `/api/builds/:id/scene3d`):

| File | Role |
| --- | --- |
| `math3d.ts` | Vec3 ops, 4×4 matrices (compose/multiply/transform), perspective + lookAt, orbit-camera math |
| `scene.ts` | Scene graph with parenting/cycle protection, primitives (cube, UV sphere, plane), mesh editing (vertex translation, transform baking), materials, lights (ambient/directional/point), keyframe animation with linear sampling and scene evaluation, validated JSON persistence |
| `renderer.ts` | **Genuine software renderer**: orbit + lookAt + perspective projection, backface culling, barycentric rasterization with a z-buffer, flat shading from the scene's actual lights (ambient + directional diffuse + point-light falloff), opacity blending. Output is a Phase 19 `PixelImage`, encodable to a real PNG. |
| `exporters.ts` | OBJ + MTL (world-space baked) and **glTF 2.0** export: embedded binary buffer, accessors/bufferViews, PBR materials, node hierarchy, keyframe animations (translation/rotation/scale channels, LINEAR) |
| `scene3dProjectGenerator.ts` | Generates a complete C# WinForms 3D app on the Phase 18 stack: `SceneDocument.cs` (scene model, cube primitive, keyframe sampling, JSON save/load, OBJ export), `Viewport3D.cs` (honest GDI+ software viewport: orbit/zoom, perspective projection, per-face shading, depth sorting), `MainForm.cs` (hierarchy tree, primitive creation, keyframe capture, timer playback, save/load/export menus) |
| `scene3dRoutes.ts` | `POST /generate` (emit app source into the build), `POST /render` (scene JSON → real rendered PNG), `POST /export` (scene JSON → glTF or OBJ/MTL) — all behind the standard auth + build-ownership checks |

## Verification evidence (2026-11-25, this host)

- **Tests: 17/17 pass** (`tests/phase21_3d_creation_engine.test.ts`) covering
  matrix/camera math, primitive geometry (cube 24 verts/12 tris/unit normals;
  sphere counts and radius; plane orientation), vertex editing and transform
  baking, hierarchy inheritance, cycle rejection, reparent-on-delete,
  keyframe interpolation/clamping/non-mutation, persistence round-trip and
  corruption rejection, OBJ content (world-baked bounds), glTF structural
  validation (buffer length, bufferView bounds, accessor counts/min-max,
  animation channel), and renderer behavior (silhouette size, red-lit faces,
  **occlusion** — a nearer green cube hides a farther blue one at the image
  center, **lighting** — removing all lights renders pure black, **animation**
  — a keyframed cube leaves the frame at t=1).
- **Real render inspected visually**: a sample scene (ground plane, red
  cube, child blue sphere) rendered to a 320×240 PNG — correct perspective,
  per-face shading (bright top face), sphere shading gradient, ground plane.
  Sample files at render time: PNG 2,361 bytes, glTF 30,011 bytes, OBJ
  48,766 bytes (scratch artifacts, not committed).
- **Generated app compiles genuinely** via the Phase 18 pipeline
  (`dotnet build`, .NET SDK 8.0.428): `ModelForge.exe` 152,064 bytes,
  sha256 `4eb05eab90eba4fad0a0eec9e1bef2db41f0a65b2a0bf2ba78c57f968bdd228b`;
  `ModelForge.dll` 22,016 bytes, sha256
  `ca2555bfb18506a50184d5dfbebe6cf305b2bdeb56e710e87f361926f2805cb9`.
- **Lint ✅, TypeScript typecheck ✅, production build ✅.**
- A real renderer bug was caught by the tests and fixed during this phase:
  backface-culling sign was inverted for the y-down screen transform (front
  faces were culled, back faces shaded ambient-only). The fix is covered by
  tests 7.1/7.2.

## Limitations (honest)

- The renderer is a CPU software renderer (flat shading, no textures in the
  rasterizer, no shadows, no GPU). It is a real renderer — occlusion,
  lighting and silhouettes come from the math — but it is a modeling/preview
  renderer, not a production film renderer. Texture references are stored on
  materials and carried into exports; they are not sampled by the rasterizer.
- Primitives are cube/sphere/plane; mesh editing is vertex translation and
  transform baking (no boolean ops, no sculpting, no subdivision).
- Animation is keyframed TRS with linear interpolation (no easing curves,
  no skeletal/bone animation, no physics).
- glTF export embeds the binary buffer as base64 (valid glTF 2.0, single
  file); no `.glb` container or external-buffer variant, no skins/morphs.
- The generated C# app's viewport is likewise a GDI+ software renderer and
  its OBJ export applies translation+scale (rotation is in the model and in
  server exports); the Windows GUI cannot execute on this Linux host, so the
  app is compile-verified only — same standing limitation as Phases 18–20.
