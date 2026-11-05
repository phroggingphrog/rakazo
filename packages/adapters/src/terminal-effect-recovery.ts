import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

/** Mark claimed calls whose run has ended as unknown, without replacing their evidence. */
export async function reconcileTerminalMcpEffects(
  prisma: PrismaClient,
  batchSize = 100,
): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
    throw new Error("Invalid terminal effect recovery batch size");
  const recovered = await runAsSystem("reconcile terminal external effects", () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      return tx.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS MATERIALIZED (
        SELECT e.id, e."dispatchClaimToken" AS token, e."dispatchClaimFence" AS fence
        FROM runs r
        JOIN external_effects e ON e."runId" = r.id AND e."spaceId" = r."spaceId"
        WHERE r.status IN ('completed', 'failed', 'cancelled')
          AND e.status = 'executing'
          AND e."dispatchClaimToken" IS NOT NULL
          AND e."dispatchClaimFence" IS NOT NULL
        ORDER BY e."updatedAt", e.id
        LIMIT ${batchSize}
        FOR UPDATE OF r, e SKIP LOCKED
      )
      UPDATE external_effects e
      SET status = 'uncertain', "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      FROM candidates c
      WHERE e.id = c.id AND e.status = 'executing'
        AND e."dispatchClaimToken" = c.token AND e."dispatchClaimFence" = c.fence
      RETURNING e.id`;
    }),
  );
  return recovered.length;
}
