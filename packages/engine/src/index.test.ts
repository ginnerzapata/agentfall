import { describe, expect, test } from "bun:test";

import { act, createRun, observe, replay } from "./index";

const run = {
  seed: "season-zero-commitment-secret",
  runId: "account-17-character-3",
  board: { width: 3, height: 1 },
  character: { position: { x: 0, y: 0 }, health: 12 },
  enemies: [
    { id: "goblin", position: { x: 1, y: 0 }, health: 8, defense: 0 },
  ],
};

describe("deterministic engine", () => {
  test("replays an identical snapshot from the same actions", () => {
    const actions = [
      { type: "attack" as const, targetId: "goblin" },
      { type: "end-turn" as const },
      { type: "attack" as const, targetId: "goblin" },
    ];

    const live = actions.reduce((snapshot, action) => act(snapshot, action).snapshot, createRun(run));
    const reconstructed = replay(run, actions);

    expect(reconstructed).toEqual(live);
    expect(reconstructed.checksum).toBe(live.checksum);
  });

  test("records the resolved random rolls in an accepted attack event", () => {
    const result = act(createRun(run), { type: "attack", targetId: "goblin" });

    expect(result.event).toMatchObject({ type: "attack", targetId: "goblin" });
    if (result.event.type !== "attack") throw new Error("Expected an attack event.");
    expect(result.event.roll).toBeGreaterThanOrEqual(1);
    expect(result.event.roll).toBeLessThanOrEqual(20);
    expect(result.event.damage).toBeGreaterThanOrEqual(0);
  });

  test("does not mutate a snapshot while observing it", () => {
    const snapshot = createRun(run);
    const before = JSON.stringify(snapshot);

    const view = observe(snapshot);

    expect(JSON.stringify(snapshot)).toBe(before);
    expect(view.legalActions).toEqual([
      { type: "attack", targetIds: ["goblin"] },
      { type: "end-turn" },
    ]);
  });
});
