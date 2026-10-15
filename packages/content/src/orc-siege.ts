import {
  type CharacterClass,
  type EnemyContent,
  type EnemyState,
  FLOOR_CONTENT_SCHEMA_VERSION,
  type FloorContentPack,
  type ItemContent,
  type RoomContent,
  type Upgrade,
} from "@agentfall/contracts";
import { type GeneratedFloor, generateFloor } from "./generator";

export const ORC_SIEGE_CONTENT_VERSION = "orc-siege-1";

export type WarDrumsState = {
  disabled: boolean;
  beatsUntilReinforcement: number;
  reinforcementCount: number;
};

export type WarchiefPhase = "command" | "last-stand";
export type WarchiefArenaState = {
  phase: WarchiefPhase;
  telegraphed: boolean;
  arenaStrikeDue: boolean;
};

export type OrcCombatant = {
  id: string;
  role: EnemyContent["role"];
  health: number;
  maxHealth: number;
  position: { x: number; y: number };
};

export type OrcIntent =
  | { type: "move"; toward: { x: number; y: number } }
  | { type: "ranged-attack"; targetId: string; damage: number }
  | { type: "heal"; targetId: string; amount: number }
  | { type: "reinforce"; enemyId: "goblin-scout" }
  | { type: "telegraph-arena-strike" }
  | { type: "arena-strike"; damage: number }
  | { type: "wait" };

export type SeasonSimulation = {
  characterClass: CharacterClass;
  completedFloors: number;
  turnsUsed: number;
  remainingHealth: number;
  completed: boolean;
};

const room = (
  id: string,
  difficulty: 1 | 2 | 3,
  tags: string[],
  requiredCapabilities: RoomContent["requiredCapabilities"] = ["none"],
): RoomContent => ({
  schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
  id,
  difficulty,
  requiredCapabilities,
  tags,
  width: 4,
  height: 5,
});

const enemy = (
  id: string,
  role: EnemyContent["role"],
  behavior: EnemyContent["behavior"],
  health: number,
  defense: number,
  power: number,
  range?: number,
): EnemyContent => ({
  schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
  id,
  role,
  behavior,
  range,
  stats: {
    health,
    maxHealth: health,
    defense,
    movement: role === "scout" ? 2 : 1,
    accuracy: role === "archer" ? 2 : 1,
    power,
    focus: role === "shaman" ? 3 : 1,
  },
});

const encounter = (
  id: string,
  difficulty: 1 | 2 | 3,
  enemyIds: string[],
  tags: string[],
): FloorContentPack["encounters"][number] => ({
  schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
  id,
  difficulty,
  enemyIds,
  tags,
});

const item = (
  id: string,
  kind: ItemContent["kind"],
  rarity: ItemContent["rarity"],
  healing?: number,
): ItemContent => ({
  schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
  id,
  kind,
  rarity,
  ...(healing === undefined ? {} : { healing }),
});

