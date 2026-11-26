import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Action, Observation } from "@agentfall/contracts";
import { createRun } from "@agentfall/engine";
import { credentialHash } from "../auth";
import { createHttpApp } from "../http/app";
import {
  type D1Database,
  type D1PreparedStatement,
  D1Seasons,
  DAILY_CAPACITY,
} from "../persistence";
import { D1McpGameplay } from "./gameplay";
import { createAgentfallMcpHandler, type McpGameplay } from "./server";

describe("MCP server", () => {
  test("the stateless handler advertises the compact, annotated gameplay tools", async () => {
    const handler = createAgentfallMcpHandler();
    const listed = await mcpRequest(handler, 1, "tools/list", {});
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
    const response = await mcpRequest(createAgentfallMcpHandler(), 2, "tools/call", {
      name: "floor_observation",
      arguments: { floorSessionId: "guessed-session" },
    });
    expect(response.result.content).toEqual([{ type: "text", text: '{"code":"AUTH_REQUIRED"}' }]);
    expect(response.result.isError).toBe(true);
  });

  test("read-only tools validate inputs and return the supplied safe result", async () => {
    const gameplay: McpGameplay = {
      startFloor: async () => ({}),
      observeFloor: async () => ({}),
      submitAction: async () => ({}),
      currentCharacter: async () => ({ schemaVersion: 1, status: "living" }),
      journal: async () => ({}),
      abandonFloor: async () => ({}),
      endFloor: async () => ({}),
      season: async () => ({}),
      standings: async () => ({}),
    };
    const handler = createAgentfallMcpHandler(gameplay);
    const valid = await mcpRequest(handler, 3, "tools/call", {
      name: "character_get",
      arguments: {},
    });
    expect(valid.result.structuredContent).toEqual({ schemaVersion: 1, status: "living" });

    const malformed = await mcpRequest(handler, 4, "tools/call", {
      name: "journal_get",
      arguments: { limit: 0 },
    });
    expect(malformed.result.isError).toBe(true);
  });

  test("read-only gameplay operations do not write credentials, sessions, or snapshots", async () => {
    const database = new ReadOnlyD1();
    const gameplay = new D1McpGameplay(database, "Bearer safe-test-token");

    expect(await gameplay.observeFloor({ floorSessionId: "session-1" })).toMatchObject({
      code: "NOT_FOUND",
      schemaVersion: 1,
    });
    expect(await gameplay.currentCharacter()).toMatchObject({
      id: "character-1",
      schemaVersion: 1,
    });
    expect(await gameplay.journal({ limit: 25 })).toEqual({ entries: [], schemaVersion: 1 });
    const activeSeason = await gameplay.season({});
    expect(activeSeason).toMatchObject({ id: "season-1", state: "active" });
    expect(activeSeason).not.toHaveProperty("seed");
    expect(await gameplay.standings({ limit: 25 })).toEqual({
      schemaVersion: 1,
      seasonId: "season-1",
      entries: [
        {
          rank: 1,
          displayName: "Vanguard",
          bestFloor: 3,
          bossesDefeated: 0,
          characterDeaths: 1,
          floorTurns: 40,
          achievedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(database.batchCalls).toBe(0);
  });
});

describe("MCP floor-session mutations", () => {
  test("completes a ranked floor, enforces idempotency and exit lock, and advances to floor 2", async () => {
    const { database, clock, tokenA } = await setupMcpDatabase();
    const handler = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenA}`, "pepper", () => clock),
      );

    const started = await callTool(handler(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "start-1",
      strategy: "prioritize the objective",
    });
    expect(started.isError).toBe(false);
    expect(started.data).toMatchObject({
      schemaVersion: 1,
      accepted: true,
      replayed: false,
      mode: "ranked",
      floor: 1,
      snapshotVersion: 0,
      briefing: { floor: 1, strategy: "prioritize the objective" },
    });
    expect(started.data).not.toHaveProperty("seed");
    const sessionId = started.data.floorSessionId as string;

    // Retrying floor_start returns the exact original result without spending another charge.
    const replayedStart = await callTool(handler(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "start-1",
      strategy: "prioritize the objective",
    });
    expect(replayedStart.data).toMatchObject({
      accepted: true,
      replayed: true,
      floorSessionId: sessionId,
      floor: 1,
    });
    expect(chargesFor(database, "account-a")).toBe(2);

    // Reusing the same idempotency key with different arguments fails cleanly.
    const conflictedStart = await callTool(handler(), "floor_start", {
      mode: "practice",
      idempotencyKey: "start-1",
    });
    expect(conflictedStart.isError).toBe(true);
    expect(conflictedStart.data).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // Cannot end the floor before unlocking the exit.
    const earlyEnd = await callTool(handler(), "floor_end", {
      floorSessionId: sessionId,
      idempotencyKey: "end-early",
    });
    expect(earlyEnd.isError).toBe(true);
    expect(earlyEnd.data).toMatchObject({ code: "EXIT_LOCKED" });

    // Stale snapshotVersion is rejected without writing events.
    const stale = await callTool(handler(), "floor_action", {
      floorSessionId: sessionId,
      snapshotVersion: 99,
      idempotencyKey: "stale-act",
      action: { type: "move", direction: "east" },
    });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ code: "STALE_SNAPSHOT" });

    // Walk across the generated floor to collect the objective and unlock the exit.
    const storedSession = database.sqlite
      .query("SELECT snapshot_json FROM snapshots WHERE floor_session_id = ?")
      .get(sessionId) as { snapshot_json: string };
    const initialSnapshot = JSON.parse(storedSession.snapshot_json) as {
      tiles: Array<{ position: { x: number; y: number }; terrain: string }>;
      character: { position: { x: number; y: number } };
    };
    const objectiveTile = initialSnapshot.tiles.find((t) => t.terrain === "objective");
    const exitTile = initialSnapshot.tiles.find((t) => t.terrain === "exit");
    if (!objectiveTile || !exitTile) throw new Error("Missing objective or exit tile.");
    const objective = objectiveTile.position;
    const exit = exitTile.position;

    let version = 0;
    let currentObservation = started.data.observation as Observation;

    // Move along y=5 spine toward objective.x - 1, dealing with any enemies/traps or using deterministic path.
    const pathActions = planCorridorFloorCompletion(currentObservation, objective, exit);
    for (let index = 0; index < pathActions.length; index += 1) {
      const action = pathActions[index] as Action;
      const step = await callTool(handler(), "floor_action", {
        floorSessionId: sessionId,
        snapshotVersion: version,
        idempotencyKey: `step-${index}`,
        action,
      });
      expect(step.isError).toBe(false);
      expect(step.data).toMatchObject({
        accepted: true,
        replayed: false,
        outcome: "continued",
        snapshotVersion: version + 1,
      });
      version += 1;
      currentObservation = step.data.observation as Observation;
    }

    // Retry the last committed action idempotently; must not advance snapshotVersion or add events.
    const eventCountBeforeRetry = (
      database.sqlite
        .query("SELECT count(*) AS count FROM events WHERE floor_session_id = ?")
        .get(sessionId) as { count: number }
    ).count;
    const lastAction = pathActions[pathActions.length - 1];
    if (!lastAction) throw new Error("Expected at least one action.");
    const replayedAction = await callTool(handler(), "floor_action", {
      floorSessionId: sessionId,
      snapshotVersion: version - 1,
      idempotencyKey: `step-${pathActions.length - 1}`,
      action: lastAction,
    });
    expect(replayedAction.isError).toBe(false);
    expect(replayedAction.data).toMatchObject({
      accepted: true,
      replayed: true,
      outcome: "continued",
      snapshotVersion: version,
    });
    expect(
      (
        database.sqlite
          .query("SELECT count(*) AS count FROM events WHERE floor_session_id = ?")
          .get(sessionId) as { count: number }
      ).count,
    ).toBe(eventCountBeforeRetry);

    // End the unlocked floor and verify idempotent retry on floor_end.
    const ended = await callTool(handler(), "floor_end", {
      floorSessionId: sessionId,
      idempotencyKey: "end-1",
    });
    expect(ended.isError).toBe(false);
    expect(ended.data).toMatchObject({
      accepted: true,
      replayed: false,
      status: "completed",
      floor: 1,
      completedFloors: 1,
      nextFloor: 2,
    });

    const replayedEnd = await callTool(handler(), "floor_end", {
      floorSessionId: sessionId,
      idempotencyKey: "end-1",
    });
    expect(replayedEnd.isError).toBe(false);
    expect(replayedEnd.data).toMatchObject({
      accepted: true,
      replayed: true,
      status: "completed",
      completedFloors: 1,
      nextFloor: 2,
    });

    const journal = await callTool(handler(), "journal_get", { limit: 25 });
    expect((journal.data.entries as unknown[]).length).toBeGreaterThanOrEqual(1);
    const standings = await callTool(handler(), "standings_get", { limit: 10 });
    expect(standings.data.entries).toMatchObject([{ rank: 1, displayName: "Alpha", bestFloor: 1 }]);

    // Starting the next floor enters floor 2 and consumes a second charge.
    const floorTwo = await callTool(handler(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "start-2",
    });
    expect(floorTwo.isError).toBe(false);
    expect(floorTwo.data).toMatchObject({ accepted: true, floor: 2 });
    expect(chargesFor(database, "account-a")).toBe(1);
  });

  test("enforces authorization, ownership, enrollment, and capacity bounds", async () => {
    const { database, clock, tokenA, tokenB, tokenUnenrolled } = await setupMcpDatabase();
    const handlerA = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenA}`, "pepper", () => clock),
      );
    const handlerB = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenB}`, "pepper", () => clock),
      );
    const handlerUnenrolled = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenUnenrolled}`, "pepper", () => clock),
      );

    // Unenrolled account cannot start ranked, but can play practice without charges.
    const rankedDenied = await callTool(handlerUnenrolled(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "unenrolled-ranked",
    });
    expect(rankedDenied.isError).toBe(true);
    expect(rankedDenied.data).toMatchObject({ code: "RANKED_ENROLLMENT_REQUIRED" });

    const practiceOk = await callTool(handlerUnenrolled(), "floor_start", {
      mode: "practice",
      idempotencyKey: "unenrolled-practice",
    });
    expect(practiceOk.isError).toBe(false);
    expect(practiceOk.data).toMatchObject({ accepted: true, mode: "practice", floor: 1 });

    const startedA = await callTool(handlerA(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "a-start",
    });
    const sessionA = startedA.data.floorSessionId as string;

    // Account B cannot observe, act on, abandon, or end Account A's session.
    for (const [tool, args] of [
      ["floor_observation", { floorSessionId: sessionA }],
      [
        "floor_action",
        {
          floorSessionId: sessionA,
          snapshotVersion: 0,
          idempotencyKey: "hijack-act",
          action: { type: "end-turn" },
        },
      ],
      ["floor_abandon", { floorSessionId: sessionA, idempotencyKey: "hijack-abandon" }],
      ["floor_end", { floorSessionId: sessionA, idempotencyKey: "hijack-end" }],
    ] as const) {
      const denied = await callTool(handlerB(), tool, args as Record<string, unknown>);
      expect(denied.isError).toBe(true);
      expect(denied.data).toMatchObject({ code: "NOT_FOUND" });
    }

    // Revoked token is rejected.
    database.sqlite
      .query("UPDATE credentials SET revoked_at = ? WHERE id = 'cred-b'")
      .run(clock.toISOString());
    const revoked = await callTool(handlerB(), "floor_start", {
      mode: "practice",
      idempotencyKey: "revoked-start",
    });
    expect(revoked.isError).toBe(true);
    expect(revoked.data).toMatchObject({ code: "AUTH_REQUIRED" });

    // Exhausted practice headroom returns typed CAPACITY_EXHAUSTED with UTC resetAt.
    const day = clock.toISOString().slice(0, 10);
    database.sqlite
      .query(
        `INSERT INTO daily_capacity (day_utc, writes_reserved, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(day_utc) DO UPDATE SET writes_reserved = excluded.writes_reserved`,
      )
      .run(day, DAILY_CAPACITY.writes - DAILY_CAPACITY.rankedWriteHeadroom, clock.toISOString());
    const shedPractice = await callTool(handlerA(), "floor_start", {
      mode: "practice",
      idempotencyKey: "a-practice-shed",
    });
    expect(shedPractice.isError).toBe(true);
    expect(shedPractice.data).toMatchObject({
      code: "CAPACITY_EXHAUSTED",
      resetAt: "2026-10-21T00:00:00.000Z",
    });
  });

  test("handles abandonment, turn-budget collapse, session expiry, and permanent death rollbacks", async () => {
    const { database, clock, tokenA, tokenB } = await setupMcpDatabase();
    const handlerA = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenA}`, "pepper", () => clock),
      );
    const handlerB = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenB}`, "pepper", () => clock),
      );

    // 1. Voluntary abandonment rolls back state and preserves spent charge.
    const s1 = await callTool(handlerA(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "abandon-start",
    });
    const session1 = s1.data.floorSessionId as string;
    const preCharacter = await callTool(handlerA(), "character_get", {});
    const moved = await callTool(handlerA(), "floor_action", {
      floorSessionId: session1,
      snapshotVersion: 0,
      idempotencyKey: "move-before-abandon",
      action: { type: "end-turn" },
    });
    expect(moved.isError).toBe(false);

    const abandoned = await callTool(handlerA(), "floor_abandon", {
      floorSessionId: session1,
      idempotencyKey: "abandon-1",
    });
    expect(abandoned.isError).toBe(false);
    expect(abandoned.data).toMatchObject({ accepted: true, replayed: false, status: "abandoned" });
    expect(
      await callTool(handlerA(), "floor_abandon", {
        floorSessionId: session1,
        idempotencyKey: "abandon-1",
      }),
    ).toMatchObject({ data: { accepted: true, replayed: true, status: "abandoned" } });
    expect(chargesFor(database, "account-a")).toBe(2);
    expect((await callTool(handlerA(), "character_get", {})).data).toEqual(preCharacter.data);

    // 2. Turn-budget collapse rolls back and replays collapse outcome on retry.
    const s2 = await callTool(handlerA(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "collapse-start",
    });
    const session2 = s2.data.floorSessionId as string;
    // Lower turnBudget to 1 in the run state to verify deterministic turn-budget collapse.
    const runRow = database.sqlite
      .query("SELECT id, state_json FROM runs WHERE account_id = 'account-a' AND mode = 'ranked'")
      .get() as { id: string; state_json: string };
    const runObj = JSON.parse(runRow.state_json);
    runObj.activeFloor.turnBudget = 1;
    database.sqlite
      .query("UPDATE runs SET state_json = ? WHERE id = ?")
      .run(JSON.stringify(runObj), runRow.id);

    const collapsed = await callTool(handlerA(), "floor_action", {
      floorSessionId: session2,
      snapshotVersion: 0,
      idempotencyKey: "collapse-turn",
      action: { type: "end-turn" },
    });
    expect(collapsed.isError).toBe(false);
    expect(collapsed.data).toMatchObject({
      accepted: true,
      replayed: false,
      outcome: "collapsed",
    });
    const collapsedReplay = await callTool(handlerA(), "floor_action", {
      floorSessionId: session2,
      snapshotVersion: 0,
      idempotencyKey: "collapse-turn",
      action: { type: "end-turn" },
    });
    expect(collapsedReplay.data).toMatchObject({
      accepted: true,
      replayed: true,
      outcome: "collapsed",
    });
    expect((await callTool(handlerA(), "journal_get", { limit: 10 })).data.entries).toMatchObject([
      { kind: "fact", payload: { kind: "death", floor: 1, cause: "floor-timed-out" } },
    ]);

    // 3. Permanent death commits death, replays death outcome, and restarts sequence 2 at floor 1.
    const s3 = await callTool(handlerA(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "death-start",
    });
    const session3 = s3.data.floorSessionId as string;
    // Place a lethal trap directly east of the character in the active snapshot.
    const snapRow = database.sqlite
      .query("SELECT snapshot_json FROM snapshots WHERE floor_session_id = ?")
      .get(session3) as { snapshot_json: string };
    const snap = JSON.parse(snapRow.snapshot_json);
    const eastTile = { x: snap.character.position.x + 1, y: snap.character.position.y };
    const rebuilt = createRun({
      seed: snap.seed,
      runId: snap.runId,
      rulesetVersion: snap.rulesetVersion,
      generatorVersion: snap.generatorVersion,
      board: snap.board,
      tiles: snap.tiles.map((t: { position: { x: number; y: number }; terrain: string }) =>
        t.position.x === eastTile.x && t.position.y === eastTile.y
          ? { position: eastTile, terrain: "floor" }
          : t,
      ),
      objects: [{ id: "lethal-trap", type: "trap", position: eastTile, damage: 999 }],
      character: snap.character,
      enemies: [],
    });
    if (!rebuilt.accepted) throw new Error("Failed to build lethal fixture.");
    database.sqlite
      .query("UPDATE snapshots SET snapshot_json = ?, checksum = ? WHERE floor_session_id = ?")
      .run(JSON.stringify(rebuilt.snapshot), rebuilt.snapshot.checksum, session3);

    const died = await callTool(handlerA(), "floor_action", {
      floorSessionId: session3,
      snapshotVersion: 0,
      idempotencyKey: "lethal-move",
      action: { type: "move", direction: "east" },
    });
    expect(died.isError).toBe(false);
    expect(died.data).toMatchObject({ accepted: true, replayed: false, outcome: "died" });

    const diedReplay = await callTool(handlerA(), "floor_action", {
      floorSessionId: session3,
      snapshotVersion: 0,
      idempotencyKey: "lethal-move",
      action: { type: "move", direction: "east" },
    });
    expect(diedReplay.data).toMatchObject({ accepted: true, replayed: true, outcome: "died" });
    expect((await callTool(handlerA(), "character_get", {})).data).toMatchObject({
      sequence: 1,
      status: "dead",
    });

    // Advance 4 hours so Account A regenerates 1 charge, then start with replacement character #2.
    clock.setTime(clock.getTime() + 4 * 60 * 60 * 1000);
    const restarted = await callTool(handlerA(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "post-death-start",
    });
    expect(restarted.isError).toBe(false);
    expect(restarted.data).toMatchObject({ accepted: true, floor: 1 });
    expect((await callTool(handlerA(), "character_get", {})).data).toMatchObject({
      sequence: 2,
      status: "living",
    });

    // 4. Session expiry after 24 hours returns SESSION_EXPIRED and rolls back without charge refund.
    const sb = await callTool(handlerB(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "b-expiry-start",
    });
    const sessionB = sb.data.floorSessionId as string;
    clock.setTime(clock.getTime() + 24 * 60 * 60 * 1000 + 1000);
    const expiredCall = await callTool(handlerB(), "floor_abandon", {
      floorSessionId: sessionB,
      idempotencyKey: "b-abandon-after-expiry",
    });
    expect(expiredCall.isError).toBe(true);
    expect(expiredCall.data).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(chargesFor(database, "account-b")).toBe(2);
  });

  test("routes mutating MCP calls over HTTP /mcp with bearer authentication", async () => {
    const { database, tokenA } = await setupMcpDatabase();
    const app = createHttpApp();
    const env = {
      DB: database,
      CREDENTIAL_HASH_PEPPER: "pepper",
      RELEASE_VERSION: "test",
    } as unknown as Env;

    const response = await app.fetch(
      new Request("https://agentfall.test/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-03-26",
          authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "floor_start",
            arguments: { mode: "practice", idempotencyKey: "http-practice-start" },
          },
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const payload = (await response.text()).replace(/^event: message\ndata: /, "").trim();
    const parsed = JSON.parse(payload) as {
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    };
    expect(parsed.result.isError).toBe(false);
    expect(parsed.result.structuredContent).toMatchObject({
      accepted: true,
      mode: "practice",
      floor: 1,
    });
  });

  test("handles same-millisecond concurrent end/abandon races, snapshotVersion conflicts, paused rejections, and post-24h status", async () => {
    const { database, clock, tokenA } = await setupMcpDatabase();
    const handler = () =>
      createAgentfallMcpHandler(
        new D1McpGameplay(database, `Bearer ${tokenA}`, "pepper", () => clock),
      );

    // 1. Paused session stays paused when floor_action is rejected with stale snapshotVersion.
    const started = await callTool(handler(), "floor_start", {
      mode: "ranked",
      idempotencyKey: "race-start",
    });
    const sessionId = started.data.floorSessionId as string;
    database.sqlite
      .query("UPDATE floor_sessions SET status = 'paused' WHERE id = ?")
      .run(sessionId);
    const staleOnPaused = await callTool(handler(), "floor_action", {
      floorSessionId: sessionId,
      snapshotVersion: 99,
      idempotencyKey: "paused-stale",
      action: { type: "end-turn" },
    });
    expect(staleOnPaused.data).toMatchObject({ code: "STALE_SNAPSHOT" });
    expect(
      (
        database.sqlite.query("SELECT status FROM floor_sessions WHERE id = ?").get(sessionId) as {
          status: string;
        }
      ).status,
    ).toBe("paused");

    // 2. Reusing action idempotencyKey with a different snapshotVersion returns IDEMPOTENCY_CONFLICT.
    const validAct = await callTool(handler(), "floor_action", {
      floorSessionId: sessionId,
      snapshotVersion: 0,
      idempotencyKey: "act-versioned",
      action: { type: "end-turn" },
    });
    expect(validAct.data).toMatchObject({ accepted: true, snapshotVersion: 1 });
    const conflictAct = await callTool(handler(), "floor_action", {
      floorSessionId: sessionId,
      snapshotVersion: 1,
      idempotencyKey: "act-versioned",
      action: { type: "end-turn" },
    });
    expect(conflictAct.data).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // 3. Complete floor and test same-millisecond floor_end race with different and identical keys.
    const snapRow = database.sqlite
      .query("SELECT snapshot_json FROM snapshots WHERE floor_session_id = ?")
      .get(sessionId) as { snapshot_json: string };
    const snap = JSON.parse(snapRow.snapshot_json);
    const objective = snap.tiles.find(
      (t: { terrain: string }) => t.terrain === "objective",
    ).position;
    const exit = snap.tiles.find((t: { terrain: string }) => t.terrain === "exit").position;
    const steps = planCorridorFloorCompletion(
      validAct.data.observation as Observation,
      objective,
      exit,
    );
    let version = 1;
    for (let i = 0; i < steps.length; i += 1) {
      const res = await callTool(handler(), "floor_action", {
        floorSessionId: sessionId,
        snapshotVersion: version,
        idempotencyKey: `race-walk-${i}`,
        action: steps[i] as Action,
      });
      expect(res.isError).toBe(false);
      version += 1;
    }

    const end1 = await callTool(handler(), "floor_end", {
      floorSessionId: sessionId,
      idempotencyKey: "end-race-1",
    });
    expect(end1.data).toMatchObject({ accepted: true, replayed: false, status: "completed" });
    const journalCountAfterEnd1 = (
      database.sqlite
        .query("SELECT count(*) AS count FROM journals WHERE account_id = 'account-a'")
        .get() as { count: number }
    ).count;

    // Different key on already-completed session in the same millisecond must fail cleanly without duplicating rows.
    const end2 = await callTool(handler(), "floor_end", {
      floorSessionId: sessionId,
      idempotencyKey: "end-race-2",
    });
    expect(end2.isError).toBe(true);
    expect(end2.data).toMatchObject({ code: "SESSION_UNAVAILABLE" });
    expect(
      (
        database.sqlite
          .query("SELECT count(*) AS count FROM journals WHERE account_id = 'account-a'")
          .get() as { count: number }
      ).count,
    ).toBe(journalCountAfterEnd1);

    // Same key replays cleanly.
    const end1Replay = await callTool(handler(), "floor_end", {
      floorSessionId: sessionId,
      idempotencyKey: "end-race-1",
    });
    expect(end1Replay.data).toMatchObject({ accepted: true, replayed: true, status: "completed" });

    // 4. After 24h, completed session remains SESSION_UNAVAILABLE (not SESSION_EXPIRED).
    clock.setTime(clock.getTime() + 25 * 60 * 60 * 1000);
    const post24hObserve = await callTool(handler(), "floor_observation", {
      floorSessionId: sessionId,
    });
    expect(post24hObserve.data).toMatchObject({ code: "SESSION_UNAVAILABLE" });
  });
});

