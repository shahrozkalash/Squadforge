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
- **Guest Session Isolation**: Unauthenticated public users receive cryptographically isolated guest sessions (`gst_*`) with scoped storage and bounded quotas, preventing cross-tenant leakage.

### 4. Remaining Limitations & Production Guidelines
- **Browser Fetch Requests**: The CSP permits outbound HTTPS requests from preview applications (e.g. public third-party REST APIs). For air-gapped environments, restrict `connect-src` strictly to `'none'` or trusted hostnames.
- **Multi-Process Execution**: Generated applications execute client-side inside the browser sandbox; full-stack backend components generated for downloaded ZIP packages require local container execution (`docker run` or `npm run dev` in an isolated virtual machine).

