# Phase 32 Progress — Production Execution Infrastructure

Status: **implemented and locally verified on 2026-11-25**. Genuine
daemon evidence (TLS, gVisor, limit enforcement against a real
dockerd) is **pending the Phase 32 CI run** — the development VM has
no Docker daemon, no `docker` CLI and no `runsc`, so nothing in this
phase claims daemon behaviour from local runs. Final acceptance
remains the project owner's decision.

Phase 32 extends the Phase 10 execution architecture in
`server/execution/` in place. No duplicate sandbox system was created.

## What was built

### Secure remote worker (TLS, fail closed) — `workerConfig.ts`, `dockerBackend.ts`
- New `resolveDockerConnection(env)`: a `tcp://`/`https://`
  `DOCKER_HOST` resolves only with all of `DOCKER_TLS_CA`,
  `DOCKER_TLS_CERT`, `DOCKER_TLS_KEY` set and pointing at readable
  files. Plaintext remote endpoints, partial TLS settings, missing
  files, `http://` and `ssh://` are configuration errors.
- `dockerClientFromEnv` now builds on that resolution and throws on
  invalid configuration instead of the old behaviour (any missing TLS
  variable silently produced a default local/plain client).
- `DockerBackend` records a configuration error and fails closed:
  `capabilities()` reports unavailable with the reason (and audits
  `execution.backend.fail_closed`), and environment/process/preview
  operations refuse. `index.ts` logs the reason at startup and audits
  `execution.backend.init_failed`.
- Diagnostics: `DockerBackend.diagnostics()` plus
  `GET /api/builds/:id/execution/worker/diagnostics` (build ownership
  **and** a `MODEL_ADMIN_USER_IDS` admin). Reports endpoint, TLS
  on/off, certificate paths and presence (never contents), daemon
  reachability/version, runtimes, storage driver and quota mode, and
  the health snapshot.

### gVisor (runsc), verified — never a silent fallback
- `SANDBOX_RUNTIME` was already passed to container creation by
  Phase 10. Phase 32 adds verification: `capabilities()` and
  `checkWorker()` read daemon info and require the configured runtime
  to be listed in the daemon's runtimes. Configured-but-absent means
  execution is unavailable with an explicit reason. With no runtime
  configured, diagnostics and capabilities report the daemon's own
  default runtime instead of assuming `runc`.

### Resource limits and disk
- Already real in Phase 10 and kept: `Memory`/`MemorySwap` from
  `EXECUTION_MEMORY_MB`, `NanoCpus` from `EXECUTION_CPUS`, `PidsLimit`
  from `EXECUTION_PIDS`, and the session-manager runtime timer from
  `EXECUTION_MAX_RUNTIME_SECONDS`.
