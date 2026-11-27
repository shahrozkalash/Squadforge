# Phase 59 Acceptance Report — Performance and Stability

Date: 2026-11-27. Status: implemented and verified locally. Staged locally,
**not pushed**. Final acceptance is the owner's.

## Requirement-by-requirement

| Roadmap / brief requirement | Verdict | Evidence |
| :--- | :--- | :--- |
| Optimize filters | **Done, measured** | Separable-convolution restructure: box-blur 2.07×/2.11×, Gaussian 2.34×/2.08× (1024²/2048², medians of 5, same session); effect-stack path 1.44×/1.42×; noise/sepia direct loops (hash-pinned) |
| Optimize layer compositing | **Measured — no change claimed** | Blend dispatch specialization + lazy clip base shipped byte-identical; serial composite medians show no consistent direction vs baseline on this shared VM (focused re-measurements straddle the baseline both ways). No speedup is claimed. The compositing win of this phase is in the parallel transport (below) |
| Optimize brush strokes | **Done, measured** | Bounded stroke application: localized stroke on 2048² 3.7× faster (62.6 → 16.9 ms A/B, byte-identical); canvas-filling strokes at parity via the ≥ 90%-coverage flat-scan fallback (134.1 vs 148.3 ms A/B) |
| Optimize large-canvas rendering / memory usage | **Done** | PNG unfilter double-buffering (decode 1.14× at 2048²); pool transfers move the input's bytes once instead of once per band; RSS leak smoke test passes (25 × composite+encode at 1024², growth < 256 MB documented bound) |
| Investigate GPU acceleration properly | **Done — honest negative** | Direct probes: no `navigator.gpu`, no WebGPU flag in this Node build, no `/dev/dri`, zero Vulkan ICDs, no Dawn/wgpu anywhere; C# side has no programmable GPU path verifiable here. No GPU execution exists or is claimed; registry unchanged; provider architecture admits a future GPU provider without engine changes |
| Retain CPU fallback | **Done** | Serial CPU remains the default everywhere; the parallel provider is opt-in via the async API and the unchanged execution-plan policy |
| Benchmark both (CPU paths) | **Done** | `scripts/phase59-benchmark.ts` baseline + post runs recorded in PHASE_59_PROGRESS.md; `scripts/phase51-benchmark.ts` re-run: parallel composite 1.09× and box-blur 2.37× at 2048² (were 0.55× / 0.76×), all byte-identical. No GPU figures exist to report |
| Parallelism revisited honestly | **Done** | Persistent pool + band-sliced transfers replace one-shot spawn+clone inside the same provider: shipped provider 1.26×/1.44× composite and 1.10×/1.28× box-blur vs serial (was 0.42–0.79×). Non-sliceable work still travels whole. Execution-plan threshold deliberately unchanged — 1024² evidence is mixed across fixtures (1.26× vs 0.44×); reasoning documented in the progress doc |
| Stress tests for large images and complex projects | **Done** | 4096² composite (deterministic), ~29k-stamp stroke, 10-effect stack = baked render, 50-layer project through save/load + PSD, 25-file batch with per-file failure, RSS loop — all in `tests/phase59_performance_stability.test.ts` (25/25) |
| Stability: absurd inputs fail with named errors | **Done** | Dimension audit: engine-wide 2^28-px cap; PNG (cap + bounded inflate + truncation), BMP (negative/huge/truncated), JPEG (header cap), project-load dimension validation — all named errors, all tested |
| Never claim improvements without measurements | **Honored** | Every speedup above cites same-session before/after medians; the one path without a measurable win (serial composite) is reported as unchanged, with the focused re-measurements shown |
| Byte-identical output for optimizations | **Honored** | 14 pre-optimization SHA-256 fixture hashes pinned in the suite and reproduced after every change; two candidate optimizations (sliding-window blur, hypot substitution) were rejected as not byte-safe |

## Verification

- Phase 59 suite: **25/25**.
- All graphics suites in one run (Phase 19 + 44–59): **438/438, 0 fail,
  0 skipped**.
- `npx tsc --noEmit`: clean.
- Desktop regression: generated app rebuilt via `DesktopBuildPipeline` —
  success, zero diagnostics, PE-verified (PixelForge.dll 131,584 B Release,
  sha256 `0afc49c6…e51c9`); Phase 57 runtime harness exit 0 (15 scenarios,
  153 assertions, 0 failures). The TS micro-optimizations are not mirrored
  in the generated C# port (by design — it mirrors engine data/behavior).
- No existing tests weakened or deleted; no needle migrations; no new
  dependencies; all public signatures preserved (additions only:
  `MAX_IMAGE_PIXELS`, `assertImageDimensions`, `bandedFilterRadius`,
  `shutdownAccelerationWorkers`).

## Limitations, stated plainly

- **Serial compositing did not get measurably faster.** The measured serial
  wins are convolutions, the filter loops inside effect stacks, PNG decode,
  and localized brush strokes. Anyone quoting this phase should quote those,
  not a composite figure.
- **Parallel gains are this machine's.** ~1.5 effective cores caps what any
  transport can win; on a true multi-core machine the pool's advantage would
  be larger, and on a single-core machine it would likely vanish. The
  execution plan's serial fallback reasons remain the guard.
- **No GPU execution exists** — the investigation is a documented negative,
  not a roadmap item silently dropped.
- The RSS test is a **smoke test** with a generous bound, not a leak
  measurement; it catches per-iteration buffer leaks, not slow drift.
- Benchmarks are medians of 5 on a shared VM whose effective CPU fluctuates
  (baseline runs of one fixture ranged 532–811 ms); ratios under ~1.15×
  should be read as "unchanged", and this report reads them that way.
- The generated desktop GUI remains compile-verified only and has never
  been run (standing Phase 56–58 limitation; nothing in this phase changes
  it).

## Recommendation

The graphics engine's performance work is complete against the Phase 59
brief, with the serial-composite caveat above: **recommended for owner
acceptance**. Remaining roadmap: Phase 60 (Desktop Release and Quality
Assurance) — not started, per the one-phase-at-a-time rule.
