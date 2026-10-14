import { describe, expect, test } from "bun:test";

import type { InventoryState, ItemDefinition, ProgressionCharacter } from "@agentfall/contracts";

import {
  chooseUpgrade,
  completeFloor,
  generateProgressionCharacter,
  generateUpgradeOptions,
  NORMAL_FLOOR_RECOVERY,
  swapEquipment,
  TRAIT_POOL,
  useConsumable,
} from "./progression";

const items: ItemDefinition[] = [
  { id: "iron-sword", kind: "weapon" },
  { id: "chain-shirt", kind: "armor" },
  { id: "moon-charm", kind: "accessory" },
  { id: "healing-potion", kind: "consumable", healing: 5 },
];

const inventory: InventoryState = {
  weapon: "wooden-sword",
  armor: "cloth",
  accessory: null,
  backpack: [
    { itemId: "iron-sword", quantity: 1 },
    { itemId: "healing-potion", quantity: 2 },
    null,
    null,
  ],
};

describe("inventory and progression", () => {
  test("makes between-floor equipment swaps free and in-floor swaps cost one AP", () => {
    const betweenFloors = swapEquipment(inventory, items, "between-floors", 0);
    expect(betweenFloors).toEqual({
      accepted: true,
      actionPointCost: 0,
      inventory: {
        weapon: "iron-sword",
        armor: "cloth",
        accessory: null,
        backpack: [
          { itemId: "wooden-sword", quantity: 1 },
          { itemId: "healing-potion", quantity: 2 },
          null,
          null,
        ],
      },
    });
    const inFloor = swapEquipment(inventory, items, "in-floor", 0);
    expect(inFloor.accepted && inFloor.actionPointCost).toBe(1);
    expect(inventory.weapon).toBe("wooden-sword");
  });

  test("consumes one potion from a stack and reports its Action cost", () => {
    const used = useConsumable(inventory, items, 1);
    expect(used).toEqual({
      accepted: true,
      actionPointCost: 1,
      healing: 5,
      inventory: {
        ...inventory,
        backpack: [
          { itemId: "iron-sword", quantity: 1 },
          { itemId: "healing-potion", quantity: 1 },
          null,
          null,
        ],
      },
    });
  });

  test("preserves normal-floor state, recovers a fixed amount, levels, and offers upgrades", () => {
    const character = generateProgressionCharacter("season-zero", 3);
    character.character.health = 4;
    character.injuries = ["sprained-ankle"];
    const completed = completeFloor(character, "normal", "season-zero");

    expect(completed.character.health).toBe(4 + NORMAL_FLOOR_RECOVERY);
    expect(completed.inventory).toEqual(character.inventory);
    expect(completed.injuries).toEqual(["sprained-ankle"]);
    expect(completed.level).toBe(2);
    expect(completed.pendingUpgrades).toHaveLength(3);
    expect(completed.pendingUpgrades).toEqual(
      generateUpgradeOptions(completed.character.class ?? "vanguard", 2, "season-zero"),
    );
    const chosen = chooseUpgrade(completed, completed.pendingUpgrades[0]?.id ?? "");
    expect(chosen?.pendingUpgrades).toEqual([]);

    const boss = completeFloor(
      { ...completed, character: { ...completed.character, health: 1 } },
      "boss",
      "season-zero",
    );
    expect(boss.character.health).toBe(boss.character.maxHealth);
  });

  test("generates deterministic class and balanced positive and negative traits", () => {
    const first = generateProgressionCharacter("season-zero", 8);
    const second = generateProgressionCharacter("season-zero", 8);
    const next = generateProgressionCharacter("season-zero", 9);
    expect(first).toEqual(second);
    expect(first.traits.map((trait) => trait.polarity).sort()).toEqual(["negative", "positive"]);
    expect(
      first.traits.every((trait) => TRAIT_POOL.some((candidate) => candidate.id === trait.id)),
    ).toBe(true);
    expect(next).not.toEqual(first);
  });

  test("rejects an upgrade selection that was not offered", () => {
    const character: ProgressionCharacter = generateProgressionCharacter("season-zero", 1);
    expect(chooseUpgrade(character, "not-offered")).toBeUndefined();
  });
});
