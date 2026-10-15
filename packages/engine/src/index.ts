import type {
  AcceptedActionResult,
  Action,
  ActionRejectionReason,
  ActionResult,
  CharacterClass,
  CharacterDamageOutcome,
  CharacterDefinition,
  CharacterState,
  CombatantStats,
  CreateRunResult,
  Direction,
  EnemyBehavior,
  EngineEvent,
  FloorObjectState,
  FloorTile,
  MandatoryObjectivePath,
  MandatoryObjectiveSolvability,
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
  ABILITY_ACTION_POINT_COST,
  ACTION_POINT_COST,
  ACTION_POINT_LIMIT,
  ARC_BOLT_RANGE,
  BACKPACK_SLOT_COUNT,
  BASIC_ATTACK_DAMAGE_DIE_SIDES,
  BASIC_ATTACK_HIT_DIFFICULTY,
  canonicalStringify,
  D20_SIDES,
  ENGINE_EVENT_SCHEMA_VERSION,
  MAX_TEMPORARY_DEFENSE_FROM_UNUSED_ACTION_POINTS,
  SCOUT_RANGE,
  SNAPSHOT_SCHEMA_VERSION,
} from "@agentfall/contracts";

export type {
  AcceptedActionResult,
  AcceptedCreateRunResult,
  Action,
  ActionRejectionReason,
  ActionResult,
  CharacterClass,
  CharacterDamageOutcome,
  CharacterDefinition,
  CharacterState,
  CombatantStats,
  CreateRunResult,
  Direction,
  EnemyBehavior,
  EnemyState,
  EngineEvent,
  FloorObjectState,
  FloorTile,
  MandatoryObjectivePath,
  MandatoryObjectiveSolvability,
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

export {
  ABILITY_ACTION_POINT_COST,
  ACTION_POINT_COST,
  ACTION_POINT_LIMIT,
  ARC_BOLT_RANGE,
  BACKPACK_SLOT_COUNT,
  BASIC_ATTACK_DAMAGE_DIE_SIDES,
  BASIC_ATTACK_HIT_DIFFICULTY,
  D20_SIDES,
  MAX_TEMPORARY_DEFENSE_FROM_UNUSED_ACTION_POINTS,
  SCOUT_RANGE,
} from "@agentfall/contracts";
export * from "./progression";
export * from "./run";

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
    tiles: clone(definition.tiles).sort(compareTiles),
    objects: clone(definition.objects)
      .sort(compareObjects)
      .map((object) => ({ ...object, used: false })),
    rememberedTiles: [],
    objectiveCollected: false,
    exitUnlocked: false,
    inventory: createInventory(definition.character),
    turn: 1,
    actionPoints: ACTION_POINT_LIMIT,
    character: {
      ...clone(definition.character),
      resurrectionCharges: definition.character.resurrectionCharges ?? 0,
      temporaryDefense: 0,
      dead: false,
      guardedTiles: [],
      guardExpiresTurn: 0,
      ward: 0,
      wardExpiresTurn: 0,
    },
    enemies: clone(definition.enemies).sort(compareEnemies),
    events: [],
  };

  updateRememberedTiles(snapshot);
  return { accepted: true, snapshot: withChecksum(snapshot) };
}

/**
 * Checks the mandatory entrance -> objective -> exit route for every class.
 * Class abilities are deliberately excluded: a required route must use only
 * universal movement, door, and interaction rules.
 */
export function evaluateMandatoryObjectiveSolvability(
  definition: RunDefinition,
): MandatoryObjectiveSolvability {
  const classes: CharacterClass[] = ["vanguard", "ranger", "arcanist"];
  const entrance = definition.tiles.find((tile) => tile.terrain === "entrance")?.position;
  const objective = definition.tiles.find((tile) => tile.terrain === "objective")?.position;
  const exit = definition.tiles.find((tile) => tile.terrain === "exit")?.position;
  if (!entrance || !objective || !exit) return { solvable: false, paths: [] };

  const toObjective = mandatoryRoute(definition, entrance, objective);
  const toExit = mandatoryRoute(definition, objective, exit);
  if (!toObjective || !toExit) return { solvable: false, paths: [] };
  const positions = [...toObjective, ...toExit.slice(1)];
  const paths: MandatoryObjectivePath[] = classes.map((characterClass) => ({
    characterClass,
    positions: clone(positions),
  }));
  return { solvable: true, paths };
}

export function act(snapshot: Snapshot, action: Action): ActionResult {
  if (snapshot.character.dead) return reject("character-dead");
  switch (action.type) {
    case "move":
      return move(snapshot, action.direction);
    case "attack":
      return attack(snapshot, action.targetId);
    case "interact":
      return interact(snapshot, action.target);
    case "open-door":
      return changeDoor(snapshot, action.target, "open");
    case "close-door":
      return changeDoor(snapshot, action.target, "closed");
    case "guard":
      return guard(snapshot);
    case "shove":
      return shove(snapshot, action.targetId);
    case "scout":
      return scout(snapshot, action.direction);
    case "disengaging-shot":
      return disengagingShot(snapshot, action.targetId);
    case "arc-bolt":
      return arcBolt(snapshot, action.targetId);
    case "drop-item":
      return dropItem(snapshot, action.slot);
    case "ward":
      return ward(snapshot);
    case "end-turn":
      return endTurn(snapshot);
  }
}

