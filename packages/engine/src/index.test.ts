import { describe, expect, test } from "bun:test";
import {
  ACTION_POINT_COST,
  ACTION_POINT_LIMIT,
  BASIC_ATTACK_DAMAGE_DIE_SIDES,
  BASIC_ATTACK_HIT_DIFFICULTY,
  canonicalStringify,
  D20_SIDES,
  ENGINE_EVENT_SCHEMA_VERSION,
  type RunDefinition,
  type RunDefinitionRejectionReason,
  SNAPSHOT_SCHEMA_VERSION,
} from "@agentfall/contracts";

import { act, createRun, observe, replay, replayEvents } from "./index";

const run: RunDefinition = {
  seed: "season-zero-commitment-secret",
  runId: "account-17-character-3",
  rulesetVersion: "season-zero-rules-1",
  generatorVersion: "season-zero-generator-1",
  board: { width: 3, height: 1 },
  tiles: [
    { position: { x: 0, y: 0 }, terrain: "entrance" },
    { position: { x: 1, y: 0 }, terrain: "objective" },
    { position: { x: 2, y: 0 }, terrain: "exit" },
  ],
  objects: [],
  character: {
    position: { x: 0, y: 0 },
    health: 12,
    maxHealth: 12,
    defense: 1,
    movement: 1,
    accuracy: 0,
    power: 0,
    focus: 0,
  },
  enemies: [
    {
      id: "goblin",
      position: { x: 1, y: 0 },
      health: 8,
      maxHealth: 8,
      defense: 0,
      movement: 1,
      accuracy: 0,
      power: 0,
      focus: 0,
    },
  ],
};

function createSnapshot(definition: RunDefinition = run) {
  const result = createRun(withTilesForBoard(definition));
  if (!result.accepted) throw new Error("Expected the Run definition to be accepted.");
  return result.snapshot;
}

function withTilesForBoard(definition: RunDefinition): RunDefinition {
  if (definition.tiles.length === definition.board.width * definition.board.height)
    return definition;
  const tiles = [] as RunDefinition["tiles"];
  for (let y = 0; y < definition.board.height; y += 1) {
    for (let x = 0; x < definition.board.width; x += 1) {
      tiles.push({ position: { x, y }, terrain: "floor" });
    }
  }
  const entrance = tiles.find(
    (tile) =>
      tile.position.x === definition.character.position.x &&
      tile.position.y === definition.character.position.y,
  );
  if (!entrance) throw new Error("Expected character position on the board.");
  entrance.terrain = "entrance";
  const available = tiles.filter((tile) => tile !== entrance);
  const objective = available.at(-1);
  const exit = available.at(-2);
  if (!objective || !exit) {
    throw new Error("Expected a board large enough for the fixture floor.");
  }
  objective.terrain = "objective";
  exit.terrain = "exit";
  return { ...definition, tiles };
}

function applyAcceptedActions(actions: Parameters<typeof replay>[1], definition = run) {
  return actions.reduce((snapshot, action) => {
    const result = act(snapshot, action);
    if (!result.accepted) throw new Error("Expected the action to be accepted.");
    return result.snapshot;
  }, createSnapshot(definition));
}

