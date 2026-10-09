# Deterministic Engine and Event Snapshots

**Status:** accepted

Agentfall will keep deterministic game resolution in a runtime-neutral `packages/engine` module with a small pure interface for creating a run, accepting a typed action, and observing state. The Worker application will persist one immutable accepted event and one versioned serialized snapshot in the same D1 transactional batch; replay will use the original ruleset, seed derivation, and recorded resolution results. This preserves byte-identical replay and keeps Bun, Workers, Hono, D1, Drizzle, MCP, and transport concerns outside the engine.

## Considered Options

- Resolve game state directly in the MCP/Worker handlers. Rejected because runtime and transport dependencies would make deterministic simulation and replay difficult to test and reuse.
- Persist snapshots only. Rejected because it cannot independently reconstruct or audit an accepted run.
- Persist events only. Rejected for MVP because replaying every action for common observations would add avoidable latency and D1 read cost.
- Use Durable Objects for active sessions. Deferred until measured contention shows D1 optimistic writes are insufficient; the MVP requires free-tier-only operation.

## Consequences

- Engine inputs and outputs must be serializable and carry no wall-clock, global-random, or platform state.
- RNG results that affect resolution become replay data rather than hidden ambient randomness.
- Persistence adapters own idempotency, optimistic snapshot versions, and transaction handling; the engine owns validation and state transition semantics.
