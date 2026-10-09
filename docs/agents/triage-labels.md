# Triage Labels

Apply one label from each applicable group. Create these labels in GitHub before relying on them for queries or automation.

## Kind

- `kind:prd`: Product requirements and success measures.
- `kind:feature`: User-visible or system capability.
- `kind:architecture`: Cross-cutting technical decision or enabling work.
- `kind:task`: Focused implementation, test, or operations work.
- `kind:bug`: A verified behavior that contradicts an accepted requirement.

## Area

- `area:engine`: Deterministic simulation, generation, replay, and rulesets.
- `area:content`: Seasonal content packs, balancing, and validation.
- `area:server`: Worker application, persistence, authentication, MCP, and HTTP.
- `area:testing`: Fixtures, simulations, golden replays, and quality gates.
- `area:docs`: Product, architecture, or agent guidance.

## State

- `state:needs-triage`: New work without a confirmed owner or scope.
- `state:ready`: Acceptance criteria and blockers are clear; implementation may start.
- `state:blocked`: Cannot progress until a named dependency or decision resolves.

## Priority

- `priority:critical`: Prevents active ranked play or compromises determinism, integrity, or data.
- `priority:high`: Required for the current phase.
- `priority:medium`: Valuable work that does not block the current phase.
- `priority:low`: Deferred improvement or investigation.
