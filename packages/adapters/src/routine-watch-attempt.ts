import type { Prisma, PrismaClient } from "@rakazo/db";
import { runAsSystemInTransaction } from "@rakazo/db";

export type RoutineWatchClaim = "claimed" | "uncertain" | "stale" | "disabled";

export const ROUTINE_WATCH_UNCERTAIN_MESSAGE =
  "A change check may still be running or its outcome is unknown. The routine was not changed.";

/** PostgreSQL's error is wrapped by Prisma's driver adapter on model writes. */
export function isRoutineWatchUncertainError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { code?: unknown; originalCode?: unknown } } };
  };
  const cause = value.meta?.driverAdapterError?.cause;
  return value.code === "P4770" || cause?.code === "P4770" || cause?.originalCode === "P4770";
}

/**
 * A successful claim means
 * the external effect may have started, even if the worker dies immediately.
 * Never use the absence of a result as evidence that it is safe to replay.
 */
export async function claimRoutineWatchAttempt(
  prisma: PrismaClient,
  input: { routineId: string; generation: string; scheduledFor: Date },
): Promise<RoutineWatchClaim> {
  if (
    !/^[1-9][0-9]{0,18}$/.test(input.generation) ||
    BigInt(input.generation) > 9_223_372_036_854_775_807n ||
    !Number.isFinite(input.scheduledFor.getTime())
  ) {
    throw new Error("Invalid routine watch attempt");
  }
  return prisma.$transaction(async (tx) => {
    const gate = await runAsSystemInTransaction(
      tx,
      "lock the routine scheduling gate",
      () =>
        tx.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT enabled FROM routine_schedule_gate WHERE id FOR SHARE`,
    );
    if (!gate[0]) throw new Error("Routine scheduling gate is unavailable");
    if (!gate[0].enabled) return "disabled";

    // This query stays in the caller's tenant context. A concurrent schedule
    // mutation must wait for the claim transaction before advancing generation.
    const routine = await tx.$queryRaw<Array<{ matches: boolean }>>`
      SELECT ("scheduleGeneration" = ${input.generation}::bigint
        AND active AND watch IS NOT NULL
        AND "nextRunAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 second'
        AND "nextRunAt" = (${input.scheduledFor}::timestamptz AT TIME ZONE 'UTC')) AS matches
      FROM routines WHERE id = ${input.routineId}
        AND "spaceId" = current_setting('app.space_id', true)
        AND "userId" = current_setting('app.user_id', true) FOR UPDATE`;
    if (!routine.length) return "stale";
    const existing = await runAsSystemInTransaction(
      tx,
      "inspect a routine watch attempt",
      () =>
        tx.$queryRaw<Array<{ state: string }>>`
        SELECT state FROM routine_watch_attempts
        WHERE "routineId" = ${input.routineId} AND generation = ${input.generation}::bigint`,
    );
    if (existing.length) return existing[0]?.state === "completed" ? "stale" : "uncertain";
    if (!routine[0]?.matches) return "stale";
    const inserted = await runAsSystemInTransaction(
      tx,
      "record an uncertain routine watch",
      () =>
        tx.$queryRaw<Array<{ routineId: string }>>`
        INSERT INTO routine_watch_attempts ("routineId", generation, "scheduledFor")
        VALUES (${input.routineId}, ${input.generation}::bigint,
                ${input.scheduledFor}::timestamptz AT TIME ZONE 'UTC')
        ON CONFLICT ("routineId", generation) DO NOTHING RETURNING "routineId"`,
    );
    return inserted.length ? "claimed" : "uncertain";
  });
}

/** Complete only alongside the resulting schedule update in the same transaction. */
export async function completeRoutineWatchAttempt(
  tx: Prisma.TransactionClient,
  input: { routineId: string; generation: string; scheduledFor: Date },
): Promise<void> {
  const gate = await runAsSystemInTransaction(
    tx,
    "lock the routine scheduling gate",
    () =>
      tx.$queryRaw<Array<{ enabled: boolean }>>`
      SELECT enabled FROM routine_schedule_gate WHERE id FOR SHARE`,
  );
  if (!gate[0]?.enabled) throw new Error("Routine watch is awaiting scheduler cutover");
  const routine = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM routines WHERE id = ${input.routineId}
      AND "spaceId" = current_setting('app.space_id', true)
      AND "userId" = current_setting('app.user_id', true)
      AND "scheduleGeneration" = ${input.generation}::bigint
      AND active AND watch IS NOT NULL
      AND "nextRunAt" = (${input.scheduledFor}::timestamptz AT TIME ZONE 'UTC') FOR UPDATE`;
  if (!routine.length) throw new Error("Routine watch changed before completion");
  const completed = await runAsSystemInTransaction(
    tx,
    "complete a routine watch attempt",
    () =>
      tx.$queryRaw<Array<{ routineId: string }>>`
      UPDATE routine_watch_attempts SET state = 'completed'
      WHERE "routineId" = ${input.routineId} AND generation = ${input.generation}::bigint
        AND state = 'uncertain' RETURNING "routineId"`,
  );
  if (completed.length !== 1) throw new Error("Routine watch attempt is unavailable");
  await tx.$queryRaw`SELECT set_config('app.scheduler_protocol', '2', true)`;
}
