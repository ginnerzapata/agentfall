import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { McpAuthenticationError } from "./gameplay";

const idempotencyKey = z.string().min(1).max(128);
const floorSessionId = z.string().min(1).max(128);
const position = z.object({ x: z.number().int(), y: z.number().int() });
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), direction: z.enum(["north", "east", "south", "west"]) }),
  z.object({ type: z.literal("scout"), direction: z.enum(["north", "east", "south", "west"]) }),
  z.object({ type: z.literal("attack"), targetId: z.string().min(1) }),
  z.object({ type: z.literal("shove"), targetId: z.string().min(1) }),
  z.object({ type: z.literal("disengaging-shot"), targetId: z.string().min(1) }),
  z.object({ type: z.literal("arc-bolt"), targetId: z.string().min(1) }),
  z.object({ type: z.literal("interact"), target: position }),
  z.object({ type: z.literal("open-door"), target: position }),
  z.object({ type: z.literal("close-door"), target: position }),
  z.object({ type: z.literal("drop-item"), slot: z.number().int().min(0) }),
  z.object({ type: z.literal("guard") }),
  z.object({ type: z.literal("ward") }),
  z.object({ type: z.literal("end-turn") }),
]);

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
    action: z.infer<typeof action>;
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
      inputSchema: z.object({
        mode: z.enum(["ranked", "practice"]),
        idempotencyKey,
        strategy: z.string().max(1_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.startFloor(input)),
  );
  server.registerTool(
    "floor_observation",
    {
      description: "Read the safe current floor view.",
      inputSchema: z.object({ floorSessionId }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => invoke(gameplay.observeFloor(input)),
  );
  server.registerTool(
    "floor_action",
    {
      description: "Commit one typed action.",
      inputSchema: z.object({
        floorSessionId,
        snapshotVersion: z.number().int().min(0),
        idempotencyKey,
        action,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.submitAction(input)),
  );
  server.registerTool(
    "character_get",
    { description: "Read the current character.", annotations: { readOnlyHint: true } },
    async () => invoke(gameplay.currentCharacter()),
  );
  server.registerTool(
    "journal_get",
    {
      description: "Read private Journal entries.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.journal(input)),
  );
  server.registerTool(
    "floor_abandon",
    {
      description: "Abandon a floor and discard its progress.",
      inputSchema: z.object({ floorSessionId, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) => invoke(gameplay.abandonFloor(input)),
  );
  server.registerTool(
    "floor_end",
    {
      description: "End an unlocked floor.",
      inputSchema: z.object({ floorSessionId, idempotencyKey }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => invoke(gameplay.endFloor(input)),
  );
  server.registerTool(
    "season_get",
    {
      description: "Read public season details.",
      inputSchema: z.object({ seasonId: z.string().min(1).max(128).optional() }),
      annotations: { readOnlyHint: true },
    },
    async (input) => invoke(gameplay.season(input)),
  );
  server.registerTool(
    "standings_get",
    {
      description: "Read season standings.",
      inputSchema: z.object({
        seasonId: z.string().min(1).max(128).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
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
    throw error;
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
