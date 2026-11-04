# SquadForge Agent Guide

Last inspected commit: `472de53b41dcafb5e4140ae37b6fc1a873a7eaf0` on `feature/agent-context-and-lockfile`, based on `main` at `8cdd207` (2026-11-04). Update this with every handoff.

This guide comes from the project owner's reconstructed handoff and from repository inspection. The original AI Studio prompt and chats are unavailable. Treat the handoff as stated intent, and check its claims against the code. When historical evidence is missing, document the uncertainty instead of inventing a decision.

## Product goal

SquadForge should become a genuine collaborative AI software development platform that can plan, build, review, debug, test, and deliver complete software projects. It is not a chatbot that generates isolated snippets.

The intended users include people who may not have the experience to coordinate multiple development tools and agents themselves. The architecture should support different AI providers rather than depending on one model.

Do not sacrifice authorization, project isolation, reliable execution, or honest validation to make the interface look more complete.

## How to work

1. Inspect the existing repository before changing anything.
2. Extend the existing architecture instead of creating duplicate systems.
3. Implement the requested functionality directly, not recommendations or mock interfaces.
4. Add meaningful tests for new functionality.
5. Run lint, tests, and production builds.
6. Document completed work and remaining limitations.
7. Never claim that a feature or test works without verification.

Commands:

```bash
npm run lint    # tsc --noEmit
npm test        # tsx --test tests/**/*.test.ts
npm run build   # vite build
npm run dev     # tsx server.ts
```

## Engineering invariants

These are proposed by the handoff and still need confirming against the code.

1. Approval must be real. Sensitive changes must not be applied before the required authorization.
2. Authorization must be enforced server-side. Frontend controls are not security boundaries.
3. Users and projects must not gain access to another user's private data or workspace.
4. Validation must be evidence-based. Finished generation does not mean a successful project.
5. Failed validation must remain visible behind any status shown to users.
6. Cancellation must stop work, not only update a database status.
7. Secrets must remain server-side. Never expose provider API keys in browser code.
8. File changes must use integrity checks, conflict handling, and safe patch application.
9. Report only tests, builds, and capabilities that have actually been verified.

## Current status

| Area | Status |
| :--- | :--- |
| Phases 1-6 | Original specs unavailable. Reconstruct them from commits, tests, and code, and separate original requirements from inferred behavior. |
| Phase 7 | Universal Software Architecture Engine. `tests/phase7_project_export_verification.test.ts` suggests phase numbering may be inconsistent. |
| Phase 8 | Historically reported as accepted. Not independently re-verified. |
| Phase 9 | Advanced Code Generation Engine. In progress and unverified. Do not treat as accepted. See `PHASE_9_PROGRESS.md`. |
| Phase 10 | Do not start until Phase 9 is finished and accepted. |

Later roadmap:

- Phase 10: Execution and Development Environment
- Phase 11: Advanced Debugging and Self-Improvement
- Phase 12: Automated Testing and Quality Assurance
- Phase 13: Advanced Application Capabilities
- Phase 14: GitHub and Project Lifecycle
- Phase 15: Deployment and Distribution
- Phase 16: Production Readiness and Intelligence

Do not present GitHub integration or deployment as complete until they are implemented and tested, even where the README lists them. The "production ready" wording in the Phase 8 report does not describe the whole product.

## Known CI and dependency problem

- `package-lock.json` was deleted from `main` in `ef3a927`. It is restored on `feature/agent-context-and-lockfile` from `6184ab1`, and `package.json` is unchanged since then.
- CI on `main` has failed since that deletion. In the run for `8cdd207`, `Set up Node.js` failed, so install, TypeScript, and test steps were skipped. The `vite: not found` build error follows from the skipped install.
- The last passing run in the recent CI history is `6184ab1`, which had the lockfile. It predates the Phase 9 code generation commit.
- The lockfile has been added and deleted repeatedly since at least 2026-10-30. The reason is unknown, and no owner decision to remove it is recorded. Find out what is deleting it, or a restored file may disappear again.
- The restored lockfile has no Windows Rolldown binding, so `npm run build` and `tests/public_access.test.ts` fail on Windows. Linux is unaffected.
- `tests/ci_workflow_integrity.test.ts` still fails because `.env.example` omits `GEMINI_API_KEY`. This depends on the open provider question below.

## Phase 9 acceptance work

Complete these before accepting Phase 9 or starting Phase 10:

Done on `feature/agent-context-and-lockfile`, not yet merged:

- Approval authorization fixed, including removal of the `human_reviewer` exception.
- Active generation and model requests are now cancelled through an `AbortSignal`.
- The lockfile is restored on the branch. Why it keeps being deleted is still unexplained.
- `PHASE_9_PROGRESS.md` added, with actual results and limitations.

Still to do:

1. Inspect the latest `main` commit.
2. Verify finalization rejects unresolved validation errors.
3. Resolve the `.env.example` test failure.
4. Test cancellation against a real provider.
5. Add `PHASE_9_ACCEPTANCE_REPORT.md`.
6. Run the full test, lint, TypeScript, and production build checks.
7. Record actual results and remaining limitations.

## Fragile areas

- Persistent storage and database reliability
- Authentication, authorization, and tenant isolation
- Safe execution of generated code
- Cancellation of active model requests
- Sensitive-file approval
- Integration validation and finalization status
- Reproducible dependency installation
- Long-running generation and frontend progress reporting

## Collaboration

The owner is actively developing the project, and AI Studio or another agent may push to `main`. The handoff proposes this policy:

1. Keep `main` as the stable integration branch.
2. Use a separate branch for each phase or focused task, including AI Studio work.
3. Review the diff and run the required checks before merging.
4. Do not have two agents modify the same files at the same time.
5. Fetch the latest changes before beginning a task.
6. Record the last inspected commit SHA in every handoff.

The project owner keeps final merge approval unless it is explicitly delegated.

### Commit attribution

All work is done on behalf of the project owner, Shahroz. Every commit must use this author and committer identity:

```text
Shahrozkalash <shahrozkalash@gmail.com>
```

Set it for this repository only with `git config --local user.name` and `git config --local user.email`, then confirm it with `git log -1 --format='%an <%ae> | %cn <%ce>'` before pushing. Do not commit under another identity or change global git config.

## Open questions

- **Accounts:** the owner asked to remove signup and login pages, and commit messages mention guest sessions and automatic user provisioning. The README still lists accounts and per-user isolation. The intended model is unconfirmed.
- **Providers:** `server.ts` checks `GEMINI_API_KEY`, but `.env.example` omits it. Inspect actual routing to establish whether OpenRouter is the primary provider, a fallback, or an additional provider.
- **Branding:** visible "Gemini engine" branding should stay out of the UI. Whether this extends to docs is unconfirmed.
- **Deployment:** no production URL, active users, or production database are verified.
- **`server.ts` size:** it is unknown whether this is deliberate. Do not preserve it as an architectural requirement without evidence.
- **First release:** the 11-step definition of done in the handoff is proposed, not approved, and no phase is assigned to it.

Never put secret values in handoffs or in this file. Use variable names only.
