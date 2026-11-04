import { mcpConnectedPrompt, QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { availableInSpace, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

export type McpContinuationCursor = { createdAt: Date; id: string };

/** Drain a bounded page. Busy rows are revisited after the cursor wraps. */
export async function reconcileMcpApprovalContinuations(
  prisma: PrismaClient,
  batchSize: number,
  cursor?: McpContinuationCursor,
  enabled = true,
): Promise<McpContinuationCursor | undefined> {
  if (!enabled) return cursor;
  const intents = await prisma.mcpApprovalContinuation.findMany({
    where: {
      status: "pending",
      ...(cursor
        ? {
            OR: [
              { createdAt: { gt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: { id: true, threadId: true, createdAt: true },
  });
  for (const intent of intents) {
    try {
      await withTransactionRetry(() =>
        prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${intent.threadId} FOR UPDATE`;
            const pending = await tx.mcpApprovalContinuation.findUnique({
              where: { id: intent.id },
            });
            if (pending?.status !== "pending") return;
            const first = await tx.mcpApprovalContinuation.findFirst({
              where: { threadId: pending.threadId, botId: pending.botId, status: "pending" },
              // Legacy zero-sequence intents precede sequenced approvals; their own
              // original order is unavailable, so use creation time then ID.
              orderBy: [{ decisionSeq: "asc" }, { createdAt: "asc" }, { id: "asc" }],
              select: { id: true },
            });
            if (first?.id !== pending.id) return;
            const [thread, bot, server, assignment, message, busy] = await Promise.all([
              tx.thread.findFirst({
                where: {
                  id: pending.threadId,
                  spaceId: pending.spaceId,
                  userId: pending.userId,
                  OR: [
                    { botId: pending.botId },
                    { group: { archivedAt: null, members: { some: { botId: pending.botId } } } },
                  ],
                },
                select: { id: true, botId: true },
              }),
              tx.bot.findFirst({
                where: {
                  id: pending.botId,
                  spaceId: pending.spaceId,
                  userId: pending.userId,
                  archivedAt: null,
                },
                select: { id: true },
              }),
              tx.mcpServer.findFirst({
                where: { id: pending.serverId, ...availableInSpace(pending) },
                select: { name: true, allBots: true, enabled: true },
              }),
              tx.botMcpServer.findFirst({
                where: {
                  botId: pending.botId,
                  serverId: pending.serverId,
                  spaceId: pending.spaceId,
                  userId: pending.userId,
                },
                select: { allowAllTools: true },
              }),
              tx.message.findFirst({
                where: {
                  id: pending.messageId,
                  threadId: pending.threadId,
                  OR: [{ botId: pending.botId }, { botId: null }],
                },
                select: { blocks: true, botId: true },
              }),
              tx.run.findFirst({
                where: {
                  threadId: pending.threadId,
                  botId: pending.botId,
                  status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
                },
                select: { id: true },
              }),
            ]);
            const card =
              Array.isArray(message?.blocks) &&
              message.blocks.some(
                (block) =>
                  typeof block === "object" &&
                  block !== null &&
                  !Array.isArray(block) &&
                  block.kind === "mcp_approval" &&
                  block.serverId === pending.serverId &&
                  block.status === "connected",
              );
            if (
              !thread ||
              !bot ||
              !server ||
              (!assignment && !server.allBots) ||
              !card ||
              (message?.botId === null && thread.botId !== pending.botId)
            ) {
              await tx.mcpApprovalContinuation.updateMany({
                where: { id: pending.id, status: "pending" },
                data: { status: "cancelled", cancelledAt: new Date() },
              });
              return;
            }
            if (!server.enabled || busy) return;
            const task = await tx.task.create({
              data: {
                spaceId: pending.spaceId,
                userId: pending.userId,
                threadId: pending.threadId,
                botId: pending.botId,
                prompt: mcpConnectedPrompt(server.name, {
                  assignmentOnly: pending.assignmentOnly,
                  allowAllTools: assignment?.allowAllTools,
                }),
                status: "queued",
              },
            });
            const run = await tx.run.create({
              data: {
                spaceId: pending.spaceId,
                userId: pending.userId,
                threadId: pending.threadId,
                botId: pending.botId,
                taskId: task.id,
                trigger: "user",
                status: "queued",
              },
              select: { id: true },
            });
            await tx.mcpApprovalContinuation.update({
              where: { id: pending.id },
              data: { status: "materialized", materializedAt: new Date(), runId: run.id },
            });
          },
          { isolationLevel: "Serializable" },
        ),
      );
    } catch (error) {
      getLogger().error("MCP approval continuation reconciliation", error);
    }
  }
  return intents.length === batchSize ? intents.at(-1) : undefined;
}