/** Walks the generated linear spine to collect the objective and unlock the exit. */
function planCorridorFloorCompletion(
  observation: Observation,
  objective: { x: number; y: number },
  exit: { x: number; y: number },
): Action[] {
  const actions: Action[] = [];
  let pos = { ...observation.character.position };
  let ap = observation.actionPoints;
  const pushWithTurnBudget = (action: Action, cost: number) => {
    if (ap < cost) {
      actions.push({ type: "end-turn" });
      ap = 4;
    }
    actions.push(action);
    ap -= cost;
  };
  const walkTo = (target: { x: number; y: number }) => {
    while (pos.x < target.x) {
      pushWithTurnBudget({ type: "move", direction: "east" }, 1);
      pos = { x: pos.x + 1, y: pos.y };
    }
    while (pos.y < target.y) {
      pushWithTurnBudget({ type: "move", direction: "south" }, 1);
      pos = { x: pos.x, y: pos.y + 1 };
    }
    while (pos.y > target.y) {
      pushWithTurnBudget({ type: "move", direction: "north" }, 1);
      pos = { x: pos.x, y: pos.y - 1 };
    }
  };
  walkTo({ x: objective.x - 1, y: objective.y });
  pushWithTurnBudget({ type: "interact", target: objective }, 1);
  walkTo({ x: exit.x - 1, y: exit.y });
  pushWithTurnBudget({ type: "interact", target: exit }, 1);
  return actions;
}

