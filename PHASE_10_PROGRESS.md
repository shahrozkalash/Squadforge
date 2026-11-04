# Phase 10 Progress: Execution and Development Environment

**Status:** Implemented and tested on local Docker and GitHub CI. Not accepted. See `PHASE_10_ACCEPTANCE_REPORT.md`.
**Assessed commit:** `bb0d750` on `feature/phase-10-execution`
**Date:** 2026-11-04

Phase 9 is not accepted either. This phase was built at the user's request, with Phase 9's blockers reported in `PHASE_9_ACCEPTANCE_REPORT.md`.

## Architecture

| Module | Responsibility |
| :--- | :--- |
| `server/execution/executionBackend.ts` | Backend interface and port parsing |
| `server/execution/disabledBackend.ts` | Default backend. Reports unavailable and runs nothing |
| `server/execution/dockerBackend.ts` | Docker API backend, container profile, networks, relay, egress proxy |
| `server/execution/workspaceMaterializer.ts` | Safe archive and workspace hash |
| `server/execution/executionSessionManager.ts` | Lifecycle, limits, timeouts, cleanup, startup reconciliation |
| `server/execution/dependencyService.ts` | Package manager detection, install commands, missing module detection |
| `server/execution/previewSessionService.ts` | Preview tokens, cookies, idle timeout |
| `server/execution/previewProxy.ts` | Separate HTTP and WebSocket listener |
| `server/execution/executionRoutes.ts` | Owner-checked API under `/api/builds/:id/execution` |
| `sandbox/` | Sandbox image, relay, and egress proxy |
| `src/components/ExecutionView.tsx` | The Run tab |

There is no fallback that runs project code as a host process. Without a configured Docker worker, execution stays off.

## How a run works

1. The owner approves `code_execution` for one workspace hash. Approvals last 24 hours.
2. Project files are uploaded to a new volume through the Docker API, without `.npmrc` or `.yarnrc` files.
3. Dependencies install with `--ignore-scripts`, through an egress proxy that only reaches the registry and exists only during the install.
4. The owner picks a named script: `dev`, `start`, `build`, `test`, or `preview`. There is no arbitrary command API, and the terminal takes no input.
5. The process runs on an internal network with no route out and no host address.
6. A preview uses a relay container and a separate origin, with a one-time link and a `__Host-` cookie.

## Requirement status

| Requirement | Status | Evidence |
| :--- | :--- | :--- |
| Isolated environment per project | Verified | Real Docker tests |
| Start, stop, restart, monitor | Verified | Unit tests and browser check |
| Output, exit codes, runtime errors | Verified | Real Docker tests |
| Timeouts, cancellation, cleanup | Verified | Unit tests with a fake backend, and real stop and destroy tests |
| Memory, CPU, process limits | Memory and process limits verified on real Docker. The CPU limit is set but not load tested |
| Disk limits | Partial | Polled with `du` inside the container, which project code can evade. No hard quota |
| Network restricted by default | Verified | Internet, metadata, raw IPs, and host gateway blocked on GitHub Linux Docker |
| No host secrets | Verified | Real Docker test |
| Privilege restrictions | Verified | Non-root, no capabilities, `no-new-privileges`, read-only root |
| Path traversal protection | Verified | Unit tests. Symlink read-back tested on real Docker |
| Dependency install | Verified for npm | Real install through the proxy in tests and Chrome |
| Lockfiles respected | Verified | `npm ci` when a lockfile exists. A new lockfile needs approval |
| Other package managers | Detected, not supported | yarn, pnpm, and pip are reported as unsupported |
| Development server and preview | Verified | Real Vite project in tests and Chrome, including WebSocket upgrade |
| Preview access control | Verified | Unit tests through the real proxy |
| Dashboard | Verified | Controls exercised in Chrome. Cancelled states and failure displays were not all exercised |
| API authorization | Verified | Every route tested with a non-owner |
| Execution approval | Verified | Tied to an exact workspace hash |
| Generated tests off the host | Verified | `runIsolatedTests` no longer runs them |

## Check results

| Check | Linux, Node 22 | GitHub CI at `bb0d750` | Windows, Node 24 |
| :--- | :--- | :--- | :--- |
| `npm run lint` | Pass | Pass | Pass |
| `npm test` | 574 pass, 0 fail | Pass | 572 pass, 2 fail |
| `npm run build` | Pass | Pass | Pass, with extra local packages |
| Real Docker tests | Not applicable | Pass | 19 of 19 pass |

- The real Docker tests are `tests/phase10_sandbox_integration.test.ts` and `tests/phase10_end_to_end.test.ts`. They need `SANDBOX_INTEGRATION=1`, and CI runs them in the `sandbox-integration` job.
- The Windows failures are Phase 4 tests 14 and 16. They predate this work and pass on Linux.
- On Windows, the build needs native packages the Linux-generated lockfile omits. They were installed locally with `npm i --no-save`.

## Problems found by real runs

Mocks did not catch these. They were found by real Docker, Linux CI, Chrome, or independent review, and are fixed:

- Sandboxes could reach host services through the bridge gateway.
- One unauthenticated preview request, or one invalid project response, could crash the server.
- `INSERT OR REPLACE` deleted a session's logs, installs, and previews on every update.
- The exit watcher could hang on Linux.
- The preview cookie was dropped in the cross-site iframe.

## Known limitations

- **Shared kernel:** the default `runc` runtime shares the worker's kernel. gVisor (`SANDBOX_RUNTIME=runsc`) is supported in code but has not been tested.
- **Remote worker untested:** only a local Docker daemon was used. TLS connection to a remote worker has not been run.
- **Relay port:** published preview ports have no authentication, so `SANDBOX_PREVIEW_BIND_IP` must be private and firewalled.
- **Disk:** no hard volume quota. `du` runs in the sandbox and can be evaded. Cache volumes are removed by cleanup only.
- **Install scripts:** when approved, they run third-party code with registry network access, and can write to the project's shared cache.
- **Egress proxy:** it is a CONNECT tunnel filtered by hostname. It does not inspect TLS.
- **Test results:** a sandbox pass proves the project's test script exited 0, not how many tests ran.
- **Session age:** a session can outlive its approval, by up to 24 hours from its own creation.
- **History:** log and session rows are not pruned.
- **Network leak:** a failed network removal is not retried.
- **Runtimes:** Node with npm only, on one Node 22 image.
- **Third-party cookies:** previews rely on a `SameSite=None` cookie. Browsers that block third-party cookies may refuse it when the preview is on another site. Using a subdomain of the app's site avoids this.
- **Live logs:** the dashboard polls every 1.5 seconds. It does not use the SSE stream.
