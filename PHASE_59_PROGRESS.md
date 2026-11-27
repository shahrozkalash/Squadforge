# Phase 59 Progress — Performance and Stability

Status: implemented and verified locally on 2026-11-27. Staged locally, **not pushed**.
Final acceptance is the owner's.

Roadmap brief: "optimize large-canvas rendering, layer compositing, brush strokes,
filters, memory usage. Investigate GPU acceleration properly, retain CPU fallback,
benchmark both. Stress tests for large images and complex projects. Never claim
performance improvements without measurements."

## Method (measurement discipline)

1. **Fixtures before changes.** Deterministic fixture builders (the Phase 51
   benchmark pattern, a feature-rich project, codec inputs, a brush project) were
   hashed with SHA-256 against the engine **as it stood before any Phase 59 edit**
   — 14 output hashes covering composites, convolutions, noise/sepia, the effect
   stack, a brush stroke, and PNG/BMP/JPEG/TIFF/PSD bytes. Those hashes are pinned
   in `tests/phase59_performance_stability.test.ts`; any optimization that changes
   an output byte fails the suite. The capture was re-run after every optimization
   round: all 14 hashes identical, every time.
2. **Baseline first.** `scripts/phase59-benchmark.ts` (new; extends the Phase 51
   surface) recorded medians of 5 runs on this VM before any optimization, and was
   re-run after. All figures below are from those two runs plus focused A/B
   re-measurements where a result needed a second look.
3. **Byte-identity gate.** An optimization that would alter output bytes was
   rejected or redesigned, never shipped silently (see "Deliberately left alone").

Environment: this VM — Node v24.22.1, 4 logical CPUs reported, ~1.5 effective
cores, ~6 GB RAM, **no GPU**. All numbers are this machine, same session.

## Baseline → post-optimization (medians of 5, `scripts/phase59-benchmark.ts`)

| Case | Before (ms) | After (ms) | Verdict |
| :--- | ---: | ---: | :--- |
| box-blur r=6, 1024² serial | 603.7 | 291.1 | **2.07× faster** |
| box-blur r=6, 2048² serial | 2239.4 | 1060.8 | **2.11× faster** |
| gaussian-blur σ=2, 1024² serial | 588.0 | 251.5 | **2.34× faster** |
| gaussian-blur σ=2, 2048² serial | 2301.3 | 1106.6 | **2.08× faster** |
| effect stack (5 fx), 1024² | 769.5 | 535.7 | **1.44× faster** |
| effect stack (5 fx), 2048² | 3042.9 | 2140.1 | **1.42× faster** |
| PNG decode, 2048² | 262.8 | 231.3 | **1.14× faster** |
| composite plain 6L, 1024² serial | 575.0 | 579.9 | unchanged |
| composite plain 20L, 1024² serial | 2052.8 | 2261.3 | unchanged (see note) |
| composite rich 10L, 1024² serial | 1468.4 | 1559.4 | unchanged (see note) |
| composite plain 6L, 2048² serial | 1861.7 | 2030.9 | unchanged (see note) |
| composite plain 20L, 2048² serial | 7356.2 | 8178.8 | unchanged (see note) |
| composite rich 10L, 2048² serial | 5312.4 | 6198.2 | unchanged (see note) |
| brush, canvas-filling serpentine 1024² | 118.7 | 138.2 | unchanged (see brush A/B) |
| brush, canvas-filling serpentine 2048² | 550.9 | 582.1 | unchanged (see brush A/B) |
| PNG encode, JPEG enc/dec, TIFF LZW decode, PSD round trip | — | — | untouched code; medians within run noise |

**Note on composite serial:** the post-run medians sit ~10% above the baseline
medians for the 2048² fixtures, but the baseline's own runs spread widely on this
shared VM (baseline plain-6 1024² runs: 532–811 ms). A focused re-measurement of
the post-optimization code on a quiet machine (medians of 7–9) gave: plain-20
1024² **1758.9** (baseline median 2052.8 — faster), plain-6 2048² **2068.0**
(baseline 1861.7), rich 1024² **1569.7** (baseline 1468.4), rich 2048² **5958.1**
(baseline 5312.4). No consistent direction — the honest verdict is **no measurable
change**, and no composite speedup is claimed. The composite changes (below) are
byte-identical, do strictly less work for clip-free projects by construction, and
are retained on that basis.

## What was optimized (all byte-identical, hash-proven)

1. **Separable convolution restructure** (`separableConvolveRows`, imageCore.ts) —
   the blur/sharpen hot path. Clamp indices are precomputed per tap into
   Int32Arrays instead of `Math.min/Math.max` per sample, and accumulation uses
   four float64 accumulators with a single store per pixel. Per-channel summation
   order and rounding are preserved exactly (a per-tap `+=` into a Float32Array
   was rejected — it would round per tap). Result: **~2.1–2.3× on box/Gaussian
   blur**, ~1.4× on the effect-stack path that contains them.
