import {
  type Action,
  canonicalStringify,
  type EngineEvent,
  type RunDefinition,
  type Snapshot,
} from "@agentfall/contracts";
import { act, replayEvents } from "@agentfall/engine";

/** A deliberately small structural subset of the Workers D1 API. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

type SnapshotRow = {
  version: number;
  checksum: string;
  snapshot_json: string;
};

type ReceiptRow = { request_hash: string; response_json: string };
type EventRow = { event_json: string };

export type StoredFloorSnapshot = { version: number; snapshot: Snapshot };

export type CommitActionInput = {
  floorSessionId: string;
  idempotencyKey: string;
  expectedSnapshotVersion: number;
  action: Action;
  now: string;
};

export type CommitActionResult =
  | { accepted: true; replayed: false; version: number; snapshot: Snapshot; event: EngineEvent }
  | { accepted: true; replayed: true; version: number; snapshot: Snapshot; event: EngineEvent }
  | {
      accepted: false;
      reason: "stale-snapshot" | "invalid-action" | "idempotency-conflict" | "not-found";
    };

/**
 * Port consumed by application use-cases. It intentionally has no observation
 * method: reads are loaded directly and never create persistence side effects.
 */
export interface FloorStore {
  loadSnapshot(floorSessionId: string): Promise<StoredFloorSnapshot | null>;
  commitAction(input: CommitActionInput): Promise<CommitActionResult>;
  verifyReplay(floorSessionId: string): Promise<ReplayIntegrityResult>;
}

export type ReplayIntegrityResult =
  | { valid: true; eventCount: number; checksum: string }
  | {
      valid: false;
      reason: "not-found" | "invalid-definition" | "invalid-event" | "checksum-mismatch";
    };

/**
 * D1 adapter. The single batch conditionally inserts the event, advances the
 * snapshot, and records the idempotent result. Every write is guarded by the
 * old snapshot version, so a losing concurrent request changes nothing.
 */
export class D1FloorStore implements FloorStore {
  constructor(private readonly database: D1Database) {}

  async loadSnapshot(floorSessionId: string): Promise<StoredFloorSnapshot | null> {
    const row = await this.database
      .prepare("SELECT version, checksum, snapshot_json FROM snapshots WHERE floor_session_id = ?")
      .bind(floorSessionId)
      .first<SnapshotRow>();
    if (!row) return null;
    const snapshot = parseJson<Snapshot>(row.snapshot_json);
    return snapshot.checksum === row.checksum ? { version: row.version, snapshot } : null;
  }

  async commitAction(input: CommitActionInput): Promise<CommitActionResult> {
    const requestHash = canonicalStringify(input.action);
    const receipt = await this.receipt(input.floorSessionId, input.idempotencyKey);
    if (receipt) return replayReceipt(receipt, requestHash);

    const stored = await this.loadSnapshot(input.floorSessionId);
    if (!stored) return { accepted: false, reason: "not-found" };
    if (stored.version !== input.expectedSnapshotVersion)
      return { accepted: false, reason: "stale-snapshot" };

    const transition = act(stored.snapshot, input.action);
    if (!transition.accepted) return { accepted: false, reason: "invalid-action" };

    const committed: CommitActionResult = {
      accepted: true,
      replayed: false,
      version: stored.version + 1,
      snapshot: transition.snapshot,
      event: transition.event,
    };
    const responseJson = canonicalStringify(committed);
    const sequence = stored.snapshot.events.length;

    // D1 batch is transactional. Each statement is additionally conditional,
    // which turns a stale version into three no-ops instead of a partial write.
    const batch = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO events (id, floor_session_id, sequence, event_json, checksum, created_at)
         SELECT ?, ?, ?, ?, ?, ? FROM snapshots WHERE floor_session_id = ? AND version = ?`,
        )
        .bind(
          `${input.floorSessionId}:${sequence + 1}`,
          input.floorSessionId,
          sequence + 1,
          canonicalStringify(transition.event),
          transition.snapshot.checksum,
          input.now,
          input.floorSessionId,
          input.expectedSnapshotVersion,
        ),
      this.database
        .prepare(
          `UPDATE snapshots SET version = ?, checksum = ?, snapshot_json = ?, updated_at = ?
         WHERE floor_session_id = ? AND version = ?`,
        )
        .bind(
          stored.version + 1,
          transition.snapshot.checksum,
          canonicalStringify(transition.snapshot),
          input.now,
          input.floorSessionId,
          input.expectedSnapshotVersion,
        ),
      this.database
        .prepare(
          `INSERT INTO mutation_receipts (scope_id, idempotency_key, request_hash, response_json, created_at)
         SELECT ?, ?, ?, ?, ? FROM snapshots WHERE floor_session_id = ? AND version = ?`,
        )
        .bind(
          input.floorSessionId,
          input.idempotencyKey,
          requestHash,
          responseJson,
          input.now,
          input.floorSessionId,
          stored.version + 1,
        ),
    ]);

    if (batch.at(-1)?.meta?.changes === 1) return committed;

    const persisted = await this.receipt(input.floorSessionId, input.idempotencyKey);
    if (persisted) return replayReceipt(persisted, requestHash);
    return { accepted: false, reason: "stale-snapshot" };
  }

  async verifyReplay(floorSessionId: string): Promise<ReplayIntegrityResult> {
    const session = await this.database
      .prepare("SELECT definition_json FROM floor_sessions WHERE id = ?")
      .bind(floorSessionId)
      .first<{ definition_json: string }>();
    const stored = await this.loadSnapshot(floorSessionId);
    if (!session || !stored) return { valid: false, reason: "not-found" };

    let definition: RunDefinition;
    try {
      definition = parseJson<RunDefinition>(session.definition_json);
    } catch {
      return { valid: false, reason: "invalid-definition" };
    }
    const rows = await this.database
      .prepare("SELECT event_json FROM events WHERE floor_session_id = ? ORDER BY sequence")
      .bind(floorSessionId)
      .all<EventRow>();
    let events: EngineEvent[];
    try {
      events = rows.results.map((row) => parseJson<EngineEvent>(row.event_json));
    } catch {
      return { valid: false, reason: "invalid-event" };
    }
    const replayed = replayEvents(definition, events);
    if (!replayed.accepted) return { valid: false, reason: "invalid-event" };
    if (replayed.snapshot.checksum !== stored.snapshot.checksum)
      return { valid: false, reason: "checksum-mismatch" };
    return { valid: true, eventCount: events.length, checksum: stored.snapshot.checksum };
  }

  private receipt(scopeId: string, idempotencyKey: string): Promise<ReceiptRow | null> {
    return this.database
      .prepare(
        "SELECT request_hash, response_json FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?",
      )
      .bind(scopeId, idempotencyKey)
      .first<ReceiptRow>();
  }
}

function replayReceipt(receipt: ReceiptRow, requestHash: string): CommitActionResult {
  if (receipt.request_hash !== requestHash)
    return { accepted: false, reason: "idempotency-conflict" };
  const original = parseJson<CommitActionResult>(receipt.response_json);
  if (!original.accepted) throw new Error("Mutation receipts must contain accepted results.");
  return { ...original, replayed: true };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
