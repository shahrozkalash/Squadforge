# SquadForge Deployment Guide

This document describes how to deploy SquadForge into production environments.

## Architecture Summary
SquadForge runs as a full-stack Node.js 22 server serving:
- React 19 SPA frontend with Tailwind CSS
- Express REST API with session authentication, rate limiting, and Server-Sent Events (SSE)
- Autonomous Multi-Agent Swarm Orchestrator with 10 specialized agent roles
- SQLite database with WAL mode and versioned migrations
- Isolated execution sandbox adapter for compilation and test execution

---

## Environment Requirements
- **Node.js**: 22.0.0 or higher
- **npm**: 10.0.0 or higher
- **Operating System**: Linux (Ubuntu 22.04+ recommended), macOS, or Windows
- **Memory**: Minimum 1 GB RAM (2 GB recommended for concurrent multi-agent executions)
- **Disk**: 500 MB for application files and SQLite database

---

## Production Setup

### 1. Clone & Install
\`\`\`bash
git clone https://github.com/shahrozkalash/Squadforge.git
cd Squadforge
npm ci
\`\`\`

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
\`\`\`bash
cp .env.example .env
\`\`\`

Required for real AI work (at least one provider):
- `GEMINI_API_KEY`: Your Google Gemini API key — the primary model provider.
- `OPENROUTER_API_KEY`: Optional fallback model provider.

Essential production settings:
- `ENCRYPTION_SECRET`: Set to a strong 32+ character random string. If unset or default in production, the server emits a critical security alert.
- `NODE_ENV`: Set to `production`. When `NODE_ENV=production`, SquadForge halts startup immediately if SQLite database initialization fails, preventing silent volatile in-memory fallback.
- `APP_URL`: Set the canonical public URL (e.g. `https://squadforge.example.com`). In production, SquadForge strictly requires a validated `APP_URL` for OAuth redirects and rejects unverified incoming host headers or wildcard domain patterns to protect against host header poisoning.

Optional settings:
- `PORT`: Server port (default `3000`).
- `SQLITE_DB_PATH`: Storage location for the persistent SQLite database (default `./squadforge.db`, or mounted container volume e.g. `/app/data/squadforge.db`).
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: GitHub OAuth application credentials.
- `RESEND_API_KEY`, or `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`: Email delivery credentials for password-reset OTP dispatch.

See `.env.example` for the template.

### 3. Build & Run
\`\`\`bash
npm run build
npm start
\`\`\`

The server listens on `0.0.0.0:3000`.

---

## Docker Deployment

Build and run using the provided multi-stage Dockerfile:

\`\`\`bash
# Build Docker image
docker build -t squadforge:latest .

# Run container with persistent volume for database
docker run -d \
  --name squadforge \
  -p 3000:3000 \
  -v squadforge_data:/app/data \
  -e NODE_ENV=production \
  -e SQLITE_DB_PATH=/app/data/squadforge.db \
  -e ENCRYPTION_SECRET=your-secure-32-char-secret-key-here \
  -e GEMINI_API_KEY=your-gemini-api-key \
  -e APP_URL=https://squadforge.example.com \
  --restart unless-stopped \
  squadforge:latest
\`\`\`

---

## Health Checks & Monitoring
- **Liveness Probe**: `GET /healthz` (returns HTTP 200 with process uptime when server is responsive)
- **Readiness Probe**: `GET /readyz` (returns HTTP 200 when SQLite storage is accessible and writable; returns HTTP 503 if storage is unready or degraded)
- **Diagnostic Health**: `GET /api/health` (detailed system status, storage verification, and configured model providers)
```json
{
  "status": "ready",
  "uptimeSeconds": 1420,
  "timestamp": 1729350000000,
  "environment": "production",
  "storage": "sqlite-persistent"
}
```

---

## Security Architecture, Sandbox Boundaries & Limitations

SquadForge implements multi-layer defense-in-depth isolation for generated code execution and preview sandboxing.

### 1. Preview Sandbox Boundaries
- **Iframe Isolation**: Generated previews execute inside an iframe configured with strict sandbox tokens: `sandbox="allow-scripts allow-forms allow-same-origin allow-modals"`.
These boundaries apply to the browser-only preview. Previews of running projects use the execution environment described later, which relies on a separate origin instead.
- **Parent Hierarchy Shield**: The sandbox injects a non-configurable barrier script at the earliest point in the document head:
  - `window.parent`, `window.top`, and `window.opener` are redefined to prevent traversing or executing functions against the host application DOM.
  - `document.cookie` access is neutralized within the preview runtime to prevent reading parent application session tokens or authentication state.
- **Content Security Policy (CSP)**: Previews enforce a restrictive CSP meta header:
  - `default-src 'none'`
  - `script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com https://esm.sh`
  - `style-src 'unsafe-inline' https://fonts.googleapis.com`
  - `font-src https://fonts.gstatic.com data:`
  - `img-src data: blob: https:`
  - `connect-src https://esm.sh https: data:`
  - `frame-src 'none'; object-src 'none'; base-uri 'none'`
