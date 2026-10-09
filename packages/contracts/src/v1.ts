// These versions describe serialized values, not the contracts package version.
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const ENGINE_EVENT_SCHEMA_VERSION = 1;

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Value is not JSON serializable.");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(",")}}`;
}

export type Direction = "north" | "east" | "south" | "west";

export type Position = {
  x: number;
  y: number;
};

export type Board = {
  width: number;
  height: number;
};

export type CharacterState = {
  position: Position;
  health: number;
};

export type EnemyState = {
  id: string;
  position: Position;
  health: number;
  defense: number;
};

export type RunDefinition = {
  seed: string;
  runId: string;
  rulesetVersion: string;
  generatorVersion: string;
  board: Board;
  character: CharacterState;
  enemies: EnemyState[];
};

export type Action =
  | { type: "move"; direction: Direction }
  | { type: "attack"; targetId: string }
  | { type: "end-turn" };

export type EngineEvent = {
  schemaVersion: typeof ENGINE_EVENT_SCHEMA_VERSION;
} & (
  | {
      type: "move";
      direction: Direction;
      from: Position;
      to: Position;
      cost: 1;
    }
  | { type: "attack"; targetId: string; roll: number; damage: number; cost: 2 }
  | { type: "end-turn" }
);

export type Snapshot = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  seed: string;
  runId: string;
  rulesetVersion: string;
  generatorVersion: string;
  board: Board;
  turn: number;
  actionPoints: number;
  character: CharacterState;
  enemies: EnemyState[];
  events: EngineEvent[];
  checksum: string;
};

export type LegalAction =
  | { type: "move"; directions: Direction[] }
  | { type: "attack"; targetIds: string[] }
  | { type: "end-turn" };

export type Observation = {
  turn: number;
  actionPoints: number;
  character: CharacterState;
  enemies: EnemyState[];
  legalActions: LegalAction[];
};

export type ActionRejectionReason =
  | "insufficient-action-points"
  | "blocked-destination"
  | "invalid-target";

export type RunDefinitionRejectionReason =
  | "invalid-board-dimensions"
  | "invalid-character-stats"
  | "invalid-enemy-stats"
  | "duplicate-entity-id"
  | "duplicate-occupancy"
  | "invalid-starting-position"
  | "invalid-ruleset-version"
  | "invalid-generator-version";

export type AcceptedCreateRunResult = {
  accepted: true;
  snapshot: Snapshot;
};

export type RejectedCreateRunResult = {
  accepted: false;
  reason: RunDefinitionRejectionReason;
};

export type CreateRunResult = AcceptedCreateRunResult | RejectedCreateRunResult;

export type AcceptedActionResult = {
  accepted: true;
  snapshot: Snapshot;
  event: EngineEvent;
};

export type RejectedActionResult = {
  accepted: false;
  reason: ActionRejectionReason;
};

export type ActionResult = AcceptedActionResult | RejectedActionResult;

export type ReplayResult =
  | { accepted: true; snapshot: Snapshot }
  | {
      accepted: false;
      snapshot: Snapshot;
      rejection: RejectedActionResult;
    }
  | { accepted: false; rejection: RejectedCreateRunResult };

export type RecordedEventReplayRejection = {
  accepted: false;
  eventIndex: number;
  reason: "unsupported-event-schema-version" | "invalid-recorded-event";
};

export type ReplayEventsResult =
  | { accepted: true; snapshot: Snapshot }
  | { accepted: false; snapshot: Snapshot; rejection: RecordedEventReplayRejection }
  | { accepted: false; rejection: RejectedCreateRunResult };
