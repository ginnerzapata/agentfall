import { describe, expect, test } from "bun:test";
import { parseCommand } from "../scripts/admin";
import { adminAuthorized } from "./admin";

describe("administrative access", () => {
  test("fails closed and accepts only the configured bearer token", async () => {
    await expect(adminAuthorized(undefined, "admin-secret")).resolves.toBe(false);
    await expect(adminAuthorized("Bearer wrong-secret", "admin-secret")).resolves.toBe(false);
    await expect(adminAuthorized("Basic admin-secret", "admin-secret")).resolves.toBe(false);
    await expect(adminAuthorized("Bearer admin-secret", "admin-secret")).resolves.toBe(true);
    await expect(adminAuthorized("Bearer admin-secret", undefined)).resolves.toBe(false);
  });

  test("requires explicit publication confirmation and all generation versions", () => {
    expect(parseCommand(["publish", "--id", "season-zero", "--seed", "secret"])).toBeNull();
    expect(
      parseCommand(["publish", "--id", "season-zero", "--seed", "secret", "--confirm"]),
    ).toEqual({ operation: "publish", id: "season-zero", seed: "secret", confirm: true });
    expect(
      parseCommand([
        "generate",
        "--id",
        "season-zero",
        "--seed",
        "secret",
        "--ruleset-version",
        "rules-1",
        "--generator-version",
        "generator-1",
        "--content-version",
        "orc-siege-1",
      ]),
    ).toEqual({
      operation: "generate",
      id: "season-zero",
      seed: "secret",
      rulesetVersion: "rules-1",
      generatorVersion: "generator-1",
      contentVersion: "orc-siege-1",
    });
  });
});
