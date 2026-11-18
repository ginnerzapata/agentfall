import { observe } from "@agentfall/engine";
import { FloorApplication } from "../application";
import { credentialHash } from "../auth";
import { type D1Database, D1ExpeditionSessions, D1FloorStore } from "../persistence";
import type { McpGameplay } from "./server";

type CredentialRow = { account_id: string };
type SessionOwnerRow = { id: string };
type CharacterRow = { id: string; sequence: number; status: string; state_json: string };
type JournalRow = { id: string; kind: string; payload_json: string; created_at: string };
type SeasonRow = {
  id: string;
  state: string;
  ruleset_version: string;
  generator_version: string;
  content_version: string;
  seed_commitment: string | null;
  revealed_seed: string | null;
};
type StandingRow = {
  account_id: string;
  display_name: string | null;
  best_floor: number;
  bosses_defeated: number;
  character_deaths: number;
  floor_turns: number;
  achieved_at: string;
};

/** D1 adapter that resolves an opaque bearer credential on every MCP call. */
export class D1McpGameplay implements McpGameplay {
  constructor(
    private readonly database: D1Database,
    private readonly authorization: string | undefined,
    private readonly credentialHashPepper = "",
  ) {}

  async startFloor(): Promise<Record<string, unknown>> {
    await this.accountId();
    return { code: "FEATURE_UNAVAILABLE" };
  }

  async observeFloor(input: { floorSessionId: string }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    if (!(await this.ownsSession(accountId, input.floorSessionId))) return { code: "NOT_FOUND" };
    const sessions = new D1ExpeditionSessions(this.database);
    const now = new Date();
    await sessions.pauseIdle(now);
    const resume = await sessions.resume(accountId, input.floorSessionId, now);
    if (resume === "expired") return { code: "SESSION_EXPIRED" };
    if (resume === "not-found") return { code: "SESSION_UNAVAILABLE" };
    const result = await new FloorApplication(new D1FloorStore(this.database)).observe(
      input.floorSessionId,
    );
    if (!result.accepted) return { code: "NOT_FOUND" };
    return { snapshotVersion: result.snapshotVersion, observation: result.observation };
  }

