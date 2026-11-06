# SquadForge Phase 14 Progress: GitHub Integration & Project Lifecycle

**Status:** Completed & Verified  
**Branch / Integration:** `main`  
**Inspected Commit:** `4e3b8fd`  
**Author / Committer Identity:** `Shahrozkalash <shahrozkalash@gmail.com>`  

---

## 1. Overview & Objectives

Phase 14 delivers full, bidirectional GitHub repository lifecycle integration into SquadForge. It replaces mock operations or isolated snippet generation with authentic Git operations executed through the GitHub REST & Git Data APIs. SquadForge projects can now be initialized directly from remote GitHub repositories, managed with branch workflows, tracked for changes with visual diffs, safely committed with atomic Git trees, kept in sync with upstream updates, and safely resolved when conflicts occur—all while maintaining ironclad tenant isolation, server-side authorization, sensitive file approval gates, and commit attribution rules.

$$\text{GitHub Auth / OAuth} \longrightarrow \text{Repo & Branch Navigation} \longrightarrow \text{Recursive Tree Import} \longrightarrow \text{Workspace Diffs} \longrightarrow \text{Approval Gates} \longrightarrow \text{Atomic Git Commits} \longrightarrow \text{PR Lifecycle} \longrightarrow \text{Fast-Forward Sync \& 3-Way Conflict Resolver}$$

---

## 2. Tasks Completed

### Task 1: Secure GitHub Account Connection
- **Module:** `server/github/githubClient.ts`, `server/github/githubLifecycleService.ts`, `server/github/githubRoutes.ts`
- Implemented secure token management using AES-256-GCM encryption (`encryptSessionToken` / `decryptSessionToken` in `server/crypto.ts`) stored in SQLite database table `encrypted_github_tokens`.
- Frontend status checks (`GET /api/github/status`) return connection metadata, avatar, username, and scope validity without ever leaking the plaintext GitHub token to client-side code.
- Graceful disconnect endpoint (`POST /api/github/disconnect`) destroys stored token records and revokes active credentials.

### Task 2: List and Connect Authorized Repositories
- **Module:** `server/github/githubLifecycleService.ts` (`listUserRepositories`, `connectProjectToRepo`)
- Lists all repositories the authenticated user has access to, including public/private status, push permissions, and default branch (`main` / `master`).
- Respects repository permissions: prevents connecting or committing to read-only repositories if push access is missing.
- When connecting a project, validates permissions and queries the remote default branch to capture the authoritative base commit SHA (`githubBaseSha`).

### Task 3: Import Repository Files into SquadForge Projects
- **Module:** `server/github/githubLifecycleService.ts` (`importRepository`)
- Recursively traverses remote Git trees (`/git/trees/:tree_sha?recursive=1`) and retrieves blobs.
- Filters out binary files and package lockfiles / node_modules automatically.
- Instantiates a clean SquadForge `Build` record, populating its file workspace via `db.setFile` with proper attribution, commit SHA, and active branch tracking.

### Task 4: Support Branch Creation and Switching
- **Module:** `server/github/githubLifecycleService.ts` (`listBranches`, `createBranch`, `switchBranch`)
- Supports listing remote branches and creating new feature branches targeting any existing branch or commit SHA.
- **Dirty State Guard:** `switchBranch` inspects workspace modifications against the base commit SHA. If uncommitted local changes exist, switching branches with checkout is rejected with an explicit error to prevent silent data loss.

### Task 5: Detect Modified Files and Display Diffs
- **Module:** `server/github/githubLifecycleService.ts` (`getWorkspaceDiff`)
- Compares active workspace files in memory against the remote Git tree at `githubBaseSha`.
- Accurately classifies changes:
  - `added`: File created in workspace that does not exist in remote tree.
  - `modified`: File content differs between workspace and remote tree.
  - `deleted`: File present in remote tree but removed from workspace.
- Detects sensitive files using `ApprovalGateService.isSensitiveFilePath` (`.env*`, `package.json`, auth files, crypto files) and flags them in the diff payload.

### Task 6: Commit Approved Changes
- **Module:** `server/github/githubLifecycleService.ts` (`commitChanges`), `server/swarm/approvalGateService.ts`
- Uses atomic Git Data API operations:
  1. Creates Git blobs for modified and added files (`POST /git/blobs`).
  2. Constructs a Git tree referencing blobs and deleting removed paths (`POST /git/trees`).
  3. Creates a Git commit pointing to the new tree and parent commit (`POST /git/commits`).
  4. Updates the branch ref (`PATCH /git/refs/heads/:branch`).
