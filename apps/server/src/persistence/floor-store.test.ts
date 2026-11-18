import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createRun, type RunDefinition } from "@agentfall/engine";

import { type D1Database, D1FloorStore, type D1PreparedStatement } from "./floor-store";

const definition: RunDefinition = {
  seed: "persistence-seed",
  runId: "run-1",
  rulesetVersion: "rules-1",
  generatorVersion: "generator-1",
  board: { width: 3, height: 1 },
  tiles: [
    { position: { x: 0, y: 0 }, terrain: "entrance" },
    { position: { x: 1, y: 0 }, terrain: "objective" },
    { position: { x: 2, y: 0 }, terrain: "exit" },
  ],
  objects: [],
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
  enemies: [],
};

describe("D1 floor persistence", () => {
  test("commits one event and snapshot, then serves an idempotent retry", async () => {
    const database = await seededDatabase();
    const store = new D1FloorStore(database);
    const first = await store.commitAction({
      floorSessionId: "session-1",
      idempotencyKey: "mutation-1",
      expectedSnapshotVersion: 0,
      action: { type: "move", direction: "east" },
      now: "2026-10-18T00:00:00.000Z",
    });
    expect(first).toMatchObject({ accepted: true, replayed: false, version: 1 });
    if (!first.accepted) throw new Error("Expected accepted mutation");
    expect(first.snapshot.character.position).toEqual({ x: 1, y: 0 });

    const retry = await store.commitAction({
      floorSessionId: "session-1",
      idempotencyKey: "mutation-1",
      expectedSnapshotVersion: 0,
      action: { type: "move", direction: "east" },
      now: "2026-10-18T00:01:00.000Z",
    });
    expect(retry).toMatchObject({
      accepted: true,
      replayed: true,
      version: 1,
      snapshot: first.snapshot,
    });
    expect(await store.verifyReplay("session-1")).toEqual({
      valid: true,
      eventCount: 1,
      checksum: first.snapshot.checksum,
    });
  });

  test("rejects stale and invalid mutations without creating an event", async () => {
    const database = await seededDatabase();
    const store = new D1FloorStore(database);
    expect(
      await store.commitAction({
        floorSessionId: "session-1",
        idempotencyKey: "stale",
        expectedSnapshotVersion: 7,
        action: { type: "move", direction: "east" },
        now: "2026-10-18T00:00:00.000Z",
      }),
    ).toEqual({ accepted: false, reason: "stale-snapshot" });
    expect(
      await store.commitAction({
        floorSessionId: "session-1",
        idempotencyKey: "invalid",
        expectedSnapshotVersion: 0,
        action: { type: "move", direction: "north" },
        now: "2026-10-18T00:00:00.000Z",
      }),
    ).toEqual({ accepted: false, reason: "invalid-action" });
    expect(database.sqlite.query("SELECT count(*) AS count FROM events").get()).toEqual({
      count: 0,
    });
    expect((await store.loadSnapshot("session-1"))?.version).toBe(0);
  });
});

async function seededDatabase(): Promise<TestD1> {
  const database = new TestD1();
  database.sqlite.exec(
    await Bun.file(new URL("../../migrations/0000_initial.sql", import.meta.url)).text(),
  );
  const initial = createRun(definition);
  if (!initial.accepted) throw new Error("Fixture must be valid.");
  const now = "2026-10-18T00:00:00.000Z";
  database.sqlite
    .query("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)")
    .run("account-1", "1", null, null, now, null);
  database.sqlite
    .query("INSERT INTO seasons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "season-1",
      "active",
      "rules-1",
      "generator-1",
      "content-1",
      null,
      null,
      "active",
      now,
      null,
    );
  database.sqlite
    .query("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("run-1", "account-1", "season-1", null, "ranked", "active", "{}", now, null);
  database.sqlite
    .query("INSERT INTO floor_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      "session-1",
      "run-1",
      1,
      "active",
      JSON.stringify(definition),
      "2026-10-19T00:00:00.000Z",
      now,
      null,
    );
  database.sqlite
    .query("INSERT INTO snapshots VALUES (?, ?, ?, ?, ?)")
    .run("session-1", 0, initial.snapshot.checksum, JSON.stringify(initial.snapshot), now);
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

  async batch(statements: D1PreparedStatement[]): Promise<Array<{ meta?: { changes?: number } }>> {
    return this.sqlite.transaction(() =>
      statements.map((statement) => {
        const result = (statement as RunnableStatement).run() as { changes?: number };
        return { meta: { changes: result.changes } };
      }),
    )();
  }
}
