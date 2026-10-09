import type {
  AcceptedActionResult,
  Action,
  ActionRejectionReason,
  ActionResult,
  CreateRunResult,
  Direction,
  EngineEvent,
  Observation,
  Position,
  RecordedEventReplayRejection,
  RejectedActionResult,
  RejectedCreateRunResult,
  ReplayEventsResult,
  ReplayResult,
  RunDefinition,
  RunDefinitionRejectionReason,
  Snapshot,
} from "@agentfall/contracts";
import {
  canonicalStringify,
  ENGINE_EVENT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
} from "@agentfall/contracts";

export type {
  AcceptedActionResult,
  AcceptedCreateRunResult,
  Action,
  ActionRejectionReason,
  ActionResult,
  CreateRunResult,
  Direction,
  EngineEvent,
  Observation,
  Position,
  RecordedEventReplayRejection,
  RejectedActionResult,
  RejectedCreateRunResult,
  ReplayEventsResult,
  ReplayResult,
  RunDefinition,
  RunDefinitionRejectionReason,
  Snapshot,
} from "@agentfall/contracts";

export function createRun(definition: RunDefinition): CreateRunResult {
  const rejection = validateRunDefinition(definition);
  if (rejection) return rejection;

  const snapshot: Omit<Snapshot, "checksum"> = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    seed: definition.seed,
    runId: definition.runId,
    rulesetVersion: definition.rulesetVersion,
    generatorVersion: definition.generatorVersion,
    board: clone(definition.board),
    turn: 1,
    actionPoints: 4,
    character: clone(definition.character),
    enemies: clone(definition.enemies).sort(compareEnemies),
    events: [],
  };

  return { accepted: true, snapshot: withChecksum(snapshot) };
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
  const created = createRun(definition);
  if (!created.accepted) return { accepted: false, rejection: created };
  let snapshot = created.snapshot;

  for (const action of actions) {
    const result = act(snapshot, action);
    if (!result.accepted) {
      return { accepted: false, snapshot, rejection: result };
    }
    snapshot = result.snapshot;
  }

  return { accepted: true, snapshot };
}

export function replayEvents(definition: RunDefinition, events: EngineEvent[]): ReplayEventsResult {
  const created = createRun(definition);
  if (!created.accepted) return { accepted: false, rejection: created };
  let snapshot = created.snapshot;

  for (const [eventIndex, event] of events.entries()) {
    const result = applyRecordedEvent(snapshot, event, eventIndex);
    if (!result.accepted) return { accepted: false, snapshot, rejection: result };
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
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
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
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
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
  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "end-turn",
  };
  return applyEvent(snapshot, event, (next) => {
    next.turn += 1;
    next.actionPoints = 4;
  });
}

function applyRecordedEvent(
  snapshot: Snapshot,
  event: EngineEvent,
  eventIndex: number,
): { accepted: true; snapshot: Snapshot } | RecordedEventReplayRejection {
  if (event.schemaVersion !== ENGINE_EVENT_SCHEMA_VERSION) {
    return rejectRecordedEvent(eventIndex, "unsupported-event-schema-version");
  }

  switch (event.type) {
    case "move": {
      const delta = directionEntries().find((entry) => entry.direction === event.direction)?.delta;
      if (
        event.cost !== 1 ||
        !delta ||
        snapshot.actionPoints < event.cost ||
        !samePosition(snapshot.character.position, event.from) ||
        !samePosition(add(event.from, delta), event.to) ||
        !canEnter(snapshot, event.to)
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          next.character.position = clone(event.to);
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    }
    case "attack": {
      const target = snapshot.enemies.find(
        (enemy) => enemy.id === event.targetId && enemy.health > 0,
      );
      if (
        event.cost !== 2 ||
        snapshot.actionPoints < event.cost ||
        !isDieRoll(event.roll, 20) ||
        !isDieRoll(event.damage, 6, true) ||
        !target ||
        !isAdjacent(snapshot.character.position, target.position)
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          const nextTarget = next.enemies.find((enemy) => enemy.id === event.targetId);
          if (!nextTarget) throw new Error("Recorded target disappeared during replay.");
          nextTarget.health = Math.max(0, nextTarget.health - event.damage);
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    }
    case "end-turn":
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          next.turn += 1;
          next.actionPoints = 4;
        }).snapshot,
      };
  }
}

function applyEvent(
  snapshot: Snapshot,
  event: EngineEvent,
  update: (next: Snapshot) => void,
): AcceptedActionResult {
  const next = clone(snapshot);
  update(next);
  next.events.push(clone(event));
  return { accepted: true, snapshot: withChecksum(next), event };
}

function withChecksum(snapshot: Omit<Snapshot, "checksum">): Snapshot {
  return {
    ...snapshot,
    checksum: hash(canonicalStringify(snapshot)).toString(16).padStart(8, "0"),
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

function rejectRecordedEvent(
  eventIndex: number,
  reason: RecordedEventReplayRejection["reason"],
): RecordedEventReplayRejection {
  return { accepted: false, eventIndex, reason };
}

function validateRunDefinition(definition: RunDefinition): RejectedCreateRunResult | undefined {
  if (!isPositiveInteger(definition.board.width) || !isPositiveInteger(definition.board.height)) {
    return rejectRunDefinition("invalid-board-dimensions");
  }
  if (!isPositiveInteger(definition.character.health)) {
    return rejectRunDefinition("invalid-character-stats");
  }
  if (!isNonEmptyString(definition.rulesetVersion)) {
    return rejectRunDefinition("invalid-ruleset-version");
  }
  if (!isNonEmptyString(definition.generatorVersion)) {
    return rejectRunDefinition("invalid-generator-version");
  }
  if (!isInBounds(definition.character.position, definition.board)) {
    return rejectRunDefinition("invalid-starting-position");
  }

  const entityIds = new Set<string>();
  const occupiedPositions = new Set([positionKey(definition.character.position)]);
  for (const enemy of definition.enemies) {
    if (!isPositiveInteger(enemy.health) || !isNonNegativeInteger(enemy.defense)) {
      return rejectRunDefinition("invalid-enemy-stats");
    }
    if (entityIds.has(enemy.id)) return rejectRunDefinition("duplicate-entity-id");
    entityIds.add(enemy.id);
    if (!isInBounds(enemy.position, definition.board)) {
      return rejectRunDefinition("invalid-starting-position");
    }

    const key = positionKey(enemy.position);
    if (occupiedPositions.has(key)) return rejectRunDefinition("duplicate-occupancy");
    occupiedPositions.add(key);
  }
}

function rejectRunDefinition(reason: RunDefinitionRejectionReason): RejectedCreateRunResult {
  return { accepted: false, reason };
}

function isInBounds(position: Position, board: Snapshot["board"]): boolean {
  return (
    Number.isInteger(position.x) &&
    Number.isInteger(position.y) &&
    position.x >= 0 &&
    position.x < board.width &&
    position.y >= 0 &&
    position.y < board.height
  );
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDieRoll(value: number, sides: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= sides;
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function isAdjacent(a: Position, b: Position): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

function compareEnemies(
  left: Snapshot["enemies"][number],
  right: Snapshot["enemies"][number],
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
