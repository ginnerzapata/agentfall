import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
};

/** Drizzle's canonical D1 schema. JSON columns hold versioned contracts, never ad-hoc state. */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  githubUserId: text("github_user_id").notNull().unique(),
  displayName: text("display_name"),
  rankedEnrolledAt: text("ranked_enrolled_at"),
  deletedAt: text("deleted_at"),
  ...timestamps,
});

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  label: text("label"),
  lastUsedAt: text("last_used_at"),
  ...timestamps,
});

export const seasons = sqliteTable(
  "seasons",
  {
    id: text("id").primaryKey(),
    state: text("state", {
      enum: ["draft", "generated", "validated", "published", "active", "ended", "revealed"],
    }).notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    generatorVersion: text("generator_version").notNull(),
    contentVersion: text("content_version").notNull(),
    seedCommitment: text("seed_commitment"),
    revealedSeed: text("revealed_seed"),
    towerJson: text("tower_json"),
    retentionState: text("retention_state", { enum: ["active", "historical", "compacted"] })
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [uniqueIndex("seasons_one_active").on(table.state).where(sql`state = 'active'`)],
);

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    seasonId: text("season_id")
      .notNull()
      .references(() => seasons.id),
    sequence: integer("sequence").notNull(),
    status: text("status", { enum: ["living", "dead", "retired"] }).notNull(),
    stateJson: text("state_json").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("characters_account_season_sequence").on(
      table.accountId,
      table.seasonId,
      table.sequence,
    ),
  ],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  seasonId: text("season_id")
    .notNull()
    .references(() => seasons.id),
  characterId: text("character_id").references(() => characters.id),
  mode: text("mode", { enum: ["ranked", "practice"] }).notNull(),
  status: text("status").notNull(),
  stateJson: text("state_json").notNull(),
  ...timestamps,
});

export const floorSessions = sqliteTable(
  "floor_sessions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    accountId: text("account_id").references(() => accounts.id),
    mode: text("mode", { enum: ["ranked", "practice"] }),
    floor: integer("floor").notNull(),
    status: text("status", {
      enum: ["active", "paused", "completed", "abandoned", "expired"],
    }).notNull(),
    definitionJson: text("definition_json").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastActionAt: text("last_action_at"),
    ...timestamps,
  },
  (table) => [index("floor_sessions_active_run").on(table.runId, table.status)],
);

export const snapshots = sqliteTable("snapshots", {
  floorSessionId: text("floor_session_id")
    .primaryKey()
    .references(() => floorSessions.id),
  version: integer("version").notNull(),
  checksum: text("checksum").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    floorSessionId: text("floor_session_id")
      .notNull()
      .references(() => floorSessions.id),
    sequence: integer("sequence").notNull(),
    eventJson: text("event_json").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("events_session_sequence").on(table.floorSessionId, table.sequence)],
);

export const mutationReceipts = sqliteTable(
  "mutation_receipts",
  {
    scopeId: text("scope_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scopeId, table.idempotencyKey] })],
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    scope: text("scope").notNull(),
    clientKey: text("client_key").notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.clientKey, table.windowStart] })],
);

export const journals = sqliteTable("journals", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  seasonId: text("season_id").references(() => seasons.id),
  kind: text("kind", { enum: ["fact", "note"] }).notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const charges = sqliteTable("charges", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id),
  available: integer("available").notNull(),
  calculatedAt: text("calculated_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const standings = sqliteTable(
  "standings",
  {
    seasonId: text("season_id")
      .notNull()
      .references(() => seasons.id),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    bestFloor: integer("best_floor").notNull(),
    bossesDefeated: integer("bosses_defeated").notNull(),
    characterDeaths: integer("character_deaths").notNull(),
    floorTurns: integer("floor_turns").notNull(),
    achievedAt: text("achieved_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.seasonId, table.accountId] })],
);
