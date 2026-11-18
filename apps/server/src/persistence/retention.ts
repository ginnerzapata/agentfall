/** The PRD retention policy expressed as explicit, reviewable database work. */
export const PRACTICE_REPLAY_RETENTION_DAYS = 14;

export interface RetentionDatabase {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
  batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]>;
}

/**
 * Active ranked histories are never touched. After seed reveal, non-qualifying
 * ranked runs are compacted to their stored run/standing summaries; practice
 * event history expires after the short debugging window.
 */
export async function applyHistoricalRetention(
  database: RetentionDatabase,
  now: string,
  practiceCutoff: string,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `DELETE FROM events WHERE floor_session_id IN (
        SELECT fs.id FROM floor_sessions fs JOIN runs r ON r.id = fs.run_id
        WHERE r.mode = 'practice' AND fs.created_at < ?
      )`,
      )
      .bind(practiceCutoff),
    database
      .prepare(
        `DELETE FROM snapshots WHERE floor_session_id IN (
        SELECT fs.id FROM floor_sessions fs JOIN runs r ON r.id = fs.run_id
        WHERE r.mode = 'practice' AND fs.created_at < ?
      )`,
      )
      .bind(practiceCutoff),
    database
      .prepare(
        `DELETE FROM events WHERE floor_session_id IN (
        SELECT fs.id FROM floor_sessions fs
        JOIN runs r ON r.id = fs.run_id JOIN seasons s ON s.id = r.season_id
        LEFT JOIN standings st ON st.season_id = r.season_id AND st.account_id = r.account_id
        WHERE r.mode = 'ranked' AND s.state = 'revealed' AND s.retention_state = 'historical'
          AND (st.best_floor < fs.floor OR st.best_floor IS NULL)
      )`,
      )
      .bind(),
    database
      .prepare(
        "UPDATE seasons SET retention_state = 'compacted', updated_at = ? WHERE state = 'revealed' AND retention_state = 'historical'",
      )
      .bind(now),
  ]);
}
