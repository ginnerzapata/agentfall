# Agentfall agent guidance

## Delivery loop

`docs/development-checklist.md` is the delivery order. GitHub Issues are the
atomic delivery units; follow `docs/agents/issue-tracker.md` for issue scope
and completion. Work on exactly one eligible issue per Goal.

1. Read the issue, its blockers, and the governing PRD, ADRs, and domain terms.
2. Implement the accepted scope and repair routine test failures autonomously.
3. Verify the issue's focused checks, then run `bun run typecheck`, `bun test`,
   and `git diff --check`.
4. Update the checklist only when the issue's acceptance criteria and checks
   pass.
5. Commit the complete, verified issue with a focused message and push the
   current branch immediately.
6. Record the compact handoff in `docs/agents/checkpoints.md`, then begin a new
   Goal for the next eligible issue.

The handoff contains only the completed issue, verification commands and
results, commit SHA, next eligible issue, and any blocker. It is the context
reset boundary: do not carry implementation work for a second issue into the
same Goal.

## Decision boundary

Proceed without a check-in for normal implementation, documentation, testing,
commits, and pushes. Pause for a material product decision, unavailable
credential or access, irreversible external action, or an ambiguity that cannot
be resolved from the PRD, ADRs, glossary, or the issue.

## Completion

An issue is complete only when its acceptance criteria pass, the required
verification is green, the checklist reflects the result where applicable, and
the verified commit is pushed.
