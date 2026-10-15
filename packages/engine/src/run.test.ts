import { describe, expect, test } from "bun:test";

import type { RunDefinition } from "@agentfall/contracts";

import {
  abandonActiveFloor,
  actInFloor,
  completeActiveFloor,
  createExpeditionRun,
  createNextCharacter,
  startFloor,
  writeFloorNote,
} from "./index";

const floor = (overrides: Partial<RunDefinition> = {}): RunDefinition => ({
  seed: "floor-seed",
  runId: "floor",
  rulesetVersion: "rules-1",
  generatorVersion: "generator-1",
  board: { width: 3, height: 2 },
  tiles: [
    { position: { x: 0, y: 0 }, terrain: "entrance" },
    { position: { x: 1, y: 0 }, terrain: "objective" },
    { position: { x: 2, y: 0 }, terrain: "exit" },
    { position: { x: 0, y: 1 }, terrain: "wall" },
    { position: { x: 1, y: 1 }, terrain: "wall" },
    { position: { x: 2, y: 1 }, terrain: "wall" },
  ],
  objects: [],
  character: {
    position: { x: 0, y: 0 },
    health: 12,
    maxHealth: 12,
    defense: 1,
    movement: 1,
    accuracy: 1,
    power: 1,
    focus: 1,
  },
  enemies: [],
  ...overrides,
});

function started(turnBudget = 3) {
  const result = startFloor(createExpeditionRun("run", "season", 2), floor(), 1, turnBudget);
  if (!result.accepted) throw new Error("Expected floor to start.");
  return result.run;
}

describe("Run failure and knowledge rules", () => {
  test("rolls back collapse and abandonment without refunding the spent charge or discoveries", () => {
    const run = started(1);
    const before = run.character;
    const noted = writeFloorNote(run, "the exit is east");
    if (!noted.accepted) throw new Error("Expected note to be accepted.");
    const collapsed = actInFloor(noted.run, { type: "end-turn" });
    expect(collapsed).toMatchObject({ accepted: true, outcome: "collapsed" });
    if (!collapsed.accepted) throw new Error("Expected collapse.");
    expect(collapsed.run.character).toEqual(before);
    expect(collapsed.run.expeditionCharges).toBe(1);
    expect(collapsed.run.journal).toEqual({ facts: [], notes: [] });

    const restarted = startFloor(collapsed.run, floor(), 1, 3);
    if (!restarted.accepted) throw new Error("Expected restart.");
    const abandoned = abandonActiveFloor(restarted.run);
    expect(abandoned).toMatchObject({ accepted: true });
    if (!abandoned.accepted) throw new Error("Expected abandonment.");
    expect(abandoned.run.expeditionCharges).toBe(0);
    expect(abandoned.run.character).toEqual(before);
  });

  test("commits completion, including optional early exit, and keeps verified facts separate from notes", () => {
    let run = started();
    for (const action of [
      { type: "interact", target: { x: 1, y: 0 } },
      { type: "move", direction: "east" },
      { type: "interact", target: { x: 2, y: 0 } },
    ] as const) {
      const result = actInFloor(run, action);
      if (!result.accepted) throw new Error(result.reason);
      run = result.run;
    }
    const noted = writeFloorNote(run, "left the side room unexplored");
    if (!noted.accepted) throw new Error("Expected note.");
    const completed = completeActiveFloor(noted.run);
    expect(completed).toMatchObject({ accepted: true });
    if (!completed.accepted) throw new Error("Expected completion.");
    expect(completed.run.completedFloors).toBe(1);
    expect(completed.run.journal.facts[0]).toMatchObject({ kind: "terrain", floor: 1 });
    expect(completed.run.journal.notes).toEqual([
      { floor: 1, text: "left the side room unexplored" },
    ]);
    const nextFloor = startFloor(completed.run, floor({ runId: "floor-two" }), 2, 3);
    expect(nextFloor).toMatchObject({ accepted: true });
    if (!nextFloor.accepted) throw new Error("Expected second floor.");
    expect(nextFloor.run.activeFloor?.snapshot.inventory).toEqual(
      completed.run.character.inventory,
    );
  });

  test("preserves permanent death and creates the next deterministic character at floor one", () => {
    const lethal = floor({
      objects: [{ id: "fatal", type: "trap", position: { x: 1, y: 0 }, damage: 99 }],
    });
    const begun = startFloor(createExpeditionRun("run", "season", 1), lethal, 1, 3);
    if (!begun.accepted) throw new Error("Expected floor to start.");
    const died = actInFloor(begun.run, { type: "move", direction: "east" });
    expect(died).toMatchObject({ accepted: true, outcome: "died" });
    if (!died.accepted) throw new Error("Expected death.");
    expect(died.run).toMatchObject({ status: "dead", expeditionCharges: 0, characterDeaths: 1 });
    expect(died.run.journal.facts).toContainEqual({
      kind: "death",
      floor: 1,
      cause: "health-depleted",
    });
    const replacement = createNextCharacter(died.run);
    expect(replacement).toMatchObject({ accepted: true });
    if (!replacement.accepted) throw new Error("Expected replacement.");
    expect(replacement.run).toMatchObject({
      status: "active",
      characterSequence: 2,
      completedFloors: 0,
      nextFloor: 1,
    });
    expect(replacement.run.journal.facts).toHaveLength(1);
  });
});
