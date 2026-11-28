# SquadForge — Multi-AI Parallel Swarm Engineering

Full-stack platform where 10+ AI models work silently in parallel as one team to build software from a single user idea.

A user describes an idea, and SquadForge's swarm orchestrator plans it, splits it into tasks, and runs specialized AI agents (architecture, frontend, backend, testing, security, and more) against it concurrently — with conflict detection, merge management, verification, and a live view of the swarm at work.

## Features

- **Multi-agent swarm orchestration** — 10 specialized agent roles with dependency-aware task scheduling, retries, and failure handling
- **Smart model routing & quotas** — routes work across model providers (Gemini, OpenRouter) with per-user usage limits and fallback handling
- **GitHub integration** — secure OAuth connect (CSRF/state protection, single-use states persisted in SQLite) and auto-push of finished projects
- **Authentication & multi-tenancy** — bcrypt password hashing, session management, rate-limited logins, and per-user project isolation
- **OTP password reset** — 6-digit email codes (Resend or SMTP) with expiry, attempt limits, and session revocation on reset
- **Verification** — honest verification service that checks syntax, security issues, and real evidence before calling a build "done"
- **Debugging and repair** — find root causes, repair them with validated minimal patches, re-run affected tests, and roll back. Tested with a real local model, not yet with a cloud provider; see `PHASE_11_ACCEPTANCE_REPORT.md`
- **Project execution (optional)** — run generated Node projects in Docker sandboxes, with dependency installs and a live preview. Off by default; see `DEPLOYMENT.md`
- **SQLite persistence** — WAL mode with versioned migrations; no external database to run

## Universal AI Software Factory

The Factory roadmap (Phases F1–F14, completed 2026-11-28) turned the swarm into a describe-to-delivered factory: one entry point classifies a plain-language description, resolves the responsible AI team from data (25 categories), builds through the verified swarm chain and a single web/desktop environment contract, and delivers only when the category's own verification gate passes — games, video/image/photo editors, websites, SaaS and APIs, Android apps, desktop apps and CLI tools, and AI applications.

- Roadmap: [`UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md`](UNIVERSAL_SOFTWARE_FACTORY_ROADMAP.md)
- What is actually proven, per model and per category — including the known gaps: [`CAPABILITY_MATRIX.md`](CAPABILITY_MATRIX.md)
- Release consolidation: [`FACTORY_PHASE_F14_ACCEPTANCE_REPORT.md`](FACTORY_PHASE_F14_ACCEPTANCE_REPORT.md)

Honest status, in one line: the factory machinery is test-proven end to end; live cloud generation is **not** proven — no provider keys are configured in the development environment, and the models refuse by name rather than fabricate (see the capability matrix).

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS 4
- **Backend:** Node.js 22, Express, Server-Sent Events (SSE) for live swarm updates
- **Database:** SQLite (WAL mode, versioned migrations)
- **AI:** Google Gemini (`@google/genai`), OpenRouter fallback

## Quick Start

Requirements: Node.js 22+, npm 10+

```bash
git clone https://github.com/shahrozkalash/Squadforge.git
cd Squadforge
npm ci
cp .env.example .env   # then set at least GEMINI_API_KEY
npm run dev            # dev server on http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

Health checks: `GET /healthz` and `GET /readyz` return the server status, storage mode, and which model providers are configured.

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example) for the full commented list. The important ones:

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Primary AI provider key (required for real swarm work) |
| `OPENROUTER_API_KEY` | Optional fallback provider |
| `ENCRYPTION_SECRET` | Strong 32+ char secret for stored credentials — set this in production |
| `APP_URL` | Public URL, used for OAuth redirects |
| `SQLITE_DB_PATH` | Database location (default `./squadforge.db`) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app for Connect GitHub / auto-push |
| `RESEND_API_KEY` or `SMTP_*` | Email delivery for password-reset codes |
| `PORT` | Server port (default `3000`) |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server (development) |
| `npm start` | Start the server |
| `npm run build` | Build the production frontend bundle |
| `npm run lint` | Type-check with `tsc --noEmit` |
| `npm test` | Run the automated test suites |

## Tests

69 automated tests across 15 suites covering authentication and authorization, SQLite migrations and persistence, GitHub OAuth security, OTP password reset, file operations, the execution adapter, and swarm orchestration:

```bash
npm test
```

## Deployment

Docker and production setup (including health checks and persistent database volume) are documented in [DEPLOYMENT.md](DEPLOYMENT.md). Backup and recovery procedures are in [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md).

CI (GitHub Actions, `.github/workflows/ci.yml`) runs install, type-check, tests, and the production build on every push to `main`.
