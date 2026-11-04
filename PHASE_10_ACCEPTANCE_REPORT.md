# Phase 10 Acceptance Report

**Recommendation:** Do not accept for production. Suitable for development and evaluation on a trusted Docker host. Acceptance is the project owner's decision.
**Assessed commit:** `bb0d750` on `feature/phase-10-execution`
**Date:** 2026-11-04

## Why production is not recommended

The feature works end to end, and all checks pass. Three things stop a production recommendation:

1. Phase 9 is not accepted, and its approval problem F4 is still open.
2. Nothing has run on a real worker, over TLS, or with gVisor.
3. An independent review of the fixes has not been repeated. The first review ran before the fixes in `bb0d750`.

## Isolation claims

These held in tests with hostile fixtures on GitHub Linux Docker with the default `runc` runtime:

- The process runs non-root, with no capabilities and no new privileges.
- The root filesystem is read-only, and `/tmp` does not allow execution.
- Host secrets are absent, and there is no Docker socket.
- Another project's workspace is not visible.
- The internet, the metadata address, raw IPs, and the host on the session network are blocked.
- A fork bomb hits the process limit, and a memory hog is stopped.
- The install proxy reaches only the registry, and is removed after the install.

This is **not** a claim of strong isolation. Containers share the worker's kernel, so a kernel exploit could escape. Production needs gVisor or a disposable VM, and a worker that holds no secrets and cannot reach SquadForge's data.

## Check results

| Check | Result |
| :--- | :--- |
| GitHub CI at `bb0d750` | `validate-and-test` and `sandbox-integration` both pass |
| Linux, Node 22, in a container | Lint and build pass, 574 tests pass |
| Windows, Node 24 | Lint passes, 572 of 574 tests pass. Phase 4 tests 14 and 16 fail, as they did before this work |
| Real Docker tests, local | 19 of 19 pass |
| Chrome, on the final code | Approve, create, install, start, preview, stop, and delete all worked with a real Vite project |

No real AI provider was involved.

## Independent review

The `invariant-reviewer` agent reviewed the work before the last fixes, by reading code and running small probes. It made 16 findings.

| Finding | Status |
| :--- | :--- |
| 1, 2: Server crash from a request or a project response | Fixed and tested |
| 3: Host reachable through the gateway | Confirmed on Docker, fixed, and tested on GitHub Linux Docker |
| 4: Sessions outliving their approval | Partly fixed: sessions end 24 hours after creation |
| 5: Workspace hash stops describing the volume | Partly fixed: installs and tests need a fresh session. `dev` can still change its own volume |
| 6: Lockfile trust and memory | Fixed and tested |
| 7: Disk limits | Partly fixed: Docker logs are bounded, installs are checked, and cache cleanup runs. No hard quota, and `du` can be evaded |
| 8: Guest block lost on restart | Fixed and tested |
| 9: Session creation race and limits | Fixed and tested |
| 10: Project cookies and socket origin | Fixed and tested |
| 11: Cross-site requests | Fixed and tested |
| 12: Relay port authentication | Open, documented |
| 13: Weak test evidence | Partly fixed: results cannot be replaced. A pass still only proves an exit code |
| 14: Approved install scripts reach | Open, documented |
| 15: Stop and cleanup gaps | Mostly fixed. Failed network removal is not retried |
| 16: Ambiguous workspace hash | Fixed and tested |

## Owner decisions

1. **Guest execution:** `EXECUTION_ALLOW_GUESTS` is off by default in production. If the app has no accounts, nobody can run projects there until this is decided. Anonymous execution invites abuse.
2. **Worker:** provision a dedicated machine, and decide whether to require gVisor.
3. **Preview domain:** choose a domain for `PREVIEW_BASE_DOMAIN`. A subdomain of the app's site works best with third-party cookie blocking.
4. **Phase 9:** decide on F4, F7, and F8 before relying on approvals in production.

## Before production

1. Run the real Docker tests on the actual worker, with TLS and gVisor.
2. Add a hard disk quota, or accept the limitation.
3. Repeat the independent review on the final code.
4. Decide the items above.