- **Zero API Key Leakage**: Previews do not receive parent environment variables, model provider API keys, encryption secrets, or admin credentials.

### 2. Dependency Resolution Intelligence
- **Strict Browser Allowlist**: All third-party imports are resolved through `DependencyResolverService` against pinned registries.
- **Subpath Enforcement**: Packages configured with `allowSubpaths: false` (e.g., `clsx`, `tailwind-merge`, `axios`, `canvas-confetti`) reject subpath imports with clear diagnostics.
- **Server Module Rejection**: All Node.js built-ins (`fs`, `path`, `crypto`, `os`, `child_process`, `net`, `http`, etc.) and server packages (`express`, `bcryptjs`, `sqlite3`, `jsonwebtoken`, etc.) are caught during AST/regex scanning and rejected before bundling.
- **Honest Mode Reporting**: Projects that fail compilation or require unsupported dependencies never show a fallback demo disguised as real execution. The UI and verification report accurately reflect `fallback_preview` or `compilationStatus: failed`.

### 3. Project Memory & Multi-Tenant Authorization
- **Strict Ownership Checks**: All project memory queries (`getRequirements`, `getMemory`, `getDefects`, `getDecisions`, `getFacts`, `getRevisions`) mandate non-empty `userId` and verify that the target build belongs to that user.
- **Guest Session Isolation**: Unauthenticated public users receive separate guest sessions (`guest_*`) with their own storage. Project execution is off for guests in production unless `EXECUTION_ALLOW_GUESTS=true`.

### 4. Remaining Limitations & Production Guidelines
- **Browser Fetch Requests**: The CSP permits outbound HTTPS requests from preview applications (e.g. public third-party REST APIs). For air-gapped environments, restrict `connect-src` strictly to `'none'` or trusted hostnames.
- **Execution**: The browser-only preview described above runs in the browser. Running a full project uses the separate Docker execution environment below, and is off by default.

## Project Execution Environment

Execution is off unless `EXECUTION_BACKEND=docker` is set. There is no fallback that runs project code on the SquadForge server, and no fallback from a configured secure worker setup to an insecure one: a misconfigured worker disables execution (fail closed) with the reason in the server log, the audit log (`execution.backend.init_failed` / `execution.backend.fail_closed`) and the diagnostics endpoint. See `PHASE_10_ACCEPTANCE_REPORT.md` for the original sandbox verification and `PHASE_32_ACCEPTANCE_REPORT.md` for the production-infrastructure status, including what is proven locally, in CI, and not yet proven anywhere.

### Isolation limits

Containers share the worker's kernel, so they are not strong isolation on their own. For untrusted users:

