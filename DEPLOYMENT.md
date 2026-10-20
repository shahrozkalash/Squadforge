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
- `ENCRYPTION_SECRET`: Set to a strong 32+ character random string. If unset, the server falls back to a built-in default that is not safe for production.
- `NODE_ENV`: Set to `production`.
- `APP_URL`: Set public URL (e.g. `https://squadforge.example.com`). Used for OAuth redirects and trusted-origin checks.

Optional settings:
- `PORT`: Server port (default `3000`).
- `SQLITE_DB_PATH`: Storage location for the database (default `./squadforge.db`, e.g. `/var/lib/squadforge/squadforge.db`).
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`: GitHub OAuth app credentials for Connect GitHub and auto-push.
- `RESEND_API_KEY`, or `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`: Email delivery for password-reset codes — configure one option.

See `.env.example` for the full commented template — it lists every variable the server reads.

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
- **Liveness & Readiness**: `GET /healthz` or `GET /readyz`
- Returns HTTP 200 with JSON payload:
\`\`\`json
{
  "status": "healthy",
  "uptimeSeconds": 1420,
  "timestamp": 1729350000000,
  "environment": "production",
  "storage": "sqlite-persistent"
}
\`\`\`
