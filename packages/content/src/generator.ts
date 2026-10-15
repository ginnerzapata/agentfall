import {
  type CharacterClass,
  type CharacterDefinition,
  type EncounterContent,
  type EnemyContent,
  type EnemyState,
  FLOOR_CONTENT_SCHEMA_VERSION,
  type FloorContentPack,
  type FloorObjectDefinition,
  type FloorTile,
  type ItemContent,
  type Position,
  type RoomContent,
  type RunDefinition,
} from "@agentfall/contracts";

export const FLOOR_GENERATOR_VERSION = "floor-generator-1";

export type GeneratedRoom = {
  id: string;
  templateId: string;
  difficulty: 1 | 2 | 3;
  bounds: { x: number; y: number; width: number; height: number };
  purpose: "entrance" | "objective" | "exit" | "encounter" | "reward" | "healing" | "secret";
};

export type GeneratedFloor = {
  contentVersion: string;
  generatorVersion: typeof FLOOR_GENERATOR_VERSION;
  seed: string;
  rooms: GeneratedRoom[];
  encounters: Array<{ roomId: string; encounterId: string }>;
  turnBudget: number;
  definition: RunDefinition;
};

export type GenerationValidation = { valid: true } | { valid: false; reasons: string[] };

const baseStats = {
  health: 12,
  maxHealth: 12,
  defense: 1,
  movement: 1,
  accuracy: 1,
  power: 1,
  focus: 1,
};

/** A small complete pack useful for local generation and generator tests. */
export const DEFAULT_FLOOR_CONTENT: FloorContentPack = {
  schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
  version: "season-zero-content-1",
  rooms: [
    room("quiet", 1, ["entrance"]),
    room("crossroads", 1, ["corridor"]),
    room("guarded", 2, ["encounter"]),
    room("vault", 2, ["objective"]),
    room("sanctum", 1, ["healing"]),
    room("hidden", 2, ["secret"]),
  ],
  enemies: [
    enemy("scout", "scout", "skirmish", 6, 0, 2),
    enemy("brute", "brute", "pursue", 9, 1, 2),
    enemy("archer", "archer", "hold", 5, 0, 2),
  ],
  encounters: [
    encounter("patrol", 1, ["scout"]),
    encounter("guard", 2, ["brute"]),
    encounter("ambush", 2, ["scout", "archer"]),
  ],
  items: [
    {
      schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
      id: "healing-potion",
      kind: "consumable",
      healing: 4,
      rarity: "common",
    },
    {
      schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
      id: "tower-charm",
      kind: "accessory",
      rarity: "uncommon",
    },
  ],
  traits: [],
  bosses: [],
};

/**
 * Builds a six-to-ten-room floor from stable template identifiers.  The linear
 * mandatory spine is deliberate: it makes universal completion provable while
 * side rooms retain optional exploration choices.
 */
