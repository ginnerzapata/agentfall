import type {
  Action,
  ExpeditionRun,
  FloorSession,
  ProgressionCharacter,
  RunDefinition,
  Snapshot,
} from "@agentfall/contracts";

import { act, createRun } from "./index";
import { completeFloor, generateProgressionCharacter } from "./progression";

export type StartFloorResult =
  | { accepted: true; run: ExpeditionRun }
  | {
      accepted: false;
      reason: "character-dead" | "floor-already-active" | "no-expedition-charge" | "invalid-floor";
    };

export type RunActionResult =
  | { accepted: true; run: ExpeditionRun; outcome: "continued" | "collapsed" | "died" }
  | { accepted: false; reason: "no-active-floor" | "character-dead" | "floor-collapsed" | string };

export function createExpeditionRun(
  runId: string,
  seasonSeed: string,
  expeditionCharges = 3,
): ExpeditionRun {
  return {
    runId,
    seasonSeed,
    characterSequence: 1,
    character: generateProgressionCharacter(seasonSeed, 1),
    expeditionCharges,
    nextFloor: 1,
    completedFloors: 0,
    characterDeaths: 0,
    journal: { facts: [], notes: [] },
    activeFloor: null,
    status: "active",
  };
}

/** Starts a charged floor from the character's exact committed state. */
export function startFloor(
  run: ExpeditionRun,
  definition: RunDefinition,
  floor: number,
  turnBudget: number,
  kind: "normal" | "boss" = "normal",
): StartFloorResult {
  if (run.status === "dead") return { accepted: false, reason: "character-dead" };
  if (run.activeFloor) return { accepted: false, reason: "floor-already-active" };
  if (floor !== run.nextFloor) return { accepted: false, reason: "invalid-floor" };
  if (!Number.isSafeInteger(turnBudget) || turnBudget < 1)
    return { accepted: false, reason: "invalid-floor" };
  if (run.expeditionCharges < 1) return { accepted: false, reason: "no-expedition-charge" };

  const created = createRun({
    ...clone(definition),
    character: {
      ...clone(run.character.character),
      inventory: clone(run.character.inventory),
      position: clone(definition.character.position),
    },
  });
  if (!created.accepted) return { accepted: false, reason: "invalid-floor" };
  const next = clone(run);
  next.expeditionCharges -= 1;
  next.activeFloor = {
    floor,
    kind,
    turnBudget,
    preFloorCharacter: clone(run.character),
    snapshot: created.snapshot,
    pendingNotes: [],
  };
  return { accepted: true, run: next };
}

/** Applies an engine action and collapses immediately after an over-budget completed turn. */
export function actInFloor(run: ExpeditionRun, action: Action): RunActionResult {
  const session = run.activeFloor;
  if (!session) return { accepted: false, reason: "no-active-floor" };
  if (run.status === "dead") return { accepted: false, reason: "character-dead" };
  if (session.snapshot.turn > session.turnBudget)
    return { accepted: false, reason: "floor-collapsed" };
  const result = act(session.snapshot, action);
  if (!result.accepted) return { accepted: false, reason: result.reason };

  const next = clone(run);
  const nextSession = required(next.activeFloor);
  nextSession.snapshot = result.snapshot;
  if (result.snapshot.character.dead)
    return { accepted: true, run: commitDeath(next), outcome: "died" };
  if (result.snapshot.turn > nextSession.turnBudget)
    return { accepted: true, run: rollback(next), outcome: "collapsed" };
  return { accepted: true, run: next, outcome: "continued" };
}

/** Commits a successful exit. Unexplored optional content is intentionally never required. */
export function completeActiveFloor(
  run: ExpeditionRun,
):
  | { accepted: true; run: ExpeditionRun }
  | { accepted: false; reason: "no-active-floor" | "exit-locked" } {
  const session = run.activeFloor;
  if (!session) return { accepted: false, reason: "no-active-floor" };
  if (!session.snapshot.exitUnlocked) return { accepted: false, reason: "exit-locked" };
  const next = clone(run);
  const current = required(next.activeFloor);
  const committed = characterFromSnapshot(current.preFloorCharacter, current.snapshot);
  next.character = completeFloor(committed, current.kind, next.seasonSeed);
  next.completedFloors = Math.max(next.completedFloors, current.floor);
  next.nextFloor = current.floor + 1;
  commitDiscoveries(next, current);
  next.activeFloor = null;
  return { accepted: true, run: next };
}

/** Voluntary abandonment follows precisely the same rollback path as collapse. */
export function abandonActiveFloor(
  run: ExpeditionRun,
): { accepted: true; run: ExpeditionRun } | { accepted: false; reason: "no-active-floor" } {
  if (!run.activeFloor) return { accepted: false, reason: "no-active-floor" };
  return { accepted: true, run: rollback(clone(run)) };
}

/** Stores a short untrusted note only until the floor is successfully completed. */
export function writeFloorNote(
  run: ExpeditionRun,
  text: string,
):
  | { accepted: true; run: ExpeditionRun }
  | { accepted: false; reason: "no-active-floor" | "invalid-note" } {
  if (!run.activeFloor) return { accepted: false, reason: "no-active-floor" };
  if (text.length === 0 || text.length > 500) return { accepted: false, reason: "invalid-note" };
  const next = clone(run);
  required(next.activeFloor).pendingNotes.push(text);
  return { accepted: true, run: next };
}

/** A committed death never rolls the character back; it creates the next deterministic character. */
export function createNextCharacter(
  run: ExpeditionRun,
): { accepted: true; run: ExpeditionRun } | { accepted: false; reason: "character-still-living" } {
  if (run.status !== "dead") return { accepted: false, reason: "character-still-living" };
  const next = clone(run);
  next.characterSequence += 1;
  next.character = generateProgressionCharacter(next.seasonSeed, next.characterSequence);
  next.nextFloor = 1;
  next.status = "active";
  return { accepted: true, run: next };
}

function rollback(run: ExpeditionRun): ExpeditionRun {
  const session = required(run.activeFloor);
  run.character = clone(session.preFloorCharacter);
  run.activeFloor = null;
  return run;
}

function commitDeath(run: ExpeditionRun): ExpeditionRun {
  const session = required(run.activeFloor);
  run.character = characterFromSnapshot(session.preFloorCharacter, session.snapshot);
  run.characterDeaths += 1;
  run.journal.facts.push({ kind: "death", floor: session.floor, cause: "health-depleted" });
  run.activeFloor = null;
  run.status = "dead";
  return run;
}

function commitDiscoveries(run: ExpeditionRun, session: FloorSession): void {
  run.journal.facts.push({
    kind: "terrain",
    floor: session.floor,
    tiles: clone(session.snapshot.rememberedTiles),
  });
  const enemyIds = [
    ...new Set(
      session.snapshot.events.flatMap((event) => ("targetId" in event ? [event.targetId] : [])),
    ),
  ].sort();
  if (enemyIds.length) run.journal.facts.push({ kind: "enemy", floor: session.floor, enemyIds });
  run.journal.notes.push(...session.pendingNotes.map((text) => ({ floor: session.floor, text })));
}

function characterFromSnapshot(
  base: ProgressionCharacter,
  snapshot: Snapshot,
): ProgressionCharacter {
  const {
    temporaryDefense: _temporaryDefense,
    dead: _dead,
    guardedTiles: _guardedTiles,
    guardExpiresTurn: _guardExpiresTurn,
    ward: _ward,
    wardExpiresTurn: _wardExpiresTurn,
    ...character
  } = snapshot.character;
  return { ...clone(base), character, inventory: clone(snapshot.inventory) };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected an active floor.");
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