export function observe(snapshot: Snapshot): Observation {
  const visiblePositions = visiblePositionKeys(snapshot);
  const directions = directionEntries()
    .filter(({ delta }) => canEnter(snapshot, add(snapshot.character.position, delta)))
    .map(({ direction }) => direction);
  const targets = snapshot.enemies
    .filter(
      (enemy) =>
        enemy.health > 0 &&
        visiblePositions.has(positionKey(enemy.position)) &&
        isAdjacent(snapshot.character.position, enemy.position),
    )
    .map((enemy) => enemy.id);
  const legalActions: Observation["legalActions"] = [];

  if (snapshot.actionPoints >= 1 && directions.length > 0) {
    legalActions.push({ type: "move", directions });
  }
  if (snapshot.actionPoints >= 2 && targets.length > 0) {
    legalActions.push({ type: "attack", targetIds: targets });
  }
  const adjacentTiles = directionEntries()
    .map(({ delta }) => add(snapshot.character.position, delta))
    .filter((position) => visiblePositions.has(positionKey(position)));
  const interactTargets = adjacentTiles.filter((position) => canInteract(snapshot, position));
  const openDoors = adjacentTiles.filter(
    (position) => tileAt(snapshot, position)?.door === "closed",
  );
  const closeDoors = adjacentTiles.filter(
    (position) => tileAt(snapshot, position)?.door === "open",
  );
  if (snapshot.actionPoints >= 1 && interactTargets.length > 0) {
    legalActions.push({ type: "interact", targets: interactTargets });
  }
  if (snapshot.actionPoints >= 1 && openDoors.length > 0) {
    legalActions.push({ type: "open-door", targets: openDoors });
  }
  if (snapshot.actionPoints >= 1 && closeDoors.length > 0) {
    legalActions.push({ type: "close-door", targets: closeDoors });
  }
  const characterClass = snapshot.character.class;
  const adjacentEnemies = targets;
  if (characterClass === "vanguard" && snapshot.actionPoints >= ABILITY_ACTION_POINT_COST.guard) {
    legalActions.push({ type: "guard" });
  }
  if (
    characterClass === "vanguard" &&
    snapshot.actionPoints >= ABILITY_ACTION_POINT_COST.shove &&
    adjacentEnemies.length > 0
  ) {
    legalActions.push({ type: "shove", targetIds: adjacentEnemies });
  }
  if (characterClass === "ranger" && snapshot.actionPoints >= ABILITY_ACTION_POINT_COST.scout) {
    legalActions.push({
      type: "scout",
      directions: directionEntries().map(({ direction }) => direction),
    });
  }
  if (
    characterClass === "ranger" &&
    snapshot.actionPoints >= ABILITY_ACTION_POINT_COST.disengagingShot
  ) {
    const disengagingTargets = adjacentEnemies.filter((targetId) => {
      const target = adjacentLivingEnemy(snapshot, targetId);
      return target !== undefined && disengageDestination(snapshot, target) !== undefined;
    });
    if (disengagingTargets.length > 0)
      legalActions.push({ type: "disengaging-shot", targetIds: disengagingTargets });
  }
  if (characterClass === "arcanist" && snapshot.actionPoints >= ABILITY_ACTION_POINT_COST.arcBolt) {
    const arcBoltTargets = visibleArcBoltTargets(snapshot);
    if (arcBoltTargets.length > 0)
      legalActions.push({ type: "arc-bolt", targetIds: arcBoltTargets });
  }
  if (characterClass === "arcanist" && snapshot.actionPoints >= ABILITY_ACTION_POINT_COST.ward) {
    legalActions.push({ type: "ward" });
  }
  const occupiedBackpackSlots = snapshot.inventory.backpack
    .map((stack, slot) => (stack === null ? undefined : slot))
    .filter((slot): slot is number => slot !== undefined);
  if (snapshot.actionPoints >= ACTION_POINT_COST.dropItem && occupiedBackpackSlots.length > 0) {
    legalActions.push({ type: "drop-item", slots: occupiedBackpackSlots });
  }
  legalActions.push({ type: "end-turn" });

  return {
    turn: snapshot.turn,
    actionPoints: snapshot.actionPoints,
    character: clone(snapshot.character),
    enemies: snapshot.enemies
      .filter((enemy) => enemy.health > 0 && visiblePositions.has(positionKey(enemy.position)))
      .map(clone),
    objects: snapshot.objects
      .filter((object) => !object.used && visiblePositions.has(positionKey(object.position)))
      .map(({ used: _used, ...object }) => clone(object)),
    tiles: observedTiles(snapshot),
    ascii: renderAscii(snapshot),
    inCombat: isInCombat(snapshot),
    attackPreviews: targets.map((targetId) => attackPreview(snapshot, targetId)),
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
  const actionPointRejection = rejectForInsufficientActionPoints(snapshot, ACTION_POINT_COST.move);
  if (actionPointRejection) return actionPointRejection;
  const delta = directionEntries().find((entry) => entry.direction === direction)?.delta;
  if (!delta) throw new Error(`Unknown direction: ${direction}`);
  const to = add(snapshot.character.position, delta);
  if (!canEnter(snapshot, to)) return reject("blocked-destination");
  const trap = objectAt(snapshot, to, "trap");

  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "move",
    direction,
    from: clone(snapshot.character.position),
    to,
    cost: ACTION_POINT_COST.move,
    ...(trap
      ? {
          triggeredTrap: {
            id: trap.id,
            damage: trap.damage,
            outcome: characterDamageOutcome(snapshot.character, trap.damage),
          },
        }
      : {}),
  };
  return applyEvent(snapshot, event, (next) => {
    next.character.position = to;
    next.actionPoints -= event.cost;
    if (event.triggeredTrap) {
      const nextTrap = objectAt(next, to, "trap");
      if (!nextTrap) throw new Error("Trap disappeared during resolution.");
      nextTrap.used = true;
      applyCharacterDamageOutcome(next.character, event.triggeredTrap.outcome);
    }
  });
}

function attack(snapshot: Snapshot, targetId: string): ActionResult {
  const actionPointRejection = rejectForInsufficientActionPoints(
    snapshot,
    ACTION_POINT_COST.attack,
  );
  if (actionPointRejection) return actionPointRejection;
  const target = snapshot.enemies.find((enemy) => enemy.id === targetId && enemy.health > 0);
  if (!target || !isAdjacent(snapshot.character.position, target.position)) {
    return reject("invalid-target");
  }

  const eventIndex = snapshot.events.length;
  const roll = rollDie(snapshot, eventIndex, `attack:${targetId}:hit`, D20_SIDES);
  const damage =
    roll + snapshot.character.accuracy >= BASIC_ATTACK_HIT_DIFFICULTY + target.defense
      ? rollDie(snapshot, eventIndex, `attack:${targetId}:damage`, BASIC_ATTACK_DAMAGE_DIE_SIDES) +
        snapshot.character.power
      : 0;
  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "attack",
    targetId,
    roll,
    damage,
    cost: ACTION_POINT_COST.attack,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextTarget = next.enemies.find((enemy) => enemy.id === targetId);
    if (!nextTarget) throw new Error("Target disappeared during resolution.");
    nextTarget.health = Math.max(0, nextTarget.health - damage);
    next.actionPoints -= event.cost;
  });
}

function guard(snapshot: Snapshot): ActionResult {
  const rejection = rejectForAbility(snapshot, "vanguard", ABILITY_ACTION_POINT_COST.guard);
  if (rejection) return rejection;
  const event: Extract<EngineEvent, { type: "guard" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "guard",
    protectedTiles: adjacentPositions(snapshot.character.position).filter((position) =>
      isInBounds(position, snapshot.board),
    ),
    expiresTurn: snapshot.turn + 1,
    cost: ABILITY_ACTION_POINT_COST.guard,
  };
  return applyEvent(snapshot, event, (next) => {
    next.character.guardedTiles = clone(event.protectedTiles);
    next.character.guardExpiresTurn = event.expiresTurn;
    next.actionPoints -= event.cost;
  });
}