- **Human Approval Gate:** Any commit touching sensitive files or targeting the default branch (`main` / `master`) automatically triggers a human approval gate (`github_sensitive_commit`). Returns HTTP 202 (`requires_approval`) until approved by the user.
- **Author Attribution:** Commits are permanently attributed to `Shahrozkalash <shahrozkalash@gmail.com>` as mandated by repository invariants.

### Task 7: Pull Request Management
- **Module:** `server/github/githubLifecycleService.ts` (`createPullRequest`, `listPullRequests`, `mergePullRequest`)
- Enables creating Pull Requests from working branches into the default branch with title, description, and draft support.
- Inspects PR mergeability and state (`open`, `closed`, `merged`).
- Supports atomic merging of approved Pull Requests (`POST /pulls/:pull_number/merge`).

### Task 8: Synchronize Local and Remote Changes
- **Module:** `server/github/githubLifecycleService.ts` (`syncRemoteChanges`)
- Fetches upstream commit status and compares remote HEAD against local `githubBaseSha`.
- When local workspace is clean, fast-forwards changes automatically, updating local files and advancing `githubBaseSha` and `githubSyncedAt`.

### Task 9: Detect and Safely Resolve Merge Conflicts
- **Module:** `server/github/githubLifecycleService.ts` (`syncRemoteChanges`, `resolveConflict`), `server/db/database.ts`, `server/store.ts`
- When both remote files and local workspace files have diverged on the same path, conflicts are detected and recorded into the `github_conflicts` table.
- Files are **never overwritten silently**. Conflicted files retain their current workspace version while structured 3-way conflict details (`baseContent`, `oursContent`, `theirsContent`) are presented to the user.
- Supports conflict resolution strategies: `'ours'`, `'theirs'`, or custom `'manual'` merged content, advancing base SHA once all conflicts for a build are resolved.

### Task 10: Display Repository and Commit History
- **Module:** `server/github/githubLifecycleService.ts` (`getCommitHistory`)
- Fetches authentic commit logs from GitHub Git log API (`GET /commits?sha=:branch`).
- Displays author name, author avatar, commit SHA, timestamp, and commit message.

---

## 3. UI Implementation

- **Component:** `src/components/GitHubLifecycleView.tsx`
- Complete, responsive interface organized into 6 tabs:
  1. **Repositories:** List accessible repositories, view privacy/permissions, and one-click import into a new SquadForge project.
  2. **Branches:** View branch list, see active branch, and create new branches with base ref selection.
  3. **Changes & Diff:** View modified/added/deleted files, inspect split diffs, review sensitive file badges, and trigger commits with inline approval gating.
  4. **Pull Requests:** List open PRs, create new pull requests, view status, and merge pull requests.
  5. **Sync & Conflicts:** Trigger upstream sync, view conflict status, and resolve merge conflicts with an interactive 3-way side-by-side diff resolver.
  6. **Commit History:** Visual chronological timeline of commits with author attribution and commit links.
- Integrated into `src/components/Navbar.tsx` and `src/App.tsx` under the dedicated **GitHub** navigation tab.

---

## 4. Database Migrations & Store Updates

- **Migration 015:** Added in `server/db/database.ts`:
  - Added `github_owner`, `github_repo_name`, `github_base_sha`, and `github_synced_at` columns to the `builds` table.
  - Created `github_conflicts` table to store persistent conflict records (`id`, `build_id`, `file_path`, `base_sha`, `remote_sha`, `base_content`, `ours_content`, `theirs_content`, `status`, `resolved_content`, `created_at`, `resolved_at`).
- **Store Methods:** Updated `server/store.ts`:
  - `saveBuild` and `getBuild` support new GitHub metadata columns.
  - Added `saveGitHubConflict`, `getGitHubConflict`, `getGitHubConflicts`, and `resolveGitHubConflict`.
  - Hardened `setFile` against uninitialized `file.history` arrays.

---

## 5. Security & Invariant Adherence

1. **Token Secrecy:** OAuth and personal tokens are encrypted at rest with AES-256-GCM. Plaintext tokens never reach frontend responses.
2. **Real Operations:** All GitHub operations invoke real REST & Git Data API endpoints; zero mock responses in production code.
3. **No Silent Overwrites:** Uncommitted changes block branch switches; diverged files generate explicit conflict records.
4. **Approval Enforcement:** Sensitive files and default branch pushes require explicit human approval via `ApprovalGateService`.
5. **Commit Attribution:** Strictly configured to `Shahrozkalash <shahrozkalash@gmail.com>`.
6. **Phase Boundary:** Strictly confined to Phase 14; Phase 15 has not been started.
