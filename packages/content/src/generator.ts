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

export const FLOOR_GENERATOR_VERSION = "floor-generator-2";

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
      focusBonus: 1,
      rarity: "uncommon",
    },
  ],
  traits: [],
  bosses: [],
};

/**
 * Builds a compact four-to-six-room branching floor from stable template identifiers.
 * A short 3-4 room main spine guarantees fast traversal and provable completion while
 * 1-2 door-gated side branches create optional risk/reward exploration choices.
 */
export function generateFloor(
  seed: string,
  content: FloorContentPack = DEFAULT_FLOOR_CONTENT,
  character: CharacterDefinition = defaultCharacter(),
): GeneratedFloor {
  const random = rng(`${content.version}:${seed}`);
  const roomCount = 4 + Math.floor(random() * 3); // 4..6 rooms
  const spineCount = roomCount >= 5 ? 4 : 3;
  const branchCount = roomCount - spineCount; // 1..2 side rooms
  const width = spineCount * 5 + 1;
  const height = branchCount >= 2 ? 16 : 11;
  const spineY = 6;
  const templates = usableRooms(content.rooms);

  const spineRooms: GeneratedRoom[] = Array.from({ length: spineCount }, (_, index) => {
    const template = templates[Math.floor(random() * templates.length)] as RoomContent;
    const purpose: GeneratedRoom["purpose"] =
      index === 0
        ? "entrance"
        : index === spineCount - 2
          ? "objective"
          : index === spineCount - 1
            ? "exit"
            : "encounter";
    return {
      id: `room-${index + 1}`,
      templateId: template.id,
      difficulty: template.difficulty,
      bounds: { x: 1 + index * 5, y: spineY, width: 4, height: 4 },
      purpose,
    };
  });

  const branchRooms: GeneratedRoom[] = [];
  const northAnchor = atRequired(spineRooms, 1, "north branch anchor");
  branchRooms.push({
    id: `room-${spineCount + 1}`,
    templateId: (templates[Math.floor(random() * templates.length)] as RoomContent).id,
    difficulty: 2,
    bounds: { x: northAnchor.bounds.x, y: 1, width: 4, height: 4 },
    purpose: "reward",
  });
  if (branchCount >= 2) {
    const southAnchor = atRequired(spineRooms, Math.min(2, spineCount - 2), "south branch anchor");
    branchRooms.push({
      id: `room-${spineCount + 2}`,
      templateId: (templates[Math.floor(random() * templates.length)] as RoomContent).id,
      difficulty: 2,
      bounds: { x: southAnchor.bounds.x, y: 11, width: 4, height: 4 },
      purpose: roomCount === 6 ? "secret" : "healing",
    });
  }

  const rooms = [...spineRooms, ...branchRooms];
  const tiles = grid(width, height);
  for (const room of rooms) carveRoom(tiles, room.bounds);

  // Connect spine rooms horizontally at y = spineY + 1 (1-tile doorway).
  for (let index = 0; index < spineRooms.length - 1; index += 1) {
    const left = atRequired(spineRooms, index, "left room").bounds;
    const right = atRequired(spineRooms, index + 1, "right room").bounds;
    carveLine(tiles, { x: left.x + left.width - 1, y: spineY + 1 }, { x: right.x, y: spineY + 1 });
    if (index === spineRooms.length - 2) {
      // Closed tactical door before the exit room.
      tile(tiles, { x: left.x + left.width, y: spineY + 1 }).door = "closed";
    }
  }

  // Connect north branch room with a closed door at y = spineY - 1.
  const northDoorPos = { x: northAnchor.bounds.x + 1, y: spineY - 1 };
  tile(tiles, northDoorPos).terrain = "floor";
  tile(tiles, northDoorPos).door = "closed";

  // Connect south branch room (if present) with a closed door at y = spineY + 4.
  if (branchCount >= 2) {
    const southAnchor = atRequired(spineRooms, Math.min(2, spineCount - 2), "south branch anchor");
    const southDoorPos = { x: southAnchor.bounds.x + 1, y: spineY + 4 };
    tile(tiles, southDoorPos).terrain = "floor";
    tile(tiles, southDoorPos).door = "closed";
  }

  const entrance = center(atRequired(spineRooms, 0, "entrance room"));
  const objective = center(atRequired(spineRooms, spineCount - 2, "objective room"));
  const exit = center(atRequired(spineRooms, spineCount - 1, "exit room"));
  tile(tiles, entrance).terrain = "entrance";
  tile(tiles, objective).terrain = "objective";
  tile(tiles, exit).terrain = "exit";

  // Place 2-3 tactical encounters across the spine and reward branch.
  const encounterCandidates = [
    ...(spineCount >= 4 ? [atRequired(spineRooms, 1, "spine encounter")] : []),
    atRequired(spineRooms, spineCount - 2, "objective room"),
    atRequired(branchRooms, 0, "reward branch"),
  ].slice(0, 3);

  const encounterTemplates = content.encounters.length
    ? content.encounters
    : DEFAULT_FLOOR_CONTENT.encounters;
  const encounters = encounterCandidates.map((room, index) => ({
    roomId: room.id,
    encounterId: atRequired(
      encounterTemplates,
      (index + Math.floor(random() * encounterTemplates.length)) % encounterTemplates.length,
      "encounter template",
    ).id,
  }));
  const enemies = encounters.flatMap(({ roomId, encounterId }) =>
    instantiateEncounter(roomId, encounterId, rooms, content),
  );

  const rewardRoom = atRequired(branchRooms, 0, "reward room");
  const sanctuaryRoom = branchRooms[1] ?? atRequired(spineRooms, 0, "entrance sanctuary");
  const trapRoom = atRequired(spineRooms, 1, "trap room");
  const objects: FloorObjectDefinition[] = [
    {
      id: "sanctuary",
      type: "sanctuary",
      position: { x: sanctuaryRoom.bounds.x + 3, y: sanctuaryRoom.bounds.y + 3 },
      healing: 4,
    },
    {
      id: "reward",
      type: "chest",
      position: { x: rewardRoom.bounds.x + 1, y: rewardRoom.bounds.y + 1 },
      itemId: itemId(content.items, Math.floor(random() * Math.max(1, content.items.length))),
    },
    {
      id: "trap",
      type: "trap",
      position: { x: trapRoom.bounds.x, y: spineY + 2 },
      damage: 2,
    },
  ];
  const secret = rooms.find((room) => room.purpose === "secret");
  if (secret)
    objects.push({
      id: "secret-reward",
      type: "item",
      position: { x: secret.bounds.x + 1, y: secret.bounds.y + 1 },
      itemId: itemId(content.items, 1),
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
  // Compact, urgent floor budget (25-45 turns) matching 4-6 branching rooms.
  return Math.max(25, Math.min(45, 16 + roomCount * 3 + encounterCount * 4));
}

export function validateGeneratedFloor(floor: GeneratedFloor): GenerationValidation {
  const reasons: string[] = [];
  if (floor.rooms.length < 4 || floor.rooms.length > 6) reasons.push("room-count");
  if (floor.turnBudget < 25 || floor.turnBudget > 45) reasons.push("turn-budget");
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
function itemId(items: ItemContent[], index = 0): string {
  const pool = items.length ? items : DEFAULT_FLOOR_CONTENT.items;
  return atRequired(pool, index % pool.length, "item template").id;
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
  return { x: room.bounds.x + 1, y: room.bounds.y + 1 };
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
      position: {
        x: room.bounds.x + 2 + (index % 2),
        y: room.bounds.y + 2 + Math.floor(index / 2),
      },
      behavior: enemy.behavior,
      role: enemy.role,
      ...(enemy.range !== undefined ? { range: enemy.range } : {}),
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