- Use a dedicated worker, never the machine holding SquadForge's database or secrets.
- Set `SANDBOX_RUNTIME=runsc` (gVisor), or use a disposable VM. SquadForge verifies at startup and on every session creation that the daemon actually lists the configured runtime; if it does not, execution stays disabled rather than silently falling back to `runc`.
- Treat Docker API access as root access to the worker. TLS client certificates are required for any remote endpoint (see below); plaintext remote connections are refused.
- Docker credentials and certificates live only in the SquadForge server's environment. They are never written into generated projects, session workspaces or preview traffic, and diagnostics report certificate paths and presence only — never contents.
- Keep `SANDBOX_PREVIEW_BIND_IP` on a private, firewalled address. Relay ports require a token, but the SquadForge-to-relay hop travels without TLS; the browser-facing preview listener can terminate TLS itself (see Preview domain).
- Rebuild the sandbox image when upgrading. An older image's relay does not understand the token, and previews will fail.

### Worker setup

1. On the worker, build the image: `docker build -t squadforge-sandbox:1 sandbox`
2. Install gVisor and register its runtime with the daemon:
   ```bash
   curl -fsSL -o /tmp/runsc https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc
   curl -fsSL -o /tmp/runsc.sha512 https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/runsc.sha512
   # verify /tmp/runsc against the checksum in /tmp/runsc.sha512, then:
   sudo install -m 0755 /tmp/runsc /usr/local/bin/runsc
   sudo /usr/local/bin/runsc install   # adds the runsc runtime to /etc/docker/daemon.json
   ```
   gVisor's default platform (systrap) works on most Linux hosts and in nested VMs; the `ptrace` platform is the fallback for hosts without the required kernel features. A worker that cannot run runsc must not be used with `SANDBOX_RUNTIME=runsc` — SquadForge will refuse to enable execution there.
3. Create a CA and issue a server certificate (SAN for the address SquadForge connects to) and a client certificate:
   ```bash
   mkdir -p docker-certs && cd docker-certs
   openssl req -x509 -newkey rsa:2048 -keyout ca-key.pem -out ca.pem -days 365 -nodes -subj "/CN=squadforge-docker-ca"
   openssl req -newkey rsa:2048 -keyout server-key.pem -out server.csr -nodes -subj "/CN=worker.internal"
   printf 'subjectAltName=DNS:worker.internal,IP:10.0.0.5\nextendedKeyUsage=serverAuth\n' > server-ext.cnf
   openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -days 365 -extfile server-ext.cnf
   openssl req -newkey rsa:2048 -keyout key.pem -out client.csr -nodes -subj "/CN=squadforge"
   printf 'extendedKeyUsage=clientAuth\n' > client-ext.cnf
   openssl x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out cert.pem -days 365 -extfile client-ext.cnf
   ```
   Keep `ca-key.pem` offline. Copy `ca.pem`, `server-cert.pem`, `server-key.pem` to the worker; copy `ca.pem`, `cert.pem`, `key.pem` to the SquadForge server (readable only by its user).
4. Configure the daemon on the worker (`/etc/docker/daemon.json`), keeping the `runsc` runtime entry that `runsc install` added, and restart Docker:
   ```json
   {
     "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
     "tlsverify": true,
     "tlscacert": "/etc/docker/certs/ca.pem",
     "tlscert": "/etc/docker/certs/server-cert.pem",
     "tlskey": "/etc/docker/certs/server-key.pem",
     "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } }
   }
   ```
   On systemd distributions whose docker unit passes `-H fd://`, add a drop-in that replaces the start command, because `-H fd://` conflicts with `hosts` in `daemon.json`:
   ```ini
   # /etc/systemd/system/docker.service.d/override.conf
   [Service]
   ExecStart=
   ExecStart=/usr/bin/dockerd
   ```
   Firewall TCP 2376 so only the SquadForge server can reach it. `tlsverify` (mutual TLS) is required — plain `tls` accepts any client.