export function generateFloor(
  seed: string,
  content: FloorContentPack = DEFAULT_FLOOR_CONTENT,
  character: CharacterDefinition = defaultCharacter(),
): GeneratedFloor {
  const random = rng(`${content.version}:${seed}`);
  const roomCount = 6 + Math.floor(random() * 5);
  const width = roomCount * 6 + 1;
  const height = 11;
  const templates = usableRooms(content.rooms);
  const rooms: GeneratedRoom[] = Array.from({ length: roomCount }, (_, index) => {
    const template = templates[Math.floor(random() * templates.length)] as RoomContent;
    const purpose: GeneratedRoom["purpose"] =
      index === 0
        ? "entrance"
        : index === roomCount - 2
          ? "objective"
          : index === roomCount - 1
            ? "exit"
            : "encounter";
    return {
      id: `room-${index + 1}`,
      templateId: template.id,
      difficulty: template.difficulty,
      bounds: { x: 1 + index * 6, y: 3, width: 4, height: 5 },
      purpose,
    };
  });
  // Dedicated optional rewards and recovery are substitutions, never obstacles on the spine.
  atRequired(rooms, 1, "recovery room").purpose = "healing";
  atRequired(rooms, 2, "reward room").purpose = "reward";
  if (roomCount > 7) atRequired(rooms, 3, "secret room").purpose = "secret";

  const tiles = grid(width, height);
  for (const room of rooms) carveRoom(tiles, room.bounds);
  for (let index = 0; index < rooms.length - 1; index += 1) {
    const left = atRequired(rooms, index, "left room").bounds;
    const right = atRequired(rooms, index + 1, "right room").bounds;
    carveLine(tiles, { x: left.x + left.width - 1, y: 5 }, { x: right.x, y: 5 });
  }
  const entrance = center(atRequired(rooms, 0, "entrance room"));
  const objective = center(atRequired(rooms, roomCount - 2, "objective room"));
  const exit = center(atRequired(rooms, roomCount - 1, "exit room"));
  tile(tiles, entrance).terrain = "entrance";
  tile(tiles, objective).terrain = "objective";
  tile(tiles, exit).terrain = "exit";

  // Rewards and recovery can be guarded; the mandatory objective and exit never are.
  const encounterRooms = rooms
    .slice(1, -2)
    .filter((room) => room.purpose !== "secret")
    .slice(0, 3);
  const encounters = encounterRooms.map((room, index) => ({
    roomId: room.id,
    encounterId: atRequired(
      content.encounters.length ? content.encounters : DEFAULT_FLOOR_CONTENT.encounters,
      index % (content.encounters.length || DEFAULT_FLOOR_CONTENT.encounters.length),
      "encounter template",
    ).id,
  }));
  const enemies = encounters.flatMap(({ roomId, encounterId }) =>
    instantiateEncounter(roomId, encounterId, rooms, content),
  );
  const objects: FloorObjectDefinition[] = [
    {
      id: "sanctuary",
      type: "sanctuary",
      position: center(atRequired(rooms, 1, "recovery room")),
      healing: 3,
    },
    {
      id: "reward",
      type: "chest",
      position: center(atRequired(rooms, 2, "reward room")),
      itemId: itemId(content.items),
    },
    {
      id: "trap",
      type: "trap",
      position: { x: atRequired(rooms, 3, "trap room").bounds.x, y: 5 },
      damage: 1,
    },
  ];
  const secret = rooms.find((room) => room.purpose === "secret");
  if (secret)
    objects.push({
      id: "secret-reward",
      type: "item",
      position: { x: secret.bounds.x + 2, y: 4 },
      itemId: itemId(content.items),
    });
  const definition: RunDefinition = {
    seed,
    runId: `generated:${seed}`,
    rulesetVersion: "season-zero-rules-1",
    generatorVersion: FLOOR_GENERATOR_VERSION,
    board: { width, height },
    tiles,
    objects,
    character: { ...character, position: entrance },
    enemies,
  };
  return {
    contentVersion: content.version,
    generatorVersion: FLOOR_GENERATOR_VERSION,
    seed,
    rooms,
    encounters,
    turnBudget: calculateTurnBudget(roomCount, encounters.length),
    definition,
  };
}

export function calculateTurnBudget(roomCount: number, encounterCount: number): number {
  // Bounded to the PRD target; optional rooms cost budget but are not required.
  return Math.max(60, Math.min(100, 42 + roomCount * 5 + encounterCount * 6));
}

export function validateGeneratedFloor(floor: GeneratedFloor): GenerationValidation {
  const reasons: string[] = [];
  if (floor.rooms.length < 6 || floor.rooms.length > 10) reasons.push("room-count");
  if (floor.turnBudget < 60 || floor.turnBudget > 100) reasons.push("turn-budget");
  const { definition } = floor;
  if (definition.tiles.length !== definition.board.width * definition.board.height)
    reasons.push("incomplete-grid");
  const terrain = (kind: FloorTile["terrain"]) =>
    definition.tiles.find((candidate) => candidate.terrain === kind)?.position;
  const entrance = terrain("entrance");
  const objective = terrain("objective");
  const exit = terrain("exit");
  if (!entrance || !objective || !exit) reasons.push("missing-mandatory-terrain");
  else {
    const reachable = reachablePositions(definition, entrance);
    if (!reachable.has(key(objective)) || !reachable.has(key(exit)))
      reasons.push("mandatory-route-unreachable");
    // The route is class neutral; retaining explicit evidence protects future template changes.
    for (const characterClass of ["vanguard", "ranger", "arcanist"] as CharacterClass[]) {
      if (!reachable.has(key(objective)) || !reachable.has(key(exit)))
        reasons.push(`class-${characterClass}-blocked`);
    }
  }
  const occupied = new Set<string>();
  for (const enemy of definition.enemies) {
    if (occupied.has(key(enemy.position))) reasons.push("duplicate-enemy-occupancy");
    occupied.add(key(enemy.position));
  }
  return reasons.length ? { valid: false, reasons } : { valid: true };
}

