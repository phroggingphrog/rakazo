import type { PrismaClient } from "@rakazo/db";
import { contentEncryptionOf, currentDbContext, IsolationError } from "@rakazo/db";

type RunIdentity = {
  id: string;
  spaceId: string;
  userId: string;
  taskId: string;
  botId: string;
  threadId: string;
};
type TaskPrompt = { id: string; protected: boolean; prompt: string };

/** Protected prompts cannot enter the executor until its downstream sinks are fenced. */
export async function prepareRunTaskForExecution<T extends TaskPrompt>(
  _prisma: PrismaClient,
  _run: RunIdentity,
  task: T,
  _workerId: string,
  _fence: number,
): Promise<T> {
  if (!task.protected) return task;
  throw new Error("Protected test execution is not enabled.");
}

/** Resolves protected text in memory only while the bound v2 Run owns a live lease. */
export async function resolveRunTaskPrompt(
  prisma: PrismaClient,
  run: RunIdentity,
  task: TaskPrompt,
  workerId: string,
  fence: number,
): Promise<string> {
  if (!task.protected) return task.prompt;
  const context = currentDbContext();
  if (
    context?.kind !== "tenant" ||
    context.spaceId !== run.spaceId ||
    context.userId !== run.userId
  )
    throw new IsolationError();
  if (!contentEncryptionOf(prisma)?.ring.encryptWrites || task.id !== run.taskId)
    throw new Error("Protected test execution is unavailable.");
  return prisma.$transaction(async (tx) => {
    const bound = await tx.$queryRaw<Array<{ attemptId: string }>>`
      SELECT a.id AS "attemptId" FROM runs r
      JOIN protected_setup_v2_claims c ON c."runId" = r.id AND c.protocol = 2
      JOIN setup_test_attempts a ON a.id = c."attemptId" AND a."taskId" = r."taskId"
      JOIN tasks t ON t.id = r."taskId" AND t."protected" = true
      JOIN protected_setup_v2_gate g ON g.id AND g.enabled
      WHERE r.id = ${run.id} AND r."spaceId" = ${run.spaceId} AND r."userId" = ${run.userId}
        AND r."taskId" = ${run.taskId} AND r."botId" = ${run.botId} AND r."threadId" = ${run.threadId}
        AND r."taskProtected" = true AND r.trigger = 'protected_setup_v2'
        AND r.status = 'running' AND r."leaseOwner" = ${workerId} AND r."leaseFence" = ${fence}
        AND r."leaseExpiresAt" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        AND c."spaceId" = r."spaceId" AND c."userId" = r."userId"
        AND a."spaceId" = r."spaceId" AND a."userId" = r."userId" AND a.status = 'prepared'
        AND t."spaceId" = r."spaceId" AND t."userId" = r."userId"
        AND t."botId" = r."botId" AND t."threadId" = r."threadId"
      FOR SHARE OF r, c, a, t, g`;
    if (!bound.length) throw new Error("Protected test execution is unavailable.");
    const content = await tx.protectedExecutionContent.findFirst({
      where: { taskId: run.taskId, spaceId: run.spaceId, userId: run.userId, protected: true },
      select: { text: true },
    });
    if (!content?.text) throw new Error("Protected test execution is unavailable.");
    return content.text;
  });
}
