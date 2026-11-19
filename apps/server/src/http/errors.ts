import type { Context } from "hono";

import type { CommitActionResult } from "../persistence";

export type TransportErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "STALE_SNAPSHOT"
  | "INVALID_ACTION"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "CAPACITY_EXHAUSTED"
  | "REQUEST_TOO_LARGE"
  | "AUTH_REQUIRED"
  | "AUTH_UNAVAILABLE"
  | "INVALID_DISPLAY_NAME"
  | "DISPLAY_NAME_TAKEN"
  | "ALREADY_ENROLLED"
  | "INVALID_SEASON_TRANSITION"
  | "INTERNAL";

export function failure(
  context: Context,
  status: 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
  code: TransportErrorCode,
) {
  return context.json({ error: { code, requestId: context.get("requestId") } }, status);
}

export function actionFailure(
  context: Context,
  result: Exclude<CommitActionResult, { accepted: true }>,
) {
  switch (result.reason) {
    case "not-found":
      return failure(context, 404, "NOT_FOUND");
    case "stale-snapshot":
      return failure(context, 409, "STALE_SNAPSHOT");
    case "invalid-action":
      return failure(context, 422, "INVALID_ACTION");
    case "idempotency-conflict":
      return failure(context, 409, "IDEMPOTENCY_CONFLICT");
  }
}

/** Typed capacity failures always expose the UTC reset boundary, never quota internals. */
export function capacityFailure(context: Context, resetAt: string) {
  context.header(
    "retry-after",
    String(Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000))),
  );
  return context.json(
    { error: { code: "CAPACITY_EXHAUSTED", resetAt, requestId: context.get("requestId") } },
    503,
  );
}
