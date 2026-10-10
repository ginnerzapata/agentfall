# Agentfall Development Checklist

This checklist turns the [product requirements](../prd.md) into an ordered path to a harness-playable Season Zero. The [domain glossary](agents/domain.md) defines canonical terms, and [ADR 0001](adr/0001-deterministic-engine-and-event-snapshots.md) governs engine and persistence boundaries.

Check an item only when its acceptance criteria and automated checks pass. Keep implementation work in focused GitHub Issues linked to the PRD.

## Current Baseline

Verified locally on 2026-10-08:

- [x] Product requirements exist in `prd.md`.
- [x] Domain, issue-tracker, and triage-label guidance exists under `docs/agents/`.
- [x] The deterministic engine and Event/Snapshot architecture is recorded in ADR 0001.
- [x] Bun workspace, TypeScript configuration, lockfile, and root test/typecheck scripts exist.
- [x] `packages/engine` exposes an initial pure `createRun`, `act`, `observe`, and `replay` interface.
- [x] The initial engine tests pass with `bun test`.
- [x] The repository typechecks with `bun run typecheck`.
- [x] The current local scaffold and documentation are reviewed and committed as a stable baseline.

## 1. Repository Foundation

- [x] Add the AGPL-3.0 license selected in the PRD.
- [x] Update `README.md` with the product summary, prerequisites, setup commands, and project status.
- [x] Extend Bun workspaces to cover both `apps/*` and `packages/*`.
- [x] Create `packages/contracts` for transport-safe schemas and public types.
- [x] Create `packages/content` for versioned seasonal content packs.
- [x] Create `packages/testing` for deterministic fixtures, simulations, and golden replays.
- [x] Create `apps/server` as the Cloudflare Worker entry point.
- [x] Add formatting and linting with repository-wide scripts.
- [x] Add CI that installs from the frozen Bun lockfile, typechecks, lints, and tests.
- [x] Document local environment variables in an example file without committing secrets.

### Foundation exit check

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

The commands must pass from a clean checkout without undocumented manual setup.

## 2. Engine Contracts and Invariants

- [x] Move all public engine input/output types into stable, versioned contracts.
- [x] Replace generic thrown errors at the engine boundary with typed rejection results.
- [x] Define Snapshot and Event schema versions independently from package versions.
- [x] Validate duplicate entity IDs, duplicate occupancy, invalid stats, and invalid starting positions.
- [x] Ensure rejected Actions never mutate state, consume RNG, or append Events.
- [x] Ensure Observations never mutate state, advance turns, or consume RNG.
- [x] Define a canonical serialization format used for checksums and golden replay fixtures.
- [x] Record resolved RNG results in Events so replay does not reroll them.
- [x] Add an API that replays recorded Events, not only the original requested Actions.
- [x] Add ruleset and generator version identifiers to Run definitions and Snapshots.

### Engine invariant tests

- [x] Same seed and accepted Action sequence produces byte-identical Events and final checksum.
- [x] Replaying stored Events reconstructs the exact Snapshot.
- [x] Reading an Observation any number of times does not change a later outcome.
- [x] Invalid Actions leave the Snapshot byte-identical.
- [x] Entity ordering does not accidentally change checksums or RNG streams.
- [x] Property tests never produce negative AP, out-of-bounds entities, or duplicate occupancy.

## 3. Grid, Vision, and Exploration

- [x] Model floors as tiles with walls, doors, terrain, entities, entrance, objective, and exit.
- [x] Implement four-direction movement and collision against walls, closed doors, and living entities.
- [x] Implement the six-tile vision radius and line-of-sight blocking.
- [x] Track visible tiles separately from remembered tiles.
- [x] Hide entities and mutable objects that are outside current vision.
- [x] Implement locked exits and a universal mandatory key/objective interaction.
- [x] Implement door opening and closing at the agreed AP cost.
- [x] Implement chests, item pickup, traps, sanctuary use, and optional secret areas.
- [x] Generate authoritative structured Observations.
- [x] Generate an ASCII view derived only from the same known structured state.
- [x] Expose only currently legal typed Actions and valid targets.

