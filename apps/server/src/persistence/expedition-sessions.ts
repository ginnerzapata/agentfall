import {
  canonicalStringify,
  type ExpeditionRun,
  type RunDefinition,
  type Snapshot,
} from "@agentfall/contracts";
import { abandonActiveFloor } from "@agentfall/engine";
import { D1CapacityBudget } from "./capacity";
import type { D1Database } from "./floor-store";

const CHARGE_CAP = 3;
const CHARGE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const IDLE_PAUSE_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type FloorMode = "ranked" | "practice";
export type StartSessionInput = {
  accountId: string;
  runId: string;
  sessionId: string;
  mode: FloorMode;
  floor: number;
  definition: RunDefinition;
  snapshot: Snapshot;
  now: Date;
};

export type ChargeState = { available: number; calculatedAt: string };

/**
 * Persists account-scoped expedition rules. All writes are conditional and
 * grouped in D1 batches, so a losing concurrent floor start makes no charge
 * or session change.
 */
export class D1ExpeditionSessions {
  constructor(
    private readonly database: D1Database,
    private readonly capacity = new D1CapacityBudget(database),
  ) {}

  async charges(accountId: string, now: Date): Promise<ChargeState> {
    await this.ensureCharges(accountId, now);
    await this.regenerate(accountId, now);
    const row = await this.database
      .prepare("SELECT available, calculated_at FROM charges WHERE account_id = ?")
      .bind(accountId)
      .first<ChargeRow>();
    if (!row) throw new Error("Charge row was not created.");
    return { available: row.available, calculatedAt: row.calculated_at };
  }

  async start(input: StartSessionInput): Promise<StartSessionResult> {
    await this.abandonExpired(input.now, input.accountId);
    if (input.mode === "ranked" && (await this.charges(input.accountId, input.now)).available === 0)
      return { accepted: false, reason: "no-charge" };
    if (await this.hasOpenSession(input.accountId, input.mode))
      return { accepted: false, reason: "session-active" };
    const capacity = await this.capacity.reserve(input.sessionId, input.mode, input.now);
    if (!capacity.accepted)
      return { accepted: false, reason: "capacity-exhausted", resetAt: capacity.resetAt };
    const now = input.now.toISOString();
    const expiresAt = new Date(input.now.getTime() + SESSION_LIFETIME_MS).toISOString();
    const statements = [
      this.database
        .prepare(
          `INSERT INTO floor_sessions
             (id, run_id, account_id, mode, floor, status, definition_json, expires_at, last_action_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND account_id = ? AND mode = ?)
             AND NOT EXISTS (
             SELECT 1 FROM floor_sessions
             WHERE account_id = ? AND mode = ? AND status IN ('active', 'paused')
           ) ${input.mode === "ranked" ? "AND EXISTS (SELECT 1 FROM charges WHERE account_id = ? AND available > 0)" : ""}`,
        )
        .bind(
          input.sessionId,
          input.runId,
          input.accountId,
          input.mode,
          input.floor,
          canonicalStringify(input.definition),
          expiresAt,
          now,
          now,
          now,
          input.runId,
          input.accountId,
          input.mode,
          input.accountId,
          input.mode,
          ...(input.mode === "ranked" ? [input.accountId] : []),
        ),
      this.database
        .prepare(
          `INSERT INTO snapshots (floor_session_id, version, checksum, snapshot_json, updated_at)
           SELECT ?, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM floor_sessions WHERE id = ?)`,
        )
        .bind(
          input.sessionId,
          input.snapshot.checksum,
          canonicalStringify(input.snapshot),
          now,
          input.sessionId,
        ),
    ];
    if (input.mode === "ranked")
      statements.push(
        this.database
          .prepare(
            `UPDATE charges SET available = available - 1, updated_at = ?
             WHERE account_id = ? AND available > 0
               AND EXISTS (SELECT 1 FROM floor_sessions WHERE id = ?)`,
          )
          .bind(now, input.accountId, input.sessionId),
      );
    const result = await this.database.batch(statements);
    if (result[0]?.meta?.changes !== 1) {
      const charge = await this.charges(input.accountId, input.now);
      return {
        accepted: false,
        reason: input.mode === "ranked" && charge.available === 0 ? "no-charge" : "session-active",
      };
    }
    return { accepted: true, expiresAt };
  }

