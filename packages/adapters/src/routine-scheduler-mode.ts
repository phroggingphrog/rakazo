import type { Prisma } from "@rakazo/db";
import { runAsSystemInTransaction } from "@rakazo/db";

export async function routineSchedulerMode(tx: Prisma.TransactionClient): Promise<boolean> {
  const gate = await runAsSystemInTransaction(
    tx,
    "check routine scheduler mode",
    () =>
      tx.$queryRaw<Array<{ enabled: boolean }>>`
      SELECT enabled FROM routine_schedule_gate WHERE id FOR SHARE`,
  );
  if (gate.length !== 1) throw new Error("Routine scheduling gate is unavailable");
  await tx.$queryRaw`SELECT set_config('app.scheduler_protocol', '2', true)`;
  return gate[0]!.enabled;
}