### Exploration exit check

- [x] A harness can enter a fixture floor, explore under fog of war, obtain the objective, and leave without hidden information leaking.
- [x] Snapshot replay produces the same remembered map and ASCII output.

## 4. Combat and Character Rules

- [x] Implement Health, Defense, Movement, Accuracy, Power, and Focus.
- [x] Implement four AP per combat turn and the agreed Action costs.
- [x] Allow movement before and after other Actions in one turn.
- [x] Convert up to two unused AP into temporary Defense when ending a turn.
- [ ] Implement seeded d20 attack resolution and small damage dice.
- [ ] Expose hit probability and damage range without exposing future rolls.
- [ ] Implement permanent death at zero Health.
- [ ] Implement the rare automatic one-use resurrection effect.
- [ ] Implement spatial retreat and deterministic enemy pursuit.
- [ ] Implement deterministic enemy behavior trees with seeded tie resolution.

### Class capabilities

- [ ] Vanguard: Guard.
- [ ] Vanguard: Shove, including wall or hazard collision behavior.
- [ ] Ranger: Scout without seeing through walls.
- [ ] Ranger: Disengaging Shot.
- [ ] Arcanist: Arc Bolt.
- [ ] Arcanist: Ward.
- [ ] Confirm every mandatory floor objective remains solvable by every class.

### Combat exit check

- [ ] Golden combat fixtures cover hits, misses, damage, death, resurrection, retreat, and each signature ability.
- [ ] Each class produces meaningfully different Action choices in simulations.

## 5. Inventory, Recovery, and Progression

- [ ] Implement weapon, armor, accessory, and four backpack slots.
- [ ] Stack identical consumables and permanently discard dropped items.
- [ ] Make between-floor inventory changes free and in-floor swaps cost one Action.
- [ ] Implement potions and one-use sanctuaries without free resting.
- [ ] Preserve injuries, gear, and remaining consumables between normal floors.
- [ ] Apply the small fixed recovery between normal floors.
- [ ] Apply full recovery after boss floors.
- [ ] Award one level after each normal floor.
- [ ] Generate three deterministic class upgrade options and let the harness choose one.
- [ ] Define and test the first balanced positive/negative trait pool.
- [ ] Generate a deterministic class and trait pair for each new character sequence.

## 6. Floor Generation and Validation

- [ ] Define versioned TypeScript schemas for room, encounter, enemy, item, trait, and boss content.
- [ ] Author reusable room templates tagged by difficulty and required capabilities.
- [ ] Deterministically assemble connected floors of six to ten rooms.
- [ ] Place the entrance, locked exit, mandatory objective, encounters, rewards, healing, trap, and optional secret area.
- [ ] Calculate a deterministic floor turn budget from floor content.
- [ ] Validate connectivity and objective reachability.
- [ ] Validate that each class can complete every mandatory path.
- [ ] Validate that the turn budget is feasible without guaranteeing exhaustive exploration.
- [ ] Reject an invalid generated season before publication.

### Generator exit check

- [ ] Property tests validate many seeds without impossible floors or illegal state.
- [ ] Given the same seed and content version, generation is byte-identical.
- [ ] A generated floor targets approximately 60–100 meaningful character decisions.

## 7. Orc Siege Content Pack

- [ ] Implement the goblin scout behavior and stats.
- [ ] Implement the orc brute behavior and stats.
- [ ] Implement the orc archer behavior and stats.
- [ ] Implement the orc shaman behavior and stats.
- [ ] Implement war drums and reinforcement behavior.
- [ ] Author enough room and encounter templates for five varied floors.
- [ ] Author the floor-five boss preparation room, arena, and reward room.
- [ ] Implement both Orc Warchief phases and the telegraphed arena mechanic.
- [ ] Add the Season Zero item and upgrade pools.
- [ ] Simulate and tune all three classes through the complete five-floor tower.

## 8. Run, Failure, and Knowledge Rules

