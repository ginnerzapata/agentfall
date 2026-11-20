# Private Alpha Security Review

Reviewed 2026-11-19 against the codebase at the start of Part 16. This is a
source review and local integration review; it is not a substitute for a
production penetration test or Cloudflare account review.

## Scope

- GitHub OAuth bootstrap, signed browser sessions, opaque bearer credentials,
  credential rotation, and ranked enrollment.
- MCP authentication, tool inputs, hidden-state handling, Journal, season, and
  standings responses.
- Administrative HTTP routes and season-seed handling.
- Error and command logging.
- Request size limits and rate-limit coverage.

## Closed findings

### High: a second gameplay transport bypassed MCP protections

`/v1/floor-sessions/:id/observation` and `/actions` accepted a guessed session
ID without authentication or ownership enforcement. The action route also
bypassed the MCP adapter's session-status and idle-resume behavior. Both routes
were removed: `/mcp` is the sole gameplay transport, as specified by the PRD.
Requests to their former paths now return `NOT_FOUND`.

### Medium: MCP had no explicit request-size or request-rate middleware

The generic `/v1/*` middleware did not cover `/mcp`. The MCP endpoint now has
the same 16 KiB body limit and an IP-scoped request limiter. Future mutating MCP
tools must retain their existing idempotency requirement and add the
active-floor mutation limiter when implemented.

### Medium: application error logs could include untrusted exception messages

The HTTP error handler no longer logs `error.message`. It records only a stable
event name, request ID, and error class, preventing credential, OAuth-code, or
request-body values from being reflected to logs through an exception.

### Medium: credential rotation could partially succeed

Rotation issued a replacement and revoked the old credential in separate
writes. A failure between those writes could leave both active. Rotation now
inserts the replacement only if the requested active credential exists, then
revokes the old credential in the same D1 batch. A focused test verifies that
exactly one active credential remains.

## Confirmed controls

- OAuth state is HMAC-signed, short-lived, and bound to an `HttpOnly`, `Secure`,
  `SameSite=Lax` nonce cookie.
- GitHub identity is derived from the immutable numeric ID; the upstream access
  token is not persisted or returned.
- MCP accepts only opaque bearer credentials whose peppered SHA-256 hash is
  stored. Revoked and expired credentials are rejected.
- Credentials are displayed only at issuance or rotation; list responses omit
  credential hashes and token values.
- Admin routes fail closed without the configured bearer secret, use a
  constant-time digest comparison, and season inspection intentionally omits
  the seed.
- Active-season MCP data uses account-scoped queries and engine observations,
  which omit unseen tiles, hidden entities, the secret seed, and future rolls.
- The replay-visibility port restricts active-season replay access to floors
  already completed by the viewer.

## Alpha operating conditions

- Register the GitHub OAuth application and provision `GITHUB_CLIENT_SECRET`,
  `AUTH_STATE_SECRET`, `CREDENTIAL_HASH_PEPPER`, and `ADMIN_BEARER_TOKEN` only
  as Worker secrets; do not use development placeholder values.
- Keep `AGENTFALL_ORIGIN` on the production HTTPS origin. Verify Worker logs
  and Cloudflare observability settings after deployment with a disposable
  credential.
- Re-review the mutation path when Part 11's remaining `floor_start`,
  `floor_action`, `floor_abandon`, and `floor_end` MCP tools are implemented.

## Evidence

- `bun run typecheck`
- `bun test`
- `bun run check`
- `bun run --cwd=apps/server test:worker`
