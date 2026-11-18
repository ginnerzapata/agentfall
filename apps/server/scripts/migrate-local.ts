import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const databasePath = process.env.AGENTFALL_D1_LOCAL_PATH ?? ".agentfall/local.sqlite";
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath, { create: true });
database.exec(
  "CREATE TABLE IF NOT EXISTS __agentfall_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
);
for (const migrationName of [
  "0000_initial.sql",
  "0001_rate_limits.sql",
  "0001_authentication.sql",
  "0002_expedition_sessions.sql",
]) {
  const applied = database
    .query("SELECT name FROM __agentfall_migrations WHERE name = ?")
    .get(migrationName);
  if (applied) continue;
  const migration = await Bun.file(
    new URL(`../migrations/${migrationName}`, import.meta.url),
  ).text();
  database.exec(migration);
  database
    .query("INSERT INTO __agentfall_migrations (name, applied_at) VALUES (?, ?)")
    .run(migrationName, new Date().toISOString());
  console.log(`Applied D1-compatible migration ${migrationName} to ${databasePath}`);
}
database.close();
