import { DEFAULT_FLOOR_CONTENT, type GeneratedFloor, generateFloor } from "@agentfall/content";
import {
  type Action,
  canonicalStringify,
  type ExpeditionRun,
  type JournalFact,
  MCP_MUTATION_SCHEMA_VERSION,
  MCP_READ_SCHEMA_VERSION,
  McpMutationResultSchema,
  McpReadResultSchema,
  type RunDefinition,
} from "@agentfall/contracts";
import {
  abandonActiveFloor,
  chooseUpgrade as applyCharacterUpgrade,
  completeActiveFloor,
  createExpeditionRun,
  createNextCharacter,
  observe,
  resolveCommittedFloorSnapshot,
  startFloor as startRunFloor,
} from "@agentfall/engine";
import { FloorApplication } from "../application";
import { credentialHash } from "../auth";
import {
  type CommitActionResult,
  type D1Database,
  D1ExpeditionSessions,
  D1FloorStore,
  type D1PreparedStatement,
} from "../persistence";
import { D1RateLimiter } from "../rate-limit";
import type { McpGameplay } from "./server";

const CHARGE_CAP = 3;
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PRACTICE_TRAINING_SEED = "agentfall-practice-training-1";
const PRACTICE_FLOOR_COUNT = 5;

type CredentialRow = { account_id: string };
type AccountRow = { ranked_enrolled_at: string | null };
type SessionOwnerRow = {
  status: string;
  expires_at: string;
  run_id: string;
  mode: "ranked" | "practice" | null;
  floor: number;
};
type CharacterRow = { id: string; sequence: number; status: string; state_json: string };
type RunRow = {
  id: string;
  season_id: string;
  character_id: string | null;
  mode: "ranked" | "practice";
  status: string;
  state_json: string;
};
type ReceiptRow = { request_hash: string; response_json: string };
type JournalRow = { id: string; kind: string; payload_json: string; created_at: string };
type SeasonRow = {
  id: string;
  state: string;
  ruleset_version: string;
  generator_version: string;
  content_version: string;
  seed_commitment: string | null;
  revealed_seed: string | null;
  tower_json?: string | null;
};
type StandingRow = {
  account_id: string;
  display_name: string | null;
  best_floor: number;
  bosses_defeated: number;
  character_deaths: number;
  floor_turns: number;
  achieved_at: string;
};

