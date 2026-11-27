import {
  type Action,
  McpCharacterInputSchema,
  McpCharacterUpgradeInputSchema,
  McpFloorAbandonInputSchema,
  McpFloorActionInputSchema,
  McpFloorEndInputSchema,
  McpFloorStartInputSchema,
  McpJournalInputSchema,
  McpObservationInputSchema,
  McpSeasonInputSchema,
  McpStandingsInputSchema,
  type Observation,
} from "@agentfall/contracts";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

import { McpAuthenticationError } from "./gameplay";

type ToolData = Record<string, unknown>;

/**
 * Port for the authenticated gameplay application. It keeps MCP schemas and
 * transport code separate from identity, D1, and the deterministic engine.
 */
export interface McpGameplay {
  startFloor(input: {
    mode: "ranked" | "practice";
    idempotencyKey: string;
    strategy?: string;
    includeTiles?: boolean;
  }): Promise<ToolData>;
  observeFloor(input: { floorSessionId?: string; includeTiles?: boolean }): Promise<ToolData>;
  submitAction(input: {
    floorSessionId?: string;
    snapshotVersion?: number;
    idempotencyKey: string;
    action?: Action;
    actions?: Action[];
    autoEndTurn?: boolean;
    includeTiles?: boolean;
  }): Promise<ToolData>;
  currentCharacter(): Promise<ToolData>;
  chooseUpgrade(input: { upgradeId: string; idempotencyKey: string }): Promise<ToolData>;
  journal(input: { limit: number }): Promise<ToolData>;
  abandonFloor(input: { floorSessionId?: string; idempotencyKey: string }): Promise<ToolData>;
  endFloor(input: { floorSessionId?: string; idempotencyKey: string }): Promise<ToolData>;
  season(input: { seasonId?: string }): Promise<ToolData>;
  standings(input: { seasonId?: string; limit: number }): Promise<ToolData>;
}

/** No account identifier is ever accepted from an MCP tool input. */
export function createAgentfallMcpHandler(gameplay: McpGameplay = unauthenticatedGameplay()) {
  return createMcpHandler(() => createServer(gameplay));
}

