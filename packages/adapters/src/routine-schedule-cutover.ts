import { currentDbContext, runAsSystem } from "@rakazo/db";
import type { Pool } from "pg";

const MAX_GENERATION = 9_223_372_036_854_775_807n;
const MAX_BATCH = 200;

export type RoutineBootstrapCandidate = {
  routineId: string;
  generation: bigint;
  priorIntentGeneration: bigint | null;
  active: boolean;
  nextRunAt: Date | null;
  hasWatch: boolean;
};

/**
 * Builds proposed non-watch intents only. It does not authorize or perform a
 * cutover: gate-off writers do not advance generation, so these values are
 * unsafe to apply without a separately enforced fleet-wide drain barrier.
 */
export function planRoutineScheduleBootstrap(candidates: readonly RoutineBootstrapCandidate[]) {
  if (candidates.length > MAX_BATCH) throw new Error("Routine bootstrap batch is too large");
  const seen = new Set<string>();
  return candidates.map((row) => {
    if (!row.routineId || seen.has(row.routineId))
      throw new Error("Invalid routine bootstrap batch");
    seen.add(row.routineId);
    if (row.hasWatch) throw new Error("Watch routines require a supported cutover path");
    const prior = row.priorIntentGeneration ?? 0n;
    if (row.generation < 0n || prior < 0n) throw new Error("Invalid routine schedule generation");
    const generation = row.generation > prior ? row.generation : prior;
    if (generation >= MAX_GENERATION) throw new Error("Routine schedule generation exhausted");
    if (row.nextRunAt && !Number.isFinite(row.nextRunAt.getTime())) {
      throw new Error("Invalid routine schedule time");
    }
    return {
      routineId: row.routineId,
      generation: generation + 1n,
      active: row.active,
      nextRunAt: row.nextRunAt ? new Date(row.nextRunAt.getTime()) : null,
      operation: "upsert" as const,
    };
  });
}

type CountRow = { count: string };

function observedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid routine cutover inventory");
  return value;
}

function sampleCount(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid routine cutover inventory");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > MAX_BATCH) {
    throw new Error("Invalid routine cutover inventory");
  }
  return count;
}

/** Counts are capped, point-in-time observations; they never prove a drain. */
export async function inspectRoutineScheduleCutover(pool: Pool) {
  if (currentDbContext()?.kind !== "system") {
    throw new Error("Routine scheduler inventory requires a system context");
  }
  return runAsSystem("inspect routine scheduler cutover blockers", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '3s'");
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
      const gate = await client.query<{ enabled: boolean; unsettledLegacyWakes: boolean }>(
        'SELECT enabled, ("legacyOutstanding" > 0) AS "unsettledLegacyWakes" FROM routine_schedule_gate WHERE id',
      );
      if (!gate.rows[0]) throw new Error("Routine scheduling gate is unavailable");
      const watches = await client.query<CountRow>(
        "SELECT count(*)::text AS count FROM (SELECT 1 FROM routines WHERE watch IS NOT NULL LIMIT $1) AS sample",
        [MAX_BATCH],
      );
      const uncertain = await client.query<CountRow>(
        `SELECT count(*)::text AS count FROM (SELECT 1 FROM routine_watch_attempts
         WHERE state = 'uncertain' LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const legacy = await client.query<{ queued: string; locked: string }>(
        `SELECT count(*) FILTER (WHERE locked_at IS NULL)::text AS queued,
                count(*) FILTER (WHERE locked_at IS NOT NULL)::text AS locked
         FROM (SELECT locked_at FROM graphile_worker.jobs
               WHERE task_identifier = 'routine.wakeup' LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const tombstones = await client.query<CountRow>(
        `SELECT count(*)::text AS count FROM (SELECT 1 FROM routine_schedule_outbox
         WHERE operation = 'delete' LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const acknowledgedTombstones = await client.query<CountRow>(
        `SELECT count(*)::text AS count FROM (SELECT 1 FROM routine_schedule_outbox
         WHERE operation = 'delete' AND "publishedGeneration" >= generation LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const pendingIntents = await client.query<CountRow>(
        `SELECT count(*)::text AS count FROM (SELECT 1 FROM routine_schedule_outbox
         WHERE "publishedGeneration" < generation LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const orphanedUpserts = await client.query<CountRow>(
        `SELECT count(*)::text AS count FROM (SELECT 1 FROM routine_schedule_outbox AS intent
         WHERE intent.operation = 'upsert' AND NOT EXISTS
           (SELECT 1 FROM routines WHERE id = intent."routineId") LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const versioned = await client.query<{ queued: string; locked: string }>(
        `SELECT count(*) FILTER (WHERE locked_at IS NULL)::text AS queued,
                count(*) FILTER (WHERE locked_at IS NOT NULL)::text AS locked
         FROM (SELECT locked_at FROM graphile_worker.jobs
               WHERE task_identifier = 'routine.wakeup.v2' LIMIT $1) AS sample`,
        [MAX_BATCH],
      );
      const locks = await client.query<{ legacy: boolean; versioned: boolean }>(
        `SELECT
          EXISTS (SELECT 1 FROM graphile_worker.jobs WHERE task_identifier = 'routine.wakeup'
            AND locked_at IS NOT NULL LIMIT 1) AS legacy,
          EXISTS (SELECT 1 FROM graphile_worker.jobs WHERE task_identifier = 'routine.wakeup.v2'
            AND locked_at IS NOT NULL LIMIT 1) AS versioned`,
      );
      const inventory = {
        gateEnabled: gate.rows[0].enabled,
        unsettledBridgeLegacyWakes: observedBoolean(gate.rows[0].unsettledLegacyWakes),
        countLimit: MAX_BATCH,
        watchRoutines: sampleCount(watches.rows[0]?.count),
        uncertainWatchAttempts: sampleCount(uncertain.rows[0]?.count),
        queuedLegacyJobs: sampleCount(legacy.rows[0]?.queued),
        lockedLegacyJobs: sampleCount(legacy.rows[0]?.locked),
        tombstones: sampleCount(tombstones.rows[0]?.count),
        acknowledgedTombstones: sampleCount(acknowledgedTombstones.rows[0]?.count),
        pendingIntents: sampleCount(pendingIntents.rows[0]?.count),
        orphanedUpserts: sampleCount(orphanedUpserts.rows[0]?.count),
        unlockedVersionedJobs: sampleCount(versioned.rows[0]?.queued),
        lockedVersionedJobs: sampleCount(versioned.rows[0]?.locked),
        anyLockedLegacyJob: observedBoolean(locks.rows[0]?.legacy),
        anyLockedVersionedJob: observedBoolean(locks.rows[0]?.versioned),
        // An empty queue is not evidence that all existing workers have drained.
        allLegacyWorkersDrained: "unverified" as const,
        allVersionedWorkersDrained: "unverified" as const,
        rollbackAvailable: false as const,
        tombstoneCleanupAvailable: false as const,
        bootstrapAvailable: false as const,
      };
      await client.query("COMMIT");
      return inventory;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

/** One snapshot of durable job locks; it does not prove that worker admission has stopped. */
export async function checkRoutineJobLockSettlement(pool: Pool) {
  const inventory = await inspectRoutineScheduleCutover(pool);
  return {
    gateEnabled: inventory.gateEnabled,
    noLockedRoutineJobsObserved: !inventory.anyLockedLegacyJob && !inventory.anyLockedVersionedJob,
    admissionStopped: "unverified" as const,
    allWorkersDrained: "unverified" as const,
  };
}