/** D1 adapter that resolves an opaque bearer credential on every MCP call. */
export class D1McpGameplay implements McpGameplay {
  constructor(
    private readonly database: D1Database,
    private readonly authorization: string | undefined,
    private readonly credentialHashPepper = "",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startFloor(input: {
    mode: "ranked" | "practice";
    idempotencyKey: string;
    strategy?: string;
    includeTiles?: boolean;
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const now = this.now();
    if (!(await this.allowRateScope("request", accountId, now)))
      return mutationResult({ code: "RATE_LIMITED" });

    const scopeId = `start:${accountId}`;
    const requestHash = canonicalStringify({
      mode: input.mode,
      strategy: input.strategy ?? null,
    });
    const existingReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
    if (existingReceipt) return replayOrConflict(existingReceipt);

    const sessions = new D1ExpeditionSessions(this.database);
    await sessions.abandonExpired(now, accountId);

    const season = await this.activeSeason();
    if (!season) return mutationResult({ code: "SEASON_UNAVAILABLE" });

    if (input.mode === "ranked") {
      const enrolled = await this.isRankedEnrolled(accountId);
      if (!enrolled) return mutationResult({ code: "RANKED_ENROLLMENT_REQUIRED" });
    }

    if (await this.hasOpenSession(accountId, input.mode))
      return mutationResult({ code: "SESSION_ACTIVE" });

    const prepared =
      input.mode === "ranked"
        ? await this.prepareRankedStart(accountId, season, sessions, now)
        : await this.preparePracticeStart(accountId, season);
    if (!prepared.accepted) return mutationResult({ code: prepared.code });

    const floorDefinition: RunDefinition = {
      ...prepared.floor.definition,
      runId: `${prepared.run.runId}:floor-${prepared.floorNumber}`,
      rulesetVersion: season.ruleset_version,
      generatorVersion: season.generator_version,
    };
    const started = startRunFloor(
      prepared.run,
      floorDefinition,
      prepared.floorNumber,
      prepared.floor.turnBudget,
      prepared.kind,
    );
    if (!started.accepted || !started.run.activeFloor)
      return mutationResult({
        code: startRejectionCode(started.accepted ? "invalid-floor" : started.reason),
      });
    if (input.strategy !== undefined) started.run.activeFloor.strategy = input.strategy;

    const sessionId = crypto.randomUUID();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
    const activeFloor = started.run.activeFloor;
    const response = {
      accepted: true,
      replayed: false,
      floorSessionId: sessionId,
      mode: input.mode,
      floor: activeFloor.floor,
      kind: activeFloor.kind,
      turnBudget: activeFloor.turnBudget,
      snapshotVersion: 0,
      expiresAt,
      briefing: {
        floor: activeFloor.floor,
        kind: activeFloor.kind,
        turnBudget: activeFloor.turnBudget,
        ...(input.strategy ? { strategy: input.strategy } : {}),
      },
      observation: compactObservation(observe(activeFloor.snapshot), input.includeTiles),
    };
    const serializedRun = canonicalStringify(started.run);
    const { preStatements, postStatements } = this.startBatchStatements({
      accountId,
      seasonId: season.id,
      mode: input.mode,
      sessionId,
      runId: started.run.runId,
      characterId: prepared.characterId,
      newCharacter: prepared.newCharacter,
      newRun: prepared.newRun,
      serializedRun,
      scopeId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      responseJson: canonicalStringify(response),
      nowIso,
    });

    const admitted = await sessions.start({
      accountId,
      runId: started.run.runId,
      sessionId,
      mode: input.mode,
      floor: activeFloor.floor,
      definition: floorDefinition,
      snapshot: activeFloor.snapshot,
      now,
      characterId: prepared.characterId,
      preStatements,
      postStatements,
    });
    if (!admitted.accepted) {
      const racedReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
      if (racedReceipt) return replayOrConflict(racedReceipt);
      if (admitted.reason === "capacity-exhausted")
        return mutationResult({ code: "CAPACITY_EXHAUSTED", resetAt: admitted.resetAt });
      return mutationResult({
        code: admitted.reason === "no-charge" ? "NO_CHARGE" : "SESSION_ACTIVE",
      });
    }
    return mutationResult(response);
  }

  async observeFloor(input: {
    floorSessionId?: string;
    includeTiles?: boolean;
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId(false);
    const floorSessionId = input.floorSessionId ?? (await this.activeSessionId(accountId));
    if (!floorSessionId) return readResult({ code: "NOT_FOUND" });
    const session = await this.session(accountId, floorSessionId);
    if (!session) return readResult({ code: "NOT_FOUND" });
    const availability = sessionAvailability(session, this.now().toISOString());
    if (availability !== "open") return readResult({ code: availability });
    const result = await new FloorApplication(new D1FloorStore(this.database)).observe(
      floorSessionId,
    );
    if (!result.accepted) return readResult({ code: "NOT_FOUND" });
    return readResult({
      floorSessionId,
      floor: session.floor,
      snapshotVersion: result.snapshotVersion,
      observation: compactObservation(result.observation, input.includeTiles),
    });
  }

  async submitAction(input: {
    floorSessionId?: string;
    snapshotVersion?: number;
    idempotencyKey: string;
    action?: Action;
    actions?: Action[];
    autoEndTurn?: boolean;
    includeTiles?: boolean;
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const now = this.now();
    if (!(await this.allowRateScope("active-floor-mutation", accountId, now)))
      return mutationResult({ code: "RATE_LIMITED" });

    const floorSessionId = input.floorSessionId ?? (await this.activeSessionId(accountId));
    if (!floorSessionId) return mutationResult({ code: "NOT_FOUND" });
    const session = await this.session(accountId, floorSessionId);
    if (!session) return mutationResult({ code: "NOT_FOUND" });

    const store = new D1FloorStore(this.database);
    const expectedSnapshotVersion =
      input.snapshotVersion ?? (await store.loadSnapshot(floorSessionId))?.version;
    if (expectedSnapshotVersion === undefined) return mutationResult({ code: "NOT_FOUND" });

    const requestHash = canonicalStringify({
      expectedSnapshotVersion,
      ...(input.actions ? { actions: input.actions } : { action: input.action }),
      ...(input.autoEndTurn ? { autoEndTurn: true } : {}),
    });
    const existingActionReceipt = await this.lookupReceipt(
      floorSessionId,
      input.idempotencyKey,
      requestHash,
    );
    if (existingActionReceipt) {
      if (existingActionReceipt.conflict) return mutationResult({ code: "IDEMPOTENCY_CONFLICT" });
      const original = existingActionReceipt.response as unknown as CommitActionResult;
      if (!original.accepted) return mutationResult({ code: "INTERNAL" });
      const outcome = await this.replayedActionOutcome(
        floorSessionId,
        input.idempotencyKey,
        original.snapshot.character.dead,
      );
      return mutationResult({
        accepted: true,
        replayed: true,
        outcome,
        floorSessionId,
        floor: session.floor,
        snapshotVersion: original.version,
        observation: compactObservation(observe(original.snapshot), input.includeTiles),
      });
    }

    const sessions = new D1ExpeditionSessions(this.database);
    await sessions.abandonExpired(now, accountId, floorSessionId);
    await sessions.pauseIdle(now);
    const current = await this.session(accountId, floorSessionId);
    if (!current) return mutationResult({ code: "NOT_FOUND" });
    const nowIso = now.toISOString();
    const availability = sessionAvailability(current, nowIso);
    if (availability !== "open") return mutationResult({ code: availability });

    const runRow = await this.loadRunById(current.run_id, accountId);
    if (!runRow) return mutationResult({ code: "SESSION_UNAVAILABLE" });
    const run = parseJson<ExpeditionRun>(runRow.state_json);
    if (!run.activeFloor || run.status === "dead")
      return mutationResult({ code: "SESSION_UNAVAILABLE" });

    const turnBudget = run.activeFloor.turnBudget;
    let computedOutcome: "continued" | "died" | "collapsed" = "continued";
    const committed = await new FloorApplication(store).submitAction({
      floorSessionId,
      idempotencyKey: input.idempotencyKey,
      expectedSnapshotVersion,
      action: input.action,
      actions: input.actions,
      autoEndTurn: input.autoEndTurn,
      now: nowIso,
      turnBudget,
      extraStatements: ({ version, snapshot }) => {
        const resolved = resolveCommittedFloorSnapshot(run, snapshot);
        computedOutcome = resolved.outcome;
        return this.actionPostCommitStatements({
          accountId,
          floorSessionId,
          idempotencyKey: input.idempotencyKey,
          snapshotVersion: version,
          runRow,
          nextRun: resolved.run,
          outcome: resolved.outcome,
          floorNumber: current.floor,
          nowIso,
        });
      },
    });
    if (!committed.accepted) {
      if (committed.reason === "floor-collapsed")
        return mutationResult({ code: "SESSION_UNAVAILABLE" });
      return mutationResult({ code: committed.reason.toUpperCase().replaceAll("-", "_") });
    }

    if (committed.replayed) {
      const outcome = await this.replayedActionOutcome(
        floorSessionId,
        input.idempotencyKey,
        committed.snapshot.character.dead,
      );
      return mutationResult({
        accepted: true,
        replayed: true,
        outcome,
        floorSessionId,
        floor: current.floor,
        turnBudget,
        snapshotVersion: committed.version,
        observation: compactObservation(observe(committed.snapshot), input.includeTiles),
      });
    }

    return mutationResult({
      accepted: true,
      replayed: false,
      outcome: computedOutcome,
      floorSessionId,
      floor: current.floor,
      turnBudget,
      eventsCommitted: committed.events?.length ?? 1,
      snapshotVersion: committed.version,
      observation: compactObservation(observe(committed.snapshot), input.includeTiles),
    });
  }

  async currentCharacter(): Promise<Record<string, unknown>> {
    const accountId = await this.accountId(false);
    const character = await this.database
      .prepare(
        `SELECT id, sequence, status, state_json FROM characters
         WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<CharacterRow>();
    if (!character) return readResult({ code: "NOT_FOUND" });
    return readResult(characterView(character));
  }

  async journal(input: { limit: number }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId(false);
    const rows = await this.database
      .prepare(
        `SELECT id, kind, payload_json, created_at FROM journals
         WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(accountId, input.limit)
      .all<JournalRow>();
    return readResult({
      entries: rows.results.flatMap((row) => {
        const payload = journalPayload(row.kind, row.payload_json);
        return payload ? [{ id: row.id, kind: row.kind, payload, createdAt: row.created_at }] : [];
      }),
    });
  }

  async chooseUpgrade(input: {
    upgradeId: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const now = this.now();
    if (!(await this.allowRateScope("request", accountId, now)))
      return mutationResult({ code: "RATE_LIMITED" });

    const scopeId = `upgrade:${accountId}`;
    const requestHash = canonicalStringify({ upgradeId: input.upgradeId });
    const existingReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
    if (existingReceipt) return replayOrConflict(existingReceipt);

    const runRow = await this.database
      .prepare(
        `SELECT id, season_id, character_id, mode, status, state_json FROM runs
         WHERE account_id = ? AND status = 'active'
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<RunRow>();
    if (!runRow) return mutationResult({ code: "NOT_FOUND" });
    const run = parseJson<ExpeditionRun>(runRow.state_json);
    if (run.activeFloor) return mutationResult({ code: "SESSION_ACTIVE" });
    if (run.status === "dead") return mutationResult({ code: "CHARACTER_DEAD" });

    const upgraded = applyCharacterUpgrade(run.character, input.upgradeId);
    if (!upgraded) return mutationResult({ code: "INVALID_UPGRADE" });
    const nextRun: ExpeditionRun = { ...run, character: upgraded };
    const nowIso = now.toISOString();
    const response = {
      accepted: true,
      replayed: false,
      upgradeId: input.upgradeId,
      character: upgraded.character,
      level: upgraded.level,
      pendingUpgrades: upgraded.pendingUpgrades,
    };

    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO mutation_receipts
             (scope_id, idempotency_key, request_hash, response_json, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)`,
        )
        .bind(
          scopeId,
          input.idempotencyKey,
          requestHash,
          canonicalStringify(response),
          nowIso,
          runRow.id,
          runRow.state_json,
        ),
    ];
    if (runRow.mode === "ranked" && runRow.character_id) {
      statements.push(
        this.database
          .prepare(
            `UPDATE characters SET state_json = ?, updated_at = ?
             WHERE id = ? AND account_id = ? AND status = 'living'
               AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
               AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
          )
          .bind(
            canonicalStringify(upgraded),
            nowIso,
            runRow.character_id,
            accountId,
            runRow.id,
            runRow.state_json,
            scopeId,
            input.idempotencyKey,
          ),
      );
    }
    statements.push(
      this.database
        .prepare(
          `UPDATE runs SET state_json = ?, updated_at = ?
           WHERE id = ? AND state_json = ?
             AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
        )
        .bind(
          canonicalStringify(nextRun),
          nowIso,
          runRow.id,
          runRow.state_json,
          scopeId,
          input.idempotencyKey,
        ),
    );
    const result = await this.database.batch(statements);
    if (result.at(-1)?.meta?.changes !== 1) {
      const racedReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
      if (racedReceipt) return replayOrConflict(racedReceipt);
      return mutationResult({ code: "INVALID_UPGRADE" });
    }
    return mutationResult(response);
  }

  async abandonFloor(input: {
    floorSessionId?: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const now = this.now();
    if (!(await this.allowRateScope("active-floor-mutation", accountId, now)))
      return mutationResult({ code: "RATE_LIMITED" });

    const floorSessionId = input.floorSessionId ?? (await this.activeSessionId(accountId));
    if (!floorSessionId) return mutationResult({ code: "NOT_FOUND" });
    const session = await this.session(accountId, floorSessionId);
    if (!session) return mutationResult({ code: "NOT_FOUND" });

    const scopeId = `abandon:${accountId}:${floorSessionId}`;
    const requestHash = canonicalStringify({ op: "abandon", floorSessionId });
    const existingReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
    if (existingReceipt) return replayOrConflict(existingReceipt);

    const sessions = new D1ExpeditionSessions(this.database);
    await sessions.abandonExpired(now, accountId, floorSessionId);
    const current = await this.session(accountId, floorSessionId);
    if (!current) return mutationResult({ code: "NOT_FOUND" });
    const nowIso = now.toISOString();
    const availability = sessionAvailability(current, nowIso);
    if (availability !== "open") return mutationResult({ code: availability });

    const stored = await new D1FloorStore(this.database).loadSnapshot(floorSessionId);
    if (!stored) return mutationResult({ code: "NOT_FOUND" });

    const runRow = await this.loadRunById(current.run_id, accountId);
    if (!runRow) return mutationResult({ code: "SESSION_UNAVAILABLE" });
    const run = parseJson<ExpeditionRun>(runRow.state_json);
    if (
      !run.activeFloor ||
      run.status === "dead" ||
      stored.snapshot.character.dead ||
      stored.snapshot.turn > run.activeFloor.turnBudget
    )
      return mutationResult({ code: "SESSION_UNAVAILABLE" });

    const abandoned = abandonActiveFloor(run);
    if (!abandoned.accepted) return mutationResult({ code: "SESSION_UNAVAILABLE" });

    const response = {
      accepted: true,
      replayed: false,
      floorSessionId,
      status: "abandoned",
      floor: current.floor,
      mode: runRow.mode,
      character: abandoned.run.character.character,
    };
    const nextState = canonicalStringify(abandoned.run);
    const result = await this.database.batch([
      this.database
        .prepare(
          `INSERT OR IGNORE INTO mutation_receipts
             (scope_id, idempotency_key, request_hash, response_json, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM floor_sessions
             WHERE id = ? AND account_id = ? AND status IN ('active', 'paused') AND expires_at > ?
           ) AND EXISTS (
             SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?
           ) AND EXISTS (
             SELECT 1 FROM runs WHERE id = ? AND state_json = ?
           )`,
        )
        .bind(
          scopeId,
          input.idempotencyKey,
          requestHash,
          canonicalStringify(response),
          nowIso,
          floorSessionId,
          accountId,
          nowIso,
          floorSessionId,
          stored.version,
          runRow.id,
          runRow.state_json,
        ),
      this.database
        .prepare(
          `UPDATE floor_sessions SET status = 'abandoned', updated_at = ?
           WHERE id = ? AND account_id = ? AND status IN ('active', 'paused') AND expires_at > ?
             AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
             AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
        )
        .bind(
          nowIso,
          floorSessionId,
          accountId,
          nowIso,
          runRow.id,
          runRow.state_json,
          scopeId,
          input.idempotencyKey,
        ),
      this.database
        .prepare(
          `UPDATE runs SET state_json = ?, updated_at = ?
           WHERE id = ? AND state_json = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)
             AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
        )
        .bind(
          nextState,
          nowIso,
          runRow.id,
          runRow.state_json,
          floorSessionId,
          stored.version,
          scopeId,
          input.idempotencyKey,
        ),
    ]);
    if (result[2]?.meta?.changes !== 1) {
      const racedReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
      if (racedReceipt) return replayOrConflict(racedReceipt);
      return mutationResult({ code: "SESSION_UNAVAILABLE" });
    }
    return mutationResult(response);
  }

  async endFloor(input: {
    floorSessionId?: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const accountId = await this.accountId();
    const now = this.now();
    if (!(await this.allowRateScope("active-floor-mutation", accountId, now)))
      return mutationResult({ code: "RATE_LIMITED" });

    const floorSessionId = input.floorSessionId ?? (await this.activeSessionId(accountId));
    if (!floorSessionId) return mutationResult({ code: "NOT_FOUND" });
    const session = await this.session(accountId, floorSessionId);
    if (!session) return mutationResult({ code: "NOT_FOUND" });

    const scopeId = `end:${accountId}:${floorSessionId}`;
    const requestHash = canonicalStringify({ op: "end", floorSessionId });
    const existingReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
    if (existingReceipt) return replayOrConflict(existingReceipt);

    const sessions = new D1ExpeditionSessions(this.database);
    await sessions.abandonExpired(now, accountId, floorSessionId);
    const current = await this.session(accountId, floorSessionId);
    if (!current) return mutationResult({ code: "NOT_FOUND" });
    const nowIso = now.toISOString();
    const availability = sessionAvailability(current, nowIso);
    if (availability !== "open") return mutationResult({ code: availability });

    const stored = await new D1FloorStore(this.database).loadSnapshot(floorSessionId);
    if (!stored) return mutationResult({ code: "NOT_FOUND" });
    if (stored.snapshot.character.dead) return mutationResult({ code: "SESSION_UNAVAILABLE" });
    if (!stored.snapshot.exitUnlocked) return mutationResult({ code: "EXIT_LOCKED" });

    const runRow = await this.loadRunById(current.run_id, accountId);
    if (!runRow) return mutationResult({ code: "SESSION_UNAVAILABLE" });
    const run = parseJson<ExpeditionRun>(runRow.state_json);
    if (!run.activeFloor || run.status === "dead")
      return mutationResult({ code: "SESSION_UNAVAILABLE" });
    if (stored.snapshot.turn > run.activeFloor.turnBudget)
      return mutationResult({ code: "SESSION_UNAVAILABLE" });

    const floorKind = run.activeFloor.kind;
    const floorNumber = run.activeFloor.floor;
    const previousFactCount = run.journal.facts.length;
    const previousNoteCount = run.journal.notes.length;
    run.activeFloor.snapshot = stored.snapshot;
    const completed = completeActiveFloor(run);
    if (!completed.accepted) return mutationResult({ code: "EXIT_LOCKED" });

    let towerLength = PRACTICE_FLOOR_COUNT;
    if (runRow.mode === "ranked") {
      if (floorKind === "boss") await sessions.charges(accountId, now);
      const seasonRow = await this.database
        .prepare("SELECT tower_json FROM seasons WHERE id = ?")
        .bind(runRow.season_id)
        .first<{ tower_json: string | null }>();
      towerLength = parseTower(seasonRow?.tower_json)?.length ?? PRACTICE_FLOOR_COUNT;
    }

    const response = {
      accepted: true,
      replayed: false,
      floorSessionId,
      status: "completed",
      floor: floorNumber,
      kind: floorKind,
      mode: runRow.mode,
      turnsUsed: stored.snapshot.turn,
      completedFloors: completed.run.completedFloors,
      nextFloor: completed.run.nextFloor,
      character: completed.run.character.character,
      pendingUpgrades: completed.run.character.pendingUpgrades,
    };

    const nextState = canonicalStringify(completed.run);
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO mutation_receipts
             (scope_id, idempotency_key, request_hash, response_json, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM floor_sessions
             WHERE id = ? AND account_id = ? AND status IN ('active', 'paused') AND expires_at > ?
           ) AND EXISTS (
             SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?
           ) AND EXISTS (
             SELECT 1 FROM runs WHERE id = ? AND state_json = ?
           )`,
        )
        .bind(
          scopeId,
          input.idempotencyKey,
          requestHash,
          canonicalStringify(response),
          nowIso,
          floorSessionId,
          accountId,
          nowIso,
          floorSessionId,
          stored.version,
          runRow.id,
          runRow.state_json,
        ),
    ];

    if (runRow.mode === "ranked") {
      if (runRow.character_id) {
        statements.push(
          this.database
            .prepare(
              `UPDATE characters SET state_json = ?, updated_at = ?
               WHERE id = ? AND account_id = ? AND status = 'living'
                 AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
                 AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
            )
            .bind(
              canonicalStringify(completed.run.character),
              nowIso,
              runRow.character_id,
              accountId,
              runRow.id,
              runRow.state_json,
              scopeId,
              input.idempotencyKey,
            ),
        );
      }
      if (floorKind === "boss") {
        statements.push(
          this.database
            .prepare(
              `UPDATE charges
               SET available = MIN(?, available + 1),
                   calculated_at = CASE WHEN available < ? THEN ? ELSE calculated_at END,
                   updated_at = ?
               WHERE account_id = ?
                 AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
                 AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
            )
            .bind(
              CHARGE_CAP,
              CHARGE_CAP,
              nowIso,
              nowIso,
              accountId,
              runRow.id,
              runRow.state_json,
              scopeId,
              input.idempotencyKey,
            ),
        );
      }
      for (const fact of completed.run.journal.facts.slice(previousFactCount)) {
        statements.push(
          this.insertJournalForEndStatement({
            accountId,
            seasonId: runRow.season_id,
            kind: "fact",
            payload: fact,
            runId: runRow.id,
            expectedRunStateJson: runRow.state_json,
            scopeId,
            idempotencyKey: input.idempotencyKey,
            nowIso,
          }),
        );
      }
      for (const note of completed.run.journal.notes.slice(previousNoteCount)) {
        statements.push(
          this.insertJournalForEndStatement({
            accountId,
            seasonId: runRow.season_id,
            kind: "note",
            payload: note,
            runId: runRow.id,
            expectedRunStateJson: runRow.state_json,
            scopeId,
            idempotencyKey: input.idempotencyKey,
            nowIso,
          }),
        );
      }
      statements.push(
        this.database
          .prepare(
            `INSERT INTO standings
               (season_id, account_id, best_floor, bosses_defeated, character_deaths, floor_turns, achieved_at)
             SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
               AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)
             ON CONFLICT(season_id, account_id) DO UPDATE SET
               best_floor = excluded.best_floor,
               bosses_defeated = excluded.bosses_defeated,
               character_deaths = excluded.character_deaths,
               floor_turns = excluded.floor_turns,
               achieved_at = excluded.achieved_at
             WHERE excluded.best_floor > standings.best_floor
                OR (excluded.best_floor = standings.best_floor
                    AND excluded.bosses_defeated > standings.bosses_defeated)
                OR (excluded.best_floor = standings.best_floor
                    AND excluded.bosses_defeated = standings.bosses_defeated
                    AND excluded.character_deaths < standings.character_deaths)
                OR (excluded.best_floor = standings.best_floor
                    AND excluded.bosses_defeated = standings.bosses_defeated
                    AND excluded.character_deaths = standings.character_deaths
                    AND excluded.floor_turns < standings.floor_turns)
                OR (excluded.best_floor = standings.best_floor
                    AND excluded.bosses_defeated = standings.bosses_defeated
                    AND excluded.character_deaths = standings.character_deaths
                    AND excluded.floor_turns = standings.floor_turns
                    AND excluded.achieved_at < standings.achieved_at)`,
          )
          .bind(
            runRow.season_id,
            accountId,
            completed.run.completedFloors,
            countBossesDefeated(completed.run.completedFloors, towerLength),
            completed.run.characterDeaths,
            stored.snapshot.turn,
            nowIso,
            runRow.id,
            runRow.state_json,
            scopeId,
            input.idempotencyKey,
          ),
      );
    }

    // Update floor_sessions and runs LAST so preceding statements can guard on old runs.state_json.
    statements.push(
      this.database
        .prepare(
          `UPDATE floor_sessions SET status = 'completed', updated_at = ?
           WHERE id = ? AND account_id = ? AND status IN ('active', 'paused') AND expires_at > ?
             AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
             AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
        )
        .bind(
          nowIso,
          floorSessionId,
          accountId,
          nowIso,
          runRow.id,
          runRow.state_json,
          scopeId,
          input.idempotencyKey,
        ),
      this.database
        .prepare(
          `UPDATE runs SET state_json = ?, updated_at = ?
           WHERE id = ? AND state_json = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)
             AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
        )
        .bind(
          nextState,
          nowIso,
          runRow.id,
          runRow.state_json,
          floorSessionId,
          stored.version,
          scopeId,
          input.idempotencyKey,
        ),
    );

    const result = await this.database.batch(statements);
    if (result.at(-1)?.meta?.changes !== 1) {
      const racedReceipt = await this.lookupReceipt(scopeId, input.idempotencyKey, requestHash);
      if (racedReceipt) return replayOrConflict(racedReceipt);
      return mutationResult({ code: "SESSION_UNAVAILABLE" });
    }
    return mutationResult(response);
  }

  async season(input: { seasonId?: string }): Promise<Record<string, unknown>> {
    await this.accountId(false);
    const season = input.seasonId
      ? await this.database
          .prepare(
            `SELECT id, state, ruleset_version, generator_version, content_version,
                    seed_commitment, revealed_seed FROM seasons WHERE id = ?`,
          )
          .bind(input.seasonId)
          .first<SeasonRow>()
      : await this.database
          .prepare(
            `SELECT id, state, ruleset_version, generator_version, content_version,
                    seed_commitment, revealed_seed FROM seasons
             WHERE state = 'active' ORDER BY created_at DESC LIMIT 1`,
          )
          .first<SeasonRow>();
    if (!season) return readResult({ code: "NOT_FOUND" });
    return readResult({
      id: season.id,
      state: season.state,
      rulesetVersion: season.ruleset_version,
      generatorVersion: season.generator_version,
      contentVersion: season.content_version,
      seedCommitment: season.seed_commitment,
      ...(season.state === "revealed" ? { seed: season.revealed_seed } : {}),
    });
  }

  async standings(input: { seasonId?: string; limit: number }): Promise<Record<string, unknown>> {
    await this.accountId(false);
    const seasonId = input.seasonId ?? (await this.activeSeasonId());
    if (!seasonId) return readResult({ code: "NOT_FOUND" });
    const rows = await this.database
      .prepare(
        `SELECT standings.account_id, accounts.display_name, standings.best_floor,
                standings.bosses_defeated, standings.character_deaths, standings.floor_turns,
                standings.achieved_at
         FROM standings JOIN accounts ON accounts.id = standings.account_id
         WHERE standings.season_id = ?
         ORDER BY best_floor DESC, bosses_defeated DESC, character_deaths ASC,
                  floor_turns ASC, achieved_at ASC LIMIT ?`,
      )
      .bind(seasonId, input.limit)
      .all<StandingRow>();
    return readResult({
      seasonId,
      entries: rows.results.map((row, index) => ({
        rank: index + 1,
        displayName: row.display_name,
        bestFloor: row.best_floor,
        bossesDefeated: row.bosses_defeated,
        characterDeaths: row.character_deaths,
        floorTurns: row.floor_turns,
        achievedAt: row.achieved_at,
      })),
    });
  }

  private async prepareRankedStart(
    accountId: string,
    season: SeasonRow,
    sessions: D1ExpeditionSessions,
    now: Date,
  ): Promise<
    | {
        accepted: true;
        run: ExpeditionRun;
        floor: GeneratedFloor;
        floorNumber: number;
        kind: "normal" | "boss";
        characterId: string;
        newCharacter: boolean;
        newRun: boolean;
      }
    | { accepted: false; code: string }
  > {
    const tower = parseTower(season.tower_json);
    const firstFloor = tower?.[0];
    if (!tower || !firstFloor) return { accepted: false, code: "SEASON_UNAVAILABLE" };

    const chargeState = await sessions.charges(accountId, now);
    if (chargeState.available < 1) return { accepted: false, code: "NO_CHARGE" };

    const existing = await this.database
      .prepare(
        `SELECT id, season_id, character_id, mode, status, state_json FROM runs
         WHERE account_id = ? AND season_id = ? AND mode = 'ranked'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(accountId, season.id)
      .first<RunRow>();

    if (!existing) {
      const runId = crypto.randomUUID();
      const characterId = crypto.randomUUID();
      const run = createExpeditionRun(runId, firstFloor.seed, chargeState.available);
      return {
        accepted: true,
        run,
        floor: firstFloor,
        floorNumber: 1,
        kind: tower.length === 1 ? "boss" : "normal",
        characterId,
        newCharacter: true,
        newRun: true,
      };
    }

    let run = parseJson<ExpeditionRun>(existing.state_json);
    run.expeditionCharges = chargeState.available;
    if (run.activeFloor) return { accepted: false, code: "SESSION_ACTIVE" };

    let characterId = existing.character_id;
    let newCharacter = false;
    if (run.status === "dead") {
      const replaced = createNextCharacter(run);
      if (!replaced.accepted) return { accepted: false, code: "INTERNAL" };
      run = replaced.run;
      characterId = crypto.randomUUID();
      newCharacter = true;
    } else if (!characterId) {
      characterId = crypto.randomUUID();
      newCharacter = true;
    }

    if (run.nextFloor < 1 || run.nextFloor > tower.length)
      return { accepted: false, code: "RUN_COMPLETED" };
    const floor = tower[run.nextFloor - 1];
    if (!floor) return { accepted: false, code: "RUN_COMPLETED" };

    return {
      accepted: true,
      run,
      floor,
      floorNumber: run.nextFloor,
      kind: isBossFloor(run.nextFloor, tower.length) ? "boss" : "normal",
      characterId,
      newCharacter,
      newRun: false,
    };
  }

  private async preparePracticeStart(
    accountId: string,
    season: SeasonRow,
  ): Promise<
    | {
        accepted: true;
        run: ExpeditionRun;
        floor: GeneratedFloor;
        floorNumber: number;
        kind: "normal";
        characterId: null;
        newCharacter: false;
        newRun: boolean;
      }
    | { accepted: false; code: string }
  > {
    const existing = await this.database
      .prepare(
        `SELECT id, season_id, character_id, mode, status, state_json FROM runs
         WHERE account_id = ? AND season_id = ? AND mode = 'practice'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(accountId, season.id)
      .first<RunRow>();

    let run: ExpeditionRun;
    let newRun = false;
    if (!existing) {
      run = createExpeditionRun(crypto.randomUUID(), PRACTICE_TRAINING_SEED, CHARGE_CAP);
      newRun = true;
    } else {
      const parsed = parseJson<ExpeditionRun>(existing.state_json);
      if (parsed.activeFloor) return { accepted: false, code: "SESSION_ACTIVE" };
      if (parsed.status === "dead" || parsed.nextFloor > PRACTICE_FLOOR_COUNT) {
        run = createExpeditionRun(crypto.randomUUID(), PRACTICE_TRAINING_SEED, CHARGE_CAP);
        newRun = true;
      } else {
        run = parsed;
        run.expeditionCharges = CHARGE_CAP;
      }
    }

    const floorNumber = run.nextFloor;
    const floor = generateFloor(`agentfall-practice-floor-${floorNumber}`, DEFAULT_FLOOR_CONTENT);
    return {
      accepted: true,
      run,
      floor,
      floorNumber,
      kind: "normal",
      characterId: null,
      newCharacter: false,
      newRun,
    };
  }

  private startBatchStatements(input: {
    accountId: string;
    seasonId: string;
    mode: "ranked" | "practice";
    sessionId: string;
    runId: string;
    characterId: string | null;
    newCharacter: boolean;
    newRun: boolean;
    serializedRun: string;
    scopeId: string;
    idempotencyKey: string;
    requestHash: string;
    responseJson: string;
    nowIso: string;
  }): { preStatements: D1PreparedStatement[]; postStatements: D1PreparedStatement[] } {
    const parsedRun = parseJson<ExpeditionRun>(input.serializedRun);
    const preStatements: D1PreparedStatement[] = [];
    const chargeGuard =
      input.mode === "ranked"
        ? "AND EXISTS (SELECT 1 FROM charges WHERE account_id = ? AND available > 0)"
        : "";
    const chargeBind = input.mode === "ranked" ? [input.accountId] : [];

    if (input.newCharacter && input.characterId) {
      preStatements.push(
        this.database
          .prepare(
            `INSERT INTO characters
               (id, account_id, season_id, sequence, status, state_json, created_at, updated_at)
             SELECT ?, ?, ?, ?, 'living', ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM characters WHERE account_id = ? AND status = 'living')
               AND NOT EXISTS (
                 SELECT 1 FROM floor_sessions
                 WHERE account_id = ? AND mode = 'ranked' AND status IN ('active', 'paused')
               ) ${chargeGuard}`,
          )
          .bind(
            input.characterId,
            input.accountId,
            input.seasonId,
            parsedRun.characterSequence,
            canonicalStringify(parsedRun.character),
            input.nowIso,
            input.nowIso,
            input.accountId,
            input.accountId,
            ...chargeBind,
          ),
      );
    }

    if (input.newRun) {
      preStatements.push(
        this.database
          .prepare(
            `INSERT INTO runs
               (id, account_id, season_id, character_id, mode, status, state_json, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM floor_sessions
               WHERE account_id = ? AND mode = ? AND status IN ('active', 'paused')
             ) ${chargeGuard}`,
          )
          .bind(
            input.runId,
            input.accountId,
            input.seasonId,
            input.characterId,
            input.mode,
            input.serializedRun,
            input.nowIso,
            input.nowIso,
            input.accountId,
            input.mode,
            ...chargeBind,
          ),
      );
    }

    const postStatements: D1PreparedStatement[] = [];
    if (!input.newRun) {
      postStatements.push(
        this.database
          .prepare(
            `UPDATE runs SET character_id = ?, status = 'active', state_json = ?, updated_at = ?
             WHERE id = ? AND account_id = ?
               AND EXISTS (SELECT 1 FROM floor_sessions WHERE id = ?)`,
          )
          .bind(
            input.characterId,
            input.serializedRun,
            input.nowIso,
            input.runId,
            input.accountId,
            input.sessionId,
          ),
      );
    }
    postStatements.push(
      this.database
        .prepare(
          `INSERT OR IGNORE INTO mutation_receipts
             (scope_id, idempotency_key, request_hash, response_json, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM floor_sessions WHERE id = ?)`,
        )
        .bind(
          input.scopeId,
          input.idempotencyKey,
          input.requestHash,
          input.responseJson,
          input.nowIso,
          input.sessionId,
        ),
    );
    return { preStatements, postStatements };
  }

  private actionPostCommitStatements(input: {
    accountId: string;
    floorSessionId: string;
    idempotencyKey: string;
    snapshotVersion: number;
    runRow: RunRow;
    nextRun: ExpeditionRun;
    outcome: "continued" | "died" | "collapsed";
    floorNumber: number;
    nowIso: string;
  }): D1PreparedStatement[] {
    if (input.outcome === "continued") {
      return [
        this.database
          .prepare(
            `UPDATE floor_sessions
             SET status = 'active', last_action_at = ?, updated_at = ?
             WHERE id = ? AND account_id = ? AND status IN ('active', 'paused') AND expires_at > ?
               AND EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)`,
          )
          .bind(
            input.nowIso,
            input.nowIso,
            input.floorSessionId,
            input.accountId,
            input.nowIso,
            input.floorSessionId,
            input.snapshotVersion,
          ),
      ];
    }

    const nextSessionStatus = input.outcome === "died" ? "completed" : "abandoned";
    const nextRunStatus = input.outcome === "died" ? "dead" : "active";
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `INSERT OR IGNORE INTO mutation_receipts
             (scope_id, idempotency_key, request_hash, response_json, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)`,
        )
        .bind(
          `action-outcome:${input.floorSessionId}`,
          input.idempotencyKey,
          input.outcome,
          canonicalStringify({ outcome: input.outcome }),
          input.nowIso,
          input.floorSessionId,
          input.snapshotVersion,
        ),
    ];

    if (input.runRow.mode === "ranked") {
      if (input.outcome === "died" && input.runRow.character_id) {
        statements.push(
          this.database
            .prepare(
              `UPDATE characters SET status = 'dead', state_json = ?, updated_at = ?
               WHERE id = ? AND account_id = ? AND status = 'living'
                 AND EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)
                 AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)`,
            )
            .bind(
              canonicalStringify(input.nextRun.character),
              input.nowIso,
              input.runRow.character_id,
              input.accountId,
              input.floorSessionId,
              input.snapshotVersion,
              input.runRow.id,
              input.runRow.state_json,
            ),
        );
      }
      const deathFact: JournalFact = {
        kind: "death",
        floor: input.floorNumber,
        cause: input.outcome === "died" ? "health-depleted" : "floor-timed-out",
      };
      statements.push(
        this.database
          .prepare(
            `INSERT INTO journals (id, account_id, season_id, kind, payload_json, created_at)
             SELECT ?, ?, ?, 'fact', ?, ?
             WHERE EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)`,
          )
          .bind(
            crypto.randomUUID(),
            input.accountId,
            input.runRow.season_id,
            canonicalStringify(deathFact),
            input.nowIso,
            input.floorSessionId,
            input.snapshotVersion,
            input.runRow.id,
            input.runRow.state_json,
          ),
      );
    }

    statements.push(
      this.database
        .prepare(
          `UPDATE floor_sessions
           SET status = ?, last_action_at = ?, updated_at = ?
           WHERE id = ? AND account_id = ? AND status IN ('active', 'paused')
             AND EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)`,
        )
        .bind(
          nextSessionStatus,
          input.nowIso,
          input.nowIso,
          input.floorSessionId,
          input.accountId,
          input.floorSessionId,
          input.snapshotVersion,
        ),
      this.database
        .prepare(
          `UPDATE runs SET status = ?, state_json = ?, updated_at = ?
           WHERE id = ? AND state_json = ?
             AND EXISTS (SELECT 1 FROM snapshots WHERE floor_session_id = ? AND version = ?)`,
        )
        .bind(
          nextRunStatus,
          canonicalStringify(input.nextRun),
          input.nowIso,
          input.runRow.id,
          input.runRow.state_json,
          input.floorSessionId,
          input.snapshotVersion,
        ),
    );
    return statements;
  }

  private async activeSessionId(accountId: string): Promise<string | null> {
    const row = await this.database
      .prepare(
        `SELECT id FROM floor_sessions
         WHERE account_id = ? AND status IN ('active', 'paused')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(accountId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  private insertJournalForEndStatement(input: {
    accountId: string;
    seasonId: string;
    kind: "fact" | "note";
    payload: unknown;
    runId: string;
    expectedRunStateJson: string;
    scopeId: string;
    idempotencyKey: string;
    nowIso: string;
  }): D1PreparedStatement {
    return this.database
      .prepare(
        `INSERT INTO journals (id, account_id, season_id, kind, payload_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND state_json = ?)
           AND EXISTS (SELECT 1 FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.accountId,
        input.seasonId,
        input.kind,
        canonicalStringify(input.payload),
        input.nowIso,
        input.runId,
        input.expectedRunStateJson,
        input.scopeId,
        input.idempotencyKey,
      );
  }

  private async replayedActionOutcome(
    floorSessionId: string,
    idempotencyKey: string,
    dead: boolean,
  ): Promise<"continued" | "died" | "collapsed"> {
    const outcomeRow = await this.database
      .prepare(
        "SELECT response_json FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?",
      )
      .bind(`action-outcome:${floorSessionId}`, idempotencyKey)
      .first<{ response_json: string }>();
    if (outcomeRow) {
      const parsed = parseJson<{ outcome?: unknown }>(outcomeRow.response_json);
      if (parsed.outcome === "died" || parsed.outcome === "collapsed") return parsed.outcome;
    }
    return dead ? "died" : "continued";
  }

  private async allowRateScope(
    scope: "request" | "active-floor-mutation",
    accountId: string,
    now: Date,
  ): Promise<boolean> {
    return new D1RateLimiter(this.database).allow(scope, accountId, now.getTime());
  }

  private async lookupReceipt(
    scopeId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ conflict: true } | { conflict: false; response: Record<string, unknown> } | null> {
    const receipt = await this.database
      .prepare(
        "SELECT request_hash, response_json FROM mutation_receipts WHERE scope_id = ? AND idempotency_key = ?",
      )
      .bind(scopeId, idempotencyKey)
      .first<ReceiptRow>();
    if (!receipt) return null;
    if (receipt.request_hash !== requestHash) return { conflict: true };
    return { conflict: false, response: parseJson<Record<string, unknown>>(receipt.response_json) };
  }

  private async accountId(touchCredential = true): Promise<string> {
    const token = bearerToken(this.authorization);
    if (!token) throw new McpAuthenticationError();
    const tokenHash = await credentialHash(token, this.credentialHashPepper);
    const nowIso = this.now().toISOString();
    const credential = await this.database
      .prepare(
        `SELECT account_id FROM credentials
         WHERE token_hash = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(tokenHash, nowIso)
      .first<CredentialRow>();
    if (!credential) throw new McpAuthenticationError();
    if (touchCredential)
      await this.database.batch([
        this.database
          .prepare(
            "UPDATE credentials SET last_used_at = ?, updated_at = ? WHERE id = (SELECT id FROM credentials WHERE token_hash = ? AND revoked_at IS NULL)",
          )
          .bind(nowIso, nowIso, tokenHash),
      ]);
    return credential.account_id;
  }

  private async isRankedEnrolled(accountId: string): Promise<boolean> {
    const row = await this.database
      .prepare("SELECT ranked_enrolled_at FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<AccountRow>();
    return Boolean(row?.ranked_enrolled_at);
  }

  private async hasOpenSession(accountId: string, mode: "ranked" | "practice"): Promise<boolean> {
    const row = await this.database
      .prepare(
        "SELECT id FROM floor_sessions WHERE account_id = ? AND mode = ? AND status IN ('active', 'paused') LIMIT 1",
      )
      .bind(accountId, mode)
      .first<{ id: string }>();
    return row !== null;
  }

  private async session(
    accountId: string,
    floorSessionId: string,
  ): Promise<SessionOwnerRow | null> {
    return this.database
      .prepare(
        `SELECT floor_sessions.status, floor_sessions.expires_at, floor_sessions.run_id,
                floor_sessions.mode, floor_sessions.floor
         FROM floor_sessions
         JOIN runs ON runs.id = floor_sessions.run_id
         WHERE floor_sessions.id = ? AND runs.account_id = ?`,
      )
      .bind(floorSessionId, accountId)
      .first<SessionOwnerRow>();
  }

  private loadRunById(runId: string, accountId: string): Promise<RunRow | null> {
    return this.database
      .prepare(
        "SELECT id, season_id, character_id, mode, status, state_json FROM runs WHERE id = ? AND account_id = ?",
      )
      .bind(runId, accountId)
      .first<RunRow>();
  }

  private activeSeason(): Promise<SeasonRow | null> {
    return this.database
      .prepare(
        `SELECT id, state, ruleset_version, generator_version, content_version,
                seed_commitment, revealed_seed, tower_json
         FROM seasons WHERE state = 'active' ORDER BY created_at DESC LIMIT 1`,
      )
      .first<SeasonRow>();
  }

  private async activeSeasonId(): Promise<string | null> {
    const season = await this.database
      .prepare("SELECT id FROM seasons WHERE state = 'active' ORDER BY created_at DESC LIMIT 1")
      .first<{ id: string }>();
    return season?.id ?? null;
  }
}

export class McpAuthenticationError extends Error {
  constructor() {
    super("Authentication required.");
  }
}

function sessionAvailability(
  session: SessionOwnerRow,
  nowIso: string,
): "open" | "SESSION_EXPIRED" | "SESSION_UNAVAILABLE" {
  if (session.status === "expired") return "SESSION_EXPIRED";
  if (session.status !== "active" && session.status !== "paused") return "SESSION_UNAVAILABLE";
  if (session.expires_at <= nowIso) return "SESSION_EXPIRED";
  return "open";
}

function isBossFloor(floorNumber: number, towerLength: number): boolean {
  return floorNumber === towerLength || floorNumber % 5 === 0;
}

function countBossesDefeated(completedFloors: number, towerLength: number): number {
  let count = 0;
  for (let floor = 1; floor <= completedFloors; floor += 1) {
    if (isBossFloor(floor, towerLength)) count += 1;
  }
  return count;
}

function bearerToken(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function readResult(data: Record<string, unknown>): Record<string, unknown> {
  return McpReadResultSchema.parse({ schemaVersion: MCP_READ_SCHEMA_VERSION, ...data });
}

function mutationResult(data: Record<string, unknown>): Record<string, unknown> {
  return McpMutationResultSchema.parse({ schemaVersion: MCP_MUTATION_SCHEMA_VERSION, ...data });
}

function replayOrConflict(
  receipt: { conflict: true } | { conflict: false; response: Record<string, unknown> },
): Record<string, unknown> {
  if (receipt.conflict) return mutationResult({ code: "IDEMPOTENCY_CONFLICT" });
  return mutationResult({ ...receipt.response, replayed: true });
}

function startRejectionCode(reason: string): string {
  switch (reason) {
    case "no-expedition-charge":
      return "NO_CHARGE";
    case "floor-already-active":
      return "SESSION_ACTIVE";
    case "character-dead":
      return "CHARACTER_DEAD";
    default:
      return "INVALID_FLOOR";
  }
}

function parseTower(towerJson: string | null | undefined): GeneratedFloor[] | null {
  if (!towerJson) return null;
  try {
    const parsed = JSON.parse(towerJson) as GeneratedFloor[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function characterView(row: CharacterRow): Record<string, unknown> {
  const state = JSON.parse(row.state_json) as Record<string, unknown>;
  return {
    id: row.id,
    sequence: row.sequence,
    status: row.status,
    ...(state.character && typeof state.character === "object"
      ? { character: state.character }
      : {}),
  };
}

function journalPayload(kind: string, value: string): Record<string, unknown> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  const fact = payload as Record<string, unknown>;
  if (kind === "fact" && fact.kind === "terrain" && Number.isSafeInteger(fact.floor))
    return {
      kind: "terrain",
      floor: fact.floor,
      tiles: Array.isArray(fact.tiles) ? fact.tiles.flatMap(rememberedTile) : [],
    };
  if (kind === "fact" && fact.kind === "enemy" && Number.isSafeInteger(fact.floor))
    return {
      kind: "enemy",
      floor: fact.floor,
      enemyIds: Array.isArray(fact.enemyIds) ? fact.enemyIds.filter(isString) : [],
    };
  if (
    kind === "fact" &&
    fact.kind === "death" &&
    Number.isSafeInteger(fact.floor) &&
    typeof fact.cause === "string"
  )
    return { kind: "death", floor: fact.floor, cause: fact.cause };
  if (kind === "note" && Number.isSafeInteger(fact.floor) && typeof fact.text === "string")
    return { floor: fact.floor, text: fact.text.slice(0, 500) };
  return null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function rememberedTile(value: unknown): Array<Record<string, unknown>> {
  if (value === null || typeof value !== "object") return [];
  const tile = value as Record<string, unknown>;
  if (
    tile.position === null ||
    typeof tile.position !== "object" ||
    !isTerrain(tile.terrain) ||
    (tile.door !== undefined && tile.door !== "open" && tile.door !== "closed")
  )
    return [];
  const position = tile.position as Record<string, unknown>;
  if (!Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) return [];
  return [
    {
      position: { x: position.x, y: position.y },
      terrain: tile.terrain,
      ...(tile.door ? { door: tile.door } : {}),
    },
  ];
}

function isTerrain(
  value: unknown,
): value is "floor" | "wall" | "entrance" | "objective" | "exit" | "secret" {
  return ["floor", "wall", "entrance", "objective", "exit", "secret"].includes(value as string);
}

function compactObservation(
  observation: ReturnType<typeof observe>,
  includeTiles = false,
): Record<string, unknown> {
  if (includeTiles) return observation as unknown as Record<string, unknown>;
  const { tiles: _tiles, ...compact } = observation;
  return compact as unknown as Record<string, unknown>;
}
