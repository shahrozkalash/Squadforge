---
name: verify-project
description: Run SquadForge's install, type, test, and build checks and report the real results. Use before claiming work is done, before merging, or when asked whether the project passes.
---

# Verify SquadForge

Run the same checks as `.github/workflows/ci.yml`, in this order:

```bash
git rev-parse HEAD
npm ci
npm run lint
npm test
npm run build
```

Run every check even if an earlier one fails, so the report is complete. CI itself skips later steps after a failure, so a red run may hide further problems.

## Reporting

Report these for each check:

- The commit SHA, operating system, and Node version
- Pass, fail, or not run
- The test totals and the name of every failing test
- The cause of each failure, if known

Never summarize a run as passing when any check failed or did not run.

## Local and CI differences

CI uses Linux and Node 22. If a failure appears only on another platform or Node version, say so and check the CI result with `gh run list --branch <branch>` and `gh run view <id> --log-failed`. CI is the reference result for merging.

On Windows, `npm run build` and `tests/public_access.test.ts` fail with `Cannot find native binding` even after `npm ci`. The committed lockfile lists Rolldown's Linux binding but not `@rolldown/binding-win32-x64-msvc`. Report this as a local limitation and use the CI result for these checks.

## Rules

- Do not delete, skip, or weaken a test to make a check pass.
- Do not regenerate `package-lock.json` unless dependencies changed. If it is missing, find the commit that removed it first.
- Do not change `.github/workflows/ci.yml` to hide a failure.
