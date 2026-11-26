# Phase 34 Acceptance Report — Native Android Video Editor

**Status:** Implemented and verified locally on 2026-11-25, and
**genuinely compile-verified in CI** on 2026-11-26: run
[45700928724](https://github.com/shahrozkalash/Squadforge/actions/runs/45700928724)
returned `ok:true` — a real Gradle build produced the ClipForge
debug APK (**12,584,339 bytes**, sha256
`7bd6af54a66dc0aa268761d7a5fa80ed4d642dbc5bfb3b9980cb545e2d3ee216`),
Google apksigner verification **PASSED**, and the app's own JVM
unit tests ran green (**8 tests, 0 failures**, incl.
`EditorOpsTest`). Final acceptance remains the project owner's
decision.
**Recommendation:** Accept. The generated app is compile-verified
end to end; the remaining limitations below are behavioural, not
build evidence.

## What this phase delivered

| # | Requirement | Result |
| :--- | :--- | :--- |
| 1 | Genuine Kotlin/Compose editor (no WebView substitute) | **Done.** Full Compose UI generated; a test scans every generated Kotlin file for WebView/webkit usage. |
| 2 | Media import from device storage | **Done.** Photo picker (video/image) + document picker (audio); no storage permission requested; grants persisted; metadata probed by streaming. |
| 3 | Media library + asset management | **Done.** Assets listed with kind/duration and added to the matching track; assets live in the project model and persist with it. |
| 4 | Multitrack timeline; select/move clips | **Done.** Video + audio tracks, duration-sized clip blocks, tap-to-select, move by ±0.5 s commands with overlap validation. (Drag gestures are not implemented; move is button-driven and stated as such.) |
| 5 | Trim, split, arrange, delete | **Done** in `EditorOps` with the server engine's rules (trim clamped, split at playhead, overlap rejected). |
| 6 | Text/image overlays, basic transitions | **Text overlays done** (add/edit/remove, preview + export burn-in). **Image overlays** work as image clips on video tracks in editing/preview; PiP compositing in export is a stated limitation. **Transitions** are modelled and validated; the app export renders them as cuts (stated), the server export renders them for real. |
| 7 | Audio tracks, volume, captions | **Done.** Track gain 0..2 + mute, clip volume, caption cues at the playhead, SRT sidecar on export in the server's format. |
| 8 | Preview/playback with a genuine media engine | **Done.** ExoPlayer (Media3) over clipped playlist items; second player for the audio track; native Compose overlay/caption rendering. |
| 9 | Export settings, progress, cancellation, errors | **Done.** Source/480p/720p/1080p via Transformer + Presentation; progress from Transformer's progress channel; cancel deletes the partial file; failures surface as messages with the export notes (what was not composited and why). |
| 10 | Save, reopen, recover projects | **Done.** Atomic JSON writes after every edit; last project reopens on launch. |
| 11 | Connect to the existing editing API | **Done.** Optional client for the Phase 31 `/project/load` + `/project/save` endpoints with the user's own session cookie. |
| 12 | Library licenses verified | **Done.** Media3/Compose/coroutines are Apache-2.0; JUnit EPL-1.0 (tests); org.json BSD-style (tests). Listed in the generated README. |
| 13 | No whole-video memory loading | **Done and tested.** Streaming probe + player/transformer pipelines; tests scan the app sources for whole-file reads/decodes. |
| 14 | Genuine projects/APKs through Phase 17 | **Done and CI-proven.** `scripts/phase34-genuine-build.ts` drives the Phase 17 pipeline with `runTests`. Run 45700928724: APK 12,584,339 bytes, sha256 `7bd6af54…ee216`, apksigner verification PASSED. |
| 15 | Tests: import, editing ops, persistence, export | **Done.** 15/15 repo tests (structure, wiring, interop, route, literal scanners) + the generated app's own `EditorOpsTest` JVM suite, run in CI via `testDebugUnitTest`: 8 tests, 0 failures/errors (Gradle test-results XML, reported by the harness as `unitTests`). |

## Check results

| Check | Result |
| :--- | :--- |
| Phase 34 tests | 15/15 pass |
| Phase 17 + 34 + 35 regression | 58/58 pass |
| Genuine Gradle build (CI run 45700928724) | **Pass** — APK 12,584,339 B, apksigner PASSED, unit tests 8/8 |
| Lint / typecheck | Pass (`tsc --noEmit`) |
| Production build | Pass |

## Not demonstrated / limitations

- **Genuine Gradle compilation and the APK** were proven only
  after five failing CI runs, each a distinct root cause, fixed
  in the generator/harness (never by weakening a check):
  #1 (45649089150) Media3 1.6.1 requires compileSdk 35, the
  generator inherited 34 → editor config pins compileSdk 35.
  #2 (45665260288) and #3 (45668710334): single-backslash escapes
  in the generator's TS templates turned `\n` inside two Kotlin
  string literals — and then two `'\n'` char literals the first
  scan could not see — into real line breaks in `EditorOps.kt`
  (`Incorrect character literal`, `apkBytes: 0`) → escapes fixed;
  the repo suite now scans generated Kotlin/Swift with an
  escape- and comment-aware literal scanner covering char
  literals. #4 (45684916243): the EditorScreen overlay label's
  escaped quotes collapsed into `"""`, a Kotlin raw-string opener
  that ran the parser to EOF → fixed; the suite now also bans
  triple quotes in generated Kotlin. #5 (45698797957): the APK
  **built** (12,584,141 bytes) but strict verification failed —
  `ApkInspector.findExecutable` never searched `$ANDROID_HOME`,
  where the runner keeps its SDK → the inspector now scans every
  build-tools version under `ANDROID_HOME`/`ANDROID_SDK_ROOT`,
  and the harness reports Gradle's real test-results XML counts
  instead of a bare claim. #6 (45700928724): **full success**
  (above). Note the runs' GitHub headlines often read "Success"
  while the harness RESULT_JSON said `ok:false` — the JSON is
  the evidence, not the headline. This host cannot run the
  Gradle daemon — the standing Phase 17 limitation — which is
  why every one of these needed a CI round-trip.
- The generated app's GUI was not exercised on a device/emulator.
- Timeline clip movement is button-driven (±0.5 s), not drag.
- App export: overlay video tracks not composited, transitions as
  cuts, clip speed/fades not baked in — all stated in the app's
  export notes and README; the server engine covers those paths.


## Workflow reliability hardening (2026-11-26)

The verification workflow itself was hardened (workflow commit
`6e2a72c`; guard tests in `tests/workflow_reliability.test.ts`,
commit `89c5d4d`). Both harness steps previously piped through
`tee` without `pipefail`, so the step exit code was `tee`'s; they
now run under `set -eo pipefail`, and a new **Validate genuine
results** step (`if: always()`) fails the workflow unless the
build RESULT_JSON is `ok:true` with non-zero `apkBytes`, the
Gradle-XML `UNIT_TESTS` line shows `failures=0 errors=0`, the
apksigner strictly-PASSED line is present, the negative test is
`ok:true`, and a non-empty APK exists in `.android_artifacts`.

- Run 45706615202 (first hardened run): **failed, genuinely** —
  Gradle failed during plugin dependency resolution (Kotlin
  Compose plugin 2.0.0 / AGP 8.5.1) after ~5 minutes;
  `apkBytes: 0`. The gate failed the workflow at its first check.
  No code had changed since the successful run 45700928724.
- Run 45710851264 (re-run, unchanged code): **full success** —
  APK 12,584,161 bytes, sha256
  `fa45c9d2bbcaf1085aac705c61a1f68b1ef78a44b8176270a0d93cde23f72cca`
  (size/hash differ slightly from run #6 — APKs embed build
  metadata; both are genuine), unit tests 8/8 from Gradle's XML,
  gate passed ("All Phase 34 checks passed."). The first failure
  is assessed as a transient plugin-repository/runner network
  failure, and it is exactly the class of failure the old
  workflow would have painted green.

## CI reliability: exact-count gate (2026-11-26)

Follow-up assignment ("Fix CI Reliability Issues Only"): the
**Validate genuine results** gate previously accepted any
`UNIT_TESTS` line showing `failures=0 errors=0`; it now requires
the single exact line `UNIT_TESTS tests=8 failures=0 errors=0
skipped=0` (workflow commit `dd2b4f8`; guard needles updated in
`tests/workflow_reliability.test.ts`, commit `8021ed6`). All other
checks (RESULT_JSON `ok:true`, non-zero `apkBytes`, strict
apksigner PASSED line, negative test `ok:true`, non-empty APK in
`.android_artifacts`) are unchanged. The gate script was
fixture-proven before going live: genuine output exits 0; a skip
count or a wrong total exits 1.

- Run #10 — 45759035975 (manual dispatch on `94c67b7`):
  **success** — RESULT_JSON `ok:true`, APK 12,584,145 bytes,
  sha256 `1ec3d770…cc107be`, `UNIT_TESTS tests=8 failures=0
  errors=0 skipped=0`, apksigner strictly PASSED, gate's final
  line "All Phase 34 checks passed." (The push-triggered run #9
  on `dd2b4f8` also passed.)
  https://github.com/shahrozkalash/Squadforge/actions/runs/45759035975

- Addendum (2026-11-26, final CI reliability fix): run #11 —
  45764584085 on `91691fc`, **success** — RESULT_JSON `ok:true`,
  APK 12,584,254 bytes (sha256 `51ff0029…c0067`), exact line
  `UNIT_TESTS tests=8 failures=0 errors=0 skipped=0`, apksigner
  strictly PASSED, gate passed ("All Phase 34 checks passed.").
  https://github.com/shahrozkalash/Squadforge/actions/runs/45764584085
