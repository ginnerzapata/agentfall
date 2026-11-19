import {
  type GeneratedFloor,
  generateOrcSiegeTower,
  validateGeneratedSeason,
} from "@agentfall/content";

import type { D1Database } from "./floor-store";

export const seasonStates = [
  "draft",
  "generated",
  "validated",
  "published",
  "active",
  "ended",
  "revealed",
] as const;

export type SeasonState = (typeof seasonStates)[number];
export type CreateSeasonInput = {
  id: string;
  rulesetVersion: string;
  generatorVersion: string;
  contentVersion: string;
  now: string;
};
export type AdvanceSeasonInput = {
  id: string;
  to: Exclude<SeasonState, "draft">;
  now: string;
  /** Required to publish a commitment and to verify the later reveal. */
  seed?: string;
};
export type AdvanceSeasonResult =
  | { accepted: true; state: SeasonState; seedCommitment?: string }
  | {
      accepted: false;
      reason:
        | "not-found"
        | "invalid-transition"
        | "active-season-exists"
        | "invalid-seed"
        | "invalid-tower";
    };

type SeasonRow = {
  id?: string;
  state: SeasonState;
  ruleset_version?: string;
  generator_version?: string;
  content_version?: string;
  seed_commitment: string | null;
  tower_json: string | null;
};

export type SeasonAdministrationView = {
  id: string;
  state: SeasonState;
  rulesetVersion: string;
  generatorVersion: string;
  contentVersion: string;
  seedCommitment: string | null;
  towerValid: boolean;
};

const predecessor: Record<Exclude<SeasonState, "draft">, SeasonState> = {
  generated: "draft",
  validated: "generated",
  published: "validated",
  active: "published",
  ended: "active",
  revealed: "ended",
};

/**
 * D1-backed state machine for the public season lifecycle. A caller may only
 * advance to the direct successor in the PRD lifecycle; no transition can
 * modify a frozen active season's versions.
 */
export class D1Seasons {
  constructor(private readonly database: D1Database) {}

