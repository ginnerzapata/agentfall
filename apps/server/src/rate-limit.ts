import type { D1Database } from "./persistence";

export type RateLimitScope = "request" | "active-floor-mutation";

export interface RateLimiter {
  allow(scope: RateLimitScope, clientKey: string, now: number): Promise<boolean>;
}

const LIMITS: Record<RateLimitScope, number> = {
  request: 60,
  // Active sessions get a separate, intentionally larger budget so a noisy
  // read endpoint cannot strand an admitted expedition.
  "active-floor-mutation": 120,
};

/** D1 uses one conditional UPSERT, so increments and admission are atomic. */
export class D1RateLimiter implements RateLimiter {
  constructor(private readonly database: D1Database) {}

  async allow(scope: RateLimitScope, clientKey: string, now: number): Promise<boolean> {
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const row = await this.database
      .prepare(
        `INSERT INTO rate_limits (scope, client_key, window_start, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(scope, client_key, window_start)
         DO UPDATE SET count = count + 1 WHERE count < ?
         RETURNING count`,
      )
      .bind(scope, clientKey, windowStart, LIMITS[scope])
      .first<{ count: number }>();
    return row !== null;
  }
}
