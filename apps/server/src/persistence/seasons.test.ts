import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { D1Database, D1PreparedStatement } from "./floor-store";
import { D1ReplayVisibility } from "./replay-visibility";
import { D1Seasons, seasonSeedCommitment } from "./seasons";
import { D1Standings } from "./standings";

describe("season lifecycle", () => {
  test("allows only the ordered lifecycle and publishes a verifiable seed commitment", async () => {
    const database = await databaseForSeasons();
    const seasons = new D1Seasons(database);
    const now = "2026-10-21T00:00:00.000Z";
    expect(
      await seasons.createDraft({
        id: "season-1",
        rulesetVersion: "rules-1",
        generatorVersion: "generator-1",
        contentVersion: "content-1",
        now,
      }),
    ).toBe(true);
    expect(await seasons.advance({ id: "season-1", to: "active", now })).toEqual({
      accepted: false,
      reason: "invalid-transition",
    });
    expect(await seasons.advance({ id: "season-1", to: "generated", now })).toEqual({
      accepted: true,
      state: "generated",
    });
    expect(await seasons.advance({ id: "season-1", to: "validated", now })).toEqual({
      accepted: false,
      reason: "invalid-tower",
    });
    // Return to a fresh draft to exercise the authoritative generation path.
    expect(
      await seasons.createDraft({
        id: "season-2",
        rulesetVersion: "rules-1",
        generatorVersion: "generator-1",
        contentVersion: "content-1",
        now,
      }),
    ).toBe(true);
    expect(
      await seasons.generateTower({ id: "season-2", now, seed: "season-zero-secret-seed" }),
    ).toEqual({ accepted: true, state: "generated" });
    expect(await seasons.advance({ id: "season-2", to: "validated", now })).toEqual({
      accepted: true,
      state: "validated",
    });
    expect(
      database.sqlite.query("SELECT tower_json FROM seasons WHERE id = 'season-2'").get(),
    ).toMatchObject({ tower_json: expect.any(String) });
  });

  test("publishes and reveals a validated generated tower with a verifiable seed commitment", async () => {
    const database = await databaseForSeasons();
    const seasons = new D1Seasons(database);
    const now = "2026-10-21T00:00:00.000Z";
    const seed = "season-zero-secret-seed";
    expect(
      await seasons.createDraft({
        id: "season-1",
        rulesetVersion: "rules-1",
        generatorVersion: "generator-1",
        contentVersion: "content-1",
        now,
      }),
    ).toBe(true);
    expect(await seasons.generateTower({ id: "season-1", now, seed })).toMatchObject({
      accepted: true,
    });
    expect(await seasons.advance({ id: "season-1", to: "validated", now })).toEqual({
      accepted: true,
      state: "validated",
    });
    expect(await seasons.advance({ id: "season-1", to: "published", now })).toEqual({
      accepted: false,
      reason: "invalid-seed",
    });
    expect(await seasons.advance({ id: "season-1", to: "published", now, seed })).toEqual({
      accepted: true,
      state: "published",
      seedCommitment: await seasonSeedCommitment(seed),
    });
    expect(await seasons.advance({ id: "season-1", to: "active", now })).toEqual({
      accepted: true,
      state: "active",
    });
    expect(
      database.sqlite.query("SELECT seed_commitment, revealed_seed FROM seasons").get(),
    ).toEqual({ seed_commitment: await seasonSeedCommitment(seed), revealed_seed: null });
    expect(() =>
      database.sqlite
        .query("UPDATE seasons SET ruleset_version = 'rules-2' WHERE id = 'season-1'")
        .run(),
    ).toThrow("active season versions are immutable");
    database.sqlite
      .query(
        `INSERT INTO accounts (id, github_user_id, created_at)
         VALUES ('account-1', '1', ?), ('account-2', '2', ?)`,
      )
      .run(now, now);
    database.sqlite
      .query(
        `INSERT INTO characters (id, account_id, season_id, sequence, status, state_json, created_at)
         VALUES ('character-1', 'account-1', 'season-1', 1, 'living', '{}', ?)`,
      )
      .run(now);
    database.sqlite
      .query(
        `INSERT INTO runs (id, account_id, season_id, mode, status, state_json, created_at)
         VALUES ('source-run', 'account-1', 'season-1', 'ranked', 'active', '{"completedFloors":2}', ?),
                ('viewer-run', 'account-2', 'season-1', 'ranked', 'active', '{"completedFloors":1}', ?)`,
      )
      .run(now, now);
    database.sqlite
      .query(
        `INSERT INTO floor_sessions
           (id, run_id, floor, status, definition_json, expires_at, created_at)
         VALUES ('floor-2', 'source-run', 2, 'completed', '{}', ?, ?)`,
      )
      .run(now, now);
    database.sqlite
      .query(
        `INSERT INTO journals (id, account_id, season_id, kind, payload_json, created_at)
         VALUES ('journal-1', 'account-1', 'season-1', 'fact', '{}', ?)`,
      )
      .run(now);
    const visibility = new D1ReplayVisibility(database);
    expect(await visibility.canView("account-2", "floor-2")).toEqual({
      allowed: false,
      reason: "floor-not-completed",
    });
    expect(await seasons.advance({ id: "season-1", to: "ended", now })).toEqual({
      accepted: true,
      state: "ended",
    });
    expect(database.sqlite.query("SELECT status FROM characters").get()).toEqual({
      status: "retired",
    });
    expect(database.sqlite.query("SELECT count(*) AS count FROM journals").get()).toEqual({
      count: 0,
    });
    expect(
      await seasons.advance({ id: "season-1", to: "revealed", now, seed: "wrong-seed-value-123" }),
    ).toEqual({
      accepted: false,
      reason: "invalid-seed",
    });
    expect(await seasons.advance({ id: "season-1", to: "revealed", now, seed })).toEqual({
      accepted: true,
      state: "revealed",
      seedCommitment: await seasonSeedCommitment(seed),
    });
    expect(await visibility.canView("account-2", "floor-2")).toEqual({
      allowed: true,
      reason: "season-revealed",
    });
    expect(
      database.sqlite.query("SELECT revealed_seed, retention_state FROM seasons").get(),
    ).toEqual({
      revealed_seed: seed,
      retention_state: "historical",
    });
  });

  test("allows only one active season", async () => {
    const database = await databaseForSeasons();
    const seasons = new D1Seasons(database);
    const now = "2026-10-21T00:00:00.000Z";
    for (const id of ["season-1", "season-2"]) {
      await seasons.createDraft({
        id,
        rulesetVersion: "rules-1",
        generatorVersion: "generator-1",
        contentVersion: "content-1",
        now,
      });
      await seasons.generateTower({ id, now, seed: `${id}-secret-seed` });
      await seasons.advance({ id, to: "validated", now });
      await seasons.advance({ id, to: "published", now, seed: `${id}-secret-seed` });
    }
    expect(await seasons.advance({ id: "season-1", to: "active", now })).toMatchObject({
      accepted: true,
    });
    expect(await seasons.advance({ id: "season-2", to: "active", now })).toEqual({
      accepted: false,
      reason: "active-season-exists",
    });
  });

  test("retains only the PRD-ordered seasonal best", async () => {
    const database = await databaseForSeasons();
    database.sqlite
      .query("INSERT INTO accounts (id, github_user_id, created_at) VALUES ('account-1', '1', ?)")
      .run("2026-10-21T00:00:00.000Z");
    database.sqlite
      .query(
        `INSERT INTO seasons
           (id, state, ruleset_version, generator_version, content_version, created_at)
         VALUES ('season-1', 'active', 'rules-1', 'generator-1', 'content-1', ?)`,
      )
      .run("2026-10-21T00:00:00.000Z");
    const standings = new D1Standings(database);
    const base = {
      seasonId: "season-1",
      accountId: "account-1",
      bestFloor: 2,
      bossesDefeated: 0,
      characterDeaths: 2,
      floorTurns: 90,
      achievedAt: "2026-10-21T01:00:00.000Z",
    };
    expect(await standings.record(base)).toBe(true);
    expect(await standings.record({ ...base, floorTurns: 99 })).toBe(false);
    expect(await standings.record({ ...base, characterDeaths: 1 })).toBe(true);
    expect(await standings.record({ ...base, characterDeaths: 1, bestFloor: 3 })).toBe(true);
    expect(
      database.sqlite
        .query("SELECT best_floor, character_deaths FROM standings WHERE season_id = 'season-1'")
        .get(),
    ).toEqual({ best_floor: 3, character_deaths: 1 });
  });
});

async function databaseForSeasons(): Promise<TestD1> {
  const database = new TestD1();
  for (const migration of [
    "0000_initial.sql",
    "0003_season_lifecycle.sql",
    "0004_season_tower.sql",
    "0005_freeze_active_season_versions.sql",
  ])
    database.sqlite.exec(
      await Bun.file(new URL(`../../migrations/${migration}`, import.meta.url)).text(),
    );
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