2. **Blend dispatch specialization** (`PIXEL_BLENDERS`) — the per-pixel blend
   function is now resolved once per layer/band from a table instead of branching
   per pixel, with the W3C formula's `B()` inlined in the original operation
   order. `normal` still routes to the verbatim `blendOver`.
3. **Lazy clip base** (`renderNodesBand`) — the per-layer full-canvas alpha-map
   pass that feeds clipped layers now runs only when a clipped sibling actually
   consumes it; previously it ran after every non-clipped node whether or not any
   layer was clipped.
4. **Noise and sepia direct loops** — both filters previously allocated a
   per-pixel object through `mapPixels`; they now write typed arrays directly.
   The PRNG consumption order (r, g, b per pixel) and all math are unchanged.
5. **Brush stroke application bounded to the deposited region** — `strokeCoverage`
   also returns the bounds of what was actually deposited; the alpha and apply
   passes iterate that box instead of scanning the whole canvas (every pixel
   outside has coverage exactly 0). Focused A/B against a scratch copy with the
   pre-59 full-scan apply restored (outputs byte-identical both ways):
   - localized stroke (200 px line) on 2048²: **62.6 → 16.9 ms (3.7×)**; second
     run 59.3 → 9.9 ms.
   - canvas-filling stroke: bounded-only was ~10% *slower* (bounds bookkeeping,
     no area saved), so the passes fall back to the flat full-canvas scan when
     the bounds cover ≥ 90% of the canvas — re-measured at parity
     (134.1 vs 148.3 ms, same A/B). Net: large win for localized strokes, no
     regression for filling ones.
6. **PNG unfilter double-buffering** (imageCodec.ts) — two row buffers swapped
   per row instead of a fresh allocation + full-row copy per row. PNG decode
   **1.14×** at 2048².
7. **Parallel transport: persistent pool + band-sliced transfers**
   (acceleration.ts) — see the parallel section below.

## Deliberately left alone (with the reason)

- **Sliding-window box blur** — changes the summation order, so output bytes
  could differ. Not byte-safe; rejected under the phase gate.
- **`Math.hypot` in the brush stamp profile** — a sqrt substitution risks 1-ulp
  profile differences in coverage. Not byte-safe; kept.
- **hue-rotate / posterize / threshold** still run through `mapPixels` — audited;
  they are not in any measured hot path, and churning them risks bytes for no
  measured gain.
- **JPEG / TIFF / PSD codecs** — no changes; their benchmark medians moved only
  within noise, and none was claimed.
- **The C# desktop port** — Phase 59 optimizes the TS engine; the generated C#
  mirrors engine *data and behavior*, not TS micro-optimizations, and its output
  is unaffected (the desktop build + Phase 57 harness were re-run, below).

## Parallelism, revisited (measured)

Phase 51's design — one fresh worker per band per call, whole input
structured-cloned into every worker — measured **0.42× (1024²) / 0.60× (2048²)**
for compositing in this phase's baseline run, confirming Phase 51's verdict and
its causes (~252 ms spawn per worker under tsx, ~116 ms clone per 16.7 MB
buffer, ~1.5 effective cores).

Phase 59 ships a different transport inside the same `cpu-parallel` provider:

- a **persistent worker pool** (spawned lazily, reused across calls, one job in
  flight per worker, `ref()` while busy / `unref()` when idle so an idle pool
  never keeps a process alive; a worker that errors/exits mid-job rejects that
  job and is retired; `shutdownAccelerationWorkers()` added for explicit
  lifecycle management);
- **band-sliced transfers** whenever the work is per-pixel across bands: each
  band job carries only its own rows (layers + masks sliced; filters sliced
  with their convolution halo via the new `bandedFilterRadius`, using the same
  kernel builders as the serial path), transferred — not cloned — so the total
  bytes moved equal the input once, not once per band;
- work that is **not** per-pixel across bands (a layer with enabled effects or
  a placement, an adjustment layer) still travels whole, by clone, exactly as
  in Phase 51. Correctness first.

Shipped-provider results (same benchmark, same run as the serial figures;
every result byte-identical):

| Case | One-shot (baseline run) | Shipped pool+sliced | vs serial (same run) |
| :--- | ---: | ---: | ---: |
| composite plain 6L, 1024² | 0.42× | 459.8 ms | **1.26×** |
| composite plain 6L, 2048² | 0.60× | 1407.3 ms | **1.44×** |
| box-blur r=6, 1024² | 0.42× | 265.0 ms | **1.10×** |
| box-blur r=6, 2048² | 0.79× | 826.0 ms | **1.28×** |
| gaussian σ=2, 2048² | — | 888.8 ms | **1.24×** |

Phase 51's own benchmark, re-run after the change (its fixture, its A/B):
composite parallel **0.44× at 1024²** (was 0.26–0.28×) and **1.09× at 2048²**
(was 0.55–0.59×); box-blur parallel **0.85× at 1024²** (was 0.39–0.51×) and
**2.37× at 2048²** (was 0.76–0.83×); all byte-identical.

