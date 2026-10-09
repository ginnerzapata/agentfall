# Agentfall Product Requirements

**Status:** Accepted product direction; Season Zero scope ready for issue decomposition
**Product phase:** Server-first private alpha
**Related documents:** [Domain glossary](docs/agents/domain.md), [deterministic engine ADR](docs/adr/0001-deterministic-engine-and-event-snapshots.md)

## 1. Product Summary

Agentfall is an asynchronous competitive roguelike played by external AI harnesses through MCP. An account sends a randomly generated character into a deterministic seasonal tower. The account may provide one strategy prompt before each floor, but the harness makes every decision after the floor begins.

The game tests exploration, tactical combat, resource management, and adaptation across permanent-death runs. Accounts compete by progressing through the same seasonal tower under the same rules, while retaining private knowledge learned from earlier failures.

Agentfall does not run or pay for model inference. Codex, Claude, and other compatible harnesses connect to the remote MCP server and remain responsible for their own model execution.

## 2. Product Principles

1. **Harness-first:** Every gameplay capability must work through structured MCP tools without requiring a graphical game client.
2. **Deterministic and auditable:** Accepted actions must be reproducible under their original ruleset.
3. **Knowledge is progression:** Death removes the character, equipment, and mechanical progress; the account retains verified knowledge.
4. **Decisions over exhaustive search:** Fog of war, floor turn limits, persistent attrition, and Expedition Charges make choices consequential.
5. **Comparable competition:** Ranked accounts face identical seasonal layouts and initial conditions.
6. **Free-tier operation:** The service must fail closed when its internal capacity budget is exhausted and must never enable automatic paid usage.
7. **Original identity:** Inspirations inform the tactical tower structure, but Agentfall uses original terminology, lore, content, and visual direction.

## 3. Goals

### Phase 1 goals

- Prove that an external AI harness can authenticate, understand a floor, take legal actions, and complete or fail a run entirely through MCP.
- Deliver a five-floor private Season Zero with three tactically distinct character classes.
- Produce exact deterministic replays and protect mutations from duplicate network delivery.
- Validate that permanent death plus retained account knowledge motivates repeat attempts.
- Operate within Cloudflare's free service tiers without surprise billing.

### Public-launch goals

- Deliver a complete 20-floor, two-week competitive season.
- Publish standings, account profiles, season information, and read-only replays on a responsive website.
- Support seamless MCP authentication while continuing to support common external harnesses.

## 4. Non-Goals

- Running, hosting, or paying for an AI model.
- Verifying which model or harness produced an action.
- Preventing all human assistance or alternate-account abuse.
- Browser-based gameplay controls.
- Multiplayer parties or shared mutable floor instances.
- Crafting, trading, an economy, or paid energy refills.
- A desktop companion during the MVP or public-launch phases.
- Fully procedural boss encounters or a general-purpose content scripting language.

## 5. Audience and Competition Model

Agentfall is for people who want to test how an AI harness explores and solves a persistent tactical game. Competition is account-based because a public MCP server cannot reliably prove which model, prompt chain, or external assistance produced an action.

Each account plays an isolated instance of the same seasonal tower. One account cannot consume another account's treasure, change its map, or affect its enemies.

Ranked enrollment is explicit. An enrolled account chooses a unique Agentfall display name. Its GitHub identity remains private unless the account voluntarily links it.

Rankings are lightweight competition rather than prize-grade enforcement. Agentfall may require a minimally established GitHub account for ranked enrollment, but it will not claim that this eliminates alternate accounts.

## 6. Season Structure

- A public season lasts two weeks.
- A public tower contains 20 floors.
- Floors 5, 10, 15, and 20 are boss floors.
- A season freezes its ruleset and content pack when activated.
- Gameplay balance cannot change silently during an active season.
- A blocking gameplay defect may void or end a season; the corrected version receives a new seed and ruleset version.
- Season-specific characters, maps, and tactical journal entries reset when the season ends.
- Account identity, historical standings, achievements, and general bestiary lore remain.

Season Zero is a private five-floor validation season rather than the first full public season.

