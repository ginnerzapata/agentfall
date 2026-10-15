import { describe, expect, test } from "bun:test";
import {
  advanceWarDrums,
  createWarDrums,
  disableWarDrums,
  generateOrcSiegeTower,
  ORC_SIEGE_CONTENT,
  ORC_SIEGE_UPGRADE_POOLS,
  resolveOrcIntent,
  resolveWarchiefIntent,
  simulateOrcSiegeTower,
  warchiefArenaState,
} from "./index";

describe("Orc Siege content pack", () => {
  test("authors all four enemy roles, varied templates, items, and upgrades", () => {
    expect(ORC_SIEGE_CONTENT.enemies.map((enemy) => enemy.role).sort()).toEqual([
      "archer",
      "boss",
      "brute",
      "scout",
      "shaman",
    ]);
    expect(ORC_SIEGE_CONTENT.rooms).toHaveLength(13);
    expect(ORC_SIEGE_CONTENT.items).toHaveLength(6);
    expect(Object.values(ORC_SIEGE_UPGRADE_POOLS).every((pool) => pool.length === 3)).toBe(true);
  });

  test("war drums reinforce every second unresolved beat and stop when disabled", () => {
    const firstBeat = advanceWarDrums(createWarDrums());
    expect(firstBeat).toMatchObject({ beatsUntilReinforcement: 1, reinforcementCount: 0 });
    const reinforcement = advanceWarDrums(firstBeat);
    expect(reinforcement).toMatchObject({ beatsUntilReinforcement: 2, reinforcementCount: 1 });
    expect(advanceWarDrums(disableWarDrums(reinforcement))).toEqual({
      ...reinforcement,
      disabled: true,
    });
  });

  test("the Warchief telegraphs and then resolves its Last Stand arena strike", () => {
    expect(warchiefArenaState(28, 28, 0)).toEqual({
      phase: "command",
      telegraphed: false,
      arenaStrikeDue: false,
    });
    expect(warchiefArenaState(14, 28, 0)).toEqual({
      phase: "last-stand",
      telegraphed: true,
      arenaStrikeDue: false,
    });
    expect(warchiefArenaState(14, 28, 1)).toEqual({
      phase: "last-stand",
      telegraphed: false,
      arenaStrikeDue: true,
    });
    expect(resolveWarchiefIntent(warchiefArenaState(14, 28, 0))).toEqual({
      type: "telegraph-arena-strike",
    });
    expect(resolveWarchiefIntent(warchiefArenaState(14, 28, 1))).toEqual({
      type: "arena-strike",
      damage: 3,
    });
  });

  test("gives each Orc role a deterministic, distinct combat intent", () => {
    const character = {
      id: "character",
      role: "boss" as const,
      health: 12,
      maxHealth: 12,
      position: { x: 4, y: 0 },
    };
    expect(
      resolveOrcIntent(
        { id: "scout", role: "scout", health: 6, maxHealth: 6, position: { x: 3, y: 0 } },
        character,
        [],
      ),
    ).toEqual({ type: "move", toward: { x: 2, y: 0 } });
    expect(
      resolveOrcIntent(
        { id: "brute", role: "brute", health: 12, maxHealth: 12, position: { x: 0, y: 0 } },
        character,
        [],
      ),
    ).toEqual({ type: "move", toward: { x: 4, y: 0 } });
    expect(
      resolveOrcIntent(
        { id: "archer", role: "archer", health: 7, maxHealth: 7, position: { x: 1, y: 0 } },
        character,
        [],
      ),
    ).toEqual({ type: "ranged-attack", targetId: "character", damage: 2 });
    expect(
      resolveOrcIntent(
        { id: "shaman", role: "shaman", health: 8, maxHealth: 8, position: { x: 0, y: 1 } },
        character,
        [{ id: "brute", role: "brute", health: 4, maxHealth: 12, position: { x: 0, y: 0 } }],
      ),
    ).toEqual({ type: "heal", targetId: "brute", amount: 2 });
  });

  test("builds a five-floor tower with an authored Warchief finale and completes it for every class", () => {
    const tower = generateOrcSiegeTower("siege-seed");
    expect(tower).toHaveLength(5);
    expect(tower[4]?.rooms.slice(0, 3).map((room) => room.templateId)).toEqual([
      "warchief-preparation",
      "warchief-arena",
      "warchief-trophy-room",
    ]);
    expect(tower[4]?.encounters).toEqual([
      { roomId: tower[4]?.rooms[1]?.id, encounterId: "warchief" },
    ]);
    expect(tower[4]?.definition.enemies.map((enemy) => enemy.id)).toEqual([
      "orc-warchief",
      "orc-archer",
    ]);
    expect(simulateOrcSiegeTower("siege-seed").every((result) => result.completed)).toBe(true);
  });
});
