import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { D1Database, D1PreparedStatement } from "../persistence";
import { type AuthError, AuthenticationService, credentialHash } from "./service";

const configuration = {
  githubClientId: "github-client",
  githubClientSecret: "github-secret",
  origin: "https://agentfall.test",
  stateSecret: "state-secret",
  credentialHashPepper: "credential-pepper",
};

describe("authentication credentials", () => {
  test("issues an opaque credential while persisting only its peppered hash and metadata", async () => {
    const database = await seededDatabase();
    const service = new AuthenticationService(database, configuration);
    const issued = await service.createCredential("account-1", { label: "Codex" });

    expect(issued.token).toStartWith("af_");
    expect(issued.token.length).toBeGreaterThan(40);
    const stored = database.sqlite
      .query("SELECT token_hash, label FROM credentials WHERE id = ?")
      .get(issued.credential.id) as { token_hash: string; label: string };
    expect(stored).toEqual({
      token_hash: await credentialHash(issued.token, configuration.credentialHashPepper),
      label: "Codex",
    });
    expect(stored.token_hash).not.toContain(issued.token);
    expect(await service.listCredentials("account-1")).toHaveLength(1);
    expect(await service.revokeCredential("account-1", issued.credential.id)).toBe(true);
    expect(await service.revokeCredential("account-1", issued.credential.id)).toBe(false);
  });

  test("makes ranked enrollment one-time and gives display names a database-backed uniqueness rule", async () => {
    const database = await seededDatabase();
    const service = new AuthenticationService(database, configuration);
    await expect(service.enrollRanked("account-1", "Tower Scout")).resolves.toMatchObject({
      displayName: "Tower Scout",
    });
    await expect(service.enrollRanked("account-1", "Different Name")).rejects.toMatchObject({
      code: "ALREADY_ENROLLED",
    } satisfies Partial<AuthError>);
    await database.batch([
      database
        .prepare("INSERT INTO accounts (id, github_user_id, created_at) VALUES (?, ?, ?)")
        .bind("account-2", "2", new Date().toISOString()),
    ]);
    await expect(service.enrollRanked("account-2", "Tower Scout")).rejects.toMatchObject({
      code: "DISPLAY_NAME_TAKEN",
    } satisfies Partial<AuthError>);
  });
});

async function seededDatabase(): Promise<TestD1> {
  const database = new TestD1();
  for (const migration of ["0000_initial.sql", "0001_authentication.sql"])
    database.sqlite.exec(
      await Bun.file(new URL(`../../migrations/${migration}`, import.meta.url)).text(),
    );
  await database.batch([
    database
      .prepare("INSERT INTO accounts (id, github_user_id, created_at) VALUES (?, ?, ?)")
      .bind("account-1", "1", new Date().toISOString()),
  ]);
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
      statements.map((statement) => {
        const result = (statement as RunnableStatement).run() as { changes?: number };
        return { meta: { changes: result.changes } };
      }),
    )();
  }
}
