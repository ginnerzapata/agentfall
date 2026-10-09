import type {
  AcceptedActionResult,
  Action,
  ActionRejectionReason,
  ActionResult,
  Direction,
  EngineEvent,
  Observation,
  Position,
  RejectedActionResult,
  ReplayResult,
  RunDefinition,
  Snapshot,
} from "@agentfall/contracts";

export type {
  AcceptedActionResult,
  Action,
  ActionRejectionReason,
  ActionResult,
  Direction,
  EngineEvent,
  Observation,
  Position,
  RejectedActionResult,
  ReplayResult,
  RunDefinition,
  Snapshot,
} from "@agentfall/contracts";

export function createRun(definition: RunDefinition): Snapshot {
  if (definition.board.width < 1 || definition.board.height < 1) {
    throw new Error("Board dimensions must be positive.");
  }

  const snapshot: Omit<Snapshot, "checksum"> = {
    version: 1,
    seed: definition.seed,
    runId: definition.runId,
    board: clone(definition.board),
    turn: 1,
    actionPoints: 4,
    character: clone(definition.character),
    enemies: clone(definition.enemies),
    events: [],
  };

  assertInBounds(snapshot.character.position, snapshot.board);
  for (const enemy of snapshot.enemies) assertInBounds(enemy.position, snapshot.board);
  return withChecksum(snapshot);
}

export function act(snapshot: Snapshot, action: Action): ActionResult {
  switch (action.type) {
    case "move":
      return move(snapshot, action.direction);
    case "attack":
      return attack(snapshot, action.targetId);
    case "end-turn":
      return endTurn(snapshot);
  }
}

export function observe(snapshot: Snapshot): Observation {
  const directions = directionEntries()
    .filter(({ delta }) => canEnter(snapshot, add(snapshot.character.position, delta)))
    .map(({ direction }) => direction);
  const targets = snapshot.enemies
    .filter((enemy) => enemy.health > 0 && isAdjacent(snapshot.character.position, enemy.position))
    .map((enemy) => enemy.id);
  const legalActions: Observation["legalActions"] = [];

  if (snapshot.actionPoints >= 1 && directions.length > 0) {
    legalActions.push({ type: "move", directions });
  }
  if (snapshot.actionPoints >= 2 && targets.length > 0) {
    legalActions.push({ type: "attack", targetIds: targets });
  }
  legalActions.push({ type: "end-turn" });

  return {
    turn: snapshot.turn,
    actionPoints: snapshot.actionPoints,
    character: clone(snapshot.character),
    enemies: clone(snapshot.enemies),
    legalActions,
  };
}

export function replay(definition: RunDefinition, actions: Action[]): ReplayResult {
  let snapshot = createRun(definition);

  for (const action of actions) {
    const result = act(snapshot, action);
    if (!result.accepted) {
      return { accepted: false, snapshot, rejection: result };
    }
    snapshot = result.snapshot;
  }

  return { accepted: true, snapshot };
}

function move(snapshot: Snapshot, direction: Direction): ActionResult {
  const actionPointRejection = rejectForInsufficientActionPoints(snapshot, 1);
  if (actionPointRejection) return actionPointRejection;
  const delta = directionEntries().find((entry) => entry.direction === direction)?.delta;
  if (!delta) throw new Error(`Unknown direction: ${direction}`);
  const to = add(snapshot.character.position, delta);
  if (!canEnter(snapshot, to)) return reject("blocked-destination");

  const event: EngineEvent = {
    type: "move",
    direction,
    from: clone(snapshot.character.position),
    to,
    cost: 1,
  };
  return applyEvent(snapshot, event, (next) => {
    next.character.position = to;
    next.actionPoints -= event.cost;
  });
}

function attack(snapshot: Snapshot, targetId: string): ActionResult {
  const actionPointRejection = rejectForInsufficientActionPoints(snapshot, 2);
  if (actionPointRejection) return actionPointRejection;
  const target = snapshot.enemies.find((enemy) => enemy.id === targetId && enemy.health > 0);
  if (!target || !isAdjacent(snapshot.character.position, target.position)) {
    return reject("invalid-target");
  }

  const eventIndex = snapshot.events.length;
  const roll = rollDie(snapshot, eventIndex, `attack:${targetId}:hit`, 20);
  const damage =
    roll >= 10 + target.defense ? rollDie(snapshot, eventIndex, `attack:${targetId}:damage`, 6) : 0;
  const event: EngineEvent = {
    type: "attack",
    targetId,
    roll,
    damage,
    cost: 2,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextTarget = next.enemies.find((enemy) => enemy.id === targetId);
    if (!nextTarget) throw new Error("Target disappeared during resolution.");
    nextTarget.health = Math.max(0, nextTarget.health - damage);
    next.actionPoints -= event.cost;
  });
}

function endTurn(snapshot: Snapshot): ActionResult {
  const event: EngineEvent = { type: "end-turn" };
  return applyEvent(snapshot, event, (next) => {
    next.turn += 1;
    next.actionPoints = 4;
  });
}

function applyEvent(
  snapshot: Snapshot,
  event: EngineEvent,
  update: (next: Snapshot) => void,
): AcceptedActionResult {
  const next = clone(snapshot);
  update(next);
  next.events.push(event);
  return { accepted: true, snapshot: withChecksum(next), event };
}

function withChecksum(snapshot: Omit<Snapshot, "checksum">): Snapshot {
  return {
    ...snapshot,
    checksum: hash(stableStringify(snapshot)).toString(16).padStart(8, "0"),
  };
}

function rollDie(snapshot: Snapshot, eventIndex: number, purpose: string, sides: number): number {
  return (hash(`${snapshot.seed}:${snapshot.runId}:${eventIndex}:${purpose}`) % sides) + 1;
}

function canEnter(snapshot: Snapshot, position: Position): boolean {
  return (
    isInBounds(position, snapshot.board) &&
    !snapshot.enemies.some((enemy) => enemy.health > 0 && samePosition(enemy.position, position))
  );
}

function rejectForInsufficientActionPoints(
  snapshot: Snapshot,
  cost: number,
): RejectedActionResult | undefined {
  return snapshot.actionPoints < cost ? reject("insufficient-action-points") : undefined;
}

function reject(reason: ActionRejectionReason): RejectedActionResult {
  return { accepted: false, reason };
}

function assertInBounds(position: Position, board: Snapshot["board"]): void {
  if (!isInBounds(position, board)) throw new Error("Position is outside the board.");
}

function isInBounds(position: Position, board: Snapshot["board"]): boolean {
  return (
    position.x >= 0 && position.x < board.width && position.y >= 0 && position.y < board.height
  );
}

function isAdjacent(a: Position, b: Position): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

function add(position: Position, delta: Position): Position {
  return { x: position.x + delta.x, y: position.y + delta.y };
}

function directionEntries(): Array<{ direction: Direction; delta: Position }> {
  return [
    { direction: "north", delta: { x: 0, y: -1 } },
    { direction: "east", delta: { x: 1, y: 0 } },
    { direction: "south", delta: { x: 0, y: 1 } },
    { direction: "west", delta: { x: -1, y: 0 } },
  ];
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return result >>> 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
