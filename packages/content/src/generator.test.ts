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

  test("generates six to ten connected, valid floors across many seeds", () => {
    const floors = Array.from({ length: 100 }, (_, index) => generateFloor(`property-${index}`));
    for (const floor of floors) {
      expect(floor.rooms.length).toBeGreaterThanOrEqual(6);
      expect(floor.rooms.length).toBeLessThanOrEqual(10);
      expect(floor.encounters.length).toBeGreaterThanOrEqual(2);
      expect(floor.encounters.length).toBeLessThanOrEqual(3);
      expect(floor.turnBudget).toBeGreaterThanOrEqual(60);
      expect(floor.turnBudget).toBeLessThanOrEqual(100);
      expect(validateGeneratedFloor(floor)).toEqual({ valid: true });
    }
    expect(validateGeneratedSeason(floors)).toEqual({ valid: true });
  });

  test("rejects invalid generated seasons before publication", () => {
    const invalid = generateFloor("invalid");
    invalid.rooms = invalid.rooms.slice(0, 5);
    expect(validateGeneratedSeason([invalid])).toEqual({
      valid: false,
      reasons: ["floor-1:room-count"],
    });
  });

  test("exports versioned authored content", () => {
    expect(DEFAULT_FLOOR_CONTENT.rooms.every((room) => room.schemaVersion === 1)).toBe(true);
  });
});
