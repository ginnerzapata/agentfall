import {
  type Action,
  McpCharacterInputSchema,
  McpFloorAbandonInputSchema,
  McpFloorActionInputSchema,
  McpFloorEndInputSchema,
  McpFloorStartInputSchema,
  McpJournalInputSchema,
  McpObservationInputSchema,
  McpSeasonInputSchema,
  McpStandingsInputSchema,
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
  }): Promise<ToolData>;
  observeFloor(input: { floorSessionId: string }): Promise<ToolData>;
  submitAction(input: {
    floorSessionId: string;
    snapshotVersion: number;
    idempotencyKey: string;
    action: Action;
  }): Promise<ToolData>;
  currentCharacter(): Promise<ToolData>;
  journal(input: { limit: number }): Promise<ToolData>;
  abandonFloor(input: { floorSessionId: string; idempotencyKey: string }): Promise<ToolData>;
  endFloor(input: { floorSessionId: string; idempotencyKey: string }): Promise<ToolData>;
  season(input: { seasonId?: string }): Promise<ToolData>;
  standings(input: { seasonId?: string; limit: number }): Promise<ToolData>;
}

/** No account identifier is ever accepted from an MCP tool input. */
export function createAgentfallMcpHandler(gameplay: McpGameplay = unauthenticatedGameplay()) {
  return createMcpHandler(() => createServer(gameplay));
}

function createServer(gameplay: McpGameplay) {
  const server = new McpServer({ name: "agentfall", version: "0.1.0" });
  server.registerTool(
    "floor_start",
    {
      description: "Start one floor.",
      inputSchema: McpFloorStartInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.startFloor(input)),
  );
  server.registerTool(
    "floor_observation",
    {
      description: "Read the safe current floor view.",
      inputSchema: McpObservationInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => invoke(gameplay.observeFloor(input)),
  );
  server.registerTool(
    "floor_action",
    {
      description: "Commit one typed action.",
      inputSchema: McpFloorActionInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.submitAction(input)),
  );
  server.registerTool(
    "character_get",
    {
      description: "Read the current character.",
      inputSchema: McpCharacterInputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => invoke(gameplay.currentCharacter()),
  );
  server.registerTool(
    "journal_get",
    {
      description: "Read private Journal entries.",
      inputSchema: McpJournalInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.journal(input)),
  );
  server.registerTool(
    "floor_abandon",
    {
      description: "Abandon a floor and discard its progress.",
      inputSchema: McpFloorAbandonInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) => invoke(gameplay.abandonFloor(input)),
  );
  server.registerTool(
    "floor_end",
    {
      description: "End an unlocked floor.",
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
      description: "Read season standings.",
      inputSchema: McpStandingsInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.standings(input)),
  );
  return server;
}

function result(data: ToolData) {
  const text = JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data,
    isError: typeof data.code === "string",
  };
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
    journal: denied,
    abandonFloor: denied,
    endFloor: denied,
    season: denied,
    standings: denied,
  };
}
