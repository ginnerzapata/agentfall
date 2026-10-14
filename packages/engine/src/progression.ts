import {
  BACKPACK_SLOT_COUNT,
  type CharacterClass,
  type CharacterDefinition,
  type InventoryContext,
  type InventoryState,
  type ItemDefinition,
  type ProgressionCharacter,
  type Trait,
  type Upgrade,
} from "@agentfall/contracts";

export const NORMAL_FLOOR_RECOVERY = 2;

export const TRAIT_POOL: Trait[] = [
  { id: "hardy", polarity: "positive", stat: "maxHealth", delta: 2 },
  { id: "keen", polarity: "positive", stat: "accuracy", delta: 1 },
  { id: "strong", polarity: "positive", stat: "power", delta: 1 },
  { id: "fragile", polarity: "negative", stat: "maxHealth", delta: -2 },
  { id: "clumsy", polarity: "negative", stat: "accuracy", delta: -1 },
  { id: "unfocused", polarity: "negative", stat: "focus", delta: -1 },
];

const CLASS_UPGRADES: Record<CharacterClass, Upgrade[]> = {
  vanguard: [
    { id: "vanguard-vitality", stat: "maxHealth", delta: 2 },
    { id: "vanguard-plate", stat: "defense", delta: 1 },
    { id: "vanguard-might", stat: "power", delta: 1 },
  ],
  ranger: [
    { id: "ranger-aim", stat: "accuracy", delta: 1 },
    { id: "ranger-stride", stat: "movement", delta: 1 },
    { id: "ranger-draw", stat: "power", delta: 1 },
  ],
  arcanist: [
    { id: "arcanist-focus", stat: "focus", delta: 1 },
    { id: "arcanist-warding", stat: "defense", delta: 1 },
    { id: "arcanist-vitality", stat: "maxHealth", delta: 2 },
  ],
};

export type InventoryOperationResult =
  | { accepted: true; inventory: InventoryState; actionPointCost: 0 | 1 }
  | { accepted: false; reason: "invalid-item" | "invalid-slot" | "backpack-full" };

export function swapEquipment(
  inventory: InventoryState,
  items: ItemDefinition[],
  context: InventoryContext,
  backpackSlot: number,
): InventoryOperationResult {
  const stack = inventory.backpack[backpackSlot];
  if (!Number.isSafeInteger(backpackSlot) || backpackSlot < 0 || !stack) {
    return { accepted: false, reason: "invalid-slot" };
  }
  const item = items.find((candidate) => candidate.id === stack.itemId);
  if (!item || item.kind === "consumable") return { accepted: false, reason: "invalid-item" };

  const next = cloneInventory(inventory);
  const equipped = next[item.kind];
  consumeBackpackItem(next, backpackSlot);
  if (equipped !== null && !addToBackpack(next, equipped)) {
    return { accepted: false, reason: "backpack-full" };
  }
  next[item.kind] = item.id;
  return { accepted: true, inventory: next, actionPointCost: context === "in-floor" ? 1 : 0 };
}

export function useConsumable(
  inventory: InventoryState,
  items: ItemDefinition[],
  backpackSlot: number,
):
  | { accepted: true; inventory: InventoryState; healing: number; actionPointCost: 1 }
  | { accepted: false; reason: "invalid-item" | "invalid-slot" } {
  const stack = inventory.backpack[backpackSlot];
  if (!Number.isSafeInteger(backpackSlot) || backpackSlot < 0 || !stack) {
    return { accepted: false, reason: "invalid-slot" };
  }
  const item = items.find((candidate) => candidate.id === stack.itemId);
  if (item?.kind !== "consumable" || !item.healing || item.healing <= 0) {
    return { accepted: false, reason: "invalid-item" };
  }
  const next = cloneInventory(inventory);
  consumeBackpackItem(next, backpackSlot);
  return { accepted: true, inventory: next, healing: item.healing, actionPointCost: 1 };
}

