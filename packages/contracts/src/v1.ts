// These versions describe serialized values, not the contracts package version.
export const SNAPSHOT_SCHEMA_VERSION = 5;
export const ENGINE_EVENT_SCHEMA_VERSION = 5;
export const ACTION_POINT_LIMIT = 4;
export const MAX_TEMPORARY_DEFENSE_FROM_UNUSED_ACTION_POINTS = 2;
export const D20_SIDES = 20;
export const BASIC_ATTACK_HIT_DIFFICULTY = 10;
export const BASIC_ATTACK_DAMAGE_DIE_SIDES = 6;
export const ACTION_POINT_COST = {
  move: 1,
  attack: 2,
  interact: 1,
  openDoor: 1,
  closeDoor: 1,
} as const;

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

export type Terrain = "floor" | "wall" | "entrance" | "objective" | "exit" | "secret";

export type FloorTile = {
  position: Position;
  terrain: Terrain;
  door?: "open" | "closed";
};

export type RememberedTile = FloorTile;

/**
 * The shared mechanical values for every combatant. Health is current health;
 * maxHealth is its upper bound. Movement is retained as an allowance even
 * though the initial move Action advances one tile per AP.
 */
export type CombatantStats = {
  health: number;
  maxHealth: number;
  defense: number;
  movement: number;
  accuracy: number;
  power: number;
  focus: number;
};

export type CharacterDefinition = CombatantStats & {
  position: Position;
};

/** Defense granted for the interval between ending a turn and the next accepted Action. */
export type CharacterState = CharacterDefinition & {
  temporaryDefense: number;
};

export type EnemyState = CombatantStats & {
  id: string;
  position: Position;
};

export type FloorObjectDefinition =
  | { id: string; type: "chest"; position: Position; itemId: string }
  | { id: string; type: "item"; position: Position; itemId: string }
  | { id: string; type: "trap"; position: Position; damage: number }
  | { id: string; type: "sanctuary"; position: Position; healing: number };

export type FloorObjectState = FloorObjectDefinition & { used: boolean };

export type RunDefinition = {
  seed: string;
  runId: string;
  rulesetVersion: string;
  generatorVersion: string;
  board: Board;
  tiles: FloorTile[];
  objects: FloorObjectDefinition[];
  character: CharacterDefinition;
  enemies: EnemyState[];
};

export type Action =
  | { type: "move"; direction: Direction }
  | { type: "attack"; targetId: string }
  | { type: "interact"; target: Position }
  | { type: "open-door"; target: Position }
  | { type: "close-door"; target: Position }
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
      triggeredTrap?: { id: string; damage: number };
    }
  | { type: "attack"; targetId: string; roll: number; damage: number; cost: 2 }
  | { type: "interact"; target: Position; interaction: "objective" | "exit"; cost: 1 }
  | { type: "open-chest"; target: Position; objectId: string; itemId: string; cost: 1 }
  | { type: "pickup-item"; target: Position; objectId: string; itemId: string; cost: 1 }
  | { type: "use-sanctuary"; target: Position; objectId: string; healing: number; cost: 1 }
  | { type: "open-door" | "close-door"; target: Position; cost: 1 }
  | { type: "end-turn"; temporaryDefense: number }
);

export type Snapshot = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  seed: string;
  runId: string;
  rulesetVersion: string;
  generatorVersion: string;
  board: Board;
  tiles: FloorTile[];
  objects: FloorObjectState[];
  rememberedTiles: RememberedTile[];
  objectiveCollected: boolean;
  exitUnlocked: boolean;
  inventory: string[];
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
  | { type: "interact"; targets: Position[] }
  | { type: "open-door"; targets: Position[] }
  | { type: "close-door"; targets: Position[] }
  | { type: "end-turn" };

export type ObservedTile = FloorTile & { visibility: "visible" | "remembered" };
export type ObservedFloorObject = Omit<FloorObjectState, "used">;

export type Observation = {
  turn: number;
  actionPoints: number;
  character: CharacterState;
  enemies: EnemyState[];
  objects: ObservedFloorObject[];
  tiles: ObservedTile[];
  ascii: string;
  legalActions: LegalAction[];
};

export type ActionRejectionReason =
  | "insufficient-action-points"
  | "blocked-destination"
  | "invalid-target"
  | "invalid-interaction";

export type RunDefinitionRejectionReason =
  | "invalid-board-dimensions"
  | "invalid-character-stats"
  | "invalid-enemy-stats"
  | "invalid-floor-object"
  | "duplicate-floor-object-id"
  | "duplicate-entity-id"
  | "duplicate-occupancy"
  | "invalid-starting-position"
  | "invalid-floor-tiles"
  | "duplicate-tile-position"
  | "missing-entrance"
  | "missing-objective"
  | "missing-exit"
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