function shove(snapshot: Snapshot, targetId: string): ActionResult {
  const rejection = rejectForAbility(snapshot, "vanguard", ABILITY_ACTION_POINT_COST.shove);
  if (rejection) return rejection;
  const target = adjacentLivingEnemy(snapshot, targetId);
  if (!target) return reject("invalid-target");
  const to = add(target.position, subtract(target.position, snapshot.character.position));
  const canMove = canEnemyEnter(snapshot, to, target.id);
  const trap = canMove ? objectAt(snapshot, to, "trap") : undefined;
  const event: Extract<EngineEvent, { type: "shove" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "shove",
    targetId,
    ...(canMove ? { to } : {}),
    damage: canMove ? (trap?.damage ?? 0) : 1 + snapshot.character.power,
    ...(trap ? { triggeredTrap: { id: trap.id, damage: trap.damage } } : {}),
    cost: ABILITY_ACTION_POINT_COST.shove,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextTarget = next.enemies.find((enemy) => enemy.id === event.targetId);
    if (!nextTarget) throw new Error("Shove target disappeared during resolution.");
    if (event.to) nextTarget.position = clone(event.to);
    nextTarget.health = Math.max(0, nextTarget.health - event.damage);
    if (event.triggeredTrap) {
      const nextTrap = objectAt(next, event.to as Position, "trap");
      if (!nextTrap) throw new Error("Shove trap disappeared during resolution.");
      nextTrap.used = true;
    }
    next.actionPoints -= event.cost;
  });
}

function scout(snapshot: Snapshot, direction: Direction): ActionResult {
  const rejection = rejectForAbility(snapshot, "ranger", ABILITY_ACTION_POINT_COST.scout);
  if (rejection) return rejection;
  const event: Extract<EngineEvent, { type: "scout" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "scout",
    direction,
    revealed: scoutPositions(snapshot, direction),
    cost: ABILITY_ACTION_POINT_COST.scout,
  };
  return applyEvent(snapshot, event, (next) => {
    const remembered = new Map(
      next.rememberedTiles.map((tile) => [positionKey(tile.position), tile]),
    );
    for (const position of event.revealed) {
      const tile = tileAt(next, position);
      if (tile) remembered.set(positionKey(position), clone(tile));
    }
    next.rememberedTiles = [...remembered.values()].sort(compareTiles);
    next.actionPoints -= event.cost;
  });
}

function disengagingShot(snapshot: Snapshot, targetId: string): ActionResult {
  const rejection = rejectForAbility(snapshot, "ranger", ABILITY_ACTION_POINT_COST.disengagingShot);
  if (rejection) return rejection;
  const target = adjacentLivingEnemy(snapshot, targetId);
  const to = target ? disengageDestination(snapshot, target) : undefined;
  if (!target || !to) return reject("invalid-target");
  const eventIndex = snapshot.events.length;
  const roll = rollDie(snapshot, eventIndex, `disengaging-shot:${targetId}:hit`, D20_SIDES);
  const damage =
    roll + snapshot.character.accuracy >= BASIC_ATTACK_HIT_DIFFICULTY + target.defense
      ? rollDie(
          snapshot,
          eventIndex,
          `disengaging-shot:${targetId}:damage`,
          BASIC_ATTACK_DAMAGE_DIE_SIDES,
        ) + snapshot.character.power
      : 0;
  const event: Extract<EngineEvent, { type: "disengaging-shot" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "disengaging-shot",
    targetId,
    roll,
    damage,
    to,
    cost: ABILITY_ACTION_POINT_COST.disengagingShot,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextTarget = next.enemies.find((enemy) => enemy.id === event.targetId);
    if (!nextTarget) throw new Error("Disengaging Shot target disappeared during resolution.");
    nextTarget.health = Math.max(0, nextTarget.health - event.damage);
    next.character.position = clone(event.to);
    next.actionPoints -= event.cost;
  });
}

function arcBolt(snapshot: Snapshot, targetId: string): ActionResult {
  const rejection = rejectForAbility(snapshot, "arcanist", ABILITY_ACTION_POINT_COST.arcBolt);
  if (rejection) return rejection;
  const target = snapshot.enemies.find((enemy) => enemy.id === targetId && enemy.health > 0);
  if (!target || !visibleArcBoltTargets(snapshot).includes(targetId))
    return reject("invalid-target");
  const event: Extract<EngineEvent, { type: "arc-bolt" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "arc-bolt",
    targetId,
    damage: Math.max(1, 2 + snapshot.character.focus - target.focus),
    cost: ABILITY_ACTION_POINT_COST.arcBolt,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextTarget = next.enemies.find((enemy) => enemy.id === event.targetId);
    if (!nextTarget) throw new Error("Arc Bolt target disappeared during resolution.");
    nextTarget.health = Math.max(0, nextTarget.health - event.damage);
    next.actionPoints -= event.cost;
  });
}

function ward(snapshot: Snapshot): ActionResult {
  const rejection = rejectForAbility(snapshot, "arcanist", ABILITY_ACTION_POINT_COST.ward);
  if (rejection) return rejection;
  const event: Extract<EngineEvent, { type: "ward" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "ward",
    protection: snapshot.character.focus + 2,
    expiresTurn: snapshot.turn + 1,
    cost: ABILITY_ACTION_POINT_COST.ward,
  };
  return applyEvent(snapshot, event, (next) => {
    next.character.ward = event.protection;
    next.character.wardExpiresTurn = event.expiresTurn;
    next.actionPoints -= event.cost;
  });
}

function dropItem(snapshot: Snapshot, slot: number): ActionResult {
  const actionPointRejection = rejectForInsufficientActionPoints(
    snapshot,
    ACTION_POINT_COST.dropItem,
  );
  if (actionPointRejection) return actionPointRejection;
  const stack = snapshot.inventory.backpack[slot];
  if (!Number.isSafeInteger(slot) || slot < 0 || !stack) return reject("invalid-target");
  const event: Extract<EngineEvent, { type: "drop-item" }> = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "drop-item",
    slot,
    itemId: stack.itemId,
    quantity: stack.quantity,
    cost: ACTION_POINT_COST.dropItem,
  };
  return applyEvent(snapshot, event, (next) => {
    next.inventory.backpack[event.slot] = null;
    next.actionPoints -= event.cost;
  });
}

function endTurn(snapshot: Snapshot): ActionResult {
  const temporaryDefense = temporaryDefenseFromUnusedActionPoints(snapshot.actionPoints);
  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "end-turn",
    temporaryDefense,
    enemyMoves: enemyBehaviorMoves(snapshot),
  };
  return applyEvent(snapshot, event, (next) => {
    next.turn += 1;
    next.actionPoints = ACTION_POINT_LIMIT;
    next.character.temporaryDefense = event.temporaryDefense;
    if (next.turn > next.character.guardExpiresTurn) next.character.guardedTiles = [];
    if (next.turn > next.character.wardExpiresTurn) next.character.ward = 0;
    for (const move of event.enemyMoves) {
      const enemy = next.enemies.find((candidate) => candidate.id === move.enemyId);
      if (!enemy) throw new Error("Enemy disappeared during pursuit.");
      enemy.position = clone(move.to);
    }
  });
}