- [ ] Persist character state across completed floors in one Run.
- [ ] Implement floor completion and the choice to leave optional content unexplored.
- [ ] Implement floor collapse when the turn budget expires.
- [ ] Implement voluntary abandonment with the same rollback behavior.
- [ ] Spend the Expedition Charge while restoring pre-floor character state on rollback.
- [ ] Discard uncommitted floor discoveries and harness notes on rollback.
- [ ] Preserve committed death even if the floor later times out.
- [ ] Generate a new random character after death and restart at floor one.
- [ ] Maintain the account-private structured Journal across character deaths.
- [ ] Store short harness-written notes separately as untrusted text.

## 9. Persistence with D1

- [ ] Design Drizzle schemas for accounts, credentials, seasons, characters, Runs, floor sessions, Events, Snapshots, Journals, charges, and standings.
- [ ] Add versioned D1 migrations and local migration commands.
- [ ] Implement persistence ports outside `packages/engine`.
- [ ] Atomically append one Event and update one Snapshot per accepted Action.
- [ ] Enforce optimistic Snapshot versions.
- [ ] Enforce unique idempotency keys per mutation scope.
- [ ] Make retries return the original committed result without advancing twice.
- [ ] Ensure a failed batch leaves both Event and Snapshot unchanged.
- [ ] Avoid persisting read-only Observations.
- [ ] Add replay integrity checks and administrative reconstruction tooling.
- [ ] Implement the agreed active-season and historical retention policy.

### Persistence exit check

- [ ] Concurrent requests against the same Snapshot produce at most one accepted transition.
- [ ] Retried network requests cannot duplicate movement, attacks, charges, or rewards.
- [ ] Stored Events reconstruct the stored Snapshot checksum.

## 10. Cloudflare Worker and HTTP Boundary

- [ ] Configure `apps/server` for Cloudflare Workers and bind D1.
- [ ] Use Hono for routing, errors, request IDs, secure headers, and request-size limits.
- [ ] Add health and version endpoints that do not expose secrets.
- [ ] Keep application use cases independent of Hono and MCP handlers.
- [ ] Normalize typed domain failures into stable transport errors.
- [ ] Add local Worker integration tests using actual bindings rather than mocks where practical.
- [ ] Add request and mutation rate limits that preserve active floor sessions.

## 11. MCP Server

- [ ] Serve one stateless Streamable HTTP endpoint at `/mcp` with the official MCP TypeScript server SDK.
- [ ] Confirm compatibility with the targeted Codex and Claude clients.
- [ ] Implement tools for floor start, Observation, typed Action, character, Journal, abandonment/end, season details, and standings.
- [ ] Require an idempotency key for every mutating tool call.
- [ ] Add accurate read-only and destructive tool annotations.
- [ ] Keep tool names, descriptions, inputs, and results concise enough for harness use.
- [ ] Ensure tool results never reveal hidden map, entity, seed, or future RNG information.
- [ ] Publish copyable Codex and Claude connection instructions.

### Harness-playability exit check

- [ ] A clean Codex configuration can authenticate and complete a fixture floor.
- [ ] A clean Claude configuration can authenticate and complete the same fixture floor.
- [ ] Neither flow requires a gameplay UI or server-side model credentials.

## 12. GitHub Authentication and Credentials

- [ ] Register the GitHub authentication application for the target environment.
- [ ] Implement the minimal bootstrap login page and callback/device flow.
- [ ] Map identity by immutable GitHub numeric ID rather than username.
- [ ] Request only the minimum GitHub identity permissions.
- [ ] Issue a high-entropy opaque Agentfall bearer credential.
- [ ] Store only its secure hash and credential metadata.
- [ ] Discard the GitHub token after identity verification unless a documented need requires encrypted retention.
- [ ] Add credential listing, revocation, expiration, and rotation.
- [ ] Keep credentials out of prompts, logs, URLs, and error messages.
- [ ] Require explicit ranked enrollment and a unique Agentfall display name.

## 13. Expedition Charges and Sessions

