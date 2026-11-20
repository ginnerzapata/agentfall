import { expect, test } from "bun:test";

import type { D1Database, D1PreparedStatement } from "../persistence";
import { D1McpGameplay } from "./gameplay";
import { createAgentfallMcpHandler } from "./server";

test("the stateless handler advertises the compact, annotated gameplay tools", async () => {
  const handler = createAgentfallMcpHandler();
  const listed = await request(handler, 1, "tools/list", {});
  const tools = listed.result.tools as Array<{
    name: string;
    annotations?: Record<string, boolean>;
    inputSchema: { required?: string[] };
  }>;

  expect(tools.map((tool) => tool.name)).toEqual([
    "floor_start",
    "floor_observation",
    "floor_action",
    "character_get",
    "journal_get",
    "floor_abandon",
    "floor_end",
    "season_get",
    "standings_get",
  ]);
  for (const name of ["floor_start", "floor_action", "floor_abandon", "floor_end"]) {
    expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain(
      "idempotencyKey",
    );
  }
  expect(tools.find((tool) => tool.name === "floor_observation")?.annotations?.readOnlyHint).toBe(
    true,
  );
  expect(tools.find((tool) => tool.name === "floor_abandon")?.annotations?.destructiveHint).toBe(
    true,
  );
});

test("unauthenticated tool calls reveal no game state", async () => {
  const response = await request(createAgentfallMcpHandler(), 2, "tools/call", {
    name: "floor_observation",
    arguments: { floorSessionId: "guessed-session" },
  });
  expect(response.result.content).toEqual([{ type: "text", text: '{"code":"AUTH_REQUIRED"}' }]);
  expect(response.result.isError).toBe(true);
});

test("read-only gameplay operations do not write credentials, sessions, or snapshots", async () => {
  const database = new ReadOnlyD1();
  const gameplay = new D1McpGameplay(database, "Bearer safe-test-token");

  expect(await gameplay.observeFloor({ floorSessionId: "session-1" })).toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await gameplay.currentCharacter()).toMatchObject({ id: "character-1" });
  expect(await gameplay.journal({ limit: 25 })).toEqual({ entries: [] });
  expect(await gameplay.season({})).toMatchObject({ id: "season-1", state: "active" });
  expect(await gameplay.standings({ limit: 25 })).toEqual({ seasonId: "season-1", entries: [] });
  expect(database.batchCalls).toBe(0);
});

async function request(
  handler: ReturnType<typeof createAgentfallMcpHandler>,
  id: number,
  method: string,
  params: Record<string, unknown>,
) {
  const response = await handler.fetch(
    new Request("https://agentfall.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  expect(response.status).toBe(200);
  const payload = await response.text();
  const json = payload.replace(/^event: message\ndata: /, "").trim();
  return JSON.parse(json) as { result: Record<string, unknown> };
}

class ReadOnlyD1 implements D1Database {
  batchCalls = 0;

  prepare(query: string): D1PreparedStatement {
    const row = query.includes("FROM credentials")
      ? { account_id: "account-1" }
      : query.includes("FROM characters")
        ? { id: "character-1", sequence: 1, status: "living", state_json: "{}" }
        : query.includes("FROM seasons") && query.includes("state = 'active'")
          ? {
              id: "season-1",
              state: "active",
              ruleset_version: "r1",
              generator_version: "g1",
              content_version: "c1",
              seed_commitment: "commitment",
              revealed_seed: null,
            }
          : null;
    const statement = {
      bind: () => statement,
      first: async <T>() => row as T | null,
      all: async <T>() => ({ results: [] as T[] }),
    };
    return statement;
  }

  async batch(): Promise<Array<{ meta?: { changes?: number } }>> {
    this.batchCalls += 1;
    return [];
  }
}
