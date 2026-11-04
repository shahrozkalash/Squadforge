---
name: agent-handoff
description: Start or finish a SquadForge work session safely when AI Studio or other agents may also be changing the repository. Use before beginning a task, and when finishing or handing off work.
---

# Agent handoff

## Before starting

1. Run `git fetch origin`, then compare `main` with `origin/main`.
2. Read `AGENTS.md`, and note any commits since its "Last inspected commit".
3. Run `git log --diff-filter=D --name-status <last-inspected>..origin/main` to spot unexpected deletions. `package-lock.json` has been deleted repeatedly.
4. Create a focused branch named `feature/<task>`. CI runs on `feature/**`. Never work directly on `main`.
5. Check open branches and PRs so two agents do not change the same files.
6. Confirm `git config --local user.name` and `user.email` match the commit attribution rule in `AGENTS.md`. Every commit goes under the project owner's name.

## When finishing

1. Run the `verify-project` skill.
2. Update `AGENTS.md`: the last inspected commit, status, and any answered or new open questions.
3. Push the branch and open a PR. The project owner keeps final merge approval unless it has been explicitly delegated.
4. Write the handoff note below.

## Handoff note

```markdown
Branch and commit SHA:
What changed:
Check results (with CI link):
Not verified:
Decisions needed from the owner:
Next step:
```

Use variable names only. Never put secret values in a handoff, commit, or doc.
