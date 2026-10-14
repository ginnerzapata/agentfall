import type { Action, RunDefinition } from "@agentfall/contracts";

export type CombatGoldenFixture = {
  name: string;
  definition: RunDefinition;
  actions: Action[];
  canonicalEvents: string;
};

export type ClassActionChoiceSimulation = {
  characterClass: "vanguard" | "ranger" | "arcanist";
  fixture: CombatGoldenFixture;
  expectedSignatureActions: Action["type"][];
};

const baseCharacter: RunDefinition["character"] = {
  position: { x: 0, y: 0 },
  health: 12,
  maxHealth: 12,
  defense: 1,
  movement: 1,
  accuracy: 0,
  power: 0,
  focus: 0,
};

const baseEnemy: RunDefinition["enemies"][number] = {
  id: "goblin",
  position: { x: 1, y: 0 },
  health: 20,
  maxHealth: 20,
  defense: 0,
  movement: 1,
  accuracy: 0,
  power: 0,
  focus: 0,
};

function fixture(
  name: string,
  overrides: Partial<RunDefinition>,
  actions: Action[],
  canonicalEvents: string,
): CombatGoldenFixture {
  return {
    name,
    definition: {
      seed: `golden-combat-${name}`,
      runId: `golden-${name}`,
      rulesetVersion: "season-zero-rules-1",
      generatorVersion: "season-zero-generator-1",
      board: { width: 5, height: 2 },
      tiles: [
        { position: { x: 0, y: 0 }, terrain: "entrance" },
        { position: { x: 1, y: 0 }, terrain: "floor" },
        { position: { x: 2, y: 0 }, terrain: "floor" },
        { position: { x: 3, y: 0 }, terrain: "floor" },
        { position: { x: 4, y: 0 }, terrain: "exit" },
        { position: { x: 0, y: 1 }, terrain: "objective" },
        { position: { x: 1, y: 1 }, terrain: "floor" },
        { position: { x: 2, y: 1 }, terrain: "floor" },
        { position: { x: 3, y: 1 }, terrain: "floor" },
        { position: { x: 4, y: 1 }, terrain: "floor" },
      ],
      objects: [],
      character: baseCharacter,
      enemies: [baseEnemy],
      ...overrides,
    },
    actions,
    canonicalEvents,
  };
}

