import type { D1Database } from "./floor-store";

export type StandingCandidate = {
  seasonId: string;
  accountId: string;
  bestFloor: number;
  bossesDefeated: number;
  characterDeaths: number;
  floorTurns: number;
  achievedAt: string;
};

/**
 * Stores an account's seasonal best using the PRD ordering: highest completed
 * floor, most bosses, fewest deaths, fewest turns, then earliest achievement.
 */
export class D1Standings {
  constructor(private readonly database: D1Database) {}

  async record(candidate: StandingCandidate): Promise<boolean> {
    if (!validCandidate(candidate)) return false;
    const result = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO standings
             (season_id, account_id, best_floor, bosses_defeated, character_deaths, floor_turns, achieved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(season_id, account_id) DO UPDATE SET
             best_floor = excluded.best_floor,
             bosses_defeated = excluded.bosses_defeated,
             character_deaths = excluded.character_deaths,
             floor_turns = excluded.floor_turns,
             achieved_at = excluded.achieved_at
           WHERE excluded.best_floor > standings.best_floor
              OR (excluded.best_floor = standings.best_floor
                  AND excluded.bosses_defeated > standings.bosses_defeated)
              OR (excluded.best_floor = standings.best_floor
                  AND excluded.bosses_defeated = standings.bosses_defeated
                  AND excluded.character_deaths < standings.character_deaths)
              OR (excluded.best_floor = standings.best_floor
                  AND excluded.bosses_defeated = standings.bosses_defeated
                  AND excluded.character_deaths = standings.character_deaths
                  AND excluded.floor_turns < standings.floor_turns)
              OR (excluded.best_floor = standings.best_floor
                  AND excluded.bosses_defeated = standings.bosses_defeated
                  AND excluded.character_deaths = standings.character_deaths
                  AND excluded.floor_turns = standings.floor_turns
                  AND excluded.achieved_at < standings.achieved_at)`,
        )
        .bind(
          candidate.seasonId,
          candidate.accountId,
          candidate.bestFloor,
          candidate.bossesDefeated,
          candidate.characterDeaths,
          candidate.floorTurns,
          candidate.achievedAt,
        ),
    ]);
    return result[0]?.meta?.changes === 1;
  }
}

function validCandidate(candidate: StandingCandidate): boolean {
  return [
    candidate.bestFloor,
    candidate.bossesDefeated,
    candidate.characterDeaths,
    candidate.floorTurns,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}