  /** Boss rewards are saturating and restart the four-hour clock only below cap. */
  async awardBossCharge(accountId: string, now: Date): Promise<ChargeState> {
    await this.ensureCharges(accountId, now);
    await this.regenerate(accountId, now);
    const stamp = now.toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE charges SET available = MIN(?, available + 1), calculated_at = CASE WHEN available < ? THEN ? ELSE calculated_at END, updated_at = ? WHERE account_id = ?",
        )
        .bind(CHARGE_CAP, CHARGE_CAP, stamp, stamp, accountId),
    ]);
    return this.charges(accountId, now);
  }

  /** Calling this before a read or mutation turns idle active sessions into paused sessions. */
  async pauseIdle(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - IDLE_PAUSE_MS).toISOString();
    const result = await this.database.batch([
      this.database
        .prepare(
          "UPDATE floor_sessions SET status = 'paused', updated_at = ? WHERE status = 'active' AND last_action_at <= ? AND expires_at > ?",
        )
        .bind(now.toISOString(), cutoff, now.toISOString()),
    ]);
    return result[0]?.meta?.changes ?? 0;
  }

  async resume(
    accountId: string,
    sessionId: string,
    now: Date,
  ): Promise<"resumed" | "expired" | "not-found"> {
    const row = await this.database
      .prepare("SELECT status, expires_at FROM floor_sessions WHERE id = ? AND account_id = ?")
      .bind(sessionId, accountId)
      .first<SessionRow>();
    if (!row) return "not-found";
    const stamp = now.toISOString();
    if (row.expires_at <= stamp) {
      await this.abandonExpired(now, accountId, sessionId);
      return "expired";
    }
    if (row.status === "active") return "resumed";
    if (row.status !== "paused") return "not-found";
    const result = await this.database.batch([
      this.database
        .prepare(
          "UPDATE floor_sessions SET status = 'active', updated_at = ? WHERE id = ? AND account_id = ? AND status = 'paused' AND expires_at > ?",
        )
        .bind(stamp, sessionId, accountId, stamp),
    ]);
    return result[0]?.meta?.changes === 1 ? "resumed" : "not-found";
  }

  async recordStateChange(accountId: string, sessionId: string, now: Date): Promise<boolean> {
    const result = await this.database.batch([
      this.database
        .prepare(
          "UPDATE floor_sessions SET last_action_at = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'active' AND expires_at > ?",
        )
        .bind(now.toISOString(), now.toISOString(), sessionId, accountId, now.toISOString()),
    ]);
    return result[0]?.meta?.changes === 1;
  }

  /**
   * Expires sessions through the same engine rollback used for a voluntary
   * abandonment. This restores the pre-floor character, drops uncommitted
   * discoveries and notes, and deliberately does not refund the start charge.
   *
   * Each candidate is conditionally updated in one D1 batch. A concurrent
   * completion, action, or expiry worker therefore either wins in full or
   * leaves this method with no changes for that session.
   */
  async abandonExpired(now: Date, accountId?: string, sessionId?: string): Promise<number> {
    const stamp = now.toISOString();
    const candidates = await this.database
      .prepare(
        `SELECT floor_sessions.id, floor_sessions.run_id, floor_sessions.floor, runs.state_json
         FROM floor_sessions JOIN runs ON runs.id = floor_sessions.run_id
         WHERE floor_sessions.status IN ('active', 'paused')
           AND floor_sessions.expires_at <= ?
           ${accountId ? "AND floor_sessions.account_id = ?" : ""}
           ${sessionId ? "AND floor_sessions.id = ?" : ""}`,
      )
      .bind(stamp, ...(accountId ? [accountId] : []), ...(sessionId ? [sessionId] : []))
      .all<ExpiredSessionRow>();

    let abandoned = 0;
    for (const candidate of candidates.results) {
      const rolledBack = rollbackExpiredRun(candidate.state_json, candidate.floor);
      if (!rolledBack) continue;
      const nextState = canonicalStringify(rolledBack);
      const result = await this.database.batch([
        this.database
          .prepare(
            `UPDATE runs SET state_json = ?, updated_at = ?
             WHERE id = ? AND state_json = ?
               AND EXISTS (
                 SELECT 1 FROM floor_sessions
                 WHERE id = ? AND status IN ('active', 'paused') AND expires_at <= ?
               )`,
          )
          .bind(nextState, stamp, candidate.run_id, candidate.state_json, candidate.id, stamp),
        this.database
          .prepare(
            `UPDATE floor_sessions SET status = 'expired', updated_at = ?
             WHERE id = ? AND status IN ('active', 'paused') AND expires_at <= ?
               AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)`,
          )
          .bind(stamp, candidate.id, stamp, candidate.run_id, nextState),
      ]);
      if (result[0]?.meta?.changes === 1 && result[1]?.meta?.changes === 1) abandoned += 1;
    }
    return abandoned;
  }

  private async ensureCharges(accountId: string, now: Date) {
    const stamp = now.toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "INSERT OR IGNORE INTO charges (account_id, available, calculated_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(accountId, CHARGE_CAP, stamp, stamp),
    ]);
  }

  private async hasOpenSession(accountId: string, mode: FloorMode): Promise<boolean> {
    const session = await this.database
      .prepare(
        "SELECT id FROM floor_sessions WHERE account_id = ? AND mode = ? AND status IN ('active', 'paused') LIMIT 1",
      )
      .bind(accountId, mode)
      .first<{ id: string }>();
    return session !== null;
  }

  private async regenerate(accountId: string, now: Date) {
    const current = await this.database
      .prepare("SELECT available, calculated_at FROM charges WHERE account_id = ?")
      .bind(accountId)
      .first<ChargeRow>();
    if (!current || current.available >= CHARGE_CAP) return;
    const elapsed = Math.max(0, now.getTime() - Date.parse(current.calculated_at));
    const gained = Math.min(
      CHARGE_CAP - current.available,
      Math.floor(elapsed / CHARGE_INTERVAL_MS),
    );
    if (!gained) return;
    const calculatedAt = new Date(
      Date.parse(current.calculated_at) + gained * CHARGE_INTERVAL_MS,
    ).toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE charges SET available = ?, calculated_at = ?, updated_at = ? WHERE account_id = ? AND available = ? AND calculated_at = ?",
        )
        .bind(
          Math.min(CHARGE_CAP, current.available + gained),
          calculatedAt,
          now.toISOString(),
          accountId,
          current.available,
          current.calculated_at,
        ),
    ]);
  }
}

export type StartSessionResult =
  | { accepted: true; expiresAt: string }
  | { accepted: false; reason: "no-charge" | "session-active" }
  | { accepted: false; reason: "capacity-exhausted"; resetAt: string };
type ChargeRow = { available: number; calculated_at: string };
type SessionRow = { status: string; expires_at: string };
type ExpiredSessionRow = { id: string; run_id: string; floor: number; state_json: string };

function rollbackExpiredRun(stateJson: string, floor: number): ExpeditionRun | null {
  let run: ExpeditionRun;
  try {
    run = JSON.parse(stateJson) as ExpeditionRun;
  } catch {
    return null;
  }
  if (!run.activeFloor || run.activeFloor.floor !== floor) return null;
  const result = abandonActiveFloor(run);
  return result.accepted ? result.run : null;
}