describe("deterministic engine", () => {
  test("starts turns with four AP and publishes the agreed action costs", () => {
    expect(ACTION_POINT_LIMIT).toBe(4);
    expect(ACTION_POINT_COST).toEqual({
      move: 1,
      attack: 2,
      interact: 1,
      openDoor: 1,
      closeDoor: 1,
    });

    let snapshot = createSnapshot({ ...run, enemies: [], board: { width: 3, height: 2 } });
    expect(snapshot.actionPoints).toBe(ACTION_POINT_LIMIT);
    const moved = act(snapshot, { type: "move", direction: "east" });
    if (!moved.accepted) throw new Error("Expected the move to be accepted.");
    snapshot = moved.snapshot;
    expect(snapshot.actionPoints).toBe(ACTION_POINT_LIMIT - ACTION_POINT_COST.move);

    const nextTurn = act(snapshot, { type: "end-turn" });
    if (!nextTurn.accepted) throw new Error("Expected the turn to end.");
    expect(nextTurn.snapshot.actionPoints).toBe(ACTION_POINT_LIMIT);
  });

  test("allows movement before and after an attack in the same turn", () => {
    const definition: RunDefinition = {
      ...run,
      board: { width: 4, height: 1 },
      tiles: [
        { position: { x: 0, y: 0 }, terrain: "entrance" },
        { position: { x: 1, y: 0 }, terrain: "floor" },
        { position: { x: 2, y: 0 }, terrain: "objective" },
        { position: { x: 3, y: 0 }, terrain: "exit" },
      ],
      character: { ...run.character, accuracy: 20 },
      enemies: [{ ...run.enemies[0], position: { x: 2, y: 0 }, health: 1, maxHealth: 1 }],
    };
    let snapshot = createSnapshot(definition);

    const approach = act(snapshot, { type: "move", direction: "east" });
    if (!approach.accepted) throw new Error("Expected the approach move to be accepted.");
    snapshot = approach.snapshot;

    const attack = act(snapshot, { type: "attack", targetId: "goblin" });
    if (!attack.accepted) throw new Error("Expected the attack to be accepted.");
    snapshot = attack.snapshot;

    const advance = act(snapshot, { type: "move", direction: "east" });
    if (!advance.accepted) throw new Error("Expected the advance move to be accepted.");

    expect(advance.snapshot.turn).toBe(1);
    expect(advance.snapshot.character.position).toEqual({ x: 2, y: 0 });
    expect(advance.snapshot.actionPoints).toBe(0);
    expect(advance.snapshot.events.map((event) => event.type)).toEqual(["move", "attack", "move"]);
  });

  test("converts up to two unused AP into temporary Defense until the next Action", () => {
    const definition: RunDefinition = { ...run, enemies: [], board: { width: 3, height: 2 } };
    let snapshot = createSnapshot(definition);

    const endedEarly = act(snapshot, { type: "end-turn" });
    if (!endedEarly.accepted || endedEarly.event.type !== "end-turn") {
      throw new Error("Expected the turn to end.");
    }
    snapshot = endedEarly.snapshot;
    expect(endedEarly.event.temporaryDefense).toBe(2);
    expect(observe(snapshot).character.temporaryDefense).toBe(2);

    const nextAction = act(snapshot, { type: "move", direction: "east" });
    if (!nextAction.accepted) throw new Error("Expected the next move to be accepted.");
    expect(nextAction.snapshot.character.temporaryDefense).toBe(0);
    expect(replayEvents(withTilesForBoard(definition), nextAction.snapshot.events)).toEqual({
      accepted: true,
      snapshot: nextAction.snapshot,
    });

    const oneUnused = applyAcceptedActions(
      [
        { type: "move", direction: "east" },
        { type: "move", direction: "west" },
        { type: "move", direction: "east" },
        { type: "end-turn" },
      ],
      definition,
    );
    expect(oneUnused.character.temporaryDefense).toBe(1);

    const noUnused = applyAcceptedActions(
      [
        { type: "move", direction: "east" },
        { type: "move", direction: "west" },
        { type: "move", direction: "east" },
        { type: "move", direction: "west" },
        { type: "end-turn" },
      ],
      definition,
    );
    expect(noUnused.character.temporaryDefense).toBe(0);
  });

  test("replays an identical snapshot from the same actions", () => {
    const actions = [
      { type: "attack" as const, targetId: "goblin" },
      { type: "end-turn" as const },
      { type: "attack" as const, targetId: "goblin" },
    ];

    const live = applyAcceptedActions(actions);
    const reconstructed = replay(run, actions);
    const independentlyReconstructed = replay(run, actions);

    expect(reconstructed).toEqual({ accepted: true, snapshot: live });
    expect(independentlyReconstructed).toEqual(reconstructed);
  });

  test("uses canonical serialization for checksums", () => {
    expect(canonicalStringify({ b: [2, { d: true, c: null }], a: 1 })).toBe(
      '{"a":1,"b":[2,{"c":null,"d":true}]}',
    );
  });

  test("replays stored Events without rerolling their resolved values", () => {
    const live = applyAcceptedActions([
      { type: "attack", targetId: "goblin" },
      { type: "end-turn" },
      { type: "attack", targetId: "goblin" },
    ]);

    expect(replayEvents(run, live.events)).toEqual({ accepted: true, snapshot: live });
  });

  test("records the resolved random rolls in an accepted attack event", () => {
    const snapshot = createSnapshot();
    const result = act(snapshot, { type: "attack", targetId: "goblin" });

    if (!result.accepted) throw new Error("Expected the attack to be accepted.");
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.rulesetVersion).toBe(run.rulesetVersion);
    expect(snapshot.generatorVersion).toBe(run.generatorVersion);
    expect(result.event.schemaVersion).toBe(ENGINE_EVENT_SCHEMA_VERSION);
    expect(result.event).toMatchObject({ type: "attack", targetId: "goblin" });
    if (result.event.type !== "attack") throw new Error("Expected an attack event.");
    expect(result.event.roll).toBeGreaterThanOrEqual(1);
    expect(result.event.roll).toBeLessThanOrEqual(20);
    expect(result.event.damage).toBeGreaterThanOrEqual(0);
  });

  test("uses Accuracy, Power, and Defense in deterministic basic attacks", () => {
    const definition: RunDefinition = {
      ...run,
      character: { ...run.character, accuracy: 120, power: 2 },
      enemies: [{ ...run.enemies[0], defense: 100, health: 20, maxHealth: 20 }],
    };
    const snapshot = createSnapshot(definition);
    const result = act(snapshot, { type: "attack", targetId: "goblin" });

    if (!result.accepted || result.event.type !== "attack") {
      throw new Error("Expected the attack to be accepted.");
    }
    expect(result.event.damage).toBeGreaterThanOrEqual(3);
    expect(result.event.damage).toBeLessThanOrEqual(8);
    expect(result.snapshot.enemies[0]?.health).toBe(20 - result.event.damage);
    expect(observe(result.snapshot).character).toMatchObject({
      defense: 1,
      movement: 1,
      accuracy: 120,
      power: 2,
      focus: 0,
    });
  });

  test("resolves seeded d20 attacks with a small deterministic damage die", () => {
    const guaranteedHit: RunDefinition = {
      ...run,
      character: { ...run.character, accuracy: D20_SIDES },
      enemies: [{ ...run.enemies[0], health: 20, maxHealth: 20 }],
    };
    const first = act(createSnapshot(guaranteedHit), { type: "attack", targetId: "goblin" });
    const second = act(createSnapshot(guaranteedHit), { type: "attack", targetId: "goblin" });

    if (!first.accepted || !second.accepted || first.event.type !== "attack") {
      throw new Error("Expected deterministic attacks to be accepted.");
    }
    expect(first).toEqual(second);
    expect(first.event.roll).toBeGreaterThanOrEqual(1);
    expect(first.event.roll).toBeLessThanOrEqual(D20_SIDES);
    expect(first.event.damage).toBeGreaterThanOrEqual(1);
    expect(first.event.damage).toBeLessThanOrEqual(BASIC_ATTACK_DAMAGE_DIE_SIDES);

    const guaranteedMiss = act(
      createSnapshot({
        ...guaranteedHit,
        character: { ...guaranteedHit.character, accuracy: 0 },
        enemies: [
          { ...guaranteedHit.enemies[0], defense: D20_SIDES + BASIC_ATTACK_HIT_DIFFICULTY },
        ],
      }),
      { type: "attack", targetId: "goblin" },
    );
    if (!guaranteedMiss.accepted || guaranteedMiss.event.type !== "attack") {
      throw new Error("Expected the deterministic miss to be accepted.");
    }
    expect(guaranteedMiss.event.damage).toBe(0);
  });

  test("does not mutate a snapshot while observing it", () => {
    const snapshot = createSnapshot();
    const before = JSON.stringify(snapshot);

    const view = observe(snapshot);

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(view.legalActions).toEqual([
      { type: "attack", targetIds: ["goblin"] },
      { type: "interact", targets: [{ x: 1, y: 0 }] },
      { type: "end-turn" },
    ]);
  });

  test("keeps terrain remembered while hiding entities and terrain behind a wall", () => {
    const definition: RunDefinition = {
      ...run,
      board: { width: 8, height: 1 },
      tiles: [
        { position: { x: 0, y: 0 }, terrain: "entrance" },
        { position: { x: 1, y: 0 }, terrain: "floor" },
        { position: { x: 2, y: 0 }, terrain: "wall" },
        { position: { x: 3, y: 0 }, terrain: "floor" },
        { position: { x: 4, y: 0 }, terrain: "floor" },
        { position: { x: 5, y: 0 }, terrain: "floor" },
        { position: { x: 6, y: 0 }, terrain: "objective" },
        { position: { x: 7, y: 0 }, terrain: "exit" },
      ],
      enemies: [
        {
          ...run.enemies[0],
          id: "hidden-goblin",
          position: { x: 4, y: 0 },
        },
      ],
    };

    const view = observe(createSnapshot(definition));

    expect(view.tiles).toEqual([
      { position: { x: 0, y: 0 }, terrain: "entrance", visibility: "visible" },
      { position: { x: 1, y: 0 }, terrain: "floor", visibility: "visible" },
      { position: { x: 2, y: 0 }, terrain: "wall", visibility: "visible" },
    ]);
    expect(view.enemies).toEqual([]);
    expect(view.ascii).toBe("@.#?????");
  });

  test("opens doors and unlocks an exit only after the objective interaction", () => {
    const definition: RunDefinition = {
      ...run,
      board: { width: 3, height: 2 },
      enemies: [],
      tiles: [
        { position: { x: 0, y: 0 }, terrain: "entrance" },
        { position: { x: 1, y: 0 }, terrain: "floor", door: "closed" },
        { position: { x: 2, y: 0 }, terrain: "objective" },
        { position: { x: 0, y: 1 }, terrain: "wall" },
        { position: { x: 1, y: 1 }, terrain: "wall" },
        { position: { x: 2, y: 1 }, terrain: "exit" },
      ],
    };
    let snapshot = createSnapshot(definition);

    expect(act(snapshot, { type: "move", direction: "east" })).toEqual({
      accepted: false,
      reason: "blocked-destination",
    });
    const opened = act(snapshot, { type: "open-door", target: { x: 1, y: 0 } });
    if (!opened.accepted) throw new Error("Expected the door to open.");
    snapshot = opened.snapshot;
    const moved = act(snapshot, { type: "move", direction: "east" });
    if (!moved.accepted) throw new Error("Expected movement through the opened door.");
    snapshot = moved.snapshot;

    expect(act(snapshot, { type: "interact", target: { x: 2, y: 1 } })).toEqual({
      accepted: false,
      reason: "invalid-interaction",
    });
    const objective = act(snapshot, { type: "interact", target: { x: 2, y: 0 } });
    if (!objective.accepted) throw new Error("Expected the objective interaction.");
    snapshot = objective.snapshot;
    const ontoObjective = act(snapshot, { type: "move", direction: "east" });
    if (!ontoObjective.accepted) throw new Error("Expected movement onto the objective tile.");
    const nextTurn = act(ontoObjective.snapshot, { type: "end-turn" });
    if (!nextTurn.accepted) throw new Error("Expected turn to end.");
    const exit = act(nextTurn.snapshot, { type: "interact", target: { x: 2, y: 1 } });
    if (!exit.accepted) throw new Error("Expected the exit interaction.");

    expect(exit.snapshot.exitUnlocked).toBe(true);
    expect(replayEvents(definition, exit.snapshot.events)).toEqual({
      accepted: true,
      snapshot: exit.snapshot,
    });
  });

  test("explores a fixture floor without leaking unseen content and replays its known state", () => {
    const tiles: RunDefinition["tiles"] = [];
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        tiles.push({ position: { x, y }, terrain: x === 7 && y === 1 ? "secret" : "floor" });
      }
    }
    const entrance = tiles.find((tile) => tile.position.x === 0 && tile.position.y === 0);
    const objective = tiles.find((tile) => tile.position.x === 8 && tile.position.y === 0);
    const exit = tiles.find((tile) => tile.position.x === 9 && tile.position.y === 0);
    if (!entrance || !objective || !exit) throw new Error("Expected fixture tiles.");
    entrance.terrain = "entrance";
    objective.terrain = "objective";
    exit.terrain = "exit";
    const definition: RunDefinition = {
      ...run,
      board: { width: 10, height: 2 },
      tiles,
      objects: [
        { id: "supply-chest", type: "chest", position: { x: 1, y: 0 }, itemId: "potion" },
        { id: "spike-trap", type: "trap", position: { x: 2, y: 0 }, damage: 3 },
        { id: "shrine", type: "sanctuary", position: { x: 3, y: 0 }, healing: 7 },
        { id: "loose-tonic", type: "item", position: { x: 7, y: 0 }, itemId: "tonic" },
      ],
      enemies: [],
      character: { ...run.character, position: { x: 0, y: 0 }, health: 8 },
    };
    let snapshot = createSnapshot(definition);
    const initial = observe(snapshot);

    expect(initial.objects.map((object) => object.id)).toEqual([
      "shrine",
      "spike-trap",
      "supply-chest",
    ]);
    expect(initial.tiles.some((tile) => tile.terrain === "secret")).toBe(false);
    expect(initial.ascii).not.toContain("s");

    const actions: Parameters<typeof replay>[1] = [
      { type: "interact", target: { x: 1, y: 0 } },
      { type: "move", direction: "east" },
      { type: "move", direction: "east" },
      { type: "interact", target: { x: 3, y: 0 } },
      { type: "end-turn" },
      { type: "move", direction: "east" },
      { type: "move", direction: "east" },
      { type: "move", direction: "east" },
      { type: "move", direction: "east" },
      { type: "end-turn" },
      { type: "interact", target: { x: 7, y: 0 } },
      { type: "move", direction: "east" },
      { type: "interact", target: { x: 8, y: 0 } },
      { type: "move", direction: "east" },
      { type: "end-turn" },
      { type: "interact", target: { x: 9, y: 0 } },
    ];
    for (const action of actions) {
      const result = act(snapshot, action);
      if (!result.accepted) throw new Error(`Expected ${action.type} to be accepted.`);
      snapshot = result.snapshot;
    }

    expect(snapshot.character.health).toBe(12);
    expect(snapshot.inventory).toEqual(["potion", "tonic"]);
    expect(snapshot.exitUnlocked).toBe(true);
    expect(snapshot.objects.every((object) => object.used)).toBe(true);
    const replayed = replayEvents(definition, snapshot.events);
    if (!replayed.accepted) throw new Error("Expected fixture events to replay.");
    expect(observe(replayed.snapshot)).toEqual(observe(snapshot));
  });

  test("repeated Observations do not change a later outcome", () => {
    const snapshot = createSnapshot();
    const cleanAttack = act(createSnapshot(), { type: "attack", targetId: "goblin" });

    for (let index = 0; index < 20; index += 1) observe(snapshot);

    expect(act(snapshot, { type: "attack", targetId: "goblin" })).toEqual(cleanAttack);
  });

  test("rejected actions leave state, Events, and deterministic rolls unchanged", () => {
    const snapshot = createSnapshot();
    const cleanAttack = act(createSnapshot(), { type: "attack", targetId: "goblin" });
    const checksum = snapshot.checksum;
    const events = snapshot.events;
    const actionPoints = snapshot.actionPoints;
    const turn = snapshot.turn;

    const blockedMove = act(snapshot, { type: "move", direction: "west" });
    const invalidTarget = act(snapshot, { type: "attack", targetId: "missing" });

    expect(blockedMove).toEqual({
      accepted: false,
      reason: "blocked-destination",
    });
    expect(invalidTarget).toEqual({ accepted: false, reason: "invalid-target" });
    expect(snapshot.checksum).toBe(checksum);
    expect(snapshot.events).toBe(events);
    expect(snapshot.events).toHaveLength(0);
    expect(snapshot.actionPoints).toBe(actionPoints);
    expect(snapshot.turn).toBe(turn);
    expect(act(snapshot, { type: "attack", targetId: "goblin" })).toEqual(cleanAttack);
  });

  test("rejects actions that cost more action points than remain", () => {
    const noEnemyRun: RunDefinition = { ...run, enemies: [], board: { width: 3, height: 2 } };
    const moves = ["east", "west", "east", "west"] as const;
    const exhausted = moves.reduce((snapshot, direction) => {
      const result = act(snapshot, { type: "move", direction });
      if (!result.accepted) throw new Error("Expected the move to be accepted.");
      return result.snapshot;
    }, createSnapshot(noEnemyRun));
    const before = JSON.stringify(exhausted);

    expect(act(exhausted, { type: "move", direction: "east" })).toEqual({
      accepted: false,
      reason: "insufficient-action-points",
    });
    expect(JSON.stringify(exhausted)).toBe(before);
  });

  test("reports the rejected action when replay cannot continue", () => {
    const result = replay(run, [{ type: "move", direction: "west" }]);

    expect(result).toMatchObject({
      accepted: false,
      rejection: { accepted: false, reason: "blocked-destination" },
    });
  });

  test("normalizes entity ordering for checksums and RNG streams", () => {
    const ordered: RunDefinition = {
      ...run,
      board: { width: 3, height: 2 },
      enemies: [
        { ...run.enemies[0], id: "goblin", position: { x: 1, y: 0 } },
        {
          ...run.enemies[0],
          id: "archer",
          position: { x: 2, y: 1 },
          health: 6,
          maxHealth: 6,
          defense: 1,
        },
      ],
    };
    const reordered: RunDefinition = { ...ordered, enemies: [...ordered.enemies].reverse() };
    const orderedSnapshot = createSnapshot(ordered);
    const reorderedSnapshot = createSnapshot(reordered);

    expect(reorderedSnapshot).toEqual(orderedSnapshot);
    expect(act(reorderedSnapshot, { type: "attack", targetId: "goblin" })).toEqual(
      act(orderedSnapshot, { type: "attack", targetId: "goblin" }),
    );
  });

  test("rejects invalid Run definitions before creating a Snapshot", () => {
    const definitions: Array<[RunDefinition, RunDefinitionRejectionReason]> = [
      [{ ...run, board: { width: 0, height: 1 } }, "invalid-board-dimensions"],
      [{ ...run, character: { ...run.character, health: 0 } }, "invalid-character-stats"],
      [{ ...run, character: { ...run.character, movement: 0 } }, "invalid-character-stats"],
      [{ ...run, character: { ...run.character, focus: -1 } }, "invalid-character-stats"],
      [{ ...run, enemies: [{ ...run.enemies[0], defense: -1 }] }, "invalid-enemy-stats"],
      [{ ...run, enemies: [{ ...run.enemies[0], power: -1 }] }, "invalid-enemy-stats"],
      [
        {
          ...run,
          enemies: [run.enemies[0], { ...run.enemies[0], position: { x: 2, y: 0 } }],
        },
        "duplicate-entity-id",
      ],
      [
        {
          ...run,
          enemies: [{ ...run.enemies[0], position: run.character.position }],
        },
        "duplicate-occupancy",
      ],
      [
        {
          ...run,
          character: { ...run.character, position: { x: -1, y: 0 } },
        },
        "invalid-starting-position",
      ],
      [{ ...run, rulesetVersion: "" }, "invalid-ruleset-version"],
      [{ ...run, generatorVersion: "" }, "invalid-generator-version"],
    ];

    for (const [definition, reason] of definitions) {
      expect(createRun(definition)).toEqual({ accepted: false, reason });
    }
  });

  test("reports an invalid Run definition when replay cannot start", () => {
    const result = replay({ ...run, enemies: [{ ...run.enemies[0], health: 0 }] }, []);

    expect(result).toEqual({
      accepted: false,
      rejection: { accepted: false, reason: "invalid-enemy-stats" },
    });
  });

  test("preserves state invariants across representative legal-action sequences", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      let snapshot = createSnapshot({
        ...run,
        seed: `seed-${seed}`,
        runId: `run-${seed}`,
        board: { width: 3, height: 2 },
        character: {
          ...run.character,
          position: { x: seed % 3, y: Math.floor(seed / 3) % 2 },
          health: 12,
          maxHealth: 12,
        },
        enemies: [],
      });

      for (let step = 0; step < 24; step += 1) {
        const move = observe(snapshot).legalActions.find((action) => action.type === "move");
        const action = move
          ? { type: "move" as const, direction: move.directions[0] }
          : { type: "end-turn" as const };
        const result = act(snapshot, action);
        if (!result.accepted) throw new Error("Expected the observed action to be accepted.");
        snapshot = result.snapshot;

        expect(snapshot.actionPoints).toBeGreaterThanOrEqual(0);
        expect(snapshot.actionPoints).toBeLessThanOrEqual(4);
        expect(snapshot.character.position.x).toBeGreaterThanOrEqual(0);
        expect(snapshot.character.position.x).toBeLessThan(snapshot.board.width);
        expect(snapshot.character.position.y).toBeGreaterThanOrEqual(0);
        expect(snapshot.character.position.y).toBeLessThan(snapshot.board.height);
        expect(
          new Set(snapshot.enemies.map((enemy) => `${enemy.position.x},${enemy.position.y}`)).size,
        ).toBe(snapshot.enemies.length);
      }
    }
  });
});