- Disk: new `storageQuotaDecision(info)` implements the documented
  Docker support matrix (btrfs/zfs = hard, overlay2 on XFS =
  conditional on pquota, everything else = soft). When the daemon
  enforces the `size` storage option, process containers now receive
  `StorageOpt.size` = `EXECUTION_WORKSPACE_MB`. When it does not, no
  option is passed and the existing polled limit remains — labelled
  soft everywhere (diagnostics report the workspace quota as
  `soft-polling` in all modes, because the workspace is a named
  volume and Docker has no per-volume quota API; the hard option
  covers the container's writable layer).

### Preview relay security
- Preview link tokens were random, hashed at rest, expiring and
  one-time (Phase 10). They are now additionally **HMAC-signed**
  (`signPreviewToken`/`verifyPreviewToken`) with
  `PREVIEW_TOKEN_SECRET` (fallback `ENCRYPTION_SECRET`, then an
  ephemeral per-process secret), and the signed payload binds the
  token to one preview id, one session id and one owner id, with the
  expiry inside the signature. `redeem()` verifies signature and
  binding before the stored one-time hash is consulted.
- The preview listener terminates TLS itself when `PREVIEW_TLS_CERT`
  and `PREVIEW_TLS_KEY` are both set; a half-configured pair is a
  startup error, never a silent HTTP fallback.
- Unchanged and re-verified: ownership checks on every execution
  route, approval-gated session creation (workspace-hash scoped), and
  the relay's per-preview token (`phase10_relay_auth` suite).

### Health monitoring, recovery, cleanup
- New `WorkerHealthMonitor` (`workerHealth.ts`): periodic daemon
  probe (`EXECUTION_HEALTH_INTERVAL_SECONDS`, default 30, minimum 5),
  one audit event per transition (`execution.worker.health_lost` /
  `execution.worker.health_regained`), recovery callback on regain.
- New `DockerBackend.sweepOrphans(liveSessionIds)`: removes
  SquadForge-labelled containers (with anonymous volumes), volumes
  and networks whose session is not live. Resources without a session
  label — the shared edge network, per-build dependency caches — are
  never swept. Wired into startup (after `reconcile()`) and into
  health regain via `ExecutionSessionManager.sweepOrphanedResources()`,
  which audits `execution.worker.orphan_cleanup` when it removes
  something. The Phase 10 reap loop (live-session orphan environments)
  is unchanged.
- Cleanup gap closed: container removals in `destroyEnvironment`,
  process exit, volume helpers, relay and egress teardown now pass
  `v: true`, so anonymous volumes die with their containers.

### Tests and CI
- `tests/phase32_execution_infrastructure.test.ts` — 36 local unit
  tests (see the acceptance report for the breakdown). Daemon-facing
  logic is tested against clearly labelled fixture clients.
- `tests/phase32_docker_integration.test.ts` — genuine, gated on
  `DOCKER_INTEGRATION=1`: valid-cert TLS connect, wrong-CA rejection,
  plaintext-to-TLS-port rejection, runsc execution verified via
  `docker inspect` (`HostConfig.Runtime === 'runsc'`), memory limit
  OOM-kill, pids limit (inspect + a contained fork flood), and
  destroy/sweep leaving zero labelled resources. Skips cleanly
  without the gate (verified locally: suite skipped, 0 failures).
- `.github/workflows/phase32-execution-verify.yml` (local file; to be
  created on GitHub via the web UI like the Phase 25/34/35 workflows,
  since the GitHub App cannot push workflow files): unit tests +
  Phase 10 suites, sandbox image build, runsc install with checksum
  verification, openssl CA/server/client + wrong-CA certificates,
  dockerd reconfigured for `tlsverify` on `tcp://127.0.0.1:2376` with
  a systemd drop-in for the `-H fd://` conflict, readiness loops, then
  the gated integration tests.

### Docs and configuration
- `DEPLOYMENT.md`: worker setup rewritten — cert generation commands,
  `daemon.json` (TLS + runsc), the systemd drop-in, diagnostics and
  health behaviour, the resource-limit and storage-quota matrices,
  signed preview tokens, and both test invocations.
- `.env.example`: added `EXECUTION_HEALTH_INTERVAL_SECONDS`,
  `PREVIEW_TOKEN_SECRET`, `PREVIEW_TLS_CERT`, `PREVIEW_TLS_KEY`
  (all empty, per the CI integrity test).

## Verification (local, 2026-11-25)

- `npx tsc --noEmit` (also `npm run lint`, the same command): pass.
- `tests/phase32_execution_infrastructure.test.ts`: **36/36 pass**.
- Phase 10 / execution regression: `phase10_execution` +
  `phase10_relay_auth` + `execution_adapter`: **93/93 pass**;
  `phase10_end_to_end` + `phase10_sandbox_integration` (gate off) +
  `phase11_sandbox_repair` + `phase33` + `ci_workflow_integrity`:
  17 pass, 1 gated skip, 0 fail.
- `npm run build`: pass (see acceptance report).
- Full suite: run before delivery; results in the acceptance report.

## Remaining

- **CI evidence**: the Phase 32 workflow has not run yet (the file
  must be created on GitHub via the web UI first). Until a green run
  exists, TLS/gVisor/limit enforcement are *implemented and
  integration-tested in code*, not *proven*.
- **Real infrastructure**: no production worker exists yet; nothing
  has run against one.