### Season lifecycle

```text
draft
  generated
    validated
      published
        active
          ended
            revealed
```

Season creation and publication require explicit administrative approval during the MVP.

## 7. Season Zero: Orc Siege

Season Zero exercises the complete five-floor loop with a focused content set.

### Enemy roles

- **Goblin scout:** mobile skirmisher.
- **Orc brute:** durable melee pursuer.
- **Orc archer:** ranged controller that prefers distance.
- **Orc shaman:** support unit that assists wounded allies.

Enemies use deterministic behavior trees. Equal-priority choices use the deterministic resolution RNG.

### Seasonal mechanic

War drums call reinforcements unless the character disables them. This creates a choice between rushing the objective, controlling enemies, and spending actions to remove future pressure.

### Boss

The floor-five Orc Warchief uses two phases and a clearly telegraphed arena mechanic. The first encounter must expose enough evidence for a harness to reason about the mechanic, while prior Journal knowledge remains valuable.

## 8. Ranked and Practice Play

### Ranked

- One living ranked character per account.
- One active ranked floor session per account.
- Ranked floors use the current season's tower and affect standings.
- Starting a ranked floor atomically consumes one Expedition Charge.
- A ranked character receives one attempt at each floor and cannot rewind it.

### Practice

- Practice is charge-free.
- Practice uses disposable characters and public training seeds.
- Training content teaches the current rules and faction behavior without reproducing ranked layouts, boss configurations, loot placement, or resolution RNG.
- Practice does not update the ranked Journal or standings.
- One practice session may coexist with the ranked character.

## 9. Character Generation and Death

A new ranked character receives:

- A generated name and cosmetic description.
- One random class.
- One balanced positive trait and one balanced negative trait.
- Fixed starting weapon and armor for the class.
- One basic healing potion.
- Fixed total base-stat power.

The account cannot reroll the character. Class and trait generation derive deterministically from the season and the account's character sequence.

Reaching zero Health causes immediate permanent death. A rare automatic resurrection item may prevent a lethal event once, restore one Health, and then be destroyed. A dead character cannot be rewound or revived after the death event commits.

After death, the account receives a new random character and restarts the tower from floor one. Mechanical progress, equipment, and consumables are lost; the account Journal remains.

## 10. Classes and Stats

### Core stats

- **Health:** remaining survivability.
- **Defense:** resistance to physical attacks.
- **Movement:** tactical movement allowance.
- **Accuracy:** attack-roll modifier.
- **Power:** physical damage effectiveness.
- **Focus:** magical effectiveness and resistance.

### Initial classes

#### Vanguard

- **Guard:** protects adjacent tiles until the next turn.
- **Shove:** pushes an adjacent enemy and may collide it with a wall or hazard.

#### Ranger

- **Scout:** reveals a cone beyond normal vision without revealing through walls.
- **Disengaging Shot:** attacks and steps away without triggering a reaction.

#### Arcanist

- **Arc Bolt:** reliable ranged magical damage.
- **Ward:** temporary magical protection.

Class abilities can provide safer routes, optional rewards, or tactical alternatives, but no mandatory objective may require a particular class.

## 11. Progression and Inventory

- Completing a normal floor awards one level.
- The harness chooses one of three deterministic upgrade options after the floor.
- Boss completion awards a larger upgrade and a full recovery checkpoint.
- Between normal floors, the character receives a small fixed Health recovery rather than a full heal.
- Injuries, equipment, and remaining consumables persist between normal floors.

Equipment and carrying capacity:

- One weapon slot.
- One armor slot.
- One accessory slot.
- Four backpack slots.
- Identical consumables may stack.
- Inventory management is free between floors.
- Swapping equipment during a floor costs one action.
- Discarded items are permanently lost.

## 12. Floor Design

A normal floor is a connected square-grid dungeon containing:

- Six to ten rooms joined by corridors.
- One entrance and one locked exit.
- One mandatory key or objective.
- Two or three combat encounters.
- Zero to two optional treasure rooms.
- One healing opportunity.
- One trap or environmental obstacle.
- At most one secret area.

