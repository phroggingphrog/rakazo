import { runAsSystem } from "@rakazo/db";
import { wrapJobPayload } from "@rakazo/logging";
import type { Pool, PoolClient } from "pg";

/**
 * The distinct task name prevents an older worker, which cannot check
 * generations, from claiming a versioned wake. Publication is gated off until
 * legacy workers and jobs are drained and the cutover protocol is complete.
 */
const VERSIONED_WAKE_TASK = "routine.wakeup.v2";
const VERSIONED_KEY_PREFIX = "routine:v2:";

/**
 * This guards new admissions only. Every in-flight v1 handler, including those
 * on new workers, must be drained before enabling the gate.
 */
export async function assertLegacyRoutineWakeAllowed(pool: Pool): Promise<void> {
  await runAsSystem("check the routine scheduling cutover gate", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
      const gate = await client.query<{ enabled: boolean }>(
        'SELECT "enabled" FROM "routine_schedule_gate" WHERE "id" FOR SHARE',
      );
      if (!gate.rows[0]) throw new Error("Routine scheduling gate is unavailable");
      if (gate.rows[0].enabled) throw new Error("Legacy routine wakes require cutover recovery");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

type ScheduleIntent = {
  routineId: string;
  generation: string;
  active: boolean;
  nextRunAt: Date | null;
  operation: "upsert" | "delete";
};

/**
 * Publish one durable intent and acknowledge it in the same database
 * transaction, using the same connection for Graphile and the row lock. This
 * avoids a nested checkout from the shared bounded pool. A cancelled, deleted
 * or re-armed row waits for the publish transaction and leaves a newer pending
 * generation. Tombstones are deliberately retained until safe cleanup exists.
 *
 * The caller must initialize the Graphile schema and grant its functions to
 * the database role before using this function. The durable worker reconciler
 * calls it, but it does not publish while the scheduler gate is off.
 */
export async function publishRoutineScheduleIntent(pool: Pool): Promise<boolean> {
  return runAsSystem("publish a durable routine schedule intent", () => publishNext(pool));
}

/** Bound each recovery pass so it cannot monopolize the shared pool. */
export async function publishRoutineScheduleIntents(pool: Pool): Promise<void> {
  for (let count = 0; count < 20; count += 1) {
    if (!(await publishRoutineScheduleIntent(pool))) break;
  }
}

async function publishNext(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
    const gate = await client.query<{ enabled: boolean }>(
      'SELECT "enabled" FROM "routine_schedule_gate" WHERE "id" FOR SHARE',
    );
    if (!gate.rows[0]) throw new Error("Routine scheduling gate is unavailable");
    if (!gate.rows[0].enabled) {
      await client.query("COMMIT");
      return false;
    }
    const pending = await client.query<ScheduleIntent>(
      `SELECT "routineId", "generation", "active", "nextRunAt" AT TIME ZONE 'UTC' AS "nextRunAt", "operation"
       FROM "routine_schedule_outbox" WHERE "publishedGeneration" < "generation"
       ORDER BY "updatedAt", "routineId" FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const intent = pending.rows[0];
    if (!intent) {
      await client.query("COMMIT");
      return false;
    }
    await publishOnConnection(client, intent);
    await client.query(
      'UPDATE "routine_schedule_outbox" SET "publishedGeneration" = $2 WHERE "routineId" = $1 AND "generation" = $2',
      [intent.routineId, intent.generation],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function publishOnConnection(client: PoolClient, intent: ScheduleIntent): Promise<void> {
  const key = `${VERSIONED_KEY_PREFIX}${intent.routineId}`;
  if (intent.operation === "delete" || !intent.active || !intent.nextRunAt) {
    await client.query("SELECT graphile_worker.remove_job($1::text)", [key]);
    return;
  }
  const payload = wrapJobPayload({
    routineId: intent.routineId,
    scheduledFor: intent.nextRunAt.toISOString(),
    generation: intent.generation,
  });
  await client.query(
    `SELECT graphile_worker.add_job(identifier := $1::text, payload := $2::json,
      run_at := $3::timestamptz, job_key := $4::text)`,
    [VERSIONED_WAKE_TASK, JSON.stringify(payload), intent.nextRunAt, key],
  );
}
