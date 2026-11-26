import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHttpApp } from "../http/app";
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

  test("rotates credentials atomically, leaving only the replacement active", async () => {
    const database = await seededDatabase();
    const service = new AuthenticationService(database, configuration);
    const original = await service.createCredential("account-1", { label: "old" });

    const replacement = await service.rotateCredential("account-1", original.credential.id, {
      label: "new",
    });

    expect(replacement).toMatchObject({ credential: { label: "new" }, token: expect.any(String) });
    expect(
      database.sqlite
        .query(
          "SELECT COUNT(*) AS count FROM credentials WHERE account_id = ? AND revoked_at IS NULL",
        )
        .get("account-1"),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .query("SELECT revoked_at FROM credentials WHERE id = ?")
        .get(original.credential.id),
    ).toMatchObject({ revoked_at: expect.any(String) });
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

  test("validates ISO-8601 credential expiry timestamps", async () => {
    const database = await seededDatabase();
    const service = new AuthenticationService(database, configuration);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const issued = await service.createCredential("account-1", { expiresAt: future });
    expect(issued.credential.expiresAt).toBe(future);
    await expect(
      service.createCredential("account-1", { expiresAt: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  test("completes GitHub OAuth callback with User-Agent and manages local vs HTTPS cookies", async () => {
    const database = await seededDatabase();
    const app = createHttpApp();
    const env = {
      DB: database,
      RELEASE_VERSION: "test",
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
      AGENTFALL_ORIGIN: "http://localhost:8787",
      AUTH_STATE_SECRET: "local-state-secret",
      CREDENTIAL_HASH_PEPPER: "local-pepper",
    } as unknown as Env;

    const startRes = await app.fetch(new Request("http://localhost:8787/auth/github"), env);
    expect(startRes.status).toBe(302);
    const location = new URL(startRes.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("scope")).toBe("read:user");
    const state = location.searchParams.get("state") ?? "";
    const nonceCookie = startRes.headers.get("set-cookie") ?? "";
    expect(nonceCookie).not.toContain("Secure;");
    const nonceMatch = nonceCookie.match(/agentfall_oauth_nonce=([^;]+)/);
    const nonce = nonceMatch?.[1] ?? "";

    const originalFetch = globalThis.fetch;
    const seenHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seenHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_secret_token" }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 987654 }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const callbackRes = await app.fetch(
        new Request(
          `http://localhost:8787/auth/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
          { headers: { cookie: `agentfall_oauth_nonce=${nonce}` } },
        ),
        env,
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.get("location")).toBe("/auth");
      expect(seenHeaders[1]?.["user-agent"]).toBe("agentfall");
      const sessionHeader = callbackRes.headers.get("set-cookie") ?? "";
      const sessionToken = sessionHeader.match(/agentfall_session=([^;]+)/)?.[1] ?? "";
      expect(sessionToken.length).toBeGreaterThan(10);

      const portalRes = await app.fetch(
        new Request("http://localhost:8787/auth", {
          headers: { cookie: `agentfall_session=${sessionToken}` },
        }),
        env,
      );
      expect(portalRes.status).toBe(200);
      expect(await portalRes.text()).toContain("Agentfall Account");
    } finally {
      globalThis.fetch = originalFetch;
    }
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