- [ ] Store charge count and the last charge calculation time.
- [ ] Lazily regenerate one charge every four hours up to a cap of three.
- [ ] Pause regeneration while at the cap.
- [ ] Consume one charge atomically when starting a ranked floor.
- [ ] Award one charge after a boss without exceeding the cap.
- [ ] Enforce one living ranked character and one active ranked floor session per account.
- [ ] Enforce one active Practice session per account.
- [ ] Pause after ten minutes without a state-changing Action.
- [ ] Allow safe resume within the 24-hour floor-session lifetime.
- [ ] Abandon expired sessions according to the rollback rules.

## 14. Seasons, Rankings, and Replay Visibility

- [ ] Implement the complete season lifecycle and legal transitions.
- [ ] Generate the full tower before publishing a season.
- [ ] Publish a cryptographic seed commitment.
- [ ] Keep the seed secret while the season is active.
- [ ] Reveal and verify the seed after the season ends.
- [ ] Freeze ruleset and content versions for active Runs.
- [ ] Rank seasonal bests by the PRD's five ordered criteria.
- [ ] Display current living-character progress separately from seasonal best.
- [ ] Hide replay details for floors the viewer has not completed.
- [ ] Reveal eligible seasonal information after the season ends.
- [ ] Reset seasonal characters and tactical Journal data while preserving allowed history.

## 15. Administration and Capacity Safety

- [ ] Build authenticated CLI commands to generate, validate, publish, activate, end, and reveal a season.
- [ ] Require explicit confirmation and successful validation before publication.
- [ ] Keep administrative secrets outside the repository.
- [ ] Define an internal daily read/write/request budget below free-tier quotas.
- [ ] Reserve conservative write capacity before admitting a floor session.
- [ ] Reject new Practice sessions before ranked sessions under pressure.
- [ ] Preserve admitted sessions while their reserved capacity remains.
- [ ] Return typed `CAPACITY_EXHAUSTED` failures with the expected UTC reset time.
- [ ] Confirm that no Cloudflare resource can automatically begin paid usage.
- [ ] Exercise quota and persistence-failure behavior in integration tests.

## 16. Private Alpha Readiness

- [ ] Perform a security review of authentication, credentials, hidden state, administrative endpoints, and logs.
- [ ] Perform deterministic replay audits against Season Zero fixtures.
- [ ] Run class and encounter balance simulations.
- [ ] Test disconnect, retry, stale version, timeout, collapse, death, and quota scenarios.
- [ ] Write participant setup and troubleshooting instructions.
- [ ] Seed a private alpha with 10–25 invited accounts.
- [ ] Capture authentication success, deterministic completion, retry integrity, repeat-attempt, class-pattern, and capacity metrics from the PRD.
- [ ] Conduct an alpha retrospective before approving the 20-floor public season.

## 17. Deferred Until After Harness Playability

- [ ] Scaffold `apps/web` only after the Phase 1 server loop is validated.
- [ ] Build the responsive standings, season, account, and expedition pages.
- [ ] Add browser credential management.
- [ ] Add a read-only grid/ASCII replay viewer.
- [ ] Expand from five floors to the first complete 20-floor public season.
- [ ] Add full MCP-compatible OAuth if needed for smoother onboarding.
- [ ] Investigate fire, poison, and controlled surface interactions.
- [ ] Investigate a desktop companion separately from the server and website.

## Per-Change Definition of Done

Before marking an implementation issue complete:

- [ ] The change uses terms from the domain glossary.
- [ ] Acceptance criteria are covered by focused automated tests.
- [ ] Deterministic behavior has no dependency on wall-clock time, ambient randomness, or iteration-order accidents.
- [ ] Rejected operations leave durable and in-memory state unchanged.
- [ ] No secret, hidden tile, hidden entity, future roll, or private identity is exposed.
- [ ] `bun run typecheck` passes.
- [ ] `bun test` passes.
- [ ] Relevant documentation, schemas, golden replays, and ADRs are updated.
- [ ] The pull request includes concrete before/after evidence and an honest merge-risk assessment.
