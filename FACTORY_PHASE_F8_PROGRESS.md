# Factory Phase F8 — Creative Editors Workflow: Progress Record

**Date:** 2026-11-27. **Status: implemented and verified locally; not
pushed. F9 not started.** Companion:
`FACTORY_PHASE_F8_ACCEPTANCE_REPORT.md` (verdicts, claim table, exact
counts).

F8 makes the three creative-editor categories work as workflows on
the factory machinery, in the F7 pattern: a described editor request
resolves its F5 team, builds through the real swarm chain, cycles
through the F6 environment contract, and is delivered only when a
category-specific verification gate passes on real evidence. The
redesign audit's photo gap (no Lightroom-class workflow) is closed
at an honest base level on the existing image engine.

## 1. Audit — what existed per category

### Classification and teams (shared)

`SoftwareRequirementsAnalyzer.detectCategory` maps any description
containing "video editor", "image editor" or "photo editor" to the
single canonical category **`multimedia_application`**. The F5 team
for it is the **Creative Software Team — Multimedia**
(`server/swarm/categoryTeams.ts`). There are no separate
video/image/photo teams; one creative team serves all three, and the
workflow differentiates by engine. All three F8 workflows therefore
plan through the same team data and diverge at the engine and the
verification gate.

### Video

Engine: `server/videoEditor/` — timeline model with validated
operations (`timeline.ts`: `createProject`, `addClip`,
`addTransition`, serialize/deserialize with format tag
`squadforge-video-project` v1, `timelineDuration`), text elements
(`editingOps.ts`), genuine ffmpeg export (`videoExporter.ts`:
`exportVideo`, `defaultExportSettings`, `validateExportSettings`),
media probing (`mediaProbe.ts`), and the ClipForge-class C# app
generator (`VideoProjectGenerator`). Phases 20–31 and Video Editor
Roadmap Phases 1–4 stand behind it.

What proves "the editor works": a real ffmpeg export of a delivered
project, verified by ffprobe (codec, dimensions, duration, audio
stream), by decoded-frame pixel checks (clip colours, burned-in
title, crossfade blend), and by audio RMS measurement — the Phase 37
evidence style, applied to the platform exporter's own output.

### Image

Engine: `server/imageEditor/` — `PixelImage` RGBA model, layers,
masks, the Phase 47 filter registry, adjustments, and codecs
(`imageCodec.ts`: PNG/JPEG/BMP/TIFF by content; PSD detected and
refused by flat import with a named error). The PixelForge-class C#
app generator is `ImageProjectGenerator`. Graphics Phases 44–60
stand behind it, including the PE-verified genuine compiles.

What proves "the editor works": engine operations applied to a
delivered project with byte/pixel-exact assertions — a
serialize → deserialize → composite round trip that is byte-identical,
and an operation chain whose output pixels are hand-computed in
advance and matched exactly.

### Photo — the gap, confirmed

Before F8 there was **no** photo workflow: no catalog, no
non-destructive develop-settings model, no batch export. The image
engine was only a base. Section 3 records the base F8 built on it.

## 2. Workflow wiring (F7 pattern, one module per editor family)

- `server/videoEditor/videoWorkflow.ts` — `VideoEditorWorkflow`
  with `plan()` (F5 team by data), `generateEditorApp()` (wraps
  `VideoProjectGenerator`), `runEnvironmentCycle()` (F6 web
  contract), and `verifyExport(packageDir)` — the category gate.
  It never throws for a bad deliverable; it refuses it through
  named checks: ffmpeg present → project parses and validates →
  media manifest materializes any missing fixture media and every
  file is re-probed against the catalogued duration (±0.15 s) and
  dimensions exactly → genuine `exportVideo` → ffprobe checks
  (h264, project dimensions, duration within ±0.35 s of
  `timelineDuration`, audio stream present) → decoded-frame checks
  via rawvideo RGB24 (first-clip colour, title near-white pixel
  count, crossfade midpoint blend) → audio RMS via ffmpeg `astats`
  (peak > −45 dB).
- `server/imageEditor/imageWorkflow.ts` — `ImageEditorWorkflow`
  with `plan()`, `generateEditorApp()` (wraps
  `ImageProjectGenerator`), `runEnvironmentCycle()`, and
  `verifyProject(delivered)`: engine deserializes the delivery →
  serialize → deserialize → composite PNG is byte-identical →
  the operation chain (`adjustBrightnessContrast(+20, 0)` then the
  registry `saturation` filter at 0.5) executes on the "Base"
  layer.
- `server/imageEditor/photoWorkflow.ts` — `PhotoEditorWorkflow`
  with `plan()`, `runEnvironmentCycle()`, and
  `verifyDelivery({deliveredProject, sources})`: catalog
  deserializes → every original verified by SHA-256 → batch export
  (JPEG q92) with every photo exported → a direct
  `exportDevelopedPhoto` must be byte-identical to the batch result
  (deterministic pipeline) and decode at the catalogued dimensions
  → originals re-hashed and proven byte-identical after the run.
  The report carries per-photo before/after hashes and mean
  luminances. Both workflow modules are exported from their engine
  indexes; no parallel editor implementation was created.

## 3. The photo base (new, on the image engine)

Two new modules in `server/imageEditor/`:

### `photoDevelop.ts` — develop settings as non-destructive data

A validated settings model (`resolveDevelopSettings` throws named
errors for unknown keys/channels/fields and out-of-range values):

