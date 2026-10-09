# Issue Tracker

GitHub Issues are the delivery record for Agentfall. Search open and closed issues before creating one; update an existing issue when it describes the same outcome.

## Create

- State the user or system outcome in the title.
- Describe scope, acceptance criteria, and explicit non-goals.
- Link the governing PRD, ADR, and blocking issues where applicable.
- Keep an issue independently testable. Split work when it cannot be verified in one focused change.
- Use the labels defined in `triage-labels.md`.

## Relationships

- The PRD is the parent product issue.
- Phase and feature issues link to the PRD using `Part of #N`.
- Implementation issues name their blockers in a `Blocked by #N` section.
- An issue closes only when its acceptance criteria and relevant automated checks are satisfied.

## Completion

- Reference the pull request, tests, and any changed ADR or domain language in the closing comment.
- Close product and delivery issues with the `completed` reason. Close duplicates only with a link to the canonical issue.
