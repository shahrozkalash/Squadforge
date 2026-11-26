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

## 6. Final CI reliability fix (2026-11-26, later the same day)

Follow-up assignment ("Final CI Reliability Fix"): re-inspect the
cancelled/skipped counts, audit the backoff timer and async
cancellation handling for unresolved promises, run everything,
and re-verify Phases 32, 34 and 35 on the latest main.

**Cancelled tests:** confirmed closed. Main CI runs #159 and
#161 both report `# cancelled 0`, and the two Phase 9 tests pass
by name in both logs.

**The one skipped unit in main CI** is the Phase 32 Docker
worker integration *suite* — run #161's log line 6374 reads
`ok 79 - Phase 32 Docker worker integration # SKIP Set
DOCKER_INTEGRATION=1 to run`. It is an environment gate, not a
failure: that suite needs a TLS + runsc Docker daemon, which
main CI's validate job does not provide — it runs genuinely in
its dedicated workflow instead (run #8 below, 7/7). Separately,
the Phase 33 live-provider test gates itself on
`LIVE_PROVIDER_TEST=1` with a real `GEMINI_API_KEY` (it is the
one skip counted in that file's standalone runs). Neither gate
was removed or weakened; enabling either inside main CI is an
owner decision (daemon infrastructure in the validate job, or a
provider secret in CI), and both are recorded here rather than
hidden.

**Async cancellation audit:** every `timer.unref` /
`child.unref` / `worker.unref` site in `server/` was classified.
All awaited plain-`setTimeout` sleeps use ref'd timers. The
watchdogs (session max-runtime, exporter kill escalation,
provider fetch timeouts), background intervals (reaper, health
monitor, lock renewal, repair heartbeat), and detached
children/workers are unref'd correctly — the work they guard
has its own ref'd handles and they are cleared or fire
independently. Two sites were the same bug class as
`backoffSleep`: in `executeGeminiCall`
(`server/smartRouter.ts`), the internal abort timer and the
caller-signal race timer both *settle an awaited
`Promise.race`* but were unref'd, so a drained loop would have
left the race pending forever. Both unrefs were removed
(commit `91691fc`); both timers are cleared in the `finally`
on settlement, so they cannot hold a process open. No
regression test was added for this pair: the repo's Gemini
tests stub at HTTP level, where real sockets mask the drain —
a test that cannot fail on the old code would be theatre. The
fix is covered by the full suite and CI below.

**Re-verification on `91691fc`:**

- Main CI run #161 (45764432618): **success** — 1199 tests,
  1198 pass, 0 fail, 0 cancelled, 1 skipped (the gated suite
  above). https://github.com/shahrozkalash/Squadforge/actions/runs/45764432618
- Phase 32 run #8 (45764540819): **success** — integration
  exactly `# tests 7 / # pass 7 / # fail 0 / # skipped 0`;
  gate line "All Phase 32 checks passed."
  https://github.com/shahrozkalash/Squadforge/actions/runs/45764540819
- Phase 34 run #11 (45764584085): **success** — RESULT_JSON
  `ok:true`, APK 12,584,254 bytes (sha256 `51ff0029…c0067`),
  exact line `UNIT_TESTS tests=8 failures=0 errors=0
  skipped=0`, apksigner strictly PASSED, gate line
  "All Phase 34 checks passed."
  https://github.com/shahrozkalash/Squadforge/actions/runs/45764584085
- Phase 35 run #7 (45764630205): **success** — RESULT_JSON
  `ok:true`, ClipForge.app executable 72,232 bytes (sha256
  `2b83a46d…c95759`, byte-identical to the accepted build),
  ops `OPS_ALL_PASS`, gate line "All Phase 35 checks passed."
  https://github.com/shahrozkalash/Squadforge/actions/runs/45764630205
- Locally: `tsc --noEmit` clean; Phase 33 + Phase 9 suites
  49 pass / 0 fail / 0 cancelled; `npm run build` (vite
  production build) succeeds.
