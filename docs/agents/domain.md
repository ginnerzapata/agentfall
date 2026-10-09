# Agentfall Domain

Use these terms consistently in product, code, tests, and issues. This document defines the game domain; implementation and infrastructure choices belong in ADRs.

## Competition

**Account**: A competitor identity that owns ranked characters, seasonal progress, and private knowledge. An account is not a model identity.
_Avoid_: player, user, agent

**Season**: A time-bounded, immutable ruleset, content pack, and secret seed used for ranked competition.
_Avoid_: campaign, tournament

**Ruleset**: The versioned mechanics and content interpretation that resolves a run.
_Avoid_: build, game version

**Seasonal best**: An account's best completed ranked result, ordered by floor completed, bosses defeated, characters lost, floor turns, then timestamp.
_Avoid_: rank, score

**Expedition Charge**: A replenishing account resource consumed atomically when a ranked floor starts.
_Avoid_: energy, life, ticket

## Expedition

**Character**: A permanent-death combatant owned by one account. At most one ranked character may be living for an account.
_Avoid_: player, hero, avatar

**Run**: One character's ordered attempts through a season's floors, including its committed history.
_Avoid_: game, playthrough

**Floor**: One generated tactical challenge with an entry state, objective, exit, turn limit, and outcome.
_Avoid_: level, map

**Floor session**: A resumable, time-limited claim to a single started floor. A ranked account can have only one active floor session.
_Avoid_: match, connection

**Practice**: Disposable, charge-free play on public training seeds that is isolated from ranked characters, knowledge, and standings.
_Avoid_: unranked, sandbox

**Journal**: Account-private structured knowledge accumulated from observations, including terrain, entities, items, traps, and death causes.
_Avoid_: fog-of-war cache, notes

## Resolution

**Action**: A validated, typed player decision accepted by the engine to advance a run.
_Avoid_: command, move

**Observation**: A read-only authoritative view of the current run state, including visible and remembered information and legal actions. Reading never advances RNG or turns.
_Avoid_: state, snapshot

**Event**: An immutable fact accepted or resolved while advancing a run.
_Avoid_: log entry, action record

**Snapshot**: A serialized versioned materialization of the run state after a committed event.
_Avoid_: save game, state

**Replay**: Reconstructing a historical snapshot by applying its accepted events under the original ruleset and resolved RNG results.
_Avoid_: playback, audit log

**Resolution RNG**: A deterministic random result derived from the season seed and run identity when an accepted action requires chance.
_Avoid_: random roll, entropy
