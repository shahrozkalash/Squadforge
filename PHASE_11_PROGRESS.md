# Phase 11 Progress: Advanced Debugging and Self-Improvement

**Status:** Accepted by the owner on 2026-11-05 at `708e761`, with the limitations in `PHASE_11_ACCEPTANCE_REPORT.md`. Most were fixed afterwards, in two rounds, and the tables below are from `708e761`. See "Fixed after acceptance" in that report.
**Assessed commit:** `708e761` on `feature/phase-11-debugging`
**Date:** 2026-11-05

## Architecture

New code is in `server/debugging/`. It adds no second way to write files, ask for approval, run code, or store memory.

| Module | Responsibility |
| :--- | :--- |
| `diagnosticCollector.ts` | Collects errors, gives each a stable fingerprint, and removes secrets |
| `importGraph.ts` | Import graph, dependents, and affected test selection |
| `rootCauseEngine.ts` | Separates causes from consequences, ranks them, and sets a repair's file scope |
| `debugAgentTeam.ts` | Specialist investigator, patch author, and reviewer |
| `repairPatchValidator.ts` | Checks a patch and dry-runs it on a copy of the project |
| `repairCoordinator.ts` | Repair lifecycle, approvals, verification, rollback, cancellation, and memory |
| `debuggingRoutes.ts` | Owner-checked API under `/api/builds/:id/debugging` |
| `src/components/DebuggingView.tsx` | The Debug tab |

| Existing system | How Phase 11 uses it |
| :--- | :--- |
| `MergeManager` | Every repair and rollback write, including its approval check |
| `ApprovalGateService` | Sensitive changes and test runs |
| `ExecutionSessionManager` | Test runs, with a new scoped option |
| `ExecutionAdapter`, `IntegrationAgent`, `ContractFirstEngine` | The checks behind diagnostics and dry runs |
| `CollaborativeDebuggingEngine`, `CollaborationManager` | Defect records and agent messages |
| `ProjectMemoryService` | Defects and lessons, stored in project knowledge |
| `AutomaticRepairEngine` | The generation pipeline's repair pass now dry-runs a patch before writing it |

## How a repair works

1. The owner starts a repair. Nothing starts on its own, so no model cost appears unasked.
2. Errors are collected and grouped into root causes. A repair targets one cause.
3. A specialist investigates. A claim that cites no real diagnostic cannot steer the repair.
4. An agent proposes a patch, limited to the files in the evidence.
5. The patch is validated on a copy. If it fails, the agent is told why and tries again, up to 3 times.
6. A second specialist reviews it. It can only veto, and no answer counts as a veto.
7. A sensitive file waits for the owner, and the patch is validated again after approval.
8. The patch is written with version and hash guards.
9. The real workspace is checked again, and affected tests run in the sandbox after approval.
10. The run ends in a status that says what is actually known.

## Repair outcomes

| Status | Meaning |
| :--- | :--- |
| `verified` | The target is gone, nothing new is wrong, and any needed proof exists |
| `applied_unverified` | The patch is applied, but something could not be proven. The reason is stated |
| `rolled_back` | The repair was undone |
| `failed` | No patch passed, or a rollback could not finish. The reason is stated |
| `rejected` | The owner did not approve it |
| `no_action` | No problems were found. Checks that did not run are listed |
| `cancelled` | Stopped. An applied patch is reported, and can still be rolled back |

## Requirement status

All requirements were stated by the owner. Evidence is at `708e761`.

| # | Requirement | Status | Evidence |
| :--- | :--- | :--- | :--- |
| 1 | Collect syntax errors | Verified | Real checks in `phase11_debugging_repair` |
| 1 | Collect build errors | Verified | Real esbuild errors with location |
| 1 | Collect runtime errors | Verified | Parser tests, and real sandbox output on Docker |
| 1 | Collect API errors | Partial | Parsed from process output and owner reports. Nothing probes a running app |
| 1 | Collect dependency errors | Verified | Real checks, process output, and failed installs |
| 2 | Root-cause analysis engine | Verified | Cascades, culprit files, ranking, and lessons as evidence |
| 3 | Specialized AI agents | Partial | Routing, evidence rules, and veto are tested with a scripted model. No real provider has run |
| 4 | Minimal, evidence-based patches | Verified | Scope, size, suppression, and test-editing checks |
| 5 | Validate patches before applying | Verified | Real dry runs, and no write on refusal |
| 6 | Re-run affected tests | Partial | Real on Docker with `node --test`, which runs the full suite. Scoped Vitest and Jest arguments are tested, but not with those runners |
| 7 | Rollback | Verified | Manual, automatic, atomic, conflict, sensitive, and real Docker cases |
| 7 | Repair history | Verified | Survives a coordinator restart, shown in the API and UI |
| 8 | Memory of verified solutions and failures | Verified | Reaches agents, blocks repeated patches, retracted on rollback |
| S1 | Never bypass approval gates | Verified | Tests, plus two independent reviews |
| S2 | Never overwrite unrelated user changes | Verified | Concurrent edit, lease, queued write, and rollback conflict tests |
| S3 | Keep project memory isolated | Verified | Separate owner and project tests |
| S4 | No success claim without validation | Verified | Unproven cases stay `applied_unverified`, tested |
| T | Automated tests | Verified | 93 new tests, plus 3 on real Docker |

## Bugs found and fixed

**In existing code, needed by this phase:**

| Bug | Effect |
| :--- | :--- |
| `applyPatchAtomic` used a string replacement | `$&` or `$'` in new text corrupted the file |
| `incrementalEditor` had the same bug | Same effect |
| The gateway dropped top-level `find` and `replace` | Repair patches that followed `PromptCompiler`'s documented format were lost |
| Batch deletes had no version check | A stale delete could remove a changed file |

**In Phase 11 code, found by real tests and review before commit or merge:**

| Bug | How it was found |
| :--- | :--- |
| The store returns live objects, so version guards compared a file with itself | Scripted race test |
| Source and error text reached prompts unfenced | Prompt injection test |
| Real Node test output, including TAP, was not understood | Real Docker run |
| A plain `Error: x` line was not parsed | Regression test |
| An unrelated passing test could verify a reported crash | Independent review |
| Rollback could erase a write queued behind the repair | Independent review |

## Automated tests

| File | Covers |
| :--- | :--- |
| `tests/phase11_debugging_repair.test.ts` | 93 tests with the real type checker, bundler, and database. The model is scripted, and the sandbox is a fake backend |
| `tests/phase11_sandbox_repair.test.ts` | Tests through the real routes, approval flow, and Docker. Needs `SANDBOX_INTEGRATION=1` |
| `tests/phase11_real_model.test.ts` | Repairs and cancellation with a real model through the real gateway. Needs `LOCAL_MODEL_INTEGRATION=1` and an OpenAI-compatible local server such as Ollama. Not run in CI |

The CI sandbox job now runs the second file.
