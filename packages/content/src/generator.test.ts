import { describe, expect, test } from "bun:test";
import { canonicalStringify } from "@agentfall/contracts";
import {
  DEFAULT_FLOOR_CONTENT,
  generateFloor,
  validateGeneratedFloor,
  validateGeneratedSeason,
} from "./index";

describe("floor generation", () => {
  test("is byte-identical for the same seed and content version", () => {
    expect(canonicalStringify(generateFloor("same-seed"))).toBe(
      canonicalStringify(generateFloor("same-seed")),
    );
  });

  test("generates four to six connected, branching valid floors across many seeds", () => {
    const floors = Array.from({ length: 100 }, (_, index) => generateFloor(`property-${index}`));
    for (const floor of floors) {
      expect(floor.rooms.length).toBeGreaterThanOrEqual(4);
      expect(floor.rooms.length).toBeLessThanOrEqual(6);
      expect(floor.encounters.length).toBeGreaterThanOrEqual(2);
      expect(floor.encounters.length).toBeLessThanOrEqual(3);
      expect(floor.turnBudget).toBeGreaterThanOrEqual(25);
      expect(floor.turnBudget).toBeLessThanOrEqual(45);
      expect(floor.definition.tiles.some((tile) => tile.door === "closed")).toBe(true);
      expect(floor.definition.enemies.every((enemy) => enemy.role !== undefined)).toBe(true);
      expect(validateGeneratedFloor(floor)).toEqual({ valid: true });
    }
    expect(validateGeneratedSeason(floors)).toEqual({ valid: true });
  });

  test("rejects invalid generated seasons before publication", () => {
    const invalid = generateFloor("invalid");
    invalid.rooms = invalid.rooms.slice(0, 3);
    expect(validateGeneratedSeason([invalid])).toEqual({
      valid: false,
      reasons: ["floor-1:room-count"],
    });
  });

  test("exports versioned authored content", () => {
    expect(DEFAULT_FLOOR_CONTENT.rooms.every((room) => room.schemaVersion === 1)).toBe(true);
  });
});
