# CI Reliability Report — 2026-11-26

Assignment: "Fix CI Reliability Issues Only." Scope: the main CI
pipeline plus the Phase 32 and Phase 34 verification gates. No
application features changed; no test was skipped or weakened;
Phase 36 was not started.

## 1. Main CI: missing FFmpeg killed all seven video suites

Run #153 (45754631384, on `1e552b0`) failed with 72 subtests
cancelled before running. Root cause, from the run's own log: the
Phase 20 suite's setup asserted "ffmpeg is required for the Phase
20 integration tests" and the Phase 26–31 suites died in their
setup hooks with "spawnSync ffmpeg ENOENT" — `ci.yml` never
installed FFmpeg and the current `ubuntu-latest` image does not
ship it.

Fix: `ci.yml` gained an "Install FFmpeg (required by the
video-editor test suites)" step in the validate-and-test job
(workflow commit `477ad2a`). Proven in run #158: every video
suite ran and passed; no `hookFailed`, no ffmpeg errors.

## 2. Main CI: Phase 22 git test failed only inside a real checkout

The single counted failure in run #153 was Phase 22 test 5.1
("init → status → add → commit → log → diff cycle"). Its scratch
directory sat inside the repo checkout, and `GitService`'s
`git rev-parse --is-inside-work-tree` walks up parent
directories, so a brand-new folder already read as a repository.
It passed locally only because the local snapshot has no `.git`.
A/B-proven in a real `git init` checkout: old code fails 5.1 with
the identical assertion; fixed code passes 14/14.

Fix (test file only, no assertion weakened): the scratch base
moved to a fresh `fs.mkdtempSync(os.tmpdir(), …)` directory
(commit `8021ed6`). Proven in run #158: 5.1 passes.

## 3. Phase 32 / Phase 34 gates tightened to exact counts

- Phase 32's **Validate genuine results** gate now requires the
  exact summary lines `# tests 7`, `# pass 7`, `# fail 0`,
  `# skipped 0` (workflow commit `94c67b7`). Proven by run #7
  (45758978615), success. Details:
  `PHASE_32_ACCEPTANCE_REPORT.md`.
- Phase 34's gate now requires the exact line
  `UNIT_TESTS tests=8 failures=0 errors=0 skipped=0` (workflow
  commit `dd2b4f8`); the artifact and apksigner checks are
  unchanged. Proven by run #10 (45759035975), success. Details:
  `PHASE_34_ACCEPTANCE_REPORT.md`.
- Both gate scripts were fixture-proven before going live
  (genuine output exits 0; fail, skip, or wrong-total variants
  exit 1), and `tests/workflow_reliability.test.ts` guard
  needles were updated to match (commit `8021ed6`).

## 4. Run #158 exposed two cancelled Phase 9 tests — root-caused and fixed

Run #158 (45758978522) proved fixes 1–2 (pass 1124 → 1195,
fail 1 → 0, cancelled 72 → 2) but still failed overall: two
tests in `tests/phase9_gate_bypass_regression.test.ts` were
cancelled with "Promise resolution is still pending but the
event loop has already resolved."

Root cause: `backoffSleep()` in `server/providerReliability.ts`
created its retry timer with `timer.unref()`. An unref'd timer
does not keep the event loop alive, so when the awaited sleep is
the only pending work — exactly the situation in the abort test,
whose mocked fetch settles via microtasks — the loop drains
mid-sleep and the test runner cancels the still-pending test.
The second cancelled test was collateral in the same file
process. A/B proof in a bare process: with the unref'd timer
the process exits without the sleep ever resolving; with the
fix it resolves after ~1 s. The Phase 9 file passes 35/35 in
isolation both ways — the bug only bites when nothing else in
the process holds the loop open, which is why it appeared in CI
and not locally.

Fix (commit `dff6811`): the `unref` was removed, with a comment
recording why an awaited sleep must keep the loop alive (the
promise always settles — timer fires or abort clears it — so a
ref'd timer cannot hold a process open). A child-process
regression test, "backoffSleep keeps the event loop alive until
the awaited sleep resolves," was added to
`tests/phase33_ai_reliability_security.test.ts`; it is proven
to fail against the old code and pass against the fix (it must
run in a child process — in-process, this suite's own stub
servers would mask the bug).

## 5. Final state — main CI run #159, success

Run #159 (45761806658, on `dff6811`):
https://github.com/shahrozkalash/Squadforge/actions/runs/45761806658

    # tests 1199   # pass 1198   # fail 0
    # cancelled 0  # skipped 1   (the gated live-provider test)

Both previously cancelled Phase 9 tests pass by name in the
log, and the new backoff regression test passes. Progression
across the assignment: run #153 — pass 1124 / fail 1 /
cancelled 72; run #158 — pass 1195 / fail 0 / cancelled 2;
run #159 — pass 1198 / fail 0 / cancelled 0. Both jobs
(validate-and-test, sandbox-integration) succeeded.