- exposure −5..5 stops (2^EV gain); contrast −100..100 (tan curve
  around mid-gray); highlights/shadows −100..100 (luma-weighted,
  ±0.35 max lift); temperature −100..100 (R gain 1+0.30t, B gain
  1−0.30t); tint −100..100 (G gain 1−0.20t, R/B gain 1+0.10t);
  saturation −100..100 (engine luma-mix math); vibrance −100..100
  (scaled by 1−pixel saturation for positive values); HSL
  per-channel for red/orange/yellow/green/aqua/blue/purple/magenta
  (hue −30..30°, saturation/luminance −100..100, triangular
  hue-proximity weight with 60° falloff).
- Fixed pipeline order: white balance → exposure → contrast →
  highlights/shadows → vibrance → saturation → HSL.
- `applyDevelopSettings(img, settings)` is pure: the input is never
  mutated, alpha is preserved, and the same settings + pixels give
  byte-identical output.

### `photoProject.ts` — catalog + develop + batch export

`PhotoProject` (format tag `squadforge-photo-project` v1): entries
record id, file name, format detected by content, dimensions, byte
size, **SHA-256 of the original bytes**, rating 0..5, flag
none/pick/reject, and resolved develop settings.

- `importPhoto` decodes through the engine's
  `importImageWithMetadata` — the catalog only accepts photos the
  engine can actually decode. Camera RAW extensions
  (`.cr2/.cr3/.nef/.arw/.dng/.rw2/.orf/.pef`) are refused by name
  ("RAW camera files are not supported"; checked first, so DNG is
  refused even though it is TIFF-based). PSD is refused by name.
  Duplicate file names are rejected.
- `updatePhotoDevelop` merges patches (per HSL channel/field) and
  revalidates. `developPhoto` verifies the SHA-256 before
  developing — a tampered original is a named refusal.
- `batchExportPhotos` follows the Phase 53 honesty pattern:
  per-photo results; one failure never aborts the batch.
- Serialization round-trips with strict per-field validation;
  develop settings are re-resolved at load.

### Honest scope

Input formats are exactly the engine's verified codecs: **PNG,
JPEG, BMP, TIFF**. No RAW support is claimed or faked. The pipeline
works on sRGB-encoded values as stored (the Phase 50 documented
assumption — no gamma linearization). There is no lens correction,
no local/brush adjustments, no noise reduction, and no
clipped-channel recovery; develop is global adjustments only. This
is a base, stated as such.

## 4. Integration findings (found by running the real chain)

1. **Milestone seeding threshold.** `SwarmOrchestrator` seeds the
   connected-app scaffold graph when the planner returns fewer
   than 4 tasks. With 3 planner tasks the scaffold's init task
   creates `package.json`/`tsconfig.json` first, and a planner task
   naming the same paths then fails `create_file` ("already
   exists"), retries, and is paused as an "unproductive agent
   loop" — the build hangs to its duration cap. F8 packages
   therefore declare exactly 4 planner tasks (the F7 shape), and
   the test stub is patch-aware: a worker patches a file that
   already exists, which is the behaviour the platform's own
   MergeManager error message demands of models.
2. **Honest-verification evidence model.** The requirements
   analyzer turns the word "export" in a build description into a
   mandatory "Data export/import functionality" requirement, and
   `HonestVerificationService` requires a file scoring ≥ 4 on
   path/content token evidence. A data-only package has no such
   file and the build fails verification. F8 packages therefore
   carry a truthful `README.md` documenting the package's actual
   import/export behaviour (serialized JSON project data in, real
   rendered exports out) — documentation the verifier's own files
   check also requires.
3. **ffmpeg 8 astats format.** ffmpeg 8.1 prints `RMS level dB:
   -21.15`; the workflow's parser now matches the real format and
   takes the loudest channel. (An earlier draft also read only the
   rejection branch's stderr; the resolved result's stderr is now
   read first.)
4. **Fixture determinism.** The lavfi `gradients` source is not
   reproducible — two invocations produce different bytes even
   with a pinned seed, so develop ratios measured on it flip
   between runs. It was replaced with a `geq`-expression gradient
   (ramps peaking at 180 for highlight headroom), verified
   byte-identical across invocations. `testsrc2` is byte-stable
   but nearly exposure-blind (×1.05 at +1 EV — its primaries are
   already clipped), so it carries the desaturation/shadows
   proofs while the gradient carries exposure/white-balance.
   White balance is evidenced in isolation (temperature only,
   ×1.27 R/B shift probed): under the combined catalog settings,
   exposure clipping compresses the ratio — recorded here rather
   than hidden by a weaker combined assertion.

## 5. Tests

`tests/factory_phase_f8_creative_editors.test.ts` (4 tests) mirrors
the F7 stub-transport pattern (approval pump, planner/verifier stub
keyed on the platform's real prompt markers). Per category one
end-to-end: team → swarm build (build `completed`,
`projectType === 'multimedia_application'`, verifier-approved
event, every sandbox check passed cleanly, all planned tasks
completed) → F6 contract cycle (build honestly `skipped` for these
data packages, project tests pass, ZIP artifact SHA-256 matches the
bytes on disk) → category gate. Plus one negative test: a video
package pointing at missing media is refused with the missing file
named; a one-byte-tampered photo original fails its named SHA-256
check; RAW import, out-of-range settings and unknown settings are
refused by name; a malformed image delivery fails its named check.
Exact counts are in the acceptance report.