**Policy decision (documented, not silent):** `resolveExecutionPlan` is
unchanged — parallel is still offered only for band-separable work ≥ 65,536 px
with ≥ 2 bands, and the serial `composite()` / `applyFilterToImage()` remain
the default entry points everywhere (the async API is explicit opt-in; no
route calls it by default). The 1024² evidence is genuinely mixed across the
two benchmark fixtures (1.26× vs 0.44×), so the measurements do not justify
re-pinning the Phase 51 threshold in either direction this phase; at 2048²
both fixtures now show the pool winning. If the owner wants the plan threshold
moved, the numbers above are the basis for that call.

## GPU investigation (evidence, not estimation)

Probed directly in this environment (2026-11-27):

- Node v24.22.1: `navigator.gpu` is **undefined**; `node --experimental-webgpu`
  is rejected ("bad option" — the flag does not exist in this build). No
  WebGPU in Node here.
- No `/dev/dri`, no display device in lspci. `libvulkan.so.1` exists but there
  are **zero Vulkan ICDs** on the system (no hardware driver, not even the
  lavapipe software rasterizer) and `/usr/share/vulkan` is absent.
- No `webgpu`/`dawn`/`wgpu` packages in node_modules; no Dawn/wgpu binaries.
- Desktop side: the generated C# engine is raw CPU buffers by design;
  System.Drawing/GDI+ is not a programmable compute path, and
  DirectX/ComputeSharp-style paths are Windows-only and unverifiable here
  (this machine cannot run the Windows app at all — Phase 57 record).

**Verdict: no GPU execution is available or verifiable in this environment,
and none is claimed.** The provider registry is unchanged (nothing real was
found to register). The Phase 51 architecture — a provider contract held to
byte-identical results — is exactly where a future GPU provider registers
without engine changes. CPU remains the measured path.

## Stability: dimension guards (audit + fixes)

Audit of every allocation-sizing entry point. Already guarded before this
phase: PSD (30,000/dim + 2^28 px), TIFF (2^28 px), resize targets, project
creation via `createPixelImage`'s positivity check. Genuine gaps found and
closed, all with named errors and tests:

- **Engine-wide pixel cap** — new `MAX_IMAGE_PIXELS = 268,435,456` (2^28, the
  existing PSD/TIFF precedent) + `assertImageDimensions` enforced in
  `createPixelImage` and `createSelection`. Previously only `<= 0` was
  checked: fractional dimensions silently produced short buffers, and a
  20000×20000 request attempted a 1.6 GB allocation.
- **PNG decode** — header dimensions were trusted before sizing the inflate
  and the output. Now capped at 2^28 px, the inflate is bounded by the exact
  expected scanline size (a zip-bomb IDAT fails with a named "decompresses
  beyond" error), and a truncated stream fails with a named error instead of
  decoding short rows as black. Same guards in `decodePng16`.
- **BMP decode** — negative width (negative-length allocation → RangeError),
  absurd dimensions, and truncated pixel data (silently decoded as black) are
  all named errors now.
- **JPEG decode** — when the frame header parses (`inspectJpeg`), its
  dimensions are capped before the decoder allocates from them (a header can
  declare 65535×65535). An unparseable header falls through to the decoder's
  own failure, exactly as before.
- **Project load** — `deserializeProject` never validated the header
  dimensions that size every layer/mask check below it; zero, fractional and
  over-cap dimensions are rejected by name on load.

## Stress results (`tests/phase59_performance_stability.test.ts`, 25/25)

- 4096×4096 composite, 5 layers: completes; two runs byte-identical.
- Very long brush stroke (~29k stamps, 2048²): completes; deterministic
  across fresh projects.
- 10-effect stack on one layer: renders byte-identically to its baked form.
- 50-layer project: save/load round trip renders byte-identically; PSD round
  trip preserves all 50 layers' names and pixels (PSD opacity quantizes to
  1/255 by format — the pinned claim is per-layer pixels, as in Phase 49).
- Batch (Phase 53) over 25 files with one corrupt input: 24 done, 1 failed
  with a recorded error, outputs verified.
- Memory loop: 25 × (1024² 6-layer composite + PNG encode), results
  discarded — RSS growth under the documented 256 MB smoke bound (a leak
  smoke test with a generous threshold, not a precise measurement).

## Verification totals

- Phase 59 suite: **25/25**.
- All graphics suites in one run (Phase 19 + 44–59): **438/438, 0 fail**.
- `npx tsc --noEmit`: clean.
- Byte-identity: 14/14 pre-optimization fixture hashes reproduce after all
  changes (also pinned inside the suite).
- Benchmarks: `scripts/phase59-benchmark.ts` baseline + post runs recorded
  (exit 0, all identity checks true); `scripts/phase51-benchmark.ts` re-run
  (above).
- Desktop: generated app rebuilt genuinely via `DesktopBuildPipeline` —
  success, zero diagnostics, PE-verified (PixelForge.dll 131,584 B, Release,
  sha256 `0afc49c6…e51c9`); Phase 57 runtime harness re-run — **exit 0,
  15 scenarios, 153 assertions, 0 failures**.
- No existing test was weakened or deleted; no needle migrations were needed
  in this phase. No new dependencies.
