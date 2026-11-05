import { randomUUID } from "node:crypto";
import { runAsSystem } from "@rakazo/db";
import type { Pool } from "pg";

async function admissionQuery(pool: Pool, sql: string, values: string[]): Promise<void> {
  await runAsSystem("account for a legacy routine wake", async () => {
    const client = await pool.connect();
    try {
      await client.query(sql, values);
    } finally {
      client.release();
    }
  });
}

/** Accounts for bridge-aware Graphile wakes only, not old binaries or memory queues. */
export async function runLegacyRoutineWake<T>(
  pool: Pool,
  routineId: string,
  scheduledFor: string,
  run: () => Promise<T>,
): Promise<T> {
  const scheduledAt = new Date(scheduledFor);
  if (!Number.isFinite(scheduledAt.getTime())) throw new Error("Invalid legacy routine wake time");
  const admissionId = randomUUID();
  await admissionQuery(pool, "SELECT routine_legacy_wake_begin($1, $2, $3::timestamptz)", [
    admissionId,
    routineId,
    scheduledAt.toISOString(),
  ]);
  // The admission survives handler failure, process death, and connection loss.
  // No database connection is held while the handler uses providers or computers.
  const result = await run();
  await admissionQuery(pool, "SELECT routine_legacy_wake_finish($1)", [admissionId]);
  return result;
}
