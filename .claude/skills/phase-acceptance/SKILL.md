---
name: phase-acceptance
description: Assess whether a SquadForge roadmap phase can be accepted, and write its PHASE_N_PROGRESS.md and PHASE_N_ACCEPTANCE_REPORT.md from verified evidence. Use when finishing, auditing, or reporting on a phase.
---

# Phase acceptance

A phase is accepted only by the project owner. This skill gathers evidence and recommends a status. Never mark a phase accepted on your own authority.

## Steps

1. Read `AGENTS.md`, and record the commit SHA being assessed.
2. List the phase's requirements. Label each as **stated by the owner** or **inferred from the code**.
3. For each requirement, find the implementing code and the test that proves it. A test only counts if it exercises the real behavior.
4. Run the `verify-project` skill and use those results. Do not reuse results from an earlier commit.
5. For security-sensitive work, use the `invariant-reviewer` agent to check the engineering invariants in `AGENTS.md`.
6. Write the reports, then give the owner a recommendation.

## Status values

Use exactly one for each requirement:

- **Verified:** code exists and a test or direct check passed at this commit
- **Implemented, unverified:** code exists but nothing has proven it works
- **Partial:** only part of the requirement works
- **Failing:** a check shows it does not work
- **Not implemented**
- **Unknown:** the evidence is missing

## Report contents

`PHASE_N_PROGRESS.md` holds the requirement checklist with statuses and evidence links.

`PHASE_N_ACCEPTANCE_REPORT.md` holds:

- Commit SHA, date, and environment
- Recommended status: recommend acceptance, or do not recommend acceptance
- Actual check results, including every failure
- Requirement table with status and evidence
- Remaining limitations and open owner decisions

## Rules

- Do not use "production ready" unless the owner has accepted that scope. Production readiness is roadmap Phase 16.
- Do not copy claims from earlier reports without re-verifying them. Label them "historically reported".
- If evidence is missing, write "Unknown" instead of inferring success.
- Do not start the next phase until the owner accepts the current one.
