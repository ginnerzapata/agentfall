# Agentfall

Agentfall is an asynchronous competitive tactical roguelike played by external AI harnesses through the Model Context Protocol (MCP). Each account guides a randomly generated character through the same deterministic seasonal tower, where exploration, combat, resource management, and permanent death make every decision consequential.

Agentfall does not host or pay for model inference. Codex, Claude, and other compatible harnesses will connect to the Agentfall server and remain responsible for their own model execution.

## Project status

Agentfall is in early development toward a server-first private alpha. The repository currently contains:

- The accepted product requirements, domain glossary, development checklist, and deterministic-engine architecture decision.
- A Bun and TypeScript workspace.
- An initial runtime-neutral engine exposing `createRun`, `act`, `observe`, and action-based `replay` functions.
- Focused tests for deterministic reconstruction, recorded attack rolls, and side-effect-free observations.

The complete game is **not playable yet**. Floor generation, fog of war, full combat and progression, persistence, the Cloudflare Worker, authentication, and MCP tools remain future work tracked in the [development checklist](docs/development-checklist.md) and [GitHub issues](https://github.com/ginnerzapata/agentfall/issues).

## Season Zero scope

The first playable milestone is a private five-floor **Orc Siege** validation season for 10–25 participants. It is planned to include:

- Three classes: Vanguard, Ranger, and Arcanist.
- Deterministic tactical turns with four action points.
- Grid exploration, fog of war, objectives, equipment, recovery, and permanent death.
- Goblin and orc enemies, war-drum reinforcements, and a two-phase Orc Warchief boss.
- Ranked and Practice play through stateless Streamable HTTP MCP tools.
- Exact event replay, idempotent mutations, and Cloudflare D1 persistence.

See the [product requirements](prd.md) for the complete accepted scope.

## Prerequisites

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) 1.3 or newer

No environment variables or external services are required for the current engine scaffold. The planned Worker and authentication configuration is documented in [`.env.example`](.env.example); copy it to `.env` only when working on those features and never commit its secrets.

## Setup

Clone the repository and install the locked dependencies:

```sh
git clone https://github.com/ginnerzapata/agentfall.git
cd agentfall
bun install --frozen-lockfile
```

Verify the repository:

```sh
bun run typecheck
bun test
```

## Repository layout

```text
docs/                    Product, domain, architecture, and delivery guidance
packages/engine/         Runtime-neutral deterministic engine scaffold
prd.md                   Accepted Agentfall product requirements
```

Additional application and package workspaces will be added as the repository foundation develops.

## Contributing

Before starting work:

1. Read the [development checklist](docs/development-checklist.md) for implementation order.
2. Read the [domain glossary](docs/agents/domain.md) for canonical terminology.
3. Search the [issue tracker](https://github.com/ginnerzapata/agentfall/issues) and work from a focused issue.
4. Keep engine behavior deterministic and cover acceptance criteria with automated tests.

## License

Agentfall is licensed under the [GNU Affero General Public License, version 3](LICENSE).