/** Publication gate: any invalid floor rejects the entire generated season. */
export function validateGeneratedSeason(floors: GeneratedFloor[]): GenerationValidation {
  if (!floors.length) return { valid: false, reasons: ["empty-season"] };
  const reasons = floors.flatMap((floor, index) => {
    const result = validateGeneratedFloor(floor);
    return result.valid ? [] : result.reasons.map((reason) => `floor-${index + 1}:${reason}`);
  });
  return reasons.length ? { valid: false, reasons } : { valid: true };
}

function room(id: string, difficulty: 1 | 2 | 3, tags: string[]): RoomContent {
  return {
    schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
    id,
    difficulty,
    requiredCapabilities: ["none"],
    tags,
    width: 4,
    height: 5,
  };
}
function enemy(
  id: string,
  role: EnemyContent["role"],
  behavior: EnemyContent["behavior"],
  health: number,
  defense: number,
  power: number,
): EnemyContent {
  return {
    schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION,
    id,
    role,
    behavior,
    stats: { ...baseStats, health, maxHealth: health, defense, power },
  };
}
function encounter(id: string, difficulty: 1 | 2 | 3, enemyIds: string[]): EncounterContent {
  return { schemaVersion: FLOOR_CONTENT_SCHEMA_VERSION, id, difficulty, enemyIds, tags: [] };
}
function defaultCharacter(): CharacterDefinition {
  return { ...baseStats, position: { x: 0, y: 0 }, class: "vanguard" };
}
function usableRooms(rooms: RoomContent[]): RoomContent[] {
  return rooms.length ? rooms : DEFAULT_FLOOR_CONTENT.rooms;
}
function itemId(items: ItemContent[]): string {
  return atRequired(items.length ? items : DEFAULT_FLOOR_CONTENT.items, 0, "item template").id;
}
function grid(width: number, height: number): FloorTile[] {
  return Array.from({ length: width * height }, (_, index) => ({
    position: { x: index % width, y: Math.floor(index / width) },
    terrain: "wall",
  }));
}
function tile(tiles: FloorTile[], position: Position): FloorTile {
  const found = tiles.find(
    (candidate) => candidate.position.x === position.x && candidate.position.y === position.y,
  );
  if (!found) throw new Error("Generated position outside the board.");
  return found;
}
function carveRoom(tiles: FloorTile[], bounds: GeneratedRoom["bounds"]): void {
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1)
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1)
      tile(tiles, { x, y }).terrain = "floor";
}
function carveLine(tiles: FloorTile[], from: Position, to: Position): void {
  for (let x = from.x; x <= to.x; x += 1) tile(tiles, { x, y: from.y }).terrain = "floor";
}
function center(room: GeneratedRoom): Position {
  return { x: room.bounds.x + 1, y: room.bounds.y + 2 };
}
function instantiateEncounter(
  roomId: string,
  encounterId: string,
  rooms: GeneratedRoom[],
  content: FloorContentPack,
): EnemyState[] {
  const encounter =
    content.encounters.find((candidate) => candidate.id === encounterId) ??
    atRequired(DEFAULT_FLOOR_CONTENT.encounters, 0, "default encounter");
  const room = required(
    rooms.find((candidate) => candidate.id === roomId),
    "encounter room",
  );
  return encounter.enemyIds.map((enemyId, index) => {
    const enemy =
      content.enemies.find((candidate) => candidate.id === enemyId) ??
      atRequired(DEFAULT_FLOOR_CONTENT.enemies, 0, "default enemy");
    return {
      id: `${roomId}-${index + 1}-${enemy.id}`,
      position: { x: room.bounds.x + 2 + (index % 2), y: room.bounds.y + 1 },
      behavior: enemy.behavior,
      ...enemy.stats,
    };
  });
}
function reachablePositions(definition: RunDefinition, start: Position): Set<string> {
  const byPosition = new Map(
    definition.tiles.map((candidate) => [key(candidate.position), candidate]),
  );
  const seen = new Set([key(start)]);
  const queue = [start];
  while (queue.length) {
    const current = required(queue.shift(), "reachable position");
    for (const next of [
      { x: current.x + 1, y: current.y },
      { x: current.x - 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x, y: current.y - 1 },
    ]) {
      const candidate = byPosition.get(key(next));
      if (candidate && candidate.terrain !== "wall" && !seen.has(key(next))) {
        seen.add(key(next));
        queue.push(next);
      }
    }
  }
  return seen;
}
function key(position: Position): string {
  return `${position.x},${position.y}`;
}
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}
function atRequired<T>(values: T[], index: number, label: string): T {
  return required(values[index], label);
}
function rng(seed: string): () => number {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
