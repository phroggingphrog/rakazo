import type { Prisma, PrismaClient } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { currentDbContext } from "./row-security.js";
import { IsolationError } from "./scope.js";

export const PROTECTED_TASK_PLACEHOLDER = "Protected task; execution is unavailable.";

/** Creates a non-runnable draft. The database rejects linking it to a run. */
export async function createProtectedTaskDraft(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string },
  input: { botId: string; threadId: string; prompt: string },
): Promise<{ id: string }> {
  const encryption = contentEncryptionOf(prisma);
  if (!encryption?.ring.encryptWrites)
    throw new Error("Content encryption is required for protected tasks.");
  return prisma.$transaction((tx) =>
    createProtectedTaskDraftInTransaction(tx, owner, input, encryption.ring.encryptWrites),
  );
}

/** Caller owns the transaction and must pass the active client's encryption setting. */
export async function createProtectedTaskDraftInTransaction(
  tx: Prisma.TransactionClient,
  owner: { spaceId: string; userId: string },
  input: { botId: string; threadId: string; prompt: string },
  encryptWrites: boolean,
): Promise<{ id: string }> {
  const context = currentDbContext();
  if (
    context?.kind !== "tenant" ||
    context.spaceId !== owner.spaceId ||
    context.userId !== owner.userId
  )
    throw new IsolationError();
  if (!encryptWrites) throw new Error("Content encryption is required for protected tasks.");
  if (!input.prompt.trim() || input.prompt.length > 2000)
    throw new Error("Protected task prompt must contain 1 to 2000 characters.");
  const [bot, thread] = await Promise.all([
    tx.bot.findFirst({
      where: { id: input.botId, ...owner, archivedAt: null },
      select: { id: true },
    }),
    tx.thread.findFirst({
      where: { id: input.threadId, ...owner, botId: input.botId },
      select: { id: true },
    }),
  ]);
  if (!bot || !thread) throw new IsolationError();
  const task = await tx.task.create({
    data: {
      ...owner,
      botId: bot.id,
      threadId: thread.id,
      prompt: PROTECTED_TASK_PLACEHOLDER,
      protected: true,
      status: "draft",
    },
    select: { id: true },
  });
  await tx.protectedExecutionContent.create({
    data: { ...owner, taskId: task.id, text: input.prompt },
  });
  return task;
}