5. Set the variables below on the SquadForge server and restart it.
6. Point a wildcard DNS record for `*.PREVIEW_BASE_DOMAIN` at the preview listener, and either terminate TLS in front of `PREVIEW_PORT` or set `PREVIEW_TLS_CERT`/`PREVIEW_TLS_KEY` so the preview listener terminates it itself.
7. Verify with diagnostics (below), then run the test suites (below).

### Diagnostics and health

`GET /api/builds/:buildId/execution/worker/diagnostics` (build ownership plus a user id listed in `MODEL_ADMIN_USER_IDS`) reports the redacted worker state: connection endpoint, TLS on/off with certificate file presence, daemon reachability and version, the daemon's runtimes and whether the configured runtime is verified, the storage driver and quota mode, and the health-monitor state. While the Docker backend is active, a health monitor probes the daemon every `EXECUTION_HEALTH_INTERVAL_SECONDS` (default 30); health loss and regain are audit-logged (`execution.worker.health_lost` / `execution.worker.health_regained`). On startup and on every health regain, SquadForge sweeps the worker for SquadForge-labelled containers, volumes and networks whose session no longer exists and removes them (`execution.worker.orphan_cleanup`).

### Resource limits

Every process container is created with: memory and memory-swap capped at `EXECUTION_MEMORY_MB`, `NanoCpus` from `EXECUTION_CPUS`, `PidsLimit` from `EXECUTION_PIDS`, a size-capped noexec tmpfs, and a session-manager timer that stops the process after `EXECUTION_MAX_RUNTIME_SECONDS`. Session teardown — stop, failure, cancellation, idle reap, server restart reconcile — removes the session's containers (including their anonymous volumes), its network and its workspace volume.

Disk limits need care, because Docker's enforceable size quota and the workspace are different things:

| Layer | Enforcement |
| :--- | :--- |
| Container writable layer | Hard `size` storage option, passed only when the daemon's storage driver enforces it (table below) |
| Workspace (named volume) | **Soft limit only.** The Docker API offers no per-volume size quota on any storage driver, so the session manager polls workspace size and stops the process past `EXECUTION_WORKSPACE_MB`. This is a polling limit, not a quota, and diagnostics report it as `soft-polling` |

Storage-driver support for the `size` storage option (documented Docker behaviour; SquadForge reads the driver and backing filesystem from daemon info and decides per worker):

| Storage driver | `size` option | Mode reported |
| :--- | :--- | :--- |
| btrfs | Enforced | `hard` |
| zfs | Enforced | `hard` |
| overlay2 on XFS with project quotas (pquota) | Enforced by the daemon; the daemon does not report whether pquota is mounted, so SquadForge passes the option and the daemon enforces or rejects container creation | `conditional` |
| overlay2 on other filesystems, vfs, fuse-overlayfs, others | Not supported | `soft` (no option passed) |

### Preview links and relay

Preview link tokens are HMAC-signed with `PREVIEW_TOKEN_SECRET` (falling back to `ENCRYPTION_SECRET`), bound to one preview, one execution session and one owner, expire after 60 seconds, and redeem exactly once for the preview cookie. The relay token that guards each published relay port is generated per preview and never sent to a browser.

### Setup verification

Run the isolation tests against the worker:

```bash
SANDBOX_INTEGRATION=1 npx tsx --test tests/phase10_sandbox_integration.test.ts tests/phase10_end_to_end.test.ts tests/phase11_sandbox_repair.test.ts
```

Run the Phase 32 genuine integration tests (TLS authentication incl. wrong-CA rejection, runsc execution verified via `docker inspect`, memory/pids enforcement, teardown and sweep cleanup) against the worker:

```bash
DOCKER_INTEGRATION=1 \
DOCKER_HOST=tcp://worker.internal:2376 \
DOCKER_TLS_CA=docker-certs/ca.pem DOCKER_TLS_CERT=docker-certs/cert.pem DOCKER_TLS_KEY=docker-certs/key.pem \
PHASE32_WRONG_CA=wrong-certs/ca.pem PHASE32_WRONG_CERT=wrong-certs/cert.pem PHASE32_WRONG_KEY=wrong-certs/key.pem \
npx tsx --test tests/phase32_docker_integration.test.ts
```

