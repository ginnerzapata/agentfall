import type { D1Database } from "./floor-store";

type ReplayRow = { season_id: string; floor: number; state: string };
type RunRow = { state_json: string };

export type ReplayVisibility =
  | { allowed: true; reason: "season-revealed" | "floor-completed" }
  | { allowed: false; reason: "not-found" | "floor-not-completed" };

/**
 * Active-season replays are visible only after the viewer has completed that
 * floor. The restriction is lifted once the seed-revealed season is public.
 */
export class D1ReplayVisibility {
  constructor(private readonly database: D1Database) {}

  async canView(viewerAccountId: string, floorSessionId: string): Promise<ReplayVisibility> {
    const replay = await this.database
      .prepare(
        `SELECT runs.season_id, floor_sessions.floor, seasons.state
         FROM floor_sessions
         JOIN runs ON runs.id = floor_sessions.run_id
         JOIN seasons ON seasons.id = runs.season_id
         WHERE floor_sessions.id = ?`,
      )
      .bind(floorSessionId)
      .first<ReplayRow>();
    if (!replay) return { allowed: false, reason: "not-found" };
    if (replay.state === "revealed") return { allowed: true, reason: "season-revealed" };
    const runs = await this.database
      .prepare(
        "SELECT state_json FROM runs WHERE account_id = ? AND season_id = ? AND mode = 'ranked'",
      )
      .bind(viewerAccountId, replay.season_id)
      .all<RunRow>();
    return runs.results.some((run) => completedFloors(run.state_json) >= replay.floor)
      ? { allowed: true, reason: "floor-completed" }
      : { allowed: false, reason: "floor-not-completed" };
  }
}

function completedFloors(stateJson: string): number {
  try {
    const state = JSON.parse(stateJson) as { completedFloors?: unknown };
    return Number.isSafeInteger(state.completedFloors) && (state.completedFloors as number) >= 0
      ? (state.completedFloors as number)
      : 0;
  } catch {
    return 0;
  }
}