The character may leave after unlocking the exit and sacrifice unexplored rewards. Every mandatory objective must be completable by every class.

Floor generation uses deterministic assembly from authored room and encounter templates. Templates are tagged by difficulty, faction mechanic, and required capabilities. Generation must validate connectivity, objective reachability, and turn-budget feasibility before a season can be published.

Boss floors are authored encounters with seeded variations. They contain a preparation room, boss arena, and reward room rather than a normal exploration maze.

## 13. Vision and Exploration

- Base vision radius is six tiles.
- Walls and closed doors block sight.
- Previously observed terrain remains visible as remembered terrain.
- Creatures and movable objects disappear when outside current vision.
- Remembered tiles do not update while unseen.
- Alerted enemies continue acting outside vision.
- Hidden entities never appear in an Observation.
- Inspecting state is free; state-changing Actions advance the floor.

Each Observation includes:

- Authoritative structured coordinates, terrain, and entities.
- A derived ASCII representation of the same known information.
- Current stats, inventory, statuses, and action points.
- Legal Actions, valid targets, and expected costs.
- Events resolved since the previous Action.

Structured data is authoritative. Coordinates use a fixed origin, with `x` increasing east and `y` increasing south.

## 14. Combat and Resolution

Combat uses a square grid with walls, doors, occupied cells, movement range, attack range, and line of sight. Elevation and complex surface simulation are deferred.

A character starts each combat turn with four action points:

- Move one tile: 1 AP.
- Basic attack: 2 AP.
- Signature ability: 2–4 AP.
- Interact or swap equipment: 1 AP.
- Open or close an unlocked door: 1 AP.

Movement may be split around other Actions. Unused AP does not carry into the next turn. Ending early converts up to two unused AP into temporary Defense.

Attacks use seeded d20 rolls against Defense with deterministic modifiers and small damage dice. Observations expose hit probability and possible damage range but never reveal future rolls.

There is no unrestricted rest Action. A generated sanctuary may appear once on a floor and may be used once. Potions consume an Action during exploration or combat.

Retreat is spatial: enemies pursue according to their behavior, and doors may slow pursuit. Leaving combat requires sufficient distance.

## 15. Floor Turn Budget and Failure

Every floor receives a deterministic turn budget calculated from its generated size and encounters. Season Zero should target approximately 60–100 meaningful character decisions per floor; final numbers require simulation and playtesting.

Combat advances the floor clock after a full combat round rather than after each AP expenditure.

If the budget expires, the floor collapses:

- The attempt fails.
- The character returns to its pre-floor state.
- The Expedition Charge remains spent.
- Floor discoveries and agent-written notes are discarded.
- The Journal records only that the floor timed out.
- Collapse cannot rescue a character whose death already committed.

Voluntary abandonment follows the same rollback rules.

## 16. Expedition Charges and Session Limits

- An account holds at most three Expedition Charges.
- When below the cap, one charge regenerates every four hours.
- Regeneration uses a lazy rolling calculation based on server UTC time.
- Reaching the cap pauses regeneration.
- Boss completion immediately restores one charge without exceeding the cap.
- Charges cannot be purchased, advertised, gifted, or refilled with money.

A started floor may remain open for at most 24 hours. After ten minutes without a state-changing Action, the session pauses safely. The account may resume within the 24-hour window. Expiration abandons the attempt using the rollback rules above.

## 17. Ranking

An account's seasonal best is ordered by:

1. Highest floor completed.
2. Bosses defeated.
3. Fewest characters lost.
4. Fewest floor turns used.
5. Earliest timestamp as the final tiebreaker.

Death does not erase the account's historical seasonal best. The living character's current floor is presented separately.

## 18. Journal and Information Sharing

The Journal has two layers:

1. Verified structured facts generated by the server, including observed terrain, enemy behavior, item effects, traps, and death causes.
2. A short, size-limited note written by the harness and clearly marked as untrusted text.

The Journal is private to the account during the season. One account's discoveries never mutate another account's run.

During an active season, replay details are visible only for floors the viewing account has already completed. Full seasonal information may become public after seed reveal.

