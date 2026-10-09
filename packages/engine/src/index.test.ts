import { describe, expect, test } from "bun:test";
import type { RunDefinition } from "@agentfall/contracts";

import { act, createRun, observe, replay } from "./index";

const run: RunDefinition = {
  seed: "season-zero-commitment-secret",
  runId: "account-17-character-3",
  board: { width: 3, height: 1 },
  character: { position: { x: 0, y: 0 }, health: 12 },
  enemies: [{ id: "goblin", position: { x: 1, y: 0 }, health: 8, defense: 0 }],
};

describe("deterministic engine", () => {
  test("replays an identical snapshot from the same actions", () => {
    const actions = [
      { type: "attack" as const, targetId: "goblin" },
      { type: "end-turn" as const },
      { type: "attack" as const, targetId: "goblin" },
    ];

    const live = actions.reduce((snapshot, action) => {
      const result = act(snapshot, action);
      if (!result.accepted) throw new Error("Expected the action to be accepted.");
      return result.snapshot;
    }, createRun(run));
    const reconstructed = replay(run, actions);

    expect(reconstructed).toEqual({ accepted: true, snapshot: live });
  });

  test("records the resolved random rolls in an accepted attack event", () => {
    const result = act(createRun(run), { type: "attack", targetId: "goblin" });

    if (!result.accepted) throw new Error("Expected the attack to be accepted.");
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

  test("rejects invalid actions without mutating the snapshot", () => {
    const snapshot = createRun(run);
    const before = JSON.stringify(snapshot);

    const blockedMove = act(snapshot, { type: "move", direction: "west" });
    const invalidTarget = act(snapshot, { type: "attack", targetId: "missing" });

    expect(blockedMove).toEqual({
      accepted: false,
      reason: "blocked-destination",
    });
    expect(invalidTarget).toEqual({ accepted: false, reason: "invalid-target" });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  test("rejects actions that cost more action points than remain", () => {
    const noEnemyRun: RunDefinition = { ...run, enemies: [], board: { width: 2, height: 1 } };
    const moves = ["east", "west", "east", "west"] as const;
    const exhausted = moves.reduce((snapshot, direction) => {
      const result = act(snapshot, { type: "move", direction });
      if (!result.accepted) throw new Error("Expected the move to be accepted.");
      return result.snapshot;
    }, createRun(noEnemyRun));
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
});