function interact(snapshot: Snapshot, target: Position): ActionResult {
  const actionPointRejection = rejectForInsufficientActionPoints(
    snapshot,
    ACTION_POINT_COST.interact,
  );
  if (actionPointRejection) return actionPointRejection;
  if (!isAdjacent(snapshot.character.position, target)) return reject("invalid-interaction");
  const tile = tileAt(snapshot, target);
  if (tile?.terrain === "objective" && !snapshot.objectiveCollected) {
    return applyInteraction(snapshot, target, "objective");
  }
  if (tile?.terrain === "exit" && snapshot.objectiveCollected && !snapshot.exitUnlocked) {
    return applyInteraction(snapshot, target, "exit");
  }
  const object = objectAt(snapshot, target);
  if (!object) return reject("invalid-interaction");
  switch (object.type) {
    case "chest":
      return useItemObject(snapshot, target, object, "open-chest");
    case "item":
      return useItemObject(snapshot, target, object, "pickup-item");
    case "sanctuary":
      return useSanctuary(snapshot, target, object);
    case "trap":
      return reject("invalid-interaction");
  }
}

function applyInteraction(
  snapshot: Snapshot,
  target: Position,
  interaction: "objective" | "exit",
): ActionResult {
  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "interact",
    target: clone(target),
    interaction,
    cost: ACTION_POINT_COST.interact,
  };
  return applyEvent(snapshot, event, (next) => {
    if (interaction === "objective") next.objectiveCollected = true;
    else next.exitUnlocked = true;
    next.actionPoints -= event.cost;
  });
}

function useItemObject(
  snapshot: Snapshot,
  target: Position,
  object:
    | Extract<FloorObjectState, { type: "chest" }>
    | Extract<FloorObjectState, { type: "item" }>,
  type: "open-chest" | "pickup-item",
): ActionResult {
  if (!hasBackpackSpace(snapshot.inventory, object.itemId)) return reject("backpack-full");
  const event: Extract<EngineEvent, { type: "open-chest" | "pickup-item" }> =
    type === "open-chest"
      ? {
          schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
          type,
          target: clone(target),
          objectId: object.id,
          itemId: object.itemId,
          cost: ACTION_POINT_COST.interact,
        }
      : {
          schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
          type,
          target: clone(target),
          objectId: object.id,
          itemId: object.itemId,
          cost: ACTION_POINT_COST.interact,
        };
  return applyEvent(snapshot, event, (next) => {
    const nextObject = objectAt(next, target);
    if (!nextObject || nextObject.id !== object.id)
      throw new Error("Item disappeared during resolution.");
    nextObject.used = true;
    if (!addToBackpack(next.inventory, event.itemId)) {
      throw new Error("Inventory capacity changed during item pickup.");
    }
    next.actionPoints -= event.cost;
  });
}

function useSanctuary(
  snapshot: Snapshot,
  target: Position,
  object: Extract<FloorObjectState, { type: "sanctuary" }>,
): ActionResult {
  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: "use-sanctuary",
    target: clone(target),
    objectId: object.id,
    healing: object.healing,
    cost: ACTION_POINT_COST.interact,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextObject = objectAt(next, target, "sanctuary");
    if (!nextObject || nextObject.id !== object.id)
      throw new Error("Sanctuary disappeared during resolution.");
    nextObject.used = true;
    next.character.health = Math.min(
      next.character.maxHealth,
      next.character.health + event.healing,
    );
    next.actionPoints -= event.cost;
  });
}

