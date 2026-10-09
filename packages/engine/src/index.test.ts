import { describe, expect, test } from "bun:test";
import {
  canonicalStringify,
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
  character: { position: { x: 0, y: 0 }, health: 12 },
  enemies: [{ id: "goblin", position: { x: 1, y: 0 }, health: 8, defense: 0 }],
};

function createSnapshot(definition: RunDefinition = run) {
  const result = createRun(definition);
  if (!result.accepted) throw new Error("Expected the Run definition to be accepted.");
  return result.snapshot;
}

function applyAcceptedActions(actions: Parameters<typeof replay>[1], definition = run) {
  return actions.reduce((snapshot, action) => {
    const result = act(snapshot, action);
    if (!result.accepted) throw new Error("Expected the action to be accepted.");
    return result.snapshot;
  }, createSnapshot(definition));
}

describe("deterministic engine", () => {
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

  test("does not mutate a snapshot while observing it", () => {
    const snapshot = createSnapshot();
    const before = JSON.stringify(snapshot);

    const view = observe(snapshot);

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(view.legalActions).toEqual([
      { type: "attack", targetIds: ["goblin"] },
      { type: "end-turn" },
    ]);
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
    const noEnemyRun: RunDefinition = { ...run, enemies: [], board: { width: 2, height: 1 } };
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
        { id: "goblin", position: { x: 1, y: 0 }, health: 8, defense: 0 },
        { id: "archer", position: { x: 2, y: 1 }, health: 6, defense: 1 },
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
      [{ ...run, enemies: [{ ...run.enemies[0], defense: -1 }] }, "invalid-enemy-stats"],
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
        character: { position: { x: seed % 3, y: Math.floor(seed / 3) % 2 }, health: 12 },
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