function chargesFor(database: TestD1, accountId: string): number {
  const row = database.sqlite
    .query("SELECT available FROM charges WHERE account_id = ?")
    .get(accountId) as { available: number };
  return row.available;
}

async function callTool(
  handler: ReturnType<typeof createAgentfallMcpHandler>,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await mcpRequest(handler, 1, "tools/call", { name, arguments: args });
  return {
    isError: Boolean(response.result.isError),
    data: response.result.structuredContent as Record<string, unknown>,
  };
}

async function mcpRequest(
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

async function setupMcpDatabase() {
  const database = new TestD1();
  for (const migration of [
    "0000_initial.sql",
    "0001_authentication.sql",
    "0001_rate_limits.sql",
    "0002_expedition_sessions.sql",
    "0003_season_lifecycle.sql",
    "0004_season_tower.sql",
    "0005_freeze_active_season_versions.sql",
    "0006_capacity_safety.sql",
  ]) {
    database.sqlite.exec(
      await Bun.file(new URL(`../../migrations/${migration}`, import.meta.url)).text(),
    );
  }
  const clock = new Date("2026-10-20T12:00:00.000Z");
  const now = clock.toISOString();
  const seasons = new D1Seasons(database);
  const seed = "season-zero-secret-seed";
  await seasons.createDraft({
    id: "season-zero",
    rulesetVersion: "season-zero-rules-1",
    generatorVersion: "floor-generator-1",
    contentVersion: "orc-siege-1",
    now,
  });
  await seasons.generateTower({ id: "season-zero", now, seed });
  // Ensure generated floors have clear corridor paths for deterministic completion test
  await seasons.advance({ id: "season-zero", to: "validated", now });
  await seasons.advance({ id: "season-zero", to: "published", now, seed });
  await seasons.advance({ id: "season-zero", to: "active", now });
  // Replace floor 1 enemies with empty list in tower_json so corridor traversal doesn't get blocked by an enemy
  const towerRow = database.sqlite
    .query("SELECT tower_json FROM seasons WHERE id = 'season-zero'")
    .get() as {
    tower_json: string;
  };
  const tower = JSON.parse(towerRow.tower_json);
  tower[0].definition.enemies = [];
  database.sqlite
    .query("UPDATE seasons SET tower_json = ? WHERE id = 'season-zero'")
    .run(JSON.stringify(tower));

  database.sqlite
    .query(
      `INSERT INTO accounts (id, github_user_id, display_name, ranked_enrolled_at, created_at)
       VALUES ('account-a', '101', 'Alpha', ?, ?),
              ('account-b', '102', 'Beta', ?, ?),
              ('account-c', '103', NULL, NULL, ?)`,
    )
    .run(now, now, now, now, now);

  const tokenA = "af_token_alpha";
  const tokenB = "af_token_beta";
  const tokenUnenrolled = "af_token_unenrolled";
  for (const [id, accountId, token] of [
    ["cred-a", "account-a", tokenA],
    ["cred-b", "account-b", tokenB],
    ["cred-c", "account-c", tokenUnenrolled],
  ] as const) {
    database.sqlite
      .query("INSERT INTO credentials (id, account_id, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, accountId, await credentialHash(token, "pepper"), now);
  }
  return { database, clock, tokenA, tokenB, tokenUnenrolled };
}

type RunnableStatement = D1PreparedStatement & { run(): unknown };
class TestD1 implements D1Database {
  readonly sqlite = new Database(":memory:");
  prepare(query: string): RunnableStatement {
    let values: unknown[] = [];
    const sqlite = this.sqlite;
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>() {
        return (sqlite.query(query).get(...(values as never[])) as T | null) ?? null;
      },
      async all<T>() {
        return { results: sqlite.query(query).all(...(values as never[])) as T[] };
      },
      run: () => sqlite.query(query).run(...(values as never[])),
    };
    return statement;
  }
  async batch(statements: D1PreparedStatement[]) {
    return this.sqlite.transaction(() =>
      statements.map((statement) => {
        const result = (statement as RunnableStatement).run() as { changes?: number };
        return { meta: { changes: result.changes } };
      }),
    )();
  }
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
      all: async <T>() => ({
        results: (query.includes("FROM standings")
          ? [
              {
                account_id: "private-account-id",
                display_name: "Vanguard",
                best_floor: 3,
                bosses_defeated: 0,
                character_deaths: 1,
                floor_turns: 40,
                achieved_at: "2026-01-01T00:00:00.000Z",
              },
            ]
          : []) as T[],
      }),
    };
    return statement;
  }

  async batch(): Promise<Array<{ meta?: { changes?: number } }>> {
    this.batchCalls += 1;
    return [];
  }
}
