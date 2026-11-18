import { type Action, type Observation, observe } from "@agentfall/engine";

import type { CommitActionResult, FloorStore } from "../persistence";

export type ObserveFloorResult =
  | { accepted: true; snapshotVersion: number; observation: Observation }
  | { accepted: false; reason: "not-found" };

export type SubmitFloorActionInput = {
  floorSessionId: string;
  idempotencyKey: string;
  expectedSnapshotVersion: number;
  action: Action;
  now: string;
};

/** Application use case: no Hono, Workers, or transport types cross this boundary. */
export class FloorApplication {
  constructor(private readonly floors: FloorStore) {}

  async observe(floorSessionId: string): Promise<ObserveFloorResult> {
    const stored = await this.floors.loadSnapshot(floorSessionId);
    if (!stored) return { accepted: false, reason: "not-found" };
    return {
      accepted: true,
      snapshotVersion: stored.version,
      observation: observe(stored.snapshot),
    };
  }

  submitAction(input: SubmitFloorActionInput): Promise<CommitActionResult> {
    return this.floors.commitAction(input);
  }
}
