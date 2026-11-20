# Delivery checkpoints

This file carries only the handoff needed to start the next autonomous Goal.
Keep the newest completed unit at the top and replace stale entries rather than
accumulating a project history; Git preserves the full history.

## Template

```md
### <issue number or checklist unit> — <status>

- Verified: `<commands>` — <result>
- Commit: `<SHA>` — <subject>
- Next: <next eligible issue or checklist unit>
- Blocker: <none, or one concrete decision/access need>
```

## Current handoff

### #32 — complete

- Verified: `bun test apps/server/src/mcp/server.test.ts`, `bun run typecheck` — pass
- Commit: `1d6e9d1` — Complete read-only MCP gameplay tools
- Next: #33 — implement mutating MCP tools with idempotency and rollback semantics
- Blocker: none
