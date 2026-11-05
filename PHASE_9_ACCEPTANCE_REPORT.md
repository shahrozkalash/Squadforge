# Phase 9 Acceptance Report

**Status:** Accepted by the project owner on 2026-11-05 at `e87efe8`, with the limitations listed below.
**Assessed commit:** the commit that merged Phases 9 and 10 to `main`
**Date:** 2026-11-05

## Check results

| Check | Result |
| :--- | :--- |
| `npm ci` | Pass |
| `npm run lint` | Pass |
| `npm test` | 604 of 604 pass, with Phase 10 included |
| `npm run build` | Pass |

These ran in a Linux container on Node 22. No real AI provider was called.

## How approvals work now

- An approval covers the exact changes the owner reviewed, identified by a fingerprint of every action on each file.
- Paths are normalized first, so spaces or doubled slashes cannot hide a sensitive file.
- Each approval works once per file, and lasts 24 hours from creation.
- The owner's latest decision on a file wins, so a rejection overrides an earlier approval.
- An approval without a fingerprint authorizes nothing. Clients cannot supply fingerprints or stored changes.
- The approval card shows the agent, the files, and the full change.
- Approving applies the stored changes. The model is not asked again.
- The owner can revoke an approval that still has unused files, with the Revoke Approval button or `POST .../approvals/:id/revoke`.

A swarm task applies and records its ordinary files, then pauses with its sensitive changes in an approval request. Approval applies them, creates any tasks from the same response, and runs the normal completion check. Rejection or expiry fails the task, so the build cannot finish as a success with those changes missing. Stop withdraws waiting requests. A code generation run pauses as a whole until the owner decides.

The owner's own edits through the ownership-checked file routes do not need an approval.

## Review findings

Independent reviews ran at `d929a34`, `66a94e4`, `11b5b9c`, and `88c1336`, by reading and tracing code. The last one found nothing blocking.

| Finding | Status |
| :--- | :--- |
| Preview could use the owner's session | Fixed |
| Reserved `system` actor and model id | Fixed |
| Batch renames not checking the destination | Fixed |
| Approval covered a path, not content (F4) | Fixed |
| Stop not stopping model requests or writes | Fixed |
| Sensitive path detection gaps (F7) | Fixed |
| Approved request valid for nearly 48 hours (F8) | Fixed. Validity now runs from creation |
| Stored cancellation hidden by the cache (F9) | Fixed for the checks in the pipeline |
| Cancellation details lost (F10) | Fixed |
| False provider failure, invented cost, and false success on cancel (F11-F13) | Fixed |
| Spaced paths, duplicate actions, and unbound approvals | Fixed |
| Swarm stalls, false task completion, stuck runs, and blocked repair | Fixed |

## Remaining limitations

- **Real providers:** cancellation has only been tested with a stubbed network. An abort may not stop a provider's work or billing.
- **Multiple processes:** another process stops a run at its next check, but cannot abort a request in flight.
- **Patch review:** `applyApprovedPatch` does not check `reviewStatus`, because nothing in the code ever sets it. Enforcing it would block every patch. The sensitive-file gate still applies.
- **Repair:** sensitive files are not repaired automatically. The run ends as failed, and the owner must approve a new change.
- **Waiting builds:** a build waiting on the owner shows as `running`. If it reaches its time limit, it resumes when the owner decides.
- **Unanswered requests:** a request only becomes `expired` when the owner responds to it. Nothing sweeps old requests, so a task can wait indefinitely if the owner never responds.
- **Lockfile:** what kept deleting `package-lock.json` from `main` is still unknown. It may happen again.
- **Rollbacks:** `revertToCheckpoint` and `revertFileVersion` are owner-only, and bypass the sensitive-file gate.
- **Approval timing:** a crash between a write and marking an approval used would leave it usable, for that same content only.

## Fixed after acceptance

These limitations were fixed after the owner accepted the phase. No independent review has covered these changes yet.

| Limitation | Fix | Test |
| :--- | :--- | :--- |
| Planner writes dropped | A sensitive planner file now waits on its own task and approval request | `tests/phase9_limitations.test.ts` |
| Held tasks skipped the completion check | Approved tasks now run the same check, and fail if a declared file is missing | Same file |
| `create_task` lost in a held response | Tasks are listed on the approval card, and created only on approval | Same file |
| No patch record on the held path | Ordinary and approved files are both recorded | Same file |
| Slow worker could pause another worker's task | The worker checks its claim before writing and before pausing | Same file |
| No tests for HTTP routes, expiry, or re-opening | Added, including rejection of other users | Same file |
| Any signed-in user could change shared models | In production, only ids in `MODEL_ADMIN_USER_IDS` can. If it is unset, nobody can | Same file |
| No revoke button | Added to the approval card | Not tested in a browser |
