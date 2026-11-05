# Phase 11 Acceptance Report

**Status:** Accepted by the project owner on 2026-11-05 at `708e761`, with the limitations below. The owner decisions at the end of this report are still open, except the first.
**Recommendation:** Suitable for development and evaluation. Not for production use. Production readiness is roadmap Phase 16.
**Assessed commit:** `708e76176d2b80638bc717f903b4307a17839f98` on `feature/phase-11-debugging`
**Date:** 2026-11-05
**Environments:** GitHub Actions on Linux with Node 22, and Windows 11 with Node 24.3.0 and Docker 29.8.1

## Check results

| Check | Environment | Result |
| :--- | :--- | :--- |
| GitHub CI [run 42017846348](https://github.com/shahrozkalash/Squadforge/actions/runs/42017846348) | Linux, Node 22 | Passed: install, lint, tests, build, and the sandbox job |
| Tests | Linux CI | **719 of 719 passed** |
| Real sandbox tests | Linux CI | **22 of 22 passed** |
| `npm run lint` | Windows | Passed |
| `npm run build` | Windows | Passed, with native packages installed locally |
| `npm test` | Windows | **717 of 719 passed, 2 failed** |
| Real sandbox tests | Windows Docker | 22 of 22 passed |
| `npm ci` | Windows | Not run, because it removes the local native package. CI ran it |

The two Windows failures are in `tests/phase4_production_reliability.test.ts`:

- Test 14: Skipped tests never treated as passed in execution report or verdict
- Test 16: Invalid TypeScript configuration reported as config error and fails verification

Both failed the same way on `main` before this work began, and both pass on Linux CI. The cause was not investigated.

**Browser check:** in Chrome at `df92895`, with a scripted model and a seeded project, analyze, repair, the recorded lesson, rollback, and the retracted lesson all worked, with no console errors. Later commits changed the server, but the page itself did not change. Approval and cancel controls were not clicked in a browser.

## What was proven on real Docker

Through the real routes, approval flow, and sandbox, with a scripted model:

1. A real failing test was diagnosed from sandbox output.
2. A patch changing `a - b` to `a * b` passed every static check, failed the real tests, and was rolled back automatically. The file returned to its exact earlier text.
3. The correct patch passed the real tests and was verified, and both lessons were stored.

## Independent review

The `invariant-reviewer` agent reviewed `df92895` and made 11 findings: 2 high, 4 medium, and 5 low. A second pass at `5f37773` re-checked the fixes and found one new medium problem.

| # | Severity | Finding | Status |
| :--- | :--- | :--- | :--- |
| 1 | High | An unrelated passing test could verify a runtime or reported problem | Fixed and tested |
| 2 | High | Rollback could erase a write queued behind the repair | Fixed and tested |
| 3 | Medium | Failures hidden by skipped checks disappeared behind `verified` | Fixed and tested |
| 4 | Medium | Project output reached swarm prompts through memory, unfenced | Fixed and tested |
| 5 | Medium | `create_file` could escape the repair's scope | Fixed and tested. Low risk remains, see below |
| 6 | Medium | Cancel did not stop dependency installs | Fixed and tested |
| 7 | Low | An unanswered rollback could lock a repair | Fixed and tested |
| 8 | Low | Unused approvals stayed live for 24 hours | Fixed and tested |
| 9 | Low | Runtime and `no_action` statuses overstated what was known | Fixed and tested |
| 10 | Low | Test helpers were not protected | Fixed and tested |
| 11 | Low | Lessons outlived a rolled-back repair | Fixed and tested. The gateway part remains, see below |
| New | Medium | Helpers could be passed to a test runner and cause a false rollback | Fixed and tested |

**The fixes made after the second pass, in `708e761`, have not had an independent review.** They are covered by tests and CI.

The reviewer found these sound: approval gating of all writes, repeated and cross-build decisions, workspace binding of execution approvals, the `cancelled` guard, memory isolation, route ownership, and prompt fencing in the debug agents. It did not review `DebuggingView.tsx`.

## Not verified

- **No real AI provider ran.** Every model answer was scripted, so the quality of real diagnoses and patches is unknown. This is the largest gap.
- Cancelling a real provider call. The abort signal is tested, and this item is already open from Phase 9.
- Scoped runs with real Vitest or Jest. Their arguments are tested, but the real runs used `node --test`, which runs the full suite.
- A real worker, TLS, and gVisor, as in Phase 10.

## Limitations

**What it can do**

- A repair is started by the owner and targets one root cause. Nothing runs automatically after a failed build.
- API errors come from process output and owner reports. Nothing sends requests to a running app.
- Static checks cover JavaScript and TypeScript. Other languages get only output parsing.
- A problem seen in a long-running `dev` or `start` process cannot be proven fixed, because the process never exits successfully. Reported problems can never reach `verified`. Both stay `applied_unverified`.

**Where it is strict or incomplete**

- Rollback refuses any file changed after the repair, and does not merge. The owner must resolve that by hand.
- Any test failure after a patch rolls it back, even one that was already failing, because a run reports only an exit code.
- A patch that reveals a new error is refused, even if the error was only hidden before.
- A static problem with no affected test can be `verified` on static evidence alone, and the outcome says so. The import graph cannot follow dynamic paths or aliases, so a test could be missed.

**Remaining low risks**

- Text printed by a project can still choose the path of a new code file during a missing-module repair. Scope, the dry run, and the approval gate still apply.
- A model reply containing only a report now counts as a success in the gateway, so it skips fallback and may be cached. Repair calls bypass the cache, and the swarm and code generation still refuse empty actions.
- Contract, component, and endpoint names in `PromptCompiler` are not fenced.
- Secret removal uses patterns, so an unusual secret format can get through.
- Checks block the server while they run, as code generation already does.
- Recovery after a restart assumes one server process.

## Decisions for the owner

1. **Accept Phase 11, or ask for changes.** Accepted on 2026-11-05. Phase 12 starts only when the owner asks.
2. **Test with a real provider** before relying on repair quality.
3. **Rollback without approval.** `requiresApproval('project_rollback')` returns true, but non-sensitive repairs roll back without a request. Automatic rollback only undoes the repair's own unverified patch, and a manual one is the owner's own action. Sensitive files always ask. Is this acceptable?
4. **Existing rollback routes.** `/rollback-checkpoint` and `/rollback-file` write as `system` or `user`, skip conflict checks, and can overwrite later user changes. They predate this phase and were not changed. Should they use the new protections?
5. **Automatic repair.** Should a failed build start a repair by itself? That adds model cost, so it was left to the owner.