## 19. Determinism and Replay

- Every account receives identical floor layouts, initial enemy positions, objectives, and initial loot for the season.
- The server keeps the actual season seed secret while the season is active.
- A cryptographic commitment to the seed is published at season start.
- The seed is revealed after the season ends.
- Action-dependent resolution streams also include account and character identity, preventing one account from revealing another account's future rolls.
- Read-only Observations never advance RNG.

The durable replay record contains:

- Season, content-pack, ruleset, and generator versions.
- Initial character and floor state.
- Every accepted Action and validated parameters.
- Every resolution RNG result.
- A state checksum after every committed transition.
- The terminal floor result.

Replaying the accepted Events under the original ruleset must reconstruct the stored Snapshot exactly.

## 20. MCP Product Interface

The initial remote interface uses one stateless Streamable HTTP endpoint at `/mcp`. Floor continuity belongs to authenticated application state, not to a long-lived MCP connection.

The tool surface covers:

- Starting a floor.
- Observing the current floor.
- Submitting one typed Action with an idempotency key.
- Reading the current character.
- Reading the account Journal.
- Ending or abandoning a floor session.
- Reading season details and standings.

The Action input is a discriminated union rather than an untyped natural-language command. Mutation results are concise, structured, and replayable. Tool names and schemas must remain compatible with common MCP clients.

The MVP does not depend on sampling, elicitation, MCP Apps, client-side UI, server-initiated model calls, or long-lived streaming behavior.

## 21. Strategy Prompt

Starting a floor accepts an optional strategy statement and returns a concise floor briefing suitable for an external harness. The submitted strategy becomes part of the replay metadata.

Agentfall cannot verify or prevent additional instructions supplied outside the service. Rankings therefore measure the account's result rather than claiming verified autonomous model performance.

## 22. Authentication and Account Identity

Phase 1 provides a small authentication bootstrap page:

1. The person authenticates with GitHub.
2. Agentfall stores the immutable numeric GitHub user ID and refreshable display metadata.
3. Agentfall issues a revocable opaque bearer credential.
4. Only a hash of that credential is stored.
5. The credential is configured through the MCP client's environment or secret configuration, never placed in the harness prompt.

The GitHub access token is not used as the ongoing game credential and should be discarded after identity verification unless a strictly necessary encrypted use is documented.

A later release may implement a complete MCP-compatible OAuth authorization layer with GitHub as the upstream identity provider.

## 23. Website

The public-launch website is read-only with respect to gameplay. It provides:

- Current and historical standings.
- Public account profiles.
- Current season details.
- Character and expedition summaries.
- Credential management.
- Read-only grid/ASCII replay visualization.

The website consumes the same application layer through public read APIs. It does not contain browser gameplay controls.

## 24. Technical Constraints

The repository is a Bun workspace with the intended structure:

```text
apps/
  server/       Cloudflare Worker, Hono, MCP, authentication, read APIs
  web/          React website, deferred until the public-launch phase
packages/
  engine/       Deterministic runtime-neutral game rules
  content/      Versioned seasonal TypeScript content packs
  contracts/    Transport-safe schemas and public types
  testing/      Fixtures, simulations, and golden replays
```

- Bun manages dependencies, workspaces, scripts, and local tests.
- Cloudflare Workers is the production server runtime.
- Hono owns HTTP routing and middleware.
- The official MCP TypeScript server SDK owns the MCP protocol.
- Vercel AI SDK is not part of the server because Agentfall does not run a model loop.
- Drizzle provides the D1 persistence layer.
- The engine cannot import Bun, Hono, Workers, D1, Drizzle, or MCP APIs.
- Seasonal behavior uses versioned deterministic TypeScript content packs rather than a custom scripting language.
- The deployable server is a modular monolith.

The accepted persistence design is defined in [ADR 0001](docs/adr/0001-deterministic-engine-and-event-snapshots.md).

## 25. Persistence and Retention

For each accepted Action, the server atomically:

1. Inserts one immutable Event containing the Action and resolved outcome.
2. Updates one serialized, checksummed, versioned Snapshot.

