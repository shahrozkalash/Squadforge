# Phase 32 Acceptance Report — Production Execution Infrastructure

**Status:** Implemented and locally verified on 2026-11-25. Genuine
daemon evidence is **pending the Phase 32 CI run** — this host has no
Docker daemon, so TLS, gVisor and limit enforcement have not yet been
observed against a real dockerd anywhere. Final acceptance remains
the project owner's decision.
**Recommendation:** Accept the implementation with the CI run as the
remaining gate. Do not treat any Docker/TLS/gVisor/quota behaviour as
proven until the workflow below is green.

## Evidence, in three tiers

### Locally tested (this VM, 2026-11-25)

| Check | Result |
| :--- | :--- |
| `tests/phase32_execution_infrastructure.test.ts` | **36/36 pass** |
| Phase 10/execution regression (`phase10_execution`, `phase10_relay_auth`, `execution_adapter`) | **93/93 pass** |
| `phase10_end_to_end`, `phase10_sandbox_integration` (gate off), `phase11_sandbox_repair`, `phase33`, `ci_workflow_integrity` | 17 pass, 1 gated skip, 0 fail |
| `tests/phase32_docker_integration.test.ts` without the gate | Skips cleanly (0 run, 0 fail) |
| Typecheck / lint (`npx tsc --noEmit` = `npm run lint`) | Pass |
| Production build (`npm run build`) | Pass |
| Full suite (`npx tsx --test tests/**/*.test.ts`) | 1,189 tests: **1,180 pass, 8 fail, 1 skipped** — failure analysis below |

The 36 local tests cover: connection resolution (plaintext remote
refused, partial TLS refused naming the missing variables, missing
cert files refused, complete TLS accepted, ssh refused,
`dockerClientFromEnv` throwing instead of falling back, a
misconfigured `DockerBackend` reporting unavailable and refusing to
create environments); configured-runtime verification against a
labelled fixture daemon (runsc absent → unavailable with an explicit
no-fallback reason; runsc present → available; unset → daemon default
reported); the storage-quota decision table (btrfs/zfs hard,
overlay2/XFS conditional, overlay2/ext4, vfs and unknown soft) and
HostConfig translation (memory/swap, NanoCpus, PidsLimit, StorageOpt
present only when supported); diagnostics redaction (certificate
contents never appear; paths and presence do); the orphan sweep
against fixtures (only dead-session resources removed; live sessions,
the edge network and caches untouched); health-monitor transitions
(loss/regain audited once each, recovery runs on regain); signed
preview tokens (round-trip, payload/signature tamper, wrong secret,
expiry, the old unsigned shape rejected) and `redeem()` binding +
one-time use against stored preview records; and the diagnostics
route over real HTTP (non-admin owner 403, admin 200, no secret in
the payload).

Fixture clients are stubs of the dockerode surface, labelled as such
in the test file. They prove SquadForge-side logic only.

### Full-suite failure analysis (8 of 1,189)

- 2 are the known pre-existing failures, proven identical on the
  pristine base in earlier phases: `tests/orchestration.test.ts`
  (sandbox-integrity checkpoint) and
  `tests/phase4_production_reliability.test.ts` test 19.
- 3 Phase 15 deployment tests failed under full-suite load and pass
  in isolation (24/24 and 9/9) — the same load-flake pattern recorded
  in Phase 33.
- 2 Phase 23 release tests failed with `spawn dotnet ENOENT`: the
  full-suite invocation did not set `DOTNET_ROOT`/`PATH` for
  `~/tools/dotnet`. With that environment they pass 7/7. A runner
  environment artifact, not a code failure.
- 1 Phase 9 test ("an abort while reading an error body is not a
  provider failure", expected `CANCELLED`, got `NETWORK_ERROR`)
  failed deterministically in isolation on this host during the
  Phase 32 run. It exercises the provider-routing code
  (`server/smartRouter.ts`), which Phase 32 does not touch; Phase
  33's run already recorded this test failing intermittently.
  **Resolved as a follow-up fix on 2026-11-25:** the Phase 33 retry
  loop drained a retryable response with
  `await response.text().catch(() => '')`, which throws
  synchronously (escaping as `NETWORK_ERROR`) when the body read
  itself fails — including when a caller abort lands mid-read —
  before the abort checks could classify it. The drain is now
  exception-safe, so the attempt reaches the existing abort checks
  and classifies as `CANCELLED`. Verified: Phase 9 gate-bypass +
  Phase 33 suites, 48 pass / 1 gated skip / 0 fail.

### CI tested — PENDING

`.github/workflows/phase32-execution-verify.yml` exists locally and
must be created on GitHub via the web UI (the GitHub App cannot push
workflow files), then run. It builds a real TLS-verified dockerd with
the runsc runtime on the runner and runs
`tests/phase32_docker_integration.test.ts` with
`DOCKER_INTEGRATION=1`: valid-certificate TLS connection, wrong-CA
certificate rejection, plaintext-to-TLS-port rejection, runsc
execution verified by `docker inspect`, memory-limit OOM kill,
pids-limit containment, and destroy/sweep cleanup leaving zero
labelled resources. **No CI result exists yet.**

### Real infrastructure tested — NONE

No production worker exists. Nothing has run against one.

## What was already true before Phase 32 (kept, not rewritten)

- TLS client construction from `DOCKER_TLS_*` existed; Phase 32 made
  it fail closed instead of silently degrading.
- `SANDBOX_RUNTIME` was passed to containers; Phase 32 added daemon
  verification of it.
- Memory/CPU/pids HostConfig limits and the runtime timer existed.
- Preview tokens were hashed, expiring and one-time; Phase 32 added
  HMAC signing and session/owner binding, plus optional TLS
  termination on the preview listener.
- The session reap already destroyed orphan environments of live
  sessions; Phase 32 added the label sweep for resources whose
  records are gone, health monitoring, and `v: true` container
  removals (anonymous volumes previously leaked).

## Limitations

- **Workspace disk quota is soft.** The workspace is a named volume
  and Docker offers no per-volume quota API on any storage driver;
  the polled limit remains and is labelled soft in diagnostics and
  docs. The hard `size` storage option covers the container's
  writable layer only, and only on btrfs/zfs (hard) or overlay2 on
  XFS with pquota (conditional — the daemon enforces or rejects; it
  does not report pquota).
- **The SquadForge-to-relay hop is not TLS.** Relay ports on the
  worker are token-guarded but plaintext; keep
  `SANDBOX_PREVIEW_BIND_IP` private and firewalled, as DEPLOYMENT.md
  states. TLS termination exists at the browser-facing preview
  listener (`PREVIEW_TLS_CERT`/`PREVIEW_TLS_KEY`).
- gVisor platform choice (systrap vs ptrace) is the worker operator's
  daemon configuration; SquadForge verifies presence of the runtime,
  not its platform.
- Diagnostics report certificate *file presence* at check time; a
  daemon-side certificate problem (e.g. expired server cert) still
  surfaces as connection failures in capabilities/health, which fail
  closed.
