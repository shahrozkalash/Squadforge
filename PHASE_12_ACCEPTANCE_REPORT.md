# Phase 12 Acceptance Report

**Status:** **Accepted by the project owner on 2026-11-25**, with the
limitations and the two pre-existing failures below kept on record.
**Assessed base commit:** `c6e90c1` on `main` (latest commit when the audit
began, 2026-11-07)
**Date:** 2026-11-25
**Environment:** Linux (Muse VM), Node v24.22.1. CI (GitHub Actions, Linux,
Node 22) has not yet run on these changes at the time of writing; the local
results below are the evidence available. Docker sandbox integration tests
were not run (they require the sandbox image and are a separate CI job).

## Scope honesty

Phase 12's detailed original specification does not survive in the
repository. The one-line scope stated by the owner in `AGENTS.md` —
"Automated Testing and Quality Assurance" — is established. Everything
beyond that line is **inferred from the code** (the Phase 7 blueprint's QA
subsystem and its 85% coverage goal, the swarm's QA task) and is labeled as
inferred in `PHASE_12_PROGRESS.md`. Phase 12 was not implemented under
another name and was not merged into another phase: there is no Phase 12
commit, test file, or document in the base tree, and history moves from
Phase 11 (2026-11-05) directly to Phase 13 (2026-11-06).

## Check results (this environment, 2026-11-25)

| Check | Result |
| :--- | :--- |
| `npm ci` | Passed (218 packages) |
| `npm run lint` (`tsc --noEmit`) | Passed |
| `npm run build` (vite) | Passed (chunk-size warning only, pre-existing) |
| `npm test` — full suite, after Phase 12 changes | **935 of 937 passed, 2 failed** (both pre-existing, see below) |
| `npm test` — full suite, before the `.env.example` fix | 934 of 937 passed, 3 failed |
| Phase 12 + verification + execution-adapter suites | 24 of 24 passed |
| CI integrity suite after fix | 4 of 4 passed |

## The two remaining failures are pre-existing

Both failed identically when the same test files were run against the
**unmodified base-commit code** (Phase 12 changes temporarily swapped out,
then restored and re-run with identical results, 39 of 41 in the two files):

1. `tests/orchestration.test.ts` — "Valid files pass sandbox integrity
   check and create verified checkpoint" (assertion at line 365).
2. `tests/phase4_production_reliability.test.ts` — test 19, "Accurate final
   verdict: verified only with genuine passing evidence across all stages"
   (verdict came back `failed`).

The Phase 11 acceptance report already records Phase 4 tests failing on
Windows while passing on Linux CI; the root cause in this environment was
not investigated beyond proving the failures pre-date Phase 12. CI on
GitHub Actions is the reference result for them.

## Requirement table

| # | Requirement | Source | Status | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Automated tests run for SquadForge itself, in CI | Stated (roadmap line) + existing code | **Verified** (historically built; re-verified today) | 937 tests run locally; `.github/workflows/ci.yml` runs install, lint, tests, build, and a sandbox job |
| 2 | Generated projects' tests execute with honest results | Existing code (Phases 9–11) | **Verified** | Sandbox-only execution in `executionAdapter.ts`; skipped tests never counted as passed (Phase 4 tests) |
| 3 | The blueprint's 85% automated coverage goal is measured and reported | Inferred (blueprint) | **Verified** (new in Phase 12) | `TestCoverageAnalyzer`; `testCoverage` in every verification report; 7 analyzer tests + 2 integration tests pass |
| 4 | Untested files are named, not hidden | Inferred (blueprint QA responsibilities) | **Verified** (new) | `uncoveredSourceFiles` in the report; unresolved-risk entry in the verification report; integration test asserts the file is named |
| 5 | No test result is ever reported as passed without execution evidence | Stated invariant (`AGENTS.md` #4/#9) | **Verified** (bug fixed) | `parseTestOutput` fallback fix; 3 parsing tests pass, including no-evidence → skipped |
| 6 | The repo's own CI integrity checks pass | Existing test | **Verified** (fixed) | `.env.example` keys restored; suite passes 4/4 |
| 7 | Coverage is a hard quality gate that can fail a verdict | Inferred | **Not implemented — owner decision** | Below-goal coverage is a `blocked` check + named risk today; it does not change the verdict. See decisions below |
| 8 | Line/branch coverage measurement | Inferred | **Not implemented** | Phase 12 measures file-level coverage only, and labels it as such everywhere it appears |

## What changed (files)

- `server/testing/testCoverageAnalyzer.ts` — new: deterministic file-level
  coverage analysis (import resolution + path pairing; no code execution).
- `server/testing/index.ts` — new: module export.
- `server/types.ts` — added `TestCoverageReport`; optional `testCoverage`
  field on `VerificationReport`.
- `server/verificationService.ts` — runs the analyzer in every evaluation;
  adds the coverage check item and the below-goal unresolved risk.
- `server/swarm/executionAdapter.ts` — `parseTestOutput` fallback honesty
  fix (no evidence → skipped, never passed).
- `.env.example` — restored `APP_URL`, `GEMINI_API_KEY`, `PORT=3000`
  (empty values; no secrets).
- `tests/phase12_automated_testing_qa.test.ts` — new: 12 tests.
- `PHASE_12_PROGRESS.md`, `PHASE_12_ACCEPTANCE_REPORT.md` — new.
- `AGENTS.md` — Phase 12 status row updated.

No existing test was deleted, skipped, or weakened. Phases 1–11 and 13–17
code paths are unchanged except the shared `parseTestOutput` fallback,
whose new behavior is the invariant-correct one and is covered by tests in
both directions (evidence → passed, no evidence → skipped).

## Security review of the Phase 12 changes

- The analyzer only reads file contents already held in the project store;
  it executes nothing, spawns nothing, and calls no model or network.
- It introduces no new route and no new data exposure: coverage results
  ride the existing authenticated verification route.
- The parsing fix removes a false-pass path; it cannot turn a real failure
  into a pass (TAP parsing precedence is unchanged and tested).
- `.env.example` values remain empty; no secret was added anywhere.

## Limitations

- File-level coverage is a coarse signal: a file imported by a test counts
  as covered even if the test asserts little. It is labeled "file-level"
  in every report surface for exactly this reason.
- The analyzer understands JS/TS import forms (`import`, `require`,
  dynamic `import()`). Other languages' test layouts are not analyzed;
  their files are excluded from the testable set rather than miscounted.
- Coverage does not yet gate the verdict (decision 1 below), and there is
  no per-project goal override in the UI — the goal is the blueprint's 85%
  unless a caller passes another value.
- The two pre-existing failures above remain open in this environment.

## Decisions for the owner

1. **Accept Phase 12, or ask for changes.** Accepted on 2026-11-25.
   Phase 13–17 already exist, so acceptance here is about the record, not
   about unblocking later work.
2. **Should below-goal coverage fail the verification verdict?** Today it
   is a blocked check and a named risk. Making it a hard gate would change
   verdicts for projects that currently verify with thin test suites.
3. **The two pre-existing failures** (orchestration checkpoint, Phase 4
   test 19): they pass on GitHub CI per the Phase 11 report's pattern, but
   if the owner wants, they can be investigated as their own task.
