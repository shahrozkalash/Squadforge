# Phase 9 Acceptance Report

**Status:** Fixes complete except for the items listed below. Formal acceptance is the project owner's decision.
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
- The owner can revoke an approval through `POST .../approvals/:id/revoke`. There is no UI button for this yet.

A swarm task applies its ordinary files, then pauses with its sensitive changes in an approval request. Approval applies them and completes the task. Rejection or expiry fails the task, so the build cannot finish as a success with those changes missing. Stop withdraws waiting requests. A code generation run pauses as a whole until the owner decides.

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
- **Planner writes:** a sensitive file written by the initial planner is dropped without a request.
- **Held tasks:** after approval, a task skips the per-task completion check, though project verification still runs. `create_task` actions in a held response are lost, and ordinary files applied on that path get no patch record.
- **Slow workers:** a worker whose model call outlasts its 90-second lease could still pause a task another worker holds.
- **Test coverage:** the HTTP approval routes, the expiry path, and task re-opening on resume have no direct tests.
- **Lockfile:** what kept deleting `package-lock.json` from `main` is still unknown. It may happen again.
- **Rollbacks:** `revertToCheckpoint` and `revertFileVersion` are owner-only, and bypass the sensitive-file gate.
- **Shared models:** in production, guests cannot change the model registry. Any signed-in user still can.
- **Approval timing:** a crash between a write and marking an approval used would leave it usable, for that same content only.