function changeDoor(snapshot: Snapshot, target: Position, door: "open" | "closed"): ActionResult {
  const actionPointRejection = rejectForInsufficientActionPoints(
    snapshot,
    door === "open" ? ACTION_POINT_COST.openDoor : ACTION_POINT_COST.closeDoor,
  );
  if (actionPointRejection) return actionPointRejection;
  if (!isAdjacent(snapshot.character.position, target)) return reject("invalid-interaction");
  const tile = tileAt(snapshot, target);
  if (!tile || tile.door === undefined || tile.door === door) return reject("invalid-interaction");
  const event: EngineEvent = {
    schemaVersion: ENGINE_EVENT_SCHEMA_VERSION,
    type: door === "open" ? "open-door" : "close-door",
    target: clone(target),
    cost: door === "open" ? ACTION_POINT_COST.openDoor : ACTION_POINT_COST.closeDoor,
  };
  return applyEvent(snapshot, event, (next) => {
    const nextTile = tileAt(next, target);
    if (!nextTile) throw new Error("Door disappeared during resolution.");
    nextTile.door = door;
    next.actionPoints -= event.cost;
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
        event.cost !== ACTION_POINT_COST.move ||
        !delta ||
        snapshot.actionPoints < event.cost ||
        !samePosition(snapshot.character.position, event.from) ||
        !samePosition(add(event.from, delta), event.to) ||
        !canEnter(snapshot, event.to) ||
        !isValidRecordedTrap(snapshot, event)
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          next.character.position = clone(event.to);
          next.actionPoints -= event.cost;
          if (event.triggeredTrap) {
            const trap = objectAt(next, event.to, "trap");
            if (!trap) throw new Error("Recorded trap disappeared during replay.");
            trap.used = true;
            applyCharacterDamageOutcome(next.character, event.triggeredTrap.outcome);
          }
        }).snapshot,
      };
    }
    case "attack": {
      const target = snapshot.enemies.find(
        (enemy) => enemy.id === event.targetId && enemy.health > 0,
      );
      if (
        event.cost !== ACTION_POINT_COST.attack ||
        snapshot.actionPoints < event.cost ||
        !isDieRoll(event.roll, D20_SIDES) ||
        !isValidRecordedAttackDamage(snapshot.character, event.damage) ||
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
    case "drop-item": {
      const stack = snapshot.inventory.backpack[event.slot];
      if (
        event.cost !== ACTION_POINT_COST.dropItem ||
        snapshot.actionPoints < event.cost ||
        !Number.isSafeInteger(event.slot) ||
        event.slot < 0 ||
        !stack ||
        stack.itemId !== event.itemId ||
        stack.quantity !== event.quantity
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          next.inventory.backpack[event.slot] = null;
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    }
    case "guard":
      return replayAbilityEvent(snapshot, eventIndex, event, { type: "guard" });
    case "shove":
      return replayAbilityEvent(snapshot, eventIndex, event, {
        type: "shove",
        targetId: event.targetId,
      });
    case "scout":
      return replayAbilityEvent(snapshot, eventIndex, event, {
        type: "scout",
        direction: event.direction,
      });
    case "disengaging-shot":
      return replayAbilityEvent(snapshot, eventIndex, event, {
        type: "disengaging-shot",
        targetId: event.targetId,
      });
    case "arc-bolt":
      return replayAbilityEvent(snapshot, eventIndex, event, {
        type: "arc-bolt",
        targetId: event.targetId,
      });
    case "ward":
      return replayAbilityEvent(snapshot, eventIndex, event, { type: "ward" });
    case "end-turn":
      if (
        event.temporaryDefense !== temporaryDefenseFromUnusedActionPoints(snapshot.actionPoints) ||
        !sameEnemyMoves(event.enemyMoves, enemyBehaviorMoves(snapshot))
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          next.turn += 1;
          next.actionPoints = ACTION_POINT_LIMIT;
          next.character.temporaryDefense = event.temporaryDefense;
          for (const move of event.enemyMoves) {
            const enemy = next.enemies.find((candidate) => candidate.id === move.enemyId);
            if (!enemy) throw new Error("Recorded enemy disappeared during pursuit.");
            enemy.position = clone(move.to);
          }
        }).snapshot,
      };
    case "interact":
      if (
        event.cost !== ACTION_POINT_COST.interact ||
        !isAdjacent(snapshot.character.position, event.target) ||
        !canReplayInteraction(snapshot, event)
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          if (event.interaction === "objective") next.objectiveCollected = true;
          else next.exitUnlocked = true;
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    case "open-chest":
    case "pickup-item": {
      const type = event.type === "open-chest" ? "chest" : "item";
      const object = objectAt(snapshot, event.target, type);
      if (
        event.cost !== ACTION_POINT_COST.interact ||
        !isAdjacent(snapshot.character.position, event.target) ||
        !object ||
        object.id !== event.objectId ||
        object.itemId !== event.itemId ||
        !hasBackpackSpace(snapshot.inventory, event.itemId)
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          const nextObject = objectAt(next, event.target, type);
          if (!nextObject) throw new Error("Recorded item disappeared during replay.");
          nextObject.used = true;
          if (!addToBackpack(next.inventory, event.itemId)) {
            throw new Error("Inventory capacity changed during replay.");
          }
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    }
    case "use-sanctuary": {
      const sanctuary = objectAt(snapshot, event.target, "sanctuary");
      if (
        event.cost !== ACTION_POINT_COST.interact ||
        !isAdjacent(snapshot.character.position, event.target) ||
        !sanctuary ||
        sanctuary.id !== event.objectId ||
        sanctuary.healing !== event.healing
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          const nextSanctuary = objectAt(next, event.target, "sanctuary");
          if (!nextSanctuary) throw new Error("Recorded sanctuary disappeared during replay.");
          nextSanctuary.used = true;
          next.character.health = Math.min(
            next.character.maxHealth,
            next.character.health + event.healing,
          );
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    }
    case "open-door":
    case "close-door": {
      const door = event.type === "open-door" ? "open" : "closed";
      const tile = tileAt(snapshot, event.target);
      if (
        event.cost !==
          (door === "open" ? ACTION_POINT_COST.openDoor : ACTION_POINT_COST.closeDoor) ||
        !isAdjacent(snapshot.character.position, event.target) ||
        !tile ||
        tile.door === undefined ||
        tile.door === door
      ) {
        return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
      }
      return {
        accepted: true,
        snapshot: applyEvent(snapshot, event, (next) => {
          const nextTile = tileAt(next, event.target);
          if (!nextTile) throw new Error("Recorded door disappeared during replay.");
          nextTile.door = door;
          next.actionPoints -= event.cost;
        }).snapshot,
      };
    }
  }
}

function replayAbilityEvent(
  snapshot: Snapshot,
  eventIndex: number,
  event: Extract<
    EngineEvent,
    { type: "guard" | "shove" | "scout" | "disengaging-shot" | "arc-bolt" | "ward" }
  >,
  action: Extract<
    Action,
    { type: "guard" | "shove" | "scout" | "disengaging-shot" | "arc-bolt" | "ward" }
  >,
): { accepted: true; snapshot: Snapshot } | RecordedEventReplayRejection {
  const result = act(snapshot, action);
  if (!result.accepted || canonicalStringify(result.event) !== canonicalStringify(event)) {
    return rejectRecordedEvent(eventIndex, "invalid-recorded-event");
  }
  return { accepted: true, snapshot: result.snapshot };
}

function applyEvent(
  snapshot: Snapshot,
  event: EngineEvent,
  update: (next: Snapshot) => void,
): AcceptedActionResult {
  const next = clone(snapshot);
  if (event.type !== "end-turn") next.character.temporaryDefense = 0;
  update(next);
  updateRememberedTiles(next);
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

function temporaryDefenseFromUnusedActionPoints(actionPoints: number): number {
  return Math.min(actionPoints, MAX_TEMPORARY_DEFENSE_FROM_UNUSED_ACTION_POINTS);
}

function canEnter(snapshot: Snapshot, position: Position): boolean {
  return (
    isInBounds(position, snapshot.board) &&
    isWalkable(tileAt(snapshot, position)) &&
    !snapshot.enemies.some((enemy) => enemy.health > 0 && samePosition(enemy.position, position))
  );
}

function rejectForInsufficientActionPoints(
  snapshot: Snapshot,
  cost: number,
): RejectedActionResult | undefined {
  return snapshot.actionPoints < cost ? reject("insufficient-action-points") : undefined;
}

function rejectForAbility(
  snapshot: Snapshot,
  characterClass: CharacterClass,
  cost: number,
): RejectedActionResult | undefined {
  if (snapshot.character.class !== characterClass) return reject("invalid-ability");
  return rejectForInsufficientActionPoints(snapshot, cost);
}

function adjacentLivingEnemy(
  snapshot: Snapshot,
  targetId: string,
): Snapshot["enemies"][number] | undefined {
  return snapshot.enemies.find(
    (enemy) =>
      enemy.id === targetId &&
      enemy.health > 0 &&
      isAdjacent(snapshot.character.position, enemy.position),
  );
}

function canEnemyEnter(snapshot: Snapshot, position: Position, movingEnemyId: string): boolean {
  return (
    isInBounds(position, snapshot.board) &&
    isWalkable(tileAt(snapshot, position)) &&
    !samePosition(position, snapshot.character.position) &&
    !snapshot.enemies.some(
      (enemy) =>
        enemy.id !== movingEnemyId && enemy.health > 0 && samePosition(enemy.position, position),
    )
  );
}

function disengageDestination(
  snapshot: Snapshot,
  target: Snapshot["enemies"][number],
): Position | undefined {
  const destination = subtract(
    snapshot.character.position,
    subtract(target.position, snapshot.character.position),
  );
  return canEnter(snapshot, destination) ? destination : undefined;
}

function visibleArcBoltTargets(snapshot: Snapshot): string[] {
  return snapshot.enemies
    .filter(
      (enemy) =>
        enemy.health > 0 &&
        manhattan(snapshot.character.position, enemy.position) <= ARC_BOLT_RANGE &&
        hasLineOfSight(snapshot, snapshot.character.position, enemy.position),
    )
    .map((enemy) => enemy.id);
}

function scoutPositions(snapshot: Snapshot, direction: Direction): Position[] {
  const delta = directionEntries().find((entry) => entry.direction === direction)?.delta;
  if (!delta) throw new Error(`Unknown scout direction: ${direction}`);
  return snapshot.tiles
    .filter((tile) => {
      const offset = subtract(tile.position, snapshot.character.position);
      const forward = offset.x * delta.x + offset.y * delta.y;
      const lateral = Math.abs(offset.x * delta.y - offset.y * delta.x);
      return (
        forward > 0 &&
        forward * forward + lateral * lateral <= SCOUT_RANGE * SCOUT_RANGE &&
        lateral <= forward &&
        hasLineOfSight(snapshot, snapshot.character.position, tile.position)
      );
    })
    .map((tile) => clone(tile.position))
    .sort(comparePositions);
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
  if (
    !hasValidCombatantStats(definition.character) ||
    !hasValidInitialInventory(definition.character) ||
    (definition.character.class !== undefined &&
      !["vanguard", "ranger", "arcanist"].includes(definition.character.class)) ||
    (definition.character.resurrectionCharges !== undefined &&
      definition.character.resurrectionCharges !== 0 &&
      definition.character.resurrectionCharges !== 1)
  ) {
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
  const tileRejection = validateTiles(definition);
  if (tileRejection) return tileRejection;
  const objectsRejection = validateObjects(definition);
  if (objectsRejection) return objectsRejection;

  const entityIds = new Set<string>();
  const occupiedPositions = new Set([positionKey(definition.character.position)]);
  for (const enemy of definition.enemies) {
    if (!hasValidCombatantStats(enemy)) {
      return rejectRunDefinition("invalid-enemy-stats");
    }
    if (
      enemy.behavior !== undefined &&
      enemy.behavior !== "pursue" &&
      enemy.behavior !== "skirmish" &&
      enemy.behavior !== "hold"
    ) {
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

function validateObjects(definition: RunDefinition): RejectedCreateRunResult | undefined {
  const ids = new Set<string>();
  for (const object of definition.objects) {
    if (
      !isNonEmptyString(object.id) ||
      !isInBounds(object.position, definition.board) ||
      ids.has(object.id) ||
      (object.type === "chest" || object.type === "item"
        ? !isNonEmptyString(object.itemId)
        : !isPositiveInteger(object.type === "trap" ? object.damage : object.healing))
    ) {
      return rejectRunDefinition(
        ids.has(object.id) ? "duplicate-floor-object-id" : "invalid-floor-object",
      );
    }
    ids.add(object.id);
  }
}

function validateTiles(definition: RunDefinition): RejectedCreateRunResult | undefined {
  if (definition.tiles.length !== definition.board.width * definition.board.height) {
    return rejectRunDefinition("invalid-floor-tiles");
  }
  const positions = new Set<string>();
  let entrances = 0;
  let objectives = 0;
  let exits = 0;
  for (const tile of definition.tiles) {
    if (!isInBounds(tile.position, definition.board) || !isTerrain(tile.terrain)) {
      return rejectRunDefinition("invalid-floor-tiles");
    }
    if (tile.door !== undefined && tile.door !== "open" && tile.door !== "closed") {
      return rejectRunDefinition("invalid-floor-tiles");
    }
    const key = positionKey(tile.position);
    if (positions.has(key)) return rejectRunDefinition("duplicate-tile-position");
    positions.add(key);
    if (tile.terrain === "entrance") entrances += 1;
    if (tile.terrain === "objective") objectives += 1;
    if (tile.terrain === "exit") exits += 1;
  }
  if (entrances !== 1) return rejectRunDefinition("missing-entrance");
  if (objectives !== 1) return rejectRunDefinition("missing-objective");
  if (exits !== 1) return rejectRunDefinition("missing-exit");
  const entrance = definition.tiles.find((tile) => tile.terrain === "entrance");
  if (!entrance || !samePosition(entrance.position, definition.character.position)) {
    return rejectRunDefinition("invalid-starting-position");
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

function hasValidCombatantStats(stats: CombatantStats): boolean {
  return (
    isPositiveInteger(stats.health) &&
    isPositiveInteger(stats.maxHealth) &&
    stats.health <= stats.maxHealth &&
    isNonNegativeInteger(stats.defense) &&
    isPositiveInteger(stats.movement) &&
    isNonNegativeInteger(stats.accuracy) &&
    isNonNegativeInteger(stats.power) &&
    isNonNegativeInteger(stats.focus)
  );
}

function hasValidInitialInventory(character: CharacterDefinition): boolean {
  if (character.inventory !== undefined) {
    const inventory = character.inventory;
    const equipped = [inventory.weapon, inventory.armor, inventory.accessory];
    if (
      inventory.backpack.length !== BACKPACK_SLOT_COUNT ||
      !equipped.every((itemId) => itemId === null || isNonEmptyString(itemId)) ||
      !inventory.backpack.every(
        (stack) =>
          stack === null ||
          (isNonEmptyString(stack.itemId) &&
            Number.isSafeInteger(stack.quantity) &&
            stack.quantity > 0),
      )
    ) {
      return false;
    }
  }
  const equipment = character.equipment;
  if (
    equipment !== undefined &&
    Object.values(equipment).some((itemId) => itemId !== null && !isNonEmptyString(itemId))
  ) {
    return false;
  }
  return (
    character.backpack === undefined ||
    (character.backpack.length <= BACKPACK_SLOT_COUNT &&
      character.backpack.every((itemId) => isNonEmptyString(itemId)))
  );
}

function createInventory(character: CharacterDefinition): Snapshot["inventory"] {
  if (character.inventory !== undefined) return clone(character.inventory);
  const inventory: Snapshot["inventory"] = {
    weapon: character.equipment?.weapon ?? null,
    armor: character.equipment?.armor ?? null,
    accessory: character.equipment?.accessory ?? null,
    backpack: Array<Snapshot["inventory"]["backpack"][number]>(BACKPACK_SLOT_COUNT).fill(null),
  };
  for (const itemId of character.backpack ?? []) {
    if (!addToBackpack(inventory, itemId)) throw new Error("Validated backpack did not fit.");
  }
  return inventory;
}

function hasBackpackSpace(inventory: Snapshot["inventory"], itemId: string): boolean {
  return (
    inventory.backpack.some((stack) => stack?.itemId === itemId) ||
    inventory.backpack.some((stack) => stack === null)
  );
}

function addToBackpack(inventory: Snapshot["inventory"], itemId: string): boolean {
  const matchingStack = inventory.backpack.find((stack) => stack?.itemId === itemId);
  if (matchingStack) {
    matchingStack.quantity += 1;
    return true;
  }
  const slot = inventory.backpack.indexOf(null);
  if (slot === -1) return false;
  inventory.backpack[slot] = { itemId, quantity: 1 };
  return true;
}

function attackPreview(
  snapshot: Snapshot,
  targetId: string,
): Observation["attackPreviews"][number] {
  const target = snapshot.enemies.find((enemy) => enemy.id === targetId);
  if (!target) throw new Error("Cannot preview an unknown target.");
  const requiredRoll = BASIC_ATTACK_HIT_DIFFICULTY + target.defense - snapshot.character.accuracy;
  const successfulRolls = Math.max(0, D20_SIDES - Math.max(1, requiredRoll) + 1);
  return {
    targetId,
    hitProbability: successfulRolls / D20_SIDES,
    damageRange: {
      minimum: successfulRolls === D20_SIDES ? 1 + snapshot.character.power : 0,
      maximum: successfulRolls === 0 ? 0 : BASIC_ATTACK_DAMAGE_DIE_SIDES + snapshot.character.power,
    },
  };
}

function characterDamageOutcome(character: CharacterState, damage: number): CharacterDamageOutcome {
  const health = Math.max(0, character.health - damage);
  if (health > 0) return { health, died: false, resurrected: false };
  if (character.resurrectionCharges > 0) return { health: 1, died: false, resurrected: true };
  return { health: 0, died: true, resurrected: false };
}

function applyCharacterDamageOutcome(
  character: CharacterState,
  outcome: CharacterDamageOutcome,
): void {
  character.health = outcome.health;
  character.dead = outcome.died;
  if (outcome.resurrected) character.resurrectionCharges = 0;
}

function enemyBehaviorMoves(
  snapshot: Snapshot,
): Extract<EngineEvent, { type: "end-turn" }>["enemyMoves"] {
  const occupied = new Set(
    snapshot.enemies
      .filter((enemy) => enemy.health > 0)
      .map((enemy) => positionKey(enemy.position)),
  );
  const moves: Extract<EngineEvent, { type: "end-turn" }>["enemyMoves"] = [];
  for (const enemy of snapshot.enemies.filter((candidate) => candidate.health > 0)) {
    occupied.delete(positionKey(enemy.position));
    const destination = decideEnemyMove(snapshot, enemy, occupied);
    if (destination) {
      moves.push({ enemyId: enemy.id, from: clone(enemy.position), to: destination });
      occupied.add(positionKey(destination));
    } else {
      occupied.add(positionKey(enemy.position));
    }
  }
  return moves;
}

function decideEnemyMove(
  snapshot: Snapshot,
  enemy: Snapshot["enemies"][number],
  occupied: ReadonlySet<string>,
): Position | undefined {
  const candidates = directionEntries()
    .map(({ delta }) => add(enemy.position, delta))
    .filter(
      (position) =>
        isInBounds(position, snapshot.board) &&
        isWalkable(tileAt(snapshot, position)) &&
        !samePosition(position, snapshot.character.position) &&
        !occupied.has(positionKey(position)),
    );
  const behavior: EnemyBehavior = enemy.behavior ?? "pursue";
  if (behavior === "hold") return undefined;

  const currentDistance = manhattan(enemy.position, snapshot.character.position);
  const preferred =
    behavior === "skirmish" && currentDistance === 1
      ? candidates.filter(
          (position) => manhattan(position, snapshot.character.position) > currentDistance,
        )
      : candidates.filter(
          (position) => manhattan(position, snapshot.character.position) < currentDistance,
        );
  if (preferred.length === 0) return undefined;

  const bestDistance =
    behavior === "skirmish" && currentDistance === 1
      ? Math.max(...preferred.map((position) => manhattan(position, snapshot.character.position)))
      : Math.min(...preferred.map((position) => manhattan(position, snapshot.character.position)));
  const ties = preferred
    .filter((position) => manhattan(position, snapshot.character.position) === bestDistance)
    .sort(comparePositions);
  return chooseSeededTie(snapshot, enemy.id, ties);
}

function chooseSeededTie(snapshot: Snapshot, enemyId: string, candidates: Position[]): Position {
  if (candidates.length === 0) throw new Error("Cannot resolve an empty enemy behavior tie.");
  const index =
    candidates.length === 1
      ? 0
      : rollDie(
          snapshot,
          snapshot.events.length,
          `enemy:${enemyId}:behavior-tie`,
          candidates.length,
        ) - 1;
  return clone(candidates[index] as Position);
}

function sameEnemyMoves(
  left: Extract<EngineEvent, { type: "end-turn" }>["enemyMoves"],
  right: Extract<EngineEvent, { type: "end-turn" }>["enemyMoves"],
): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

function isInCombat(snapshot: Snapshot): boolean {
  return snapshot.enemies.some(
    (enemy) => enemy.health > 0 && manhattan(enemy.position, snapshot.character.position) <= 6,
  );
}

function isValidRecordedAttackDamage(attacker: CharacterState, damage: number): boolean {
  return (
    isNonNegativeInteger(damage) &&
    (damage === 0 ||
      (damage >= 1 + attacker.power && damage <= BASIC_ATTACK_DAMAGE_DIE_SIDES + attacker.power))
  );
}

function isDieRoll(value: number, sides: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= sides;
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function isTerrain(value: string): value is FloorTile["terrain"] {
  return ["floor", "wall", "entrance", "objective", "exit", "secret"].includes(value);
}

function isWalkable(tile: FloorTile | undefined): boolean {
  return tile !== undefined && tile.terrain !== "wall" && tile.door !== "closed";
}

function mandatoryRoute(
  definition: RunDefinition,
  from: Position,
  to: Position,
): Position[] | undefined {
  const start = positionKey(from);
  const destination = positionKey(to);
  const tiles = new Map(definition.tiles.map((tile) => [positionKey(tile.position), tile]));
  const previous = new Map<string, string | undefined>([[start, undefined]]);
  const queue = [clone(from)];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    const currentKey = positionKey(current);
    if (currentKey === destination) {
      const route: Position[] = [];
      let key: string | undefined = currentKey;
      while (key !== undefined) {
        const tile = tiles.get(key);
        if (!tile) throw new Error("Mandatory route references a missing tile.");
        route.push(clone(tile.position));
        key = previous.get(key);
      }
      return route.reverse();
    }
    for (const { delta } of directionEntries()) {
      const next = add(current, delta);
      const nextKey = positionKey(next);
      const tile = tiles.get(nextKey);
      // Every class can open a door before entering it.
      if (!tile || tile.terrain === "wall" || previous.has(nextKey)) continue;
      previous.set(nextKey, currentKey);
      queue.push(next);
    }
  }
  return undefined;
}

function tileAt(snapshot: Pick<Snapshot, "tiles">, position: Position): FloorTile | undefined {
  return snapshot.tiles.find((tile) => samePosition(tile.position, position));
}

function canInteract(snapshot: Snapshot, position: Position): boolean {
  const tile = tileAt(snapshot, position);
  const object = objectAt(snapshot, position);
  return (
    (tile?.terrain === "objective" && !snapshot.objectiveCollected) ||
    (tile?.terrain === "exit" && snapshot.objectiveCollected && !snapshot.exitUnlocked) ||
    (object !== undefined &&
      (object.type !== "chest" && object.type !== "item"
        ? true
        : hasBackpackSpace(snapshot.inventory, object.itemId)))
  );
}

function objectAt(
  snapshot: Pick<Snapshot, "objects">,
  position: Position,
): FloorObjectState | undefined;
function objectAt<T extends FloorObjectState["type"]>(
  snapshot: Pick<Snapshot, "objects">,
  position: Position,
  type: T,
): Extract<FloorObjectState, { type: T }> | undefined;
function objectAt(
  snapshot: Pick<Snapshot, "objects">,
  position: Position,
  type?: FloorObjectState["type"],
): FloorObjectState | undefined {
  return snapshot.objects.find(
    (object) =>
      !object.used &&
      samePosition(object.position, position) &&
      (type === undefined || object.type === type),
  );
}

function isValidRecordedTrap(
  snapshot: Snapshot,
  event: Extract<EngineEvent, { type: "move" }>,
): boolean {
  const trap = objectAt(snapshot, event.to, "trap");
  return (
    (event.triggeredTrap === undefined && trap === undefined) ||
    (event.triggeredTrap !== undefined &&
      trap !== undefined &&
      trap.id === event.triggeredTrap.id &&
      trap.damage === event.triggeredTrap.damage &&
      canonicalStringify(event.triggeredTrap.outcome) ===
        canonicalStringify(characterDamageOutcome(snapshot.character, trap.damage)))
  );
}

function canReplayInteraction(
  snapshot: Snapshot,
  event: Extract<EngineEvent, { type: "interact" }>,
): boolean {
  const tile = tileAt(snapshot, event.target);
  return (
    (event.interaction === "objective" &&
      tile?.terrain === "objective" &&
      !snapshot.objectiveCollected) ||
    (event.interaction === "exit" &&
      tile?.terrain === "exit" &&
      snapshot.objectiveCollected &&
      !snapshot.exitUnlocked)
  );
}

function visiblePositionKeys(snapshot: Snapshot): Set<string> {
  const visible = new Set<string>();
  for (const tile of snapshot.tiles) {
    const dx = tile.position.x - snapshot.character.position.x;
    const dy = tile.position.y - snapshot.character.position.y;
    if (
      dx * dx + dy * dy <= 36 &&
      hasLineOfSight(snapshot, snapshot.character.position, tile.position)
    ) {
      visible.add(positionKey(tile.position));
    }
  }
  return visible;
}

function hasLineOfSight(snapshot: Snapshot, from: Position, to: Position): boolean {
  const points = line(from, to);
  for (const point of points.slice(1, -1)) {
    const tile = tileAt(snapshot, point);
    if (tile?.terrain === "wall" || tile?.door === "closed") return false;
  }
  return true;
}

function line(from: Position, to: Position): Position[] {
  const points: Position[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = from.x < to.x ? 1 : -1;
  const sy = from.y < to.y ? 1 : -1;
  let error = dx - dy;
  while (true) {
    points.push({ x, y });
    if (x === to.x && y === to.y) return points;
    const twiceError = error * 2;
    if (twiceError > -dy) {
      error -= dy;
      x += sx;
    }
    if (twiceError < dx) {
      error += dx;
      y += sy;
    }
  }
}

function updateRememberedTiles(snapshot: Omit<Snapshot, "checksum">): void {
  const visible = visiblePositionKeys(snapshot as Snapshot);
  const remembered = new Map(
    snapshot.rememberedTiles.map((tile) => [positionKey(tile.position), tile]),
  );
  for (const tile of snapshot.tiles) {
    if (visible.has(positionKey(tile.position)))
      remembered.set(positionKey(tile.position), clone(tile));
  }
  snapshot.rememberedTiles = [...remembered.values()].sort(compareTiles);
}

function observedTiles(snapshot: Snapshot): Observation["tiles"] {
  const visible = visiblePositionKeys(snapshot);
  const current = new Map(snapshot.tiles.map((tile) => [positionKey(tile.position), tile]));
  return snapshot.rememberedTiles.map((remembered) => {
    const key = positionKey(remembered.position);
    return {
      ...(visible.has(key) ? clone(current.get(key) ?? remembered) : clone(remembered)),
      visibility: visible.has(key) ? "visible" : "remembered",
    };
  });
}

function renderAscii(snapshot: Snapshot): string {
  const knownTiles = new Map(
    observedTiles(snapshot).map((tile) => [positionKey(tile.position), tile]),
  );
  const visible = visiblePositionKeys(snapshot);
  const visibleEnemies = new Map(
    snapshot.enemies
      .filter((enemy) => enemy.health > 0 && visible.has(positionKey(enemy.position)))
      .map((enemy) => [positionKey(enemy.position), enemy]),
  );
  const rows: string[] = [];
  for (let y = 0; y < snapshot.board.height; y += 1) {
    let row = "";
    for (let x = 0; x < snapshot.board.width; x += 1) {
      const position = { x, y };
      const tile = knownTiles.get(positionKey(position));
      if (!tile) row += "?";
      else if (samePosition(position, snapshot.character.position)) row += "@";
      else if (visibleEnemies.has(positionKey(position))) row += "e";
      else if (tile.door === "closed") row += "+";
      else if (tile.door === "open") row += "/";
      else if (tile.terrain === "wall") row += "#";
      else if (tile.terrain === "entrance") row += ">";
      else if (tile.terrain === "objective") row += snapshot.objectiveCollected ? "." : "*";
      else if (tile.terrain === "exit") row += snapshot.exitUnlocked ? "<" : "X";
      else if (tile.terrain === "secret") row += "s";
      else row += ".";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

function isAdjacent(a: Position, b: Position): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function comparePositions(left: Position, right: Position): number {
  return left.y - right.y || left.x - right.x;
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

function compareTiles(left: FloorTile, right: FloorTile): number {
  return left.position.y - right.position.y || left.position.x - right.position.x;
}

function compareObjects(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function add(position: Position, delta: Position): Position {
  return { x: position.x + delta.x, y: position.y + delta.y };
}

function subtract(left: Position, right: Position): Position {
  return { x: left.x - right.x, y: left.y - right.y };
}

function adjacentPositions(position: Position): Position[] {
  return directionEntries().map(({ delta }) => add(position, delta));
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