function createServer(gameplay: McpGameplay) {
  const server = new McpServer({ name: "agentfall", version: "0.2.0" });
  server.registerTool(
    "floor_start",
    {
      description: "Enter the next tower floor (ranked or practice).",
      inputSchema: McpFloorStartInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.startFloor(input)),
  );
  server.registerTool(
    "floor_observation",
    {
      description: "Inspect the current floor HUD, map, enemies, and legal actions.",
      inputSchema: McpObservationInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => invoke(gameplay.observeFloor(input)),
  );
  server.registerTool(
    "floor_action",
    {
      description:
        "Take one action or a batch of actions on the active floor (supports autoEndTurn).",
      inputSchema: McpFloorActionInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.submitAction(input)),
  );
  server.registerTool(
    "character_get",
    {
      description: "Inspect your current living character, gear, traits, and pending upgrades.",
      inputSchema: McpCharacterInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => invoke(gameplay.currentCharacter()),
  );
  server.registerTool(
    "character_upgrade",
    {
      description: "Claim one pending level-up upgrade between floors.",
      inputSchema: McpCharacterUpgradeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.chooseUpgrade(input)),
  );
  server.registerTool(
    "journal_get",
    {
      description: "Read private Journal discoveries from previous floors.",
      inputSchema: McpJournalInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.journal(input)),
  );
  server.registerTool(
    "floor_abandon",
    {
      description: "Abandon the current floor and roll back to pre-floor state.",
      inputSchema: McpFloorAbandonInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) => invoke(gameplay.abandonFloor(input)),
  );
  server.registerTool(
    "floor_end",
    {
      description: "Descend through the unlocked exit to complete the floor.",
      inputSchema: McpFloorEndInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.endFloor(input)),
  );
  server.registerTool(
    "season_get",
    {
      description: "Read public season details.",
      inputSchema: McpSeasonInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.season(input)),
  );
  server.registerTool(
    "standings_get",
    {
      description: "Read season leaderboard standings.",
      inputSchema: McpStandingsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.standings(input)),
  );
  return server;
}

function result(data: ToolData) {
  const isError = typeof data.code === "string";
  const text = isError ? JSON.stringify(data) : formatGameText(data);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data,
    isError,
  };
}

function formatGameText(data: ToolData): string {
  const obs = data.observation as Partial<Observation> | undefined;
  if (obs && typeof obs === "object" && obs.character && typeof obs.ascii === "string") {
    const c = obs.character;
    const floorLabel = typeof data.floor === "number" ? `FLOOR ${data.floor} | ` : "";
    const budgetLabel = typeof data.turnBudget === "number" ? `/${data.turnBudget}` : "";
    const combatTag = obs.inCombat ? "COMBAT" : "EXPLORE";
    const statusParts = [
      `${floorLabel}Turn ${obs.turn ?? 1}${budgetLabel}`,
      `HP ${c.health}/${c.maxHealth}`,
      `AP ${obs.actionPoints ?? 0}/4`,
      combatTag,
    ];
    if (c.temporaryDefense > 0) statusParts.push(`+${c.temporaryDefense} DEF`);
    if (c.ward > 0) statusParts.push(`Ward ${c.ward}`);
    if (data.outcome && data.outcome !== "continued") {
      statusParts.push(`OUTCOME: ${String(data.outcome).toUpperCase()}`);
    }

    const lines: string[] = [`=== ${statusParts.join(" | ")} ===`];
    const recent = obs.recentEvents ?? [];
    if (recent.length > 0) {
      lines.push("LOG:");
      for (const entry of recent.slice(-4)) lines.push(`- ${entry}`);
    }
    lines.push("MAP:");
    lines.push(obs.ascii);
    lines.push(
      "Legend: @ You | g/B/a/S/W Enemies | + Door | ! Chest | H Sanctuary | $ Item | ^ Trap | * Obj | X/< Exit",
    );

    const enemies = obs.enemies ?? [];
    if (enemies.length > 0) {
      const intents = new Map((obs.enemyIntents ?? []).map((i) => [i.enemyId, i.summary]));
      lines.push("ENEMIES:");
      for (const e of enemies) {
        const intent = intents.get(e.id);
        lines.push(
          `- ${e.id} (${e.health}/${e.maxHealth} HP) at (${e.position.x},${e.position.y})${intent ? ` -> ${intent}` : ""}`,
        );
      }
    }

    const actions = (obs.legalActions ?? []).map((a) => {
      if (a.type === "move") return `move(${a.directions.join("/")})`;
      if (a.type === "travel") return `travel(${a.directions.join("/")})`;
      if (a.type === "attack") {
        const previews = new Map((obs.attackPreviews ?? []).map((p) => [p.targetId, p]));
        return `attack(${a.targetIds
          .map((id) => {
            const p = previews.get(id);
            return p
              ? `${id} ${Math.round(p.hitProbability * 100)}% ${p.damageRange.minimum}-${p.damageRange.maximum}dmg`
              : id;
          })
          .join(", ")})`;
      }
      if (a.type === "interact")
        return `interact(${a.targets.map((t) => `${t.x},${t.y}`).join(" | ")})`;
      if (a.type === "open-door")
        return `open-door(${a.targets.map((t) => `${t.x},${t.y}`).join(" | ")})`;
      if (a.type === "close-door")
        return `close-door(${a.targets.map((t) => `${t.x},${t.y}`).join(" | ")})`;
      if (a.type === "use-item" || a.type === "equip-item" || a.type === "drop-item")
        return `${a.type}(slot ${a.slots.join("/")})`;
      if ("targetIds" in a) return `${a.type}(${a.targetIds.join(", ")})`;
      if ("directions" in a) return `${a.type}(${a.directions.join("/")})`;
      return a.type;
    });
    if (actions.length > 0) {
      lines.push(`ACTIONS: ${actions.join(" | ")}`);
    }
    return lines.join("\n");
  }

  if (data.status === "completed" && typeof data.floor === "number") {
    const upgrades = Array.isArray(data.pendingUpgrades)
      ? (data.pendingUpgrades as Array<{ id: string; stat: string; delta: number }>)
          .map((u) => `${u.id} (+${u.delta} ${u.stat})`)
          .join(", ")
      : "";
    return [
      `=== FLOOR ${data.floor} CLEARED in ${data.turnsUsed} turns! ===`,
      `Next floor: ${data.nextFloor}`,
      ...(upgrades ? [`Pending upgrades (call character_upgrade): ${upgrades}`] : []),
    ].join("\n");
  }

  return JSON.stringify(data);
}

async function invoke(operation: Promise<ToolData>) {
  try {
    return result(await operation);
  } catch (error) {
    if (error instanceof McpAuthenticationError) return result({ code: "AUTH_REQUIRED" });
    return result({ code: "INTERNAL" });
  }
}

function unauthenticatedGameplay(): McpGameplay {
  const denied = async (): Promise<ToolData> => ({ code: "AUTH_REQUIRED" });
  return {
    startFloor: denied,
    observeFloor: denied,
    submitAction: denied,
    currentCharacter: denied,
    chooseUpgrade: denied,
    journal: denied,
    abandonFloor: denied,
    endFloor: denied,
    season: denied,
    standings: denied,
  };
}