export const combatGoldenFixtures: CombatGoldenFixture[] = [
  fixture(
    "basic-hit",
    { character: { ...baseCharacter, accuracy: 20 } },
    [{ type: "attack", targetId: "goblin" }],
    '[{"cost":2,"damage":1,"roll":7,"schemaVersion":10,"targetId":"goblin","type":"attack"}]',
  ),
  fixture(
    "basic-miss",
    { enemies: [{ ...baseEnemy, defense: 30 }] },
    [{ type: "attack", targetId: "goblin" }],
    '[{"cost":2,"damage":0,"roll":19,"schemaVersion":10,"targetId":"goblin","type":"attack"}]',
  ),
  fixture(
    "death",
    {
      character: { ...baseCharacter, health: 2, maxHealth: 2 },
      enemies: [],
      objects: [{ id: "spikes", type: "trap", position: { x: 1, y: 0 }, damage: 2 }],
    },
    [{ type: "move", direction: "east" }],
    '[{"cost":1,"direction":"east","from":{"x":0,"y":0},"schemaVersion":10,"to":{"x":1,"y":0},"triggeredTrap":{"damage":2,"id":"spikes","outcome":{"died":true,"health":0,"resurrected":false}},"type":"move"}]',
  ),
  fixture(
    "resurrection",
    {
      character: { ...baseCharacter, health: 2, maxHealth: 2, resurrectionCharges: 1 },
      enemies: [],
      objects: [{ id: "spikes", type: "trap", position: { x: 1, y: 0 }, damage: 2 }],
    },
    [{ type: "move", direction: "east" }],
    '[{"cost":1,"direction":"east","from":{"x":0,"y":0},"schemaVersion":10,"to":{"x":1,"y":0},"triggeredTrap":{"damage":2,"id":"spikes","outcome":{"died":false,"health":1,"resurrected":true}},"type":"move"}]',
  ),
  fixture(
    "enemy-retreat",
    { enemies: [{ ...baseEnemy, behavior: "skirmish" }] },
    [{ type: "end-turn" }],
    '[{"enemyMoves":[{"enemyId":"goblin","from":{"x":1,"y":0},"to":{"x":2,"y":0}}],"schemaVersion":10,"temporaryDefense":2,"type":"end-turn"}]',
  ),
  fixture(
    "vanguard-guard",
    { character: { ...baseCharacter, class: "vanguard" }, enemies: [] },
    [{ type: "guard" }],
    '[{"cost":2,"expiresTurn":2,"protectedTiles":[{"x":1,"y":0},{"x":0,"y":1}],"schemaVersion":10,"type":"guard"}]',
  ),
  fixture(
    "vanguard-shove",
    {
      character: { ...baseCharacter, position: { x: 1, y: 0 }, class: "vanguard", power: 2 },
      enemies: [{ ...baseEnemy, position: { x: 2, y: 0 } }],
      tiles: (
        [
          { position: { x: 0, y: 0 }, terrain: "floor" },
          { position: { x: 1, y: 0 }, terrain: "floor" },
          { position: { x: 2, y: 0 }, terrain: "floor" },
          { position: { x: 3, y: 0 }, terrain: "wall" },
          { position: { x: 4, y: 0 }, terrain: "exit" },
          { position: { x: 0, y: 1 }, terrain: "objective" },
          { position: { x: 1, y: 1 }, terrain: "floor" },
          { position: { x: 2, y: 1 }, terrain: "floor" },
          { position: { x: 3, y: 1 }, terrain: "floor" },
          { position: { x: 4, y: 1 }, terrain: "floor" },
        ] satisfies RunDefinition["tiles"]
      ).map((tile) =>
        tile.position.x === 1 && tile.position.y === 0
          ? { ...tile, terrain: "entrance" as const }
          : tile,
      ),
    },
    [{ type: "shove", targetId: "goblin" }],
    '[{"cost":2,"damage":3,"schemaVersion":10,"targetId":"goblin","type":"shove"}]',
  ),
  fixture(
    "ranger-scout",
    { character: { ...baseCharacter, class: "ranger" }, enemies: [] },
    [{ type: "scout", direction: "east" }],
    '[{"cost":2,"direction":"east","revealed":[{"x":1,"y":0},{"x":2,"y":0},{"x":3,"y":0},{"x":4,"y":0},{"x":1,"y":1},{"x":2,"y":1},{"x":3,"y":1},{"x":4,"y":1}],"schemaVersion":10,"type":"scout"}]',
  ),
  fixture(
    "ranger-disengaging-shot",
    {
      character: { ...baseCharacter, position: { x: 1, y: 0 }, class: "ranger", accuracy: 20 },
      enemies: [{ ...baseEnemy, position: { x: 2, y: 0 } }],
      tiles: [
        { position: { x: 0, y: 0 }, terrain: "floor" },
        { position: { x: 1, y: 0 }, terrain: "entrance" },
        { position: { x: 2, y: 0 }, terrain: "floor" },
        { position: { x: 3, y: 0 }, terrain: "floor" },
        { position: { x: 4, y: 0 }, terrain: "exit" },
        { position: { x: 0, y: 1 }, terrain: "objective" },
        { position: { x: 1, y: 1 }, terrain: "floor" },
        { position: { x: 2, y: 1 }, terrain: "floor" },
        { position: { x: 3, y: 1 }, terrain: "floor" },
        { position: { x: 4, y: 1 }, terrain: "floor" },
      ],
    },
    [{ type: "disengaging-shot", targetId: "goblin" }],
    '[{"cost":3,"damage":2,"roll":6,"schemaVersion":10,"targetId":"goblin","to":{"x":0,"y":0},"type":"disengaging-shot"}]',
  ),
  fixture(
    "arcanist-arc-bolt",
    {
      character: { ...baseCharacter, class: "arcanist", focus: 4 },
      enemies: [{ ...baseEnemy, position: { x: 3, y: 0 }, focus: 1 }],
    },
    [{ type: "arc-bolt", targetId: "goblin" }],
    '[{"cost":2,"damage":5,"schemaVersion":10,"targetId":"goblin","type":"arc-bolt"}]',
  ),
  fixture(
    "arcanist-ward",
    { character: { ...baseCharacter, class: "arcanist", focus: 4 }, enemies: [] },
    [{ type: "ward" }],
    '[{"cost":2,"expiresTurn":2,"protection":6,"schemaVersion":10,"type":"ward"}]',
  ),
];

function fixtureByName(name: string): CombatGoldenFixture {
  const found = combatGoldenFixtures.find((fixture) => fixture.name === name);
  if (!found) throw new Error(`Missing combat fixture: ${name}`);
  return found;
}

/** Deterministic observations used to ensure class choices are tactically distinct. */
export const classActionChoiceSimulations: ClassActionChoiceSimulation[] = [
  {
    characterClass: "vanguard",
    fixture: fixtureByName("vanguard-shove"),
    expectedSignatureActions: ["guard", "shove"],
  },
  {
    characterClass: "ranger",
    fixture: fixtureByName("ranger-disengaging-shot"),
    expectedSignatureActions: ["scout", "disengaging-shot"],
  },
  {
    characterClass: "arcanist",
    fixture: fixtureByName("arcanist-arc-bolt"),
    expectedSignatureActions: ["arc-bolt", "ward"],
  },
];
