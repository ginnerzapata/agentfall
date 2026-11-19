# GitHub bootstrap authentication

Each environment needs its own GitHub OAuth App before enabling `/auth`. In the
GitHub developer settings, set the callback URL to
`https://YOUR_AGENTFALL_HOST/auth/callback` (or the exact local origin). Copy
the client ID and client secret into Cloudflare Worker secrets; do not put them
in `wrangler.jsonc`.

The Worker additionally requires `AGENTFALL_ORIGIN`, `AUTH_STATE_SECRET`, and
`CREDENTIAL_HASH_PEPPER`. Generate the latter two independently with at least
32 random bytes and make the credential pepper stable for the environment. Set
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_STATE_SECRET`, and
`CREDENTIAL_HASH_PEPPER` as Worker secrets; `AGENTFALL_ORIGIN` may be a
non-secret Worker variable.

The authorization request asks only for GitHub's `read:user` scope. The
callback reads GitHub's immutable numeric `id`, creates or finds the matching
Agentfall account, then drops the GitHub access token. It neither stores the
token nor exposes it in a response or log.

After signing in, use the authenticated credential endpoints to create,
list, rotate, revoke, or expire Agentfall bearer credentials. A plaintext
credential appears only in the create or rotate response; only its peppered
SHA-256 hash and metadata are retained. Put the plaintext in an MCP client
environment secret, never a URL, prompt, source file, or log.

Ranked enrollment is a separate, one-time `POST /v1/ranked-enrollment` action
with a 3–24 character Agentfall display name. The database enforces its
uniqueness; GitHub login names are never used for rankings.

## Administrative season operations

Set `ADMIN_BEARER_TOKEN` as a distinct Cloudflare Worker secret for each
environment. It protects the internal `/v1/admin/*` API used only by the
repository's CLI; it is not an MCP or player credential. The CLI reads both
`ADMIN_BEARER_TOKEN` and `AGENTFALL_ADMIN_URL` from the local environment:

```sh
bun run --cwd apps/server admin:season generate --id season-zero --seed "$SEASON_SEED" --ruleset-version 1 --generator-version 1 --content-version orc-siege-1
bun run --cwd apps/server admin:season validate --id season-zero
bun run --cwd apps/server admin:season publish --id season-zero --seed "$SEASON_SEED" --confirm
```

The Worker generates the complete tower before validation. Publication cannot
run without a valid tower, a matching seed, and the explicit `--confirm` flag.
Keep the seed in a local secret manager or CI secret, never a shell history,
repository file, URL, request log, or command output. Activate, end, reveal,
and inspect use the same command with their respective operation names.
