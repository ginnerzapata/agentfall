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
  board: Board;
  character: CharacterState;
  enemies: EnemyState[];
};

export type Action =
  | { type: "move"; direction: Direction }
  | { type: "attack"; targetId: string }
  | { type: "end-turn" };

export type EngineEvent =
  | {
      type: "move";
      direction: Direction;
      from: Position;
      to: Position;
      cost: 1;
    }
  | { type: "attack"; targetId: string; roll: number; damage: number; cost: 2 }
  | { type: "end-turn" };

export type Snapshot = {
  version: 1;
  seed: string;
  runId: string;
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
    };
