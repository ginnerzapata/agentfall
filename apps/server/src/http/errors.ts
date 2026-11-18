import type { Context } from "hono";

import type { CommitActionResult } from "../persistence";

export type TransportErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "STALE_SNAPSHOT"
  | "INVALID_ACTION"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "REQUEST_TOO_LARGE"
  | "AUTH_REQUIRED"
  | "AUTH_UNAVAILABLE"
  | "INVALID_DISPLAY_NAME"
  | "DISPLAY_NAME_TAKEN"
  | "ALREADY_ENROLLED"
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