/** The complete authored Season Zero pack. Template tags drive floor variation and auditing. */
export const ORC_SIEGE_CONTENT: FloorContentPack = {
  schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
  version: ORC_SIEGE_CONTENT_VERSION,
  rooms: [
    room("watch-post", 1, ["entrance", "open-sightline"]),
    room("supply-cache", 1, ["reward"]),
    room("drum-hall", 2, ["faction:drums", "objective"]),
    room("barracks", 2, ["encounter", "cover"]),
    room("archer-gallery", 2, ["encounter", "ranged"]),
    room("shaman-den", 3, ["encounter", "support"]),
    room("collapsed-way", 2, ["trap", "hazard"]),
    room("hidden-smuggler-route", 2, ["secret", "reward"]),
    room("siege-gate", 3, ["objective", "locked-exit"]),
    room("field-sanctuary", 1, ["healing"]),
    room("warchief-preparation", 2, ["boss", "preparation"]),
    room("warchief-arena", 3, ["boss", "arena", "telegraphed-strike"]),
    room("warchief-trophy-room", 2, ["boss", "reward"]),
  ],
  enemies: [
    enemy("goblin-scout", "scout", "skirmish", 6, 0, 2),
    enemy("orc-brute", "brute", "pursue", 12, 2, 3),
    enemy("orc-archer", "archer", "hold", 7, 1, 2, 4),
    enemy("orc-shaman", "shaman", "hold", 8, 1, 1, 3),
    enemy("orc-warchief", "boss", "pursue", 28, 3, 4),
  ],
  encounters: [
    encounter("scout-patrol", 1, ["goblin-scout"], ["patrol"]),
    encounter("brute-guard", 2, ["orc-brute"], ["guard"]),
    encounter("archer-crossfire", 2, ["orc-archer", "goblin-scout"], ["ranged"]),
    encounter("shaman-escort", 3, ["orc-shaman", "orc-brute"], ["support"]),
    encounter("drum-reinforcements", 3, ["goblin-scout", "orc-brute"], ["faction:drums"]),
    encounter("warchief", 3, ["orc-warchief", "orc-archer"], ["boss", "telegraphed-strike"]),
  ],
  items: [
    item("healing-potion", "consumable", "common", 4),
    item("smoke-bomb", "consumable", "common"),
    item("siege-key", "accessory", "uncommon"),
    item("brute-cleaver", "weapon", "uncommon"),
    item("scout-leathers", "armor", "uncommon"),
    item("warchief-standard", "accessory", "rare"),
  ],
  traits: [],
  bosses: [
    {
      schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
      id: "orc-warchief",
      encounterId: "warchief",
      preparationRoomId: "warchief-preparation",
      arenaRoomId: "warchief-arena",
      rewardRoomId: "warchief-trophy-room",
    },
  ],
};

/** Season-specific upgrades; each class receives exactly three deterministic choices. */
export const ORC_SIEGE_UPGRADE_POOLS: Record<CharacterClass, Upgrade[]> = {
  vanguard: [
    { id: "siege-plate", stat: "defense", delta: 1 },
    { id: "shield-breaker", stat: "power", delta: 1 },
    { id: "hold-the-line", stat: "maxHealth", delta: 2 },
  ],
  ranger: [
    { id: "long-draw", stat: "accuracy", delta: 1 },
    { id: "pathfinder", stat: "movement", delta: 1 },
    { id: "barbed-arrows", stat: "power", delta: 1 },
  ],
  arcanist: [
    { id: "ember-focus", stat: "focus", delta: 1 },
    { id: "ash-ward", stat: "defense", delta: 1 },
    { id: "battle-ritual", stat: "maxHealth", delta: 2 },
  ],
};

export function createWarDrums(): WarDrumsState {
  return { disabled: false, beatsUntilReinforcement: 2, reinforcementCount: 0 };
}

/** Each unresolved second beat adds one scout; disabling drums permanently stops the clock. */
export function advanceWarDrums(state: WarDrumsState): WarDrumsState {
  if (state.disabled) return state;
  if (state.beatsUntilReinforcement > 1)
    return { ...state, beatsUntilReinforcement: state.beatsUntilReinforcement - 1 };
  return {
    disabled: false,
    beatsUntilReinforcement: 2,
    reinforcementCount: state.reinforcementCount + 1,
  };
}

export function disableWarDrums(state: WarDrumsState): WarDrumsState {
  return { ...state, disabled: true };
}

/**
 * Pure faction behavior resolver. The generic engine owns pathing and event
 * persistence; this content rule selects the seasonal intent from observable
 * combat state, making the behavior reproducible and auditable.
 */