Unique idempotency keys and optimistic Snapshot versions prevent duplicate or concurrent advancement. Read-only Observations are never persisted as Events.

Retention policy:

- Active-season ranked Event histories remain available.
- Practice replays have a short debugging retention window.
- Top-ranked and boss-clearing replays remain complete after a season.
- Ordinary ended-season runs may be compacted to summaries after seed reveal.
- Accounts, standings, achievements, and aggregate statistics remain.
- Account deletion removes private identity data while allowing anonymized historical standings where required.

## 26. Free-Tier Capacity Policy

Agentfall must remain within free Cloudflare quotas.

- Maintain an internal daily capacity budget below platform limits.
- Reserve conservative write capacity when admitting a new floor.
- Shed practice traffic before ranked traffic.
- Stop admitting new ranked floors before reserved active-session capacity is threatened.
- If persistence is unavailable, reject the mutation without changing state and permit an idempotent retry.
- Return a typed `CAPACITY_EXHAUSTED` result with the expected UTC reset time.
- Never automatically enable a paid plan or overage billing.

## 27. Administration

The MVP uses authenticated CLI workflows rather than an admin website. Administrative operations include:

- Generate a complete season.
- Run deterministic and reachability validation.
- Review validation results.
- Publish the seed commitment.
- Activate and end the season.
- Reveal the season seed.

Administrative secrets remain outside the repository. Season publication requires explicit confirmation.

## 28. Quality Requirements

The automated suite must demonstrate:

- The same seed and Action sequence produce byte-identical Events and final checksum.
- Stored Events reconstruct the exact Snapshot.
- Retried idempotency keys never advance state twice.
- Observations never consume resolution RNG.
- Generated mandatory objectives are reachable by every class.
- Generated floors do not contain illegal coordinates, negative AP, duplicate occupancy, or impossible objectives.
- Golden replays remain pinned to their ruleset version.
- Invalid, unauthorized, stale-version, and over-capacity mutations leave state unchanged.

## 29. Delivery Plan

### Phase 1: Harness-playable private alpha

- Five-floor Orc Siege Season Zero.
- GitHub bootstrap authentication and revocable Agentfall credentials.
- Ranked and Practice MCP gameplay.
- Vanguard, Ranger, and Arcanist.
- Fog of war, exploration, combat, loot, permanent death, and Journal retention.
- Deterministic Event/Snapshot replay.
- MCP-accessible season details and standings.
- Administrative CLI.
- Ten to twenty-five invited accounts.

### Phase 2: Public launch

- Full 20-floor season and four bosses.
- Responsive ranking and profile website.
- Credential management.
- Season, character, and expedition summaries.
- Read-only replay viewer.
- Full MCP-compatible OAuth if required for smoother client onboarding.

### Future

- Additional factions and seasonal mechanics.
- Fire, poison, and controlled environmental interactions.
- Desktop companion inspired by compact agent-monitoring interfaces.
- Durable Objects only if measured concurrency demonstrates that D1 optimistic writes are insufficient.

## 30. Alpha Success Criteria

Season Zero succeeds when:

- At least 80% of invited participants authenticate and start a run without manual troubleshooting.
- At least one complete five-floor expedition replays deterministically.
- No duplicate or lost Actions occur during tested retries.
- At least five participants voluntarily start another character after permanent death.
- The three classes produce observably different Action patterns.
- The service stays within its internal free-tier budget.

## 31. Open Balance and Implementation Decisions

The following are deliberately unresolved and must be settled through simulation, focused issues, and playtesting rather than assumption:

- Exact class, enemy, item, and trait values.
- The initial positive and negative trait pool.
- The class upgrade pools.
- Exact room and encounter templates.
- Final floor turn-budget formula.
- Loot frequency and resurrection-item rarity.
- Minimum GitHub account age for ranked enrollment.
- Internal capacity thresholds below platform quotas.
- Exact token lifetime and credential-rotation policy.

These choices may evolve before Season Zero is published, provided they do not violate the product principles and accepted architecture above.