  async createDraft(input: CreateSeasonInput): Promise<boolean> {
    const result = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO seasons
             (id, state, ruleset_version, generator_version, content_version, created_at, updated_at)
           VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.rulesetVersion,
          input.generatorVersion,
          input.contentVersion,
          input.now,
          input.now,
        ),
    ]);
    return result[0]?.meta?.changes === 1;
  }

  /** Safe administrative review view; intentionally never returns a seed. */
  async inspect(id: string): Promise<SeasonAdministrationView | null> {
    const row = await this.database
      .prepare(
        `SELECT id, state, ruleset_version, generator_version, content_version,
                seed_commitment, tower_json FROM seasons WHERE id = ?`,
      )
      .bind(id)
      .first<Required<SeasonRow>>();
    if (!row) return null;
    return {
      id: row.id,
      state: row.state,
      rulesetVersion: row.ruleset_version,
      generatorVersion: row.generator_version,
      contentVersion: row.content_version,
      seedCommitment: row.seed_commitment,
      towerValid: storedTowerIsValid(row.tower_json),
    };
  }

  /** Generates and persists the entire Season Zero tower before it can be validated. */
  async generateTower(
    input: Pick<CreateSeasonInput, "id" | "now"> & { seed: string },
  ): Promise<AdvanceSeasonResult> {
    if (!validSeed(input.seed)) return { accepted: false, reason: "invalid-seed" };
    const current = await this.season(input.id);
    if (!current) return { accepted: false, reason: "not-found" };
    if (current.state !== "draft") return { accepted: false, reason: "invalid-transition" };
    const tower = generateOrcSiegeTower(input.seed);
    if (!validTower(tower)) return { accepted: false, reason: "invalid-tower" };
    const result = await this.database.batch([
      this.database
        .prepare(
          `UPDATE seasons SET state = 'generated', tower_json = ?, updated_at = ?
           WHERE id = ? AND state = 'draft'`,
        )
        .bind(JSON.stringify(tower), input.now, input.id),
    ]);
    return result[0]?.meta?.changes === 1
      ? { accepted: true, state: "generated" }
      : { accepted: false, reason: "invalid-transition" };
  }

  async advance(input: AdvanceSeasonInput): Promise<AdvanceSeasonResult> {
    const current = await this.database
      .prepare("SELECT state, seed_commitment, tower_json FROM seasons WHERE id = ?")
      .bind(input.id)
      .first<SeasonRow>();
    if (!current) return { accepted: false, reason: "not-found" };
    if (current.state !== predecessor[input.to])
      return { accepted: false, reason: "invalid-transition" };

    if (input.to === "validated" && !storedTowerIsValid(current.tower_json))
      return { accepted: false, reason: "invalid-tower" };

    if (input.to === "published") {
      if (!validSeed(input.seed)) return { accepted: false, reason: "invalid-seed" };
      const seedCommitment = await seasonSeedCommitment(input.seed);
      const updated = await this.update(
        input.id,
        current.state,
        "published",
        input.now,
        "seed_commitment = ?",
        [seedCommitment],
      );
      return updated
        ? { accepted: true, state: "published", seedCommitment }
        : { accepted: false, reason: "invalid-transition" };
    }

    if (input.to === "revealed") {
      if (!validSeed(input.seed) || !current.seed_commitment)
        return { accepted: false, reason: "invalid-seed" };
      if ((await seasonSeedCommitment(input.seed)) !== current.seed_commitment)
        return { accepted: false, reason: "invalid-seed" };
      const updated = await this.update(
        input.id,
        current.state,
        "revealed",
        input.now,
        "revealed_seed = ?, retention_state = 'historical'",
        [input.seed],
      );
      return updated
        ? { accepted: true, state: "revealed", seedCommitment: current.seed_commitment }
        : { accepted: false, reason: "invalid-transition" };
    }

    if (input.to === "ended") {
      const result = await this.database.batch([
        this.database
          .prepare(
            "UPDATE seasons SET state = 'ended', updated_at = ? WHERE id = ? AND state = 'active'",
          )
          .bind(input.now, input.id),
        this.database
          .prepare(
            `UPDATE characters SET status = 'retired', updated_at = ?
             WHERE season_id = ? AND EXISTS (
               SELECT 1 FROM seasons WHERE id = ? AND state = 'ended' AND updated_at = ?
             )`,
          )
          .bind(input.now, input.id, input.id, input.now),
        this.database
          .prepare(
            `UPDATE runs SET status = 'ended', updated_at = ?
             WHERE season_id = ? AND EXISTS (
               SELECT 1 FROM seasons WHERE id = ? AND state = 'ended' AND updated_at = ?
             )`,
          )
          .bind(input.now, input.id, input.id, input.now),
        this.database
          .prepare(
            `DELETE FROM journals WHERE season_id = ? AND EXISTS (
               SELECT 1 FROM seasons WHERE id = ? AND state = 'ended' AND updated_at = ?
             )`,
          )
          .bind(input.id, input.id, input.now),
      ]);
      return result[0]?.meta?.changes === 1
        ? { accepted: true, state: "ended" }
        : { accepted: false, reason: "invalid-transition" };
    }

    const activeGuard =
      input.to === "active" ? " AND NOT EXISTS (SELECT 1 FROM seasons WHERE state = 'active')" : "";
    const updated = await this.update(
      input.id,
      current.state,
      input.to,
      input.now,
      "",
      [],
      activeGuard,
    );
    if (updated) return { accepted: true, state: input.to };
    return {
      accepted: false,
      reason: input.to === "active" ? "active-season-exists" : "invalid-transition",
    };
  }

  private season(id: string): Promise<SeasonRow | null> {
    return this.database
      .prepare("SELECT state, seed_commitment, tower_json FROM seasons WHERE id = ?")
      .bind(id)
      .first<SeasonRow>();
  }

  private async update(
    id: string,
    from: SeasonState,
    to: SeasonState,
    now: string,
    assignments: string,
    values: unknown[],
    guard = "",
  ): Promise<boolean> {
    const separator = assignments ? ", " : "";
    const result = await this.database.batch([
      this.database
        .prepare(
          `UPDATE seasons SET state = ?, updated_at = ?${separator}${assignments}
           WHERE id = ? AND state = ?${guard}`,
        )
        .bind(to, now, ...values, id, from),
    ]);
    return result[0]?.meta?.changes === 1;
  }
}

export async function seasonSeedCommitment(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validSeed(seed: string | undefined): seed is string {
  return typeof seed === "string" && seed.length >= 16;
}

function storedTowerIsValid(value: string | null): boolean {
  if (!value) return false;
  try {
    return validTower(JSON.parse(value) as GeneratedFloor[]);
  } catch {
    return false;
  }
}

function validTower(tower: GeneratedFloor[]): boolean {
  return validateGeneratedSeason(tower).valid;
}
