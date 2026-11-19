import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createExpeditionRun, createRun, type RunDefinition, startFloor } from "@agentfall/engine";
import { D1CapacityBudget, DAILY_CAPACITY } from "./capacity";
import { D1ExpeditionSessions } from "./expedition-sessions";
import type { D1Database, D1PreparedStatement } from "./floor-store";

const definition: RunDefinition = {
  seed: "session-seed",
  runId: "run",
  rulesetVersion: "r",
  generatorVersion: "g",
  board: { width: 3, height: 1 },
  tiles: [
    { position: { x: 0, y: 0 }, terrain: "entrance" },
    { position: { x: 1, y: 0 }, terrain: "objective" },
    { position: { x: 2, y: 0 }, terrain: "exit" },
  ],
  objects: [],
  enemies: [],
  character: {
    position: { x: 0, y: 0 },
    health: 5,
    maxHealth: 5,
    defense: 0,
    movement: 1,
    accuracy: 0,
    power: 0,
    focus: 0,
  },
};

describe("expedition charges and sessions", () => {
  test("reserves a conservative full-floor allowance and sheds practice before ranked", async () => {
    const database = await databaseForSessions();
    const capacity = new D1CapacityBudget(database);
    const now = new Date("2026-10-20T12:00:00.000Z");
    const day = now.toISOString().slice(0, 10);
    database.sqlite
      .query("INSERT INTO daily_capacity (day_utc, writes_reserved, updated_at) VALUES (?, ?, ?)")
      .run(day, DAILY_CAPACITY.writes - DAILY_CAPACITY.rankedWriteHeadroom, now.toISOString());

    await expect(capacity.reserve("practice-capacity", "practice", now)).resolves.toMatchObject({
      accepted: false,
      reason: "capacity-exhausted",
      resetAt: "2026-10-21T00:00:00.000Z",
    });
    await expect(capacity.reserve("ranked-capacity", "ranked", now)).resolves.toEqual({
      accepted: true,
    });
    expect(await capacity.usage(now)).toMatchObject({
      writes_reserved: DAILY_CAPACITY.writes - DAILY_CAPACITY.rankedWriteHeadroom + 2_000,
      ranked_writes_reserved: 2_000,
    });
  });

  test("does not reserve capacity for a rejected no-charge or already-open start", async () => {
    const database = await databaseForSessions();
    const sessions = new D1ExpeditionSessions(database);
    const now = new Date("2026-10-20T12:00:00.000Z");
    await sessions.charges("account-1", now);
    database.sqlite.query("UPDATE charges SET available = 0 WHERE account_id = ?").run("account-1");
    await expect(
      sessions.start({
        accountId: "account-1",
        runId: "ranked-run",
        sessionId: "no-charge-session",
        mode: "ranked",
        floor: 1,
        definition,
        snapshot: validSnapshot(),
        now,
      }),
    ).resolves.toEqual({ accepted: false, reason: "no-charge" });
    expect(await new D1CapacityBudget(database).usage(now)).toBeNull();
  });

  test("fails closed when persisting an admission reservation fails", async () => {
    const database = await databaseForSessions();
    // The third capacity batch records the reservation after the conservative
    // ledger increment, modelling an interrupted D1 write.
    const sessions = new D1ExpeditionSessions(new FailingBatchD1(database, 3));
    const now = new Date("2026-10-20T12:00:00.000Z");
    await expect(
      sessions.start({
        accountId: "account-1",
        runId: "practice-run",
        sessionId: "persistence-failure-session",
        mode: "practice",
        floor: 1,
        definition,
        snapshot: validSnapshot(),
        now,
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: "capacity-exhausted",
      resetAt: "2026-10-21T00:00:00.000Z",
    });
    expect(database.sqlite.query("SELECT count(*) AS count FROM floor_sessions").get()).toEqual({
      count: 0,
    });
    expect(await new D1CapacityBudget(database).usage(now)).toMatchObject({
      writes_reserved: DAILY_CAPACITY.perFloor.writes,
    });
  });

  test("regenerates lazily, pauses at cap, and consumes a ranked start exactly once", async () => {
    const database = await databaseForSessions();
    const sessions = new D1ExpeditionSessions(database);
    const start = new Date("2026-10-20T00:00:00.000Z");
    expect(await sessions.charges("account-1", start)).toEqual({
      available: 3,
      calculatedAt: start.toISOString(),
    });
    database.sqlite
      .query("UPDATE charges SET available = 1, calculated_at = ? WHERE account_id = ?")
      .run(start.toISOString(), "account-1");
    expect(await sessions.charges("account-1", new Date("2026-10-20T08:00:00.000Z"))).toMatchObject(
      { available: 3 },
    );
    const atCap = database.sqlite
      .query("SELECT calculated_at FROM charges WHERE account_id = ?")
      .get("account-1") as { calculated_at: string };
    expect(atCap.calculated_at).toBe("2026-10-20T08:00:00.000Z");

    const snapshot = validSnapshot();
    const begun = await sessions.start({
      accountId: "account-1",
      runId: "ranked-run",
      sessionId: "ranked-session",
      mode: "ranked",
      floor: 1,
      definition,
      snapshot,
      now: new Date("2026-10-20T08:01:00.000Z"),
    });
    expect(begun.accepted).toBe(true);
    expect(await sessions.charges("account-1", new Date("2026-10-20T08:01:00.000Z"))).toMatchObject(
      { available: 2 },
    );
    expect(
      (
        await sessions.start({
          accountId: "account-1",
          runId: "ranked-run",
          sessionId: "another",
          mode: "ranked",
          floor: 1,
          definition,
          snapshot,
          now: new Date("2026-10-20T08:02:00.000Z"),
        })
      ).accepted,
    ).toBe(false);
    expect(await sessions.charges("account-1", new Date("2026-10-20T08:02:00.000Z"))).toMatchObject(
      { available: 2 },
    );
    expect(
      await sessions.awardBossCharge("account-1", new Date("2026-10-20T08:03:00.000Z")),
    ).toMatchObject({ available: 3 });
    expect(
      await sessions.awardBossCharge("account-1", new Date("2026-10-20T08:04:00.000Z")),
    ).toMatchObject({ available: 3 });
  });

  test("limits practice independently and permits a paused session to resume before expiry", async () => {
    const database = await databaseForSessions();
    const sessions = new D1ExpeditionSessions(database);
    const snapshot = validSnapshot();
    const start = new Date("2026-10-20T00:00:00.000Z");
    expect(
      (
        await sessions.start({
          accountId: "account-1",
          runId: "practice-run",
          sessionId: "practice-session",
          mode: "practice",
          floor: 1,
          definition,
          snapshot,
          now: start,
        })
      ).accepted,
    ).toBe(true);
    expect(await sessions.pauseIdle(new Date("2026-10-20T00:10:00.000Z"))).toBe(1);
    expect(
      await sessions.resume("account-1", "practice-session", new Date("2026-10-20T00:11:00.000Z")),
    ).toBe("resumed");
    expect(
      await sessions.recordStateChange(
        "account-1",
        "practice-session",
        new Date("2026-10-20T00:11:00.000Z"),
      ),
    ).toBe(true);
  });

  test("expires a session by rolling its persisted run back without refunding its charge", async () => {
    const database = await databaseForSessions();
    const sessions = new D1ExpeditionSessions(database);
    const start = new Date("2026-10-20T00:00:00.000Z");
    const begun = startFloor(createExpeditionRun("ranked-run", "season", 2), definition, 1, 20);
    if (!begun.accepted) throw new Error("Expected fixture run to start.");
    const activeFloor = begun.run.activeFloor;
    if (!activeFloor) throw new Error("Expected fixture floor to be active.");
    database.sqlite
      .query("UPDATE runs SET state_json = ? WHERE id = ?")
      .run(JSON.stringify(begun.run), "ranked-run");
    expect(
      await sessions.start({
        accountId: "account-1",
        runId: "ranked-run",
        sessionId: "expired-session",
        mode: "ranked",
        floor: 1,
        definition,
        snapshot: activeFloor.snapshot,
        now: start,
      }),
    ).toMatchObject({ accepted: true });

    expect(await sessions.abandonExpired(new Date("2026-10-21T00:00:00.000Z"))).toBe(1);
    const session = database.sqlite
      .query("SELECT status FROM floor_sessions WHERE id = ?")
      .get("expired-session") as { status: string };
    expect(session.status).toBe("expired");
    const persisted = database.sqlite
      .query("SELECT state_json FROM runs WHERE id = ?")
      .get("ranked-run") as { state_json: string };
    const run = JSON.parse(persisted.state_json);
    expect(run).toMatchObject({ expeditionCharges: 1, activeFloor: null });
    expect(run.character).toEqual(activeFloor.preFloorCharacter);
  });

  test("cleans up an expired session before allowing a new session to start", async () => {
    const database = await databaseForSessions();
    const sessions = new D1ExpeditionSessions(database);
    const first = new Date("2026-10-20T00:00:00.000Z");
    const begun = startFloor(createExpeditionRun("ranked-run", "season", 3), definition, 1, 20);
    if (!begun.accepted) throw new Error("Expected fixture run to start.");
    const activeFloor = begun.run.activeFloor;
    if (!activeFloor) throw new Error("Expected fixture floor to be active.");
    database.sqlite
      .query("UPDATE runs SET state_json = ? WHERE id = ?")
      .run(JSON.stringify(begun.run), "ranked-run");
    await sessions.start({
      accountId: "account-1",
      runId: "ranked-run",
      sessionId: "old-session",
      mode: "ranked",
      floor: 1,
      definition,
      snapshot: activeFloor.snapshot,
      now: first,
    });
    expect(
      await sessions.start({
        accountId: "account-1",
        runId: "ranked-run",
        sessionId: "new-session",
        mode: "ranked",
        floor: 1,
        definition,
        snapshot: activeFloor.snapshot,
        now: new Date("2026-10-21T00:00:00.000Z"),
      }),
    ).toMatchObject({ accepted: true });
  });

  test("database constraints prevent a second living ranked character", async () => {
    const database = await databaseForSessions();
    const now = "2026-10-20T00:00:00.000Z";
    const insert = database.sqlite.query(
      "INSERT INTO characters (id, account_id, season_id, sequence, status, state_json, created_at) VALUES (?, 'account-1', 'season-1', ?, 'living', '{}', ?)",
    );
    insert.run("character-1", 1, now);
    expect(() => insert.run("character-2", 2, now)).toThrow();
  });
});

function validSnapshot() {
  const created = createRun(definition);
  if (!created.accepted) throw new Error("Fixture must be valid.");
  return created.snapshot;
}

async function databaseForSessions(): Promise<TestD1> {
  const database = new TestD1();
  for (const migration of [
    "0000_initial.sql",
    "0001_authentication.sql",
    "0002_expedition_sessions.sql",
    "0006_capacity_safety.sql",
  ])
    database.sqlite.exec(
      await Bun.file(new URL(`../../migrations/${migration}`, import.meta.url)).text(),
    );
  const now = "2026-10-20T00:00:00.000Z";
  database.sqlite
    .query("INSERT INTO accounts (id, github_user_id, created_at) VALUES (?, ?, ?)")
    .run("account-1", "1", now);
  database.sqlite
    .query(
      "INSERT INTO seasons (id, state, ruleset_version, generator_version, content_version, created_at) VALUES (?, 'active', 'r', 'g', 'c', ?)",
    )
    .run("season-1", now);
  database.sqlite
    .query(
      "INSERT INTO runs (id, account_id, season_id, mode, status, state_json, created_at) VALUES (?, 'account-1', 'season-1', ?, 'active', '{}', ?)",
    )
    .run("ranked-run", "ranked", now);
  database.sqlite
    .query(
      "INSERT INTO runs (id, account_id, season_id, mode, status, state_json, created_at) VALUES (?, 'account-1', 'season-1', ?, 'active', '{}', ?)",
    )
    .run("practice-run", "practice", now);
  return database;
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
      statements.map((statement) => ({
        meta: { changes: ((statement as RunnableStatement).run() as { changes?: number }).changes },
      })),
    )();
  }
}

class FailingBatchD1 implements D1Database {
  private batches = 0;

  constructor(
    private readonly delegate: D1Database,
    private readonly failingBatch: number,
  ) {}

  prepare(query: string) {
    return this.delegate.prepare(query);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.batches += 1;
    if (this.batches === this.failingBatch) throw new Error("D1 unavailable");
    return this.delegate.batch(statements);
  }
}
