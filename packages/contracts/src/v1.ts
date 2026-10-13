// These versions describe serialized values, not the contracts package version.
export const SNAPSHOT_SCHEMA_VERSION = 8;
export const ENGINE_EVENT_SCHEMA_VERSION = 8;
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
export const ABILITY_ACTION_POINT_COST = {
  guard: 2,
  shove: 2,
  scout: 2,
  disengagingShot: 3,
  arcBolt: 2,
  ward: 2,
} as const;
export const ARC_BOLT_RANGE = 4;
export const SCOUT_RANGE = 8;

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

export type CharacterClass = "vanguard" | "ranger" | "arcanist";

/**
 * A class-neutral route through the required floor sequence. Closed doors are
 * traversable because opening them is a universal Action; walls are not.
 */
export type MandatoryObjectivePath = {
  characterClass: CharacterClass;
  positions: Position[];
};

/** Static reachability evidence used when accepting authored floor content. */
export type MandatoryObjectiveSolvability = {
  solvable: boolean;
  paths: MandatoryObjectivePath[];
};

export type CharacterDefinition = CombatantStats & {
  position: Position;
  class?: CharacterClass;
  /** A rare item that automatically prevents one otherwise lethal event. */
  resurrectionCharges?: 0 | 1;
};

/** Defense granted for the interval between ending a turn and the next accepted Action. */
export type CharacterState = CharacterDefinition & {
  temporaryDefense: number;
  resurrectionCharges: 0 | 1;
  dead: boolean;
  guardedTiles: Position[];
  guardExpiresTurn: number;
  ward: number;
  wardExpiresTurn: number;
};

/** A small, content-selected behavior tree evaluated at the end of each player turn. */
export type EnemyBehavior = "pursue" | "skirmish" | "hold";

export type EnemyState = CombatantStats & {
  id: string;
  position: Position;
  behavior?: EnemyBehavior;
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
  | { type: "guard" }
  | { type: "shove"; targetId: string }
  | { type: "scout"; direction: Direction }
  | { type: "disengaging-shot"; targetId: string }
  | { type: "arc-bolt"; targetId: string }
  | { type: "ward" }
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
      triggeredTrap?: { id: string; damage: number; outcome: CharacterDamageOutcome };
    }
  | { type: "attack"; targetId: string; roll: number; damage: number; cost: 2 }
  | { type: "interact"; target: Position; interaction: "objective" | "exit"; cost: 1 }
  | { type: "open-chest"; target: Position; objectId: string; itemId: string; cost: 1 }
  | { type: "pickup-item"; target: Position; objectId: string; itemId: string; cost: 1 }
  | { type: "use-sanctuary"; target: Position; objectId: string; healing: number; cost: 1 }
  | { type: "open-door" | "close-door"; target: Position; cost: 1 }
  | { type: "guard"; protectedTiles: Position[]; expiresTurn: number; cost: 2 }
  | {
      type: "shove";
      targetId: string;
      to?: Position;
      damage: number;
      triggeredTrap?: { id: string; damage: number };
      cost: 2;
    }
  | { type: "scout"; direction: Direction; revealed: Position[]; cost: 2 }
  | {
      type: "disengaging-shot";
      targetId: string;
      roll: number;
      damage: number;
      to: Position;
      cost: 3;
    }
  | { type: "arc-bolt"; targetId: string; damage: number; cost: 2 }
  | { type: "ward"; protection: number; expiresTurn: number; cost: 2 }
  | {
      type: "end-turn";
      temporaryDefense: number;
      enemyMoves: Array<{ enemyId: string; from: Position; to: Position }>;
    }
);

/** The irreversible result of a damaging event, stored for replay. */
export type CharacterDamageOutcome = {
  health: number;
  died: boolean;
  resurrected: boolean;
};

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
  | { type: "guard" }
  | { type: "shove"; targetIds: string[] }
  | { type: "scout"; directions: Direction[] }
  | { type: "disengaging-shot"; targetIds: string[] }
  | { type: "arc-bolt"; targetIds: string[] }
  | { type: "ward" }
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
  inCombat: boolean;
  attackPreviews: AttackPreview[];
  legalActions: LegalAction[];
};

/** Public odds calculated from visible statistics; it never contains a future RNG result. */
export type AttackPreview = {
  targetId: string;
  hitProbability: number;
  damageRange: { minimum: number; maximum: number };
};

export type ActionRejectionReason =
  | "insufficient-action-points"
  | "blocked-destination"
  | "invalid-target"
  | "invalid-interaction"
  | "invalid-ability"
  | "character-dead";

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