`PHASE32_WRONG_*` point at a client certificate issued by a different CA; that test skips when they are unset. The same suites run in CI (`.github/workflows/phase32-execution-verify.yml`) against a TLS + runsc daemon created on the runner; see `PHASE_32_ACCEPTANCE_REPORT.md` for the current evidence status.

### Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `EXECUTION_BACKEND` | `disabled` | Set to `docker` to enable execution |
| `REPAIR_AUTO_START` | Off | Set to `true` to start a repair after a failed generation. Each repair spends model tokens |
| `DOCKER_HOST` | Local daemon socket | Worker address. A `tcp://` address is only ever used with the TLS files below; plaintext remote endpoints are refused |
| `DOCKER_TLS_CA`, `DOCKER_TLS_CERT`, `DOCKER_TLS_KEY` | — | Paths to the CA and client certificate files for the worker. All three are required for a remote worker |
| `SANDBOX_IMAGE` | `squadforge-sandbox:1` | Image used for all containers |
| `SANDBOX_RUNTIME` | Daemon default | Container runtime, such as `runsc`. If the daemon does not list it, execution is disabled (no silent fallback) |
| `SANDBOX_PREVIEW_BIND_IP` | `127.0.0.1` | Worker address for relay ports |
| `SANDBOX_PREVIEW_HOST` | Bind IP | Address SquadForge uses to reach relay ports |
| `PREVIEW_BASE_DOMAIN` | `preview.localhost` outside production | Preview domain. Previews are off in production without it |
| `PREVIEW_PORT` | `3001` | Preview listener port |
| `PREVIEW_IDLE_MINUTES` | `15` | Idle preview timeout |
| `PREVIEW_TOKEN_SECRET` | `ENCRYPTION_SECRET` | HMAC secret for signed preview link tokens |
| `PREVIEW_TLS_CERT`, `PREVIEW_TLS_KEY` | — | When both are set, the preview listener terminates TLS itself. Setting only one is a startup error |
| `EXECUTION_ALLOW_GUESTS` | Off in production | Lets guest sessions run projects |
| `MODEL_ADMIN_USER_IDS` | Empty | Comma-separated user ids that can change shared models in production and read worker diagnostics. If empty, nobody can |
| `EXECUTION_MAX_CONCURRENT` | `4` | Total live sessions |
| `EXECUTION_MAX_PER_USER` | `2` | Live sessions per user |
| `EXECUTION_MEMORY_MB` | `1024` | Memory limit (also caps swap) |
| `EXECUTION_CPUS` | `1` | CPU limit (`NanoCpus`) |
| `EXECUTION_PIDS` | `256` | Process limit (`PidsLimit`) |
| `EXECUTION_MAX_RUNTIME_SECONDS` | `1800` | Time limit per process |
| `EXECUTION_WORKSPACE_MB` | `1024` | Workspace size limit. Enforced as the container-layer `size` option where the storage driver supports it; the workspace volume itself is polled (soft limit, not a hard quota) |
| `EXECUTION_IDLE_MINUTES` | `30` | Idle session timeout |
| `EXECUTION_HEALTH_INTERVAL_SECONDS` | `30` | Worker health-check interval (minimum 5) |
| `NPM_REGISTRY_URL` | `https://registry.npmjs.org/` | The only host installs can reach |

### Preview domain

Use a dedicated host under a domain that does not serve anything sensitive. A subdomain of the app's site works best, because browsers that block third-party cookies may otherwise refuse the preview cookie. Project `Set-Cookie` headers with a `Domain` attribute are removed, and the preview cookie is limited to its own host.

### Supported runtimes

Node with npm, on the Node 22 sandbox image. yarn, pnpm, and pip projects are detected and reported as unsupported.
