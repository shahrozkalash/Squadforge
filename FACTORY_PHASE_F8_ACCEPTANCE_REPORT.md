# Factory Phase F8 — Creative Editors Workflow: Acceptance Report

**Date:** 2026-11-27. **Verdict: F8 criteria met**, with the claim
scoping below recorded plainly. Implemented and verified locally;
not pushed. F9 not started. Companion:
`FACTORY_PHASE_F8_PROGRESS.md` (audit map, photo-base design,
integration findings).

## What was delivered

The three creative-editor categories work as **workflows** on the
factory machinery, in the F7 pattern:

```
description → workflow.plan()                 (F5 team by data)
            → SwarmOrchestrator build         (F2–F4 chain + gates)
            → workflow.runEnvironmentCycle()  (F6 contract, web)
            → category verification gate      (real evidence)
            → verified delivery verdict
```

New code: `server/videoEditor/videoWorkflow.ts`,
`server/imageEditor/imageWorkflow.ts`,
`server/imageEditor/photoWorkflow.ts`, and the photo base
`server/imageEditor/photoDevelop.ts` +
`server/imageEditor/photoProject.ts` — all extending the existing
engines, exported from the existing engine indexes. No parallel
editor implementation was created.

## Criterion-by-criterion verdict (roadmap F8 acceptance criteria)

### 1. Video: a described editor variant generates the ClipForge-class app; genuine-export checks pass for its export path — **MET**

The end-to-end test drives "Build a video editor app with a
multitrack timeline, crossfades, titles and MP4 export" through
team → swarm → contract, then `VideoEditorWorkflow.verifyExport`
on the delivered package: the serialized project (two 2 s clips,
0.5 s crossfade, title "F8 STUDIO", timeline duration 3.5 s) is
rendered by the platform's genuine `exportVideo`; ffprobe confirms
h264, 320×240, duration within ±0.35 s of 3.5 s, and an audio
stream; decoded frames confirm the first clip's colour, > 30
near-white title pixels in the title rows, and a genuine crossfade
blend at the midpoint (1.75 s); the mixed tone track measures
> −45 dB peak RMS via `astats`. The ClipForge-class app is the
platform generator's file set, asserted by manifest.

### 2. Image: a described editor variant generates the PixelForge-class app; the delivery is engine-verified at pixel level — **MET** (with the scoping stated in the progress doc)

The end-to-end test delivers a two-layer engine project and
`ImageEditorWorkflow.verifyProject` proves: the
serialize → deserialize → composite round trip is byte-identical,
and the operation chain (brightness +20, then the registry
`saturation` filter at 0.5) produces the hand-computed pixel
(255, 108, 33) at the asserted coordinate while the non-target
layer's pixel is unchanged. The PixelForge-class app is the
platform generator's file set, asserted by manifest; its genuine
PE-verified compile evidence stands from Graphics Phases 56–60 —
the app was **not** recompiled in F8, and F8 does not claim a new
compile.

### 3. Photo: define the Lightroom-class gap honestly and build the workflow on the image engine; acceptance is a real import → develop → batch-export run with byte-level before/after evidence — **MET at the honest base level**

The gap (no catalog, no non-destructive develop model, no batch
export) is defined in the progress doc, and the base is built:
catalog with SHA-256-pinned originals, develop settings as
validated data (exposure, contrast, highlights/shadows,
temperature/tint, saturation, vibrance, per-channel HSL), and
batch export. The end-to-end run proves, on real decoded photos:
+1 EV brightens mean luminance ×1.85 on the gradient photo (gate
threshold ×1.3); temperature +40 shifts the R/B channel ratio
×1.27 measured in isolation; saturation −100 leaves max channel
spread ≤ 1 while shadows +50 lifts mean luminance (123.4 → 138.2
on the test-pattern photo); settings round-trip as data (edit →
re-apply → different bytes; restore → byte-identical export); and
the originals' SHA-256 are identical before and after the whole
delivery. Scope is stated plainly: formats are PNG/JPEG/BMP/TIFF
only, camera RAW is refused by name, adjustments are global only.

### 4. Relevant engine suites pass; lint and build pass — **MET**

Counts below.

## Claim table

| Category | Claimed | Evidence | Not claimed |
| :--- | :--- | :--- | :--- |
| Video | Described request flows F5 team → swarm → F6 contract → verified genuine ffmpeg export | F8 suite video test: ffprobe + decoded-frame + RMS checks all pass on the exporter's real output | Live model generation (stub transport; F1 verdict stands); the ClipForge GUI running |
| Image | Described request flows to a delivered engine project; round trip byte-identical; operation chain pixel-exact | F8 suite image test: hand-computed pixel (255, 108, 33) matched; non-target layer untouched | A new genuine compile of the PixelForge app in F8 (compile evidence stands from Phases 56–60) |
| Photo | Catalog + non-destructive develop + batch export works end-to-end with byte-level evidence | F8 suite photo test: luminance ×1.85, R/B ×1.27, desaturation spread ≤ 1, settings round-trip byte-identical, originals hash-identical | RAW support (refused by name); local adjustments, lens correction, noise reduction; gamma-linear processing |
| All | A corrupt/invalid deliverable fails its category verification | F8 negatives test: missing media named, tampered original's SHA-256 check fails, RAW/bad settings refused by name, malformed image delivery refused | — |

## Verification (exact counts, from printed summaries)

- **F8 suite** `tests/factory_phase_f8_creative_editors.test.ts`:
  **4/4 pass, 0 fail, 0 skipped** — run twice consecutively with
  the same result (the fixture-determinism finding in the progress
  doc is why the second run matters).
- **Regression batch** (each suite run individually, summaries
  read): F7 games workflow 4/4; orchestration 22/22 (the
  F2-fixed `orchestration.test.ts:334` stays green);
  Phase 20 video engine 15/15; video editor Phase 4 render/export
  11/11 (the F2-fixed phase4 test 19 stays green); Phase 19 image
  engine 24/24; Phase 47 filters 51/51; Phase 52 non-destructive
  editing 27/27; Phase 58 professional file handling 24/24.
  **Total 178/178 pass, 0 fail.**
- **Lint:** `npm run lint` (tsc --noEmit) clean.
- **Build:** `npm run build` succeeds (standard chunk-size warning
  only).

## Limitations

- Generation runs over the stub transport; the F1 verdict stands —
  no live model generation is claimed anywhere in F8.
- Editor artifacts come from the platform's own engines and
  generators, labelled as such; the generated editor GUIs have
  never been run (standing platform limitation).
- Fixture media and photos are ffmpeg lavfi-generated test media,
  labelled as such in the suite; they are real encoded files
  decoded by the real engines, not photographs of the world.
- The photo base is a base: global develop adjustments on
  8-bit decoded images in PNG/JPEG/BMP/TIFF; no RAW, no local
  adjustments, no lens/noise tooling.
- One swarm behaviour worth knowing (progress doc §4): planner
  graphs under 4 tasks trigger the connected-app scaffold seeding,
  whose file ownership can collide with planner tasks; F8 packages
  declare 4 tasks, matching the F7 shape.