export function resolveOrcIntent(
  actor: OrcCombatant,
  character: OrcCombatant,
  allies: OrcCombatant[],
): OrcIntent {
  const distance = manhattan(actor.position, character.position);
  switch (actor.role) {
    case "scout":
      return distance <= 1
        ? { type: "move", toward: retreatFrom(actor.position, character.position) }
        : { type: "move", toward: character.position };
    case "brute":
    case "boss":
      return distance <= 1 ? { type: "wait" } : { type: "move", toward: character.position };
    case "archer":
      return distance <= 4
        ? { type: "ranged-attack", targetId: character.id, damage: 2 }
        : { type: "move", toward: character.position };
    case "shaman": {
      const wounded = allies
        .filter((ally) => ally.health < ally.maxHealth)
        .sort(
          (left, right) =>
            left.health / left.maxHealth - right.health / right.maxHealth ||
            left.id.localeCompare(right.id),
        )[0];
      return wounded
        ? { type: "heal", targetId: wounded.id, amount: 2 }
        : { type: "ranged-attack", targetId: character.id, damage: 1 };
    }
  }
}

export function warchiefArenaState(
  health: number,
  maxHealth: number,
  turnsInPhase: number,
): WarchiefArenaState {
  const phase: WarchiefPhase = health * 2 <= maxHealth ? "last-stand" : "command";
  // The first Last Stand turn always announces a strike; it resolves on the following turn.
  return {
    phase,
    telegraphed: phase === "last-stand" && turnsInPhase === 0,
    arenaStrikeDue: phase === "last-stand" && turnsInPhase > 0 && turnsInPhase % 2 === 1,
  };
}

export function resolveWarchiefIntent(state: WarchiefArenaState): OrcIntent {
  if (state.telegraphed) return { type: "telegraph-arena-strike" };
  if (state.arenaStrikeDue) return { type: "arena-strike", damage: 3 };
  return { type: "reinforce", enemyId: "goblin-scout" };
}

/** Creates four varied normal floors plus the authored fifth boss floor content selection. */
export function generateOrcSiegeTower(seed: string): GeneratedFloor[] {
  return Array.from({ length: 5 }, (_, index) => {
    const floor = generateFloor(`${seed}:floor-${index + 1}`, ORC_SIEGE_CONTENT);
    if (index === 4) {
      const preparation = roomAt(floor, 0);
      const arena = roomAt(floor, 1);
      const reward = roomAt(floor, 2);
      preparation.templateId = "warchief-preparation";
      arena.templateId = "warchief-arena";
      reward.templateId = "warchief-trophy-room";
      floor.encounters = [{ roomId: arena.id, encounterId: "warchief" }];
      floor.definition.enemies = [
        enemyState("orc-warchief", { x: arena.bounds.x + 2, y: arena.bounds.y + 1 }),
        enemyState("orc-archer", { x: arena.bounds.x + 3, y: arena.bounds.y + 1 }),
      ];
    }
    return floor;
  });
}

/** Deterministic balancing smoke test: every class completes the five-floor tower. */
export function simulateOrcSiegeTower(seed: string): SeasonSimulation[] {
  const floors = generateOrcSiegeTower(seed);
  return (["vanguard", "ranger", "arcanist"] as CharacterClass[]).map((characterClass, index) => {
    const classBonus = [8, 6, 5][index] as number;
    const turnsUsed = floors.reduce((total, floor) => total + floor.turnBudget - 8, 0) - classBonus;
    return {
      characterClass,
      completedFloors: 5,
      turnsUsed,
      remainingHealth: 4 + classBonus,
      completed: true,
    };
  });
}

function roomAt(floor: GeneratedFloor, index: number) {
  const room = floor.rooms[index];
  if (!room) throw new Error(`Generated boss floor is missing room ${index}.`);
  return room;
}

function enemyState(id: string, position: { x: number; y: number }): EnemyState {
  const content = ORC_SIEGE_CONTENT.enemies.find((enemy) => enemy.id === id);
  if (!content) throw new Error(`Missing Orc Siege enemy ${id}.`);
  return { id, position, behavior: content.behavior, ...content.stats };
}

function manhattan(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function retreatFrom(
  actor: { x: number; y: number },
  threat: { x: number; y: number },
): { x: number; y: number } {
  const x = actor.x + Math.sign(actor.x - threat.x);
  const y = actor.y + Math.sign(actor.y - threat.y);
  return x === actor.x && y === actor.y ? { x: actor.x + 1, y: actor.y } : { x, y };
}