export function generateProgressionCharacter(seed: string, sequence: number): ProgressionCharacter {
  const classes: CharacterClass[] = ["vanguard", "ranger", "arcanist"];
  const characterClass = classes[
    seededIndex(seed, sequence, "class", classes.length)
  ] as CharacterClass;
  const positive = TRAIT_POOL.filter((trait) => trait.polarity === "positive");
  const negative = TRAIT_POOL.filter((trait) => trait.polarity === "negative");
  const traits = [
    positive[seededIndex(seed, sequence, "positive-trait", positive.length)] as Trait,
    negative[seededIndex(seed, sequence, "negative-trait", negative.length)] as Trait,
  ];
  const character: CharacterDefinition = {
    position: { x: 0, y: 0 },
    class: characterClass,
    health: 12,
    maxHealth: 12,
    defense: 1,
    movement: 1,
    accuracy: 1,
    power: 1,
    focus: 1,
  };
  for (const trait of traits) applyModifier(character, trait);
  return {
    character,
    inventory: {
      weapon: `${characterClass}-starter-weapon`,
      armor: `${characterClass}-starter-armor`,
      accessory: null,
      backpack: [
        { itemId: "healing-potion", quantity: 1 },
        ...Array<null>(BACKPACK_SLOT_COUNT - 1).fill(null),
      ],
    },
    level: 1,
    injuries: [],
    traits: traits.map(clone),
    pendingUpgrades: [],
  };
}

export function completeFloor(
  character: ProgressionCharacter,
  kind: "normal" | "boss",
  seed: string,
): ProgressionCharacter {
  const next = clone(character);
  if (kind === "boss") {
    next.character.health = next.character.maxHealth;
    return next;
  }
  next.character.health = Math.min(
    next.character.maxHealth,
    next.character.health + NORMAL_FLOOR_RECOVERY,
  );
  next.level += 1;
  next.pendingUpgrades = generateUpgradeOptions(
    next.character.class ?? "vanguard",
    next.level,
    seed,
  );
  return next;
}

export function generateUpgradeOptions(
  characterClass: CharacterClass,
  level: number,
  seed: string,
): Upgrade[] {
  const upgrades = CLASS_UPGRADES[characterClass];
  const offset = seededIndex(seed, level, `${characterClass}:upgrades`, upgrades.length);
  return upgrades.map((_, index) => clone(upgrades[(index + offset) % upgrades.length] as Upgrade));
}

export function chooseUpgrade(
  character: ProgressionCharacter,
  upgradeId: string,
): ProgressionCharacter | undefined {
  const upgrade = character.pendingUpgrades.find((candidate) => candidate.id === upgradeId);
  if (!upgrade) return undefined;
  const next = clone(character);
  applyModifier(next.character, upgrade);
  next.pendingUpgrades = [];
  return next;
}

function consumeBackpackItem(inventory: InventoryState, slot: number): void {
  const stack = inventory.backpack[slot];
  if (!stack) throw new Error("Cannot consume an empty backpack slot.");
  if (stack.quantity === 1) inventory.backpack[slot] = null;
  else stack.quantity -= 1;
}

function addToBackpack(inventory: InventoryState, itemId: string): boolean {
  const matching = inventory.backpack.find((stack) => stack?.itemId === itemId);
  if (matching) {
    matching.quantity += 1;
    return true;
  }
  const slot = inventory.backpack.indexOf(null);
  if (slot < 0) return false;
  inventory.backpack[slot] = { itemId, quantity: 1 };
  return true;
}

function applyModifier(
  character: CharacterDefinition,
  modifier: Pick<Trait | Upgrade, "stat" | "delta">,
): void {
  const stat = modifier.stat;
  character[stat] += modifier.delta;
  if (stat === "maxHealth") character.health = Math.min(character.health, character.maxHealth);
}

function seededIndex(seed: string, sequence: number, purpose: string, length: number): number {
  let hash = 2166136261;
  for (const character of `${seed}:${sequence}:${purpose}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % length;
}

function cloneInventory(inventory: InventoryState): InventoryState {
  return clone(inventory);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
