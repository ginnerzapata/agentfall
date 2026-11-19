import type { D1Database } from "./floor-store";

export type CapacityMode = "ranked" | "practice";

/**
 * Deliberately below the Workers Free and D1 Free daily limits.  A floor may
 * consume at most 100 state-changing turns, and every turn is reserved as a
 * request plus a conservatively rounded D1 read/write allowance.
 */
export const DAILY_CAPACITY = {
  requests: 50_000,
  reads: 2_000_000,
  writes: 60_000,
  rankedWriteHeadroom: 20_000,
  perFloor: { requests: 500, reads: 20_000, writes: 2_000 },
} as const;

export type CapacityReservation =
  | { accepted: true }
  | { accepted: false; reason: "capacity-exhausted"; resetAt: string };

type CapacityRow = {
  requests_reserved: number;
  reads_reserved: number;
  writes_reserved: number;
  ranked_writes_reserved: number;
};

/**
 * Admission-only quota guard. Accepted sessions have their whole floor
 * allowance reserved up front, so later actions do not compete with new
 * admissions. All dates are UTC calendar days, matching Cloudflare resets.
 */
export class D1CapacityBudget {
  constructor(private readonly database: D1Database) {}

  async reserve(
    floorSessionId: string,
    mode: CapacityMode,
    now: Date,
  ): Promise<CapacityReservation> {
    const day = utcDay(now);
    const stamp = now.toISOString();
    const resetAt = nextUtcMidnight(now).toISOString();
    try {
      return await this.reserveForDay(floorSessionId, mode, day, stamp, resetAt);
    } catch {
      // An unavailable ledger must never permit a new floor. The caller gets
      // the same stable, retryable response as an exhausted budget; the next
      // UTC reset is the earliest safe point at which to retry admission.
      return { accepted: false, reason: "capacity-exhausted", resetAt };
    }
  }

  private async reserveForDay(
    floorSessionId: string,
    mode: CapacityMode,
    day: string,
    stamp: string,
    resetAt: string,
  ): Promise<CapacityReservation> {
    const existing = await this.database
      .prepare(
        "SELECT floor_session_id FROM daily_capacity_reservations WHERE floor_session_id = ?",
      )
      .bind(floorSessionId)
      .first<{ floor_session_id: string }>();
    if (existing) return { accepted: true };

    await this.database.batch([
      this.database
        .prepare("INSERT OR IGNORE INTO daily_capacity (day_utc, updated_at) VALUES (?, ?)")
        .bind(day, stamp),
    ]);

    const floor = DAILY_CAPACITY.perFloor;
    const practiceHeadroom = mode === "practice" ? DAILY_CAPACITY.rankedWriteHeadroom : 0;
    const updated = await this.database.batch([
      this.database
        .prepare(
          `UPDATE daily_capacity
           SET requests_reserved = requests_reserved + ?, reads_reserved = reads_reserved + ?,
               writes_reserved = writes_reserved + ?,
               ranked_writes_reserved = ranked_writes_reserved + ?, updated_at = ?
           WHERE day_utc = ?
             AND requests_reserved + ? <= ?
             AND reads_reserved + ? <= ?
             AND writes_reserved + ? + ? <= ?`,
        )
        .bind(
          floor.requests,
          floor.reads,
          floor.writes,
          mode === "ranked" ? floor.writes : 0,
          stamp,
          day,
          floor.requests,
          DAILY_CAPACITY.requests,
          floor.reads,
          DAILY_CAPACITY.reads,
          floor.writes,
          practiceHeadroom,
          DAILY_CAPACITY.writes,
        ),
    ]);
    if (updated[0]?.meta?.changes !== 1)
      return { accepted: false, reason: "capacity-exhausted", resetAt };

    // The ledger update is deliberately first. If D1 becomes unavailable here,
    // the unused reservation remains fail-closed until UTC reset rather than
    // risking an over-admission.
    await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO daily_capacity_reservations
             (floor_session_id, day_utc, mode, requests_reserved, reads_reserved, writes_reserved, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(floorSessionId, day, mode, floor.requests, floor.reads, floor.writes, stamp),
    ]);
    return { accepted: true };
  }

  async usage(now: Date): Promise<CapacityRow | null> {
    return this.database
      .prepare(
        "SELECT requests_reserved, reads_reserved, writes_reserved, ranked_writes_reserved FROM daily_capacity WHERE day_utc = ?",
      )
      .bind(utcDay(now))
      .first<CapacityRow>();
  }
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
