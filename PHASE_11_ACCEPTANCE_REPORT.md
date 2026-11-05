# Phase 11 Acceptance Report

**Status:** Accepted by the project owner on 2026-11-05 at `708e761`, with the limitations below. The owner decisions at the end of this report are still open, except the first. Most limitations were fixed afterwards. See "Fixed after acceptance", which replaces the older limitations and results where they differ.
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

## Fixed after acceptance

The owner asked for the limitations above to be fixed before merging. These changes came after acceptance at `708e761`. The first round was checked at `45078d4`, and a second round of smaller gaps at `4e3b8fd`. The results below are from `4e3b8fd`.

### Check results at `45078d4`

| Check | Environment | Result |
| :--- | :--- | :--- |
| GitHub CI [run 42029901049](https://github.com/shahrozkalash/Squadforge/actions/runs/42029901049) | Linux, Node 22 | Passed. **759 of 759 tests**, and **26 of 26 real sandbox tests** |
| `npm run lint`, `npm run build` | Windows | Passed |
| `npm test` | Windows | 757 of 759 passed. The same two Phase 4 tests failed |
| Real sandbox tests | Windows Docker | 26 of 26 passed |
| Real model, `qwen2.5:7b` through Ollama | Windows | See below. Not part of CI |

### Real AI model

The largest gap is closed for a local model. Repairs ran through the real gateway with `qwen2.5:7b`, and nothing about the model was scripted.

| Test | Result across all runs |
| :--- | :--- |
| Type error | Verified every time |
| Missing export in another file | Verified in most runs. In the last 5 completed runs, 4 verified and 1 failed. Bad patches were refused by validation, and the model used that feedback. The cause of the failures was never captured |
| Cancelling a real request | Passed every time, in about a second |

No cloud provider has been tested, because no API key is available here. A 7B model is also weaker than the models this will normally use, so this shows the pipeline works, not how good cloud repairs will be.

### What changed

| Limitation | Now |
| :--- | :--- |
| One root cause per run | **Repair all** continues after each verified repair, up to 5 runs, and stops at the first it cannot verify |
| Nothing automatic | Optional `REPAIR_AUTO_START=true` after a failed generation. Off by default, because it spends model tokens |
| Nothing probed a running app | The Debug tab and API can call a running project's GET routes through its relay. Routes whose names suggest a change, such as `/logout`, are skipped |
| `dev` and `start` problems could not be proven | The failed script runs again in the sandbox after approval. A crash at start is proven if the server listens and outlives the original crash by at least double. A route failure SquadForge found itself is proven by a 2xx from that route |
| Rollback refused any later edit | It undoes the repair's own lines and keeps later edits to other lines. Any change to the repaired lines is still a conflict |
| An old failing test rolled back a good repair | Failures are compared by name with the run before the repair. The result is `applied_unverified`, not a rollback. A new failure, a hang, or a file-level failure still rolls back |
| A patch revealing a hidden error was refused | An error hidden by garbled code in the broken file is reported and blocks `verified`, but no longer refuses the patch |
| Aliases and computed imports could hide a test | `tsconfig` path aliases are followed, and a computed import selects every test |
| Text printed by a project could choose a new file's path | The import must really be in the file |
| Report-only model replies counted as success everywhere | Only callers that ask for a report accept one |
| Contract and component names were not fenced | Fenced or removed in repair prompts |
| Secret removal missed unusual formats | Values from the project's own env files are removed, more patterns are covered, and secret files are never sent to a model |
| Checks blocked the server | Repair checks run in a separate process with no server secrets, and can be cancelled |
| Recovery assumed one server process | A heartbeat keeps other processes from closing a live run, and a cancel reaches the process that owns it |

### Real Docker proof of these changes

- Real Vitest and real Jest ran only the affected tests, while an unrelated failing test never ran.
- A real crash at start was proven fixed by the server staying up.
- A real 500 was found by calling a route through the relay, and proven fixed by the same call.

### Other bugs found by this work

| Bug | Found by |
| :--- | :--- |
| A local model was never routed to the local provider | Real model run |
| A root `server.js` run by Node was treated as browser code | Real Docker run |
| Proof by surviving start-up alone, or by any status under 500 | Independent review |
| Rollback could edit inside a longer line, turning a user's `30` into `10` | Independent review |
| A file-level test failure could excuse a new failure in that file | Independent review |
| A check process failure could crash the server | Independent review |
| A 200 could prove a report that needed a login | Independent review |
| Repair all left the run needing approval out of view | Browser check |

### Review of these changes

The `invariant-reviewer` agent reviewed them three more times, covering everything since `708e761`, and found 3 high and 3 medium problems, plus one blocker in a fix. All are fixed and tested. Its final answer at `45078d4` was to merge, from reading the code.

Chrome at `45078d4`: analyze, Repair all, the held approval state, Cancel, and history rows all worked with no console errors. In one earlier run on an older build, the panels came back empty after clicking a waiting repair. That did not repeat, and the cause is unknown. Approving from the Collaboration tab was not clicked in a browser, but the real Docker tests use that route.

### Smaller gaps closed in the second round

| Gap | Now |
| :--- | :--- |
| A crash caused by a request could look like a crash at start | Counts as a crash at start only if nothing outside the sandbox could have reached the session. Any preview or route check disqualifies it, and project output cannot fake or hide that record |
| A route failure on a long-running session could pass on a fresh start | Such a failure is recorded as `HTTP_PROBE_WARM`, which never proves a fix. Only a failure on a session under 10 minutes old with no outside traffic can be proven |
| A GET route with side effects could be called | Routes are also skipped when their handler code writes, such as `.save(`, `.delete(`, or `INSERT INTO` |
| Cancelling a repair could remove the owner's session | A repair removes only a session it created. If the owner already ran a script in the session for this version, the repair stops with a message saying what to do, and leaves it alone |
| The Debug tab could keep polling after a failed chain | It stops after 15 seconds |
| Generic failure messages could match an old failure | "Test suite failed to run" is no longer used to excuse a failure |
| Code generation's checks blocked the server | They run in the check process too. Finalization re-checks if the project changed during the check, and fails if it keeps changing |
| A cancelled check waited its turn | It stops at once |

Review of these found one blocker: code generation could have been finalized for files that changed while the check ran. It is fixed and tested. The review also found a session leak when a repair paused for a second approval. It is fixed and tested.

### What is still limited

- No cloud provider has been tested.
- Static checks cover JavaScript and TypeScript, and the sandbox runs only Node projects.
- A reported problem can never reach `verified`, because nothing shows the same request failed in the sandbox. The same goes for failures only a non-GET request or a logged-in user can show.
- With no earlier test run to compare, any test failure still rolls back the repair.
- Route checks skip handlers by name and by what their code visibly does. A GET route that changes things in another way can still be called, inside the sandbox only.
- A script mentioned in `package.json` exempts that file from the browser dependency check. TypeScript's own import errors still apply.
- One check at a time runs in the check process, so a large project queues behind another and can time out after 5 minutes. A timeout is reported as a failed check, never a pass.
- A run whose approval expires while it is paused leaves its sandbox session to the idle reaper.
- A real worker, TLS, and gVisor are still unverified, as in Phase 10.

### Decisions still open

Decisions 3 and 4 above are unchanged. Decision 5 is now a setting, which stays off until the owner chooses to turn it on.
