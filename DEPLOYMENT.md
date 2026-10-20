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