  async submitAction(input: {
    floorSessionId: string;
    snapshotVersion: number;
    idempotencyKey: string;
    action: Parameters<FloorApplication["submitAction"]>[0]["action"];
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    if (!(await this.ownsSession(accountId, input.floorSessionId))) return { code: "NOT_FOUND" };
    const sessions = new D1ExpeditionSessions(this.database);
    const now = new Date();
    await sessions.pauseIdle(now);
    const resume = await sessions.resume(accountId, input.floorSessionId, now);
    if (resume === "expired") return { code: "SESSION_EXPIRED" };
    if (resume === "not-found") return { code: "SESSION_UNAVAILABLE" };
    const committed = await new FloorApplication(new D1FloorStore(this.database)).submitAction({
      ...input,
      expectedSnapshotVersion: input.snapshotVersion,
      now: new Date().toISOString(),
    });
    if (!committed.accepted) return { code: committed.reason.toUpperCase().replaceAll("-", "_") };
    if (!committed.replayed)
      await sessions.recordStateChange(accountId, input.floorSessionId, new Date());
    return {
      accepted: true,
      replayed: committed.replayed,
      snapshotVersion: committed.version,
      observation: observe(committed.snapshot),
    };
  }

  async currentCharacter(): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const character = await this.database
      .prepare(
        `SELECT id, sequence, status, state_json FROM characters
         WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<CharacterRow>();
    if (!character) return { code: "NOT_FOUND" };
    return characterView(character);
  }

  async journal(input: { limit: number }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const rows = await this.database
      .prepare(
        `SELECT id, kind, payload_json, created_at FROM journals
         WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(accountId, input.limit)
      .all<JournalRow>();
    return {
      entries: rows.results.flatMap((row) => {
        const payload = journalPayload(row.kind, row.payload_json);
        return payload ? [{ id: row.id, kind: row.kind, payload, createdAt: row.created_at }] : [];
      }),
    };
  }

  async abandonFloor(): Promise<Record<string, unknown>> {
    await this.accountId();
    return { code: "FEATURE_UNAVAILABLE" };
  }

  async endFloor(): Promise<Record<string, unknown>> {
    await this.accountId();
    return { code: "FEATURE_UNAVAILABLE" };
  }

  async season(input: { seasonId?: string }): Promise<Record<string, unknown>> {
    await this.accountId();
    const season = input.seasonId
      ? await this.database
          .prepare(
            `SELECT id, state, ruleset_version, generator_version, content_version,
                    seed_commitment, revealed_seed FROM seasons WHERE id = ?`,
          )
          .bind(input.seasonId)
          .first<SeasonRow>()
      : await this.database
          .prepare(
            `SELECT id, state, ruleset_version, generator_version, content_version,
                    seed_commitment, revealed_seed FROM seasons
             WHERE state = 'active' ORDER BY created_at DESC LIMIT 1`,
          )
          .first<SeasonRow>();
    if (!season) return { code: "NOT_FOUND" };
    return {
      id: season.id,
      state: season.state,
      rulesetVersion: season.ruleset_version,
      generatorVersion: season.generator_version,
      contentVersion: season.content_version,
      seedCommitment: season.seed_commitment,
      ...(season.state === "revealed" ? { seed: season.revealed_seed } : {}),
    };
  }

  async standings(input: { seasonId?: string; limit: number }): Promise<Record<string, unknown>> {
    await this.accountId();
    const seasonId = input.seasonId ?? (await this.activeSeasonId());
    if (!seasonId) return { code: "NOT_FOUND" };
    const rows = await this.database
      .prepare(
        `SELECT standings.account_id, accounts.display_name, standings.best_floor,
                standings.bosses_defeated, standings.character_deaths, standings.floor_turns,
                standings.achieved_at
         FROM standings JOIN accounts ON accounts.id = standings.account_id
         WHERE standings.season_id = ?
         ORDER BY best_floor DESC, bosses_defeated DESC, character_deaths ASC,
                  floor_turns ASC, achieved_at ASC LIMIT ?`,
      )
      .bind(seasonId, input.limit)
      .all<StandingRow>();
    return {
      seasonId,
      entries: rows.results.map((row, index) => ({
        rank: index + 1,
        accountId: row.account_id,
        displayName: row.display_name,
        bestFloor: row.best_floor,
        bossesDefeated: row.bosses_defeated,
        characterDeaths: row.character_deaths,
        floorTurns: row.floor_turns,
        achievedAt: row.achieved_at,
      })),
    };
  }

  private async accountId(): Promise<string> {
    const token = bearerToken(this.authorization);
    if (!token) throw new McpAuthenticationError();
    const tokenHash = await credentialHash(token, this.credentialHashPepper);
    const credential = await this.database
      .prepare(
        `SELECT account_id FROM credentials
         WHERE token_hash = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(tokenHash, new Date().toISOString())
      .first<CredentialRow>();
    if (!credential) throw new McpAuthenticationError();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE credentials SET last_used_at = ?, updated_at = ? WHERE id = (SELECT id FROM credentials WHERE token_hash = ? AND revoked_at IS NULL)",
        )
        .bind(new Date().toISOString(), new Date().toISOString(), tokenHash),
    ]);
    return credential.account_id;
  }

  private async ownsSession(accountId: string, floorSessionId: string): Promise<boolean> {
    const session = await this.database
      .prepare(
        `SELECT floor_sessions.id FROM floor_sessions
         JOIN runs ON runs.id = floor_sessions.run_id
         WHERE floor_sessions.id = ? AND runs.account_id = ?`,
      )
      .bind(floorSessionId, accountId)
      .first<SessionOwnerRow>();
    return session !== null;
  }

  private async activeSeasonId(): Promise<string | null> {
    const season = await this.database
      .prepare("SELECT id FROM seasons WHERE state = 'active' ORDER BY created_at DESC LIMIT 1")
      .first<{ id: string }>();
    return season?.id ?? null;
  }
}

export class McpAuthenticationError extends Error {
  constructor() {
    super("Authentication required.");
  }
}

function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function characterView(row: CharacterRow): Record<string, unknown> {
  const state = JSON.parse(row.state_json) as Record<string, unknown>;
  return {
    id: row.id,
    sequence: row.sequence,
    status: row.status,
    ...(state.character && typeof state.character === "object"
      ? { character: state.character }
      : {}),
  };
}

function journalPayload(kind: string, value: string): Record<string, unknown> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  const fact = payload as Record<string, unknown>;
  if (kind === "fact" && fact.kind === "terrain" && Number.isSafeInteger(fact.floor))
    return {
      kind: "terrain",
      floor: fact.floor,
      tiles: Array.isArray(fact.tiles) ? fact.tiles.flatMap(rememberedTile) : [],
    };
  if (kind === "fact" && fact.kind === "enemy" && Number.isSafeInteger(fact.floor))
    return {
      kind: "enemy",
      floor: fact.floor,
      enemyIds: Array.isArray(fact.enemyIds) ? fact.enemyIds.filter(isString) : [],
    };
  if (
    kind === "fact" &&
    fact.kind === "death" &&
    Number.isSafeInteger(fact.floor) &&
    typeof fact.cause === "string"
  )
    return { kind: "death", floor: fact.floor, cause: fact.cause };
  if (kind === "note" && Number.isSafeInteger(fact.floor) && typeof fact.text === "string")
    return { floor: fact.floor, text: fact.text.slice(0, 500) };
  return null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function rememberedTile(value: unknown): Array<Record<string, unknown>> {
  if (value === null || typeof value !== "object") return [];
  const tile = value as Record<string, unknown>;
  if (
    tile.position === null ||
    typeof tile.position !== "object" ||
    !isTerrain(tile.terrain) ||
    (tile.door !== undefined && tile.door !== "open" && tile.door !== "closed")
  )
    return [];
  const position = tile.position as Record<string, unknown>;
  if (!Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) return [];
  return [
    {
      position: { x: position.x, y: position.y },
      terrain: tile.terrain,
      ...(tile.door ? { door: tile.door } : {}),
    },
  ];
}

function isTerrain(
  value: unknown,
): value is "floor" | "wall" | "entrance" | "objective" | "exit" | "secret" {
  return ["floor", "wall", "entrance", "objective", "exit", "secret"].includes(value as string);
}
