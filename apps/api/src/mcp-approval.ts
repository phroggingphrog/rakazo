import { ORPCError } from "@orpc/server";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { mcpConnectedPrompt, QUEUE_HOLDING_RUN_STATUSES } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  availableInSpace,
  IsolationError,
  withTransactionRetry,
} from "@rakazo/db";
import { requireBotThread } from "./bot-thread.js";

export type McpApprovalDeps = {
  prisma: PrismaClient;
  events: ThreadEvents;
};

export type McpApprovalResolution = {
  botId: string;
  serverId: string;
  status: "connected" | "dismissed";
  /** The chat whose cards should resolve; defaults to the bot's own thread. */
  threadId?: string;
  messageId?: string;
};

export type McpApprovalDecision = {
  /** Whether this decision may create the bot's assignment. */
  assign: boolean;
  /** Whether it closed an open card, rather than repeating a decision. */
  resolved: boolean;
  /** At least one resolved card describes an assignment to an existing integration. */
  assignmentOnly?: true;
  /** An unambiguous newly resolved card in this chat, when one exists. */
  messageId?: string;
  decisionSeq?: number;
};

export type ThreadSeq = {
  threadId: string;
  seq: number;
};

type ApprovalBlock = Extract<MessageBlock, { kind: "mcp_approval" }>;

function isApproval(block: MessageBlock, serverId: string): block is ApprovalBlock {
  return block.kind === "mcp_approval" && block.serverId === serverId;
}

function isOpen(block: ApprovalBlock): boolean {
  return block.status !== "connected" && block.status !== "dismissed";
}

async function threadsForDecision(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
): Promise<ApprovalThread[]> {
  if (!input.threadId) return threadsForBot(deps.prisma, actor, input.botId);
  const member = await deps.prisma.thread.findMany({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [{ botId: input.botId }, { group: { members: { some: { botId: input.botId } } } }],
    },
    select: { id: true, botId: true },
  });
  if (member.length > 0) return member;
  // A bot removed from a group leaves its card behind. The bot still has to
  // belong to this actor; the fallback never opens another bot's direct chat.
  try {
    await requireBotThread(deps, actor, input.botId);
  } catch (error) {
    if (error instanceof IsolationError) return [];
    throw error;
  }
  return deps.prisma.thread.findMany({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: { not: null },
    },
    select: { id: true, botId: true },
  });
}

type ApprovalThread = { id: string; botId: string | null };

async function threadsForBot(
  db: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
  botId: string,
): Promise<ApprovalThread[]> {
  return db.thread.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [{ botId }, { groupId: { not: null }, messages: { some: { botId } } }],
    },
    select: { id: true, botId: true },
  });
}

async function rewriteCards(
  tx: Prisma.TransactionClient,
  actor: Actor,
  threads: ApprovalThread[],
  input: { botId?: string; serverId: string; status: ApprovalBlock["status"]; messageId?: string },
  selectable: (block: ApprovalBlock) => boolean,
  allowedMessageIds?: Set<string>,
): Promise<{
  seqs: ThreadSeq[];
  flipped: number;
  dismissed: boolean;
  connected: boolean;
  assignmentOnly: boolean;
  messageId?: string;
  decisionSeq?: number;
}> {
  const seqs: ThreadSeq[] = [];
  let flipped = 0;
  let dismissed = false;
  let connected = false;
  let assignmentOnly = false;
  let messageId: string | undefined;
  let decisionSeq: number | undefined;
  for (const thread of threads) {
    const messages = await tx.message.findMany({
      where: {
        threadId: thread.id,
        ...(allowedMessageIds ? { id: { in: [...allowedMessageIds] } } : {}),
      },
      select: { id: true, botId: true, blocks: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(allowedMessageIds ? {} : { take: 100 }),
    });
    for (const message of messages) {
      if (allowedMessageIds && !allowedMessageIds.has(message.id)) continue;
      if (message.botId && message.botId !== input.botId) continue;
      const blocks = message.blocks as MessageBlock[];
      const matching = blocks.filter((block): block is ApprovalBlock =>
        isApproval(block, input.serverId),
      );
      if (matching.length === 0) continue;
      for (const block of matching) {
        if (block.status === "dismissed") dismissed = true;
        else if (block.status === "connected") connected = true;
      }
      if (!matching.some(selectable)) continue;
      const useForContinuation =
        !messageId &&
        (!input.messageId || input.messageId === message.id) &&
        (message.botId === input.botId || (!message.botId && thread.botId === input.botId));
      if (matching.some((block) => selectable(block) && block.assignmentOnly === true))
        assignmentOnly = true;
      const next = blocks.map((block) =>
        isApproval(block, input.serverId) && selectable(block)
          ? { ...block, status: input.status }
          : block,
      );
      await tx.message.update({ where: { id: message.id }, data: { blocks: next } });
      flipped += 1;
      const eventBotId = message.botId ?? thread.botId ?? input.botId;
      if (!eventBotId) continue;
      const event = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: thread.id,
        botId: eventBotId,
        type: "thread.message.updated",
        payload: { messageId: message.id, role: "bot", blocks: next },
      });
      seqs.push({ threadId: thread.id, seq: event.seq });
      if (useForContinuation) {
        messageId = message.id;
        decisionSeq = event.seq;
      }
    }
  }
  return { seqs, flipped, dismissed, connected, assignmentOnly, messageId, decisionSeq };
}

/** Flip every open mcp_approval card for this server. The read, the writes,
    and `effect` share one serializable transaction. A card decision (one that
    passes threadId) sees `assign: false` when a dismissal already won, so that
    race does not create an assignment. Settings approval omits threadId and
    still assigns. */
export async function resolveMcpApprovalCards<T>(
  deps: McpApprovalDeps,
  actor: Actor,
  input: McpApprovalResolution,
  effect?: (tx: Prisma.TransactionClient, decision: McpApprovalDecision) => Promise<T>,
): Promise<T | undefined> {
  if (input.messageId && !input.threadId)
    throw new ORPCError("BAD_REQUEST", { message: "A conversation is required for this card." });
  const threads = await threadsForDecision(deps, actor, input);
  const committed = await withTransactionRetry(() =>
    deps.prisma.$transaction(
      async (tx) => {
        if (input.threadId)
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`;
        const selectable =
          input.threadId === undefined
            ? (block: ApprovalBlock) => block.status !== "connected"
            : isOpen;
        let selectedIds: Set<string> | undefined;
        if (input.threadId) {
          const thread = threads.find((item) => item.id === input.threadId);
          let messages = thread
            ? await tx.message.findMany({
                where: {
                  threadId: thread.id,
                  ...(input.messageId
                    ? { id: input.messageId }
                    : {
                        blocks: {
                          array_contains: [{ kind: "mcp_approval", serverId: input.serverId }],
                        },
                      }),
                },
                select: { id: true, botId: true, runId: true, blocks: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 101,
              })
            : [];
          const target = input.messageId
            ? messages.find((message) => message.id === input.messageId)
            : undefined;
          if (
            input.messageId &&
            (!target ||
              (target.botId !== input.botId &&
                !(target.botId === null && thread?.botId === input.botId)) ||
              !(target.blocks as MessageBlock[]).some((block) => isApproval(block, input.serverId)))
          )
            throw new IsolationError();
          if (
            target?.runId &&
            (target.blocks as MessageBlock[]).some(
              (block) => isApproval(block, input.serverId) && selectable(block),
            )
          ) {
            messages = await tx.message.findMany({
              where: {
                threadId: input.threadId,
                runId: target.runId,
                blocks: { array_contains: [{ kind: "mcp_approval", serverId: input.serverId }] },
              },
              select: { id: true, botId: true, runId: true, blocks: true },
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 101,
            });
          }
          if (messages.length > 100)
            throw new ORPCError("CONFLICT", {
              message:
                "There are too many messages to identify this request safely. Open integration settings to manage access.",
            });
          if (
            !input.messageId &&
            messages.some(
              (message) =>
                message.botId === null &&
                thread?.botId !== input.botId &&
                (message.blocks as MessageBlock[]).some(
                  (block) => isApproval(block, input.serverId) && selectable(block),
                ),
            )
          )
            throw new ORPCError("CONFLICT", {
              message:
                "This older card cannot be linked to a bot. Open integration settings to manage access.",
            });
          const cards = messages.flatMap((message) => {
            if (
              message.botId !== input.botId &&
              !(message.botId === null && thread?.botId === input.botId)
            )
              return [];
            const blocks = (message.blocks as MessageBlock[]).filter(
              (block): block is ApprovalBlock => isApproval(block, input.serverId),
            );
            if (!blocks.length) return [];
            const open = blocks.filter(selectable);
            const kinds = new Set(
              (open.length ? open : blocks).map((block) => block.assignmentOnly === true),
            );
            return [{ id: message.id, runId: message.runId, open: open.length > 0, kinds }];
          });
          const selected = input.messageId
            ? cards.find((card) => card.id === input.messageId)
            : undefined;
          if (input.messageId && !selected) throw new IsolationError();
          const candidates = selected ? [selected] : cards.filter((card) => card.open);
          const groups = new Set(
            candidates.flatMap((card) =>
              [...card.kinds].map((kind) => JSON.stringify([card.runId ?? card.id, kind])),
            ),
          );
          if (groups.size > 1)
            throw new ORPCError("CONFLICT", {
              message:
                "Several requests need this integration. Update Rakazo and approve or dismiss each card separately.",
            });
          const first = candidates[0];
          selectedIds = new Set(
            first
              ? cards
                  .filter(
                    (card) =>
                      card.id === first.id ||
                      (first.open &&
                        first.runId &&
                        card.runId === first.runId &&
                        card.kinds.size === 1 &&
                        first.kinds.size === 1 &&
                        [...card.kinds][0] === [...first.kinds][0]),
                  )
                  .map((card) => card.id)
              : cards.map((card) => card.id),
          );
        }
        const painted = await rewriteCards(tx, actor, threads, input, selectable, selectedIds);
        const dismissalWon =
          input.threadId !== undefined &&
          painted.flipped === 0 &&
          !painted.connected &&
          painted.dismissed;
        const assign = !dismissalWon;
        const resolved = painted.flipped > 0;
        const value = effect
          ? await effect(tx, {
              assign,
              resolved,
              ...(painted.assignmentOnly ? { assignmentOnly: true as const } : {}),
              ...(input.threadId && painted.messageId ? { messageId: painted.messageId } : {}),
              ...(input.threadId && painted.decisionSeq !== undefined
                ? { decisionSeq: painted.decisionSeq }
                : {}),
            })
          : undefined;
        return { seqs: painted.seqs, value };
      },
      { isolationLevel: "Serializable" },
    ),
  );
  for (const event of committed.seqs) await deps.events.notify(event.threadId, event.seq);
  return committed.value;
}

/** Persist an approved card as a durable intent without starting another chat run yet. */
export async function createMcpApprovalContinuation(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: {
    botId: string;
    serverId: string;
    threadId: string;
    messageId: string;
    decisionSeq: number;
    assignmentOnly?: boolean;
  },
): Promise<void> {
  const [thread, bot] = await Promise.all([
    tx.thread.findFirst({
      where: {
        id: input.threadId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        OR: [
          { botId: input.botId },
          { group: { archivedAt: null, members: { some: { botId: input.botId } } } },
        ],
      },
      select: { id: true },
    }),
    tx.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    }),
  ]);
  if (!thread || !bot) return;
  // The card decision and its pending continuation share this thread lock.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM threads WHERE id = ${input.threadId} AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId} FOR UPDATE`;
  if (!locked.length) return;
  const pending = await tx.mcpApprovalContinuation.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      threadId: input.threadId,
      messageId: input.messageId,
      botId: input.botId,
      serverId: input.serverId,
      status: "pending",
    },
    select: { id: true, decisionSeq: true },
  });
  if (pending) {
    // A replay of an older decision must never move a newer approval backwards.
    if (pending.decisionSeq < input.decisionSeq) {
      const changed = await tx.mcpApprovalContinuation.updateMany({
        where: {
          id: pending.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          status: "pending",
          decisionSeq: pending.decisionSeq,
        },
        data: { decisionSeq: input.decisionSeq, assignmentOnly: input.assignmentOnly === true },
      });
      if (changed.count !== 1) throw new Error("Pending MCP approval changed while saving.");
    }
    return;
  }
  await tx.mcpApprovalContinuation.upsert({
    where: {
      messageId_botId_serverId_decisionSeq: {
        messageId: input.messageId,
        botId: input.botId,
        serverId: input.serverId,
        decisionSeq: input.decisionSeq,
      },
    },
    create: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      threadId: input.threadId,
      botId: input.botId,
      serverId: input.serverId,
      messageId: input.messageId,
      assignmentOnly: input.assignmentOnly === true,
      decisionSeq: input.decisionSeq,
    },
    update: {},
  });
}

/** A removed assignment must not leave its card saying the server is connected.
    Pass `tx` to commit the repaint with the assignment change; otherwise this
    notifies after its own transaction. */
export async function revertConnectedMcpApprovals(
  deps: McpApprovalDeps,
  actor: Actor,
  input: { botId: string; serverId: string; status: "pending" | "dismissed" },
  tx?: Prisma.TransactionClient,
): Promise<ThreadSeq[]> {
  const selectable = (block: ApprovalBlock) =>
    input.status === "dismissed" ? block.status !== "dismissed" : block.status === "connected";
  const paint = async (client: Prisma.TransactionClient, threads: ApprovalThread[]) => {
    const painted = await rewriteCards(client, actor, threads, input, selectable);
    await client.mcpApprovalContinuation.updateMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: input.botId,
        serverId: input.serverId,
        status: "pending",
      },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
    return painted.seqs;
  };
  if (tx) return paint(tx, await threadsForBot(tx, actor, input.botId));
  const threads = await threadsForBot(deps.prisma, actor, input.botId);
  const seqs = await withTransactionRetry(() =>
    deps.prisma.$transaction((client) => paint(client, threads), {
      isolationLevel: "Serializable",
    }),
  );
  for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
  return seqs;
}

async function closeServerCards(
  client: Prisma.TransactionClient,
  actor: Actor,
  serverId: string,
): Promise<ThreadSeq[]> {
  const messages = await client.message.findMany({
    where: {
      thread: { spaceId: actor.spaceId, userId: actor.userId },
      blocks: { array_contains: [{ kind: "mcp_approval", serverId }] },
    },
    select: {
      id: true,
      botId: true,
      blocks: true,
      threadId: true,
      thread: { select: { botId: true } },
    },
  });
  const seqs: ThreadSeq[] = [];
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (!blocks.some((block) => isApproval(block, serverId) && block.status !== "dismissed")) {
      continue;
    }
    const next = blocks.map((block) =>
      isApproval(block, serverId) && block.status !== "dismissed"
        ? { ...block, status: "dismissed" as const }
        : block,
    );
    await client.message.update({ where: { id: message.id }, data: { blocks: next } });
    const eventBotId = message.botId ?? message.thread?.botId;
    if (!eventBotId) continue;
    const event = await appendEventInTransaction(client, {
      spaceId: actor.spaceId,
      threadId: message.threadId,
      botId: eventBotId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: next },
    });
    seqs.push({ threadId: message.threadId, seq: event.seq });
  }
  await client.mcpApprovalContinuation.updateMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, serverId, status: "pending" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return seqs;
}

/** Deleting a server closes every approval card for it, including cards that
    were never assigned. */
export async function dismissMcpServerApprovals(
  deps: McpApprovalDeps,
  actor: Actor,
  serverId: string,
  tx?: Prisma.TransactionClient,
): Promise<ThreadSeq[]> {
  if (tx) return closeServerCards(tx, actor, serverId);
  const seqs = await withTransactionRetry(() =>
    deps.prisma.$transaction((client) => closeServerCards(client, actor, serverId), {
      isolationLevel: "Serializable",
    }),
  );
  for (const event of seqs) await deps.events.notify(event.threadId, event.seq);
  return seqs;
}

/** Approving a card in a chat is the user's turn: queue a hidden-prompt run (like
    a call's hang-up) so the bot carries on with the server's tools instead of
    waiting for another message. Skipped while the bot is busy in that chat, no
    longer in it, or archived along with the chat. Returns the run to enqueue. */
export async function queueMcpConnectedRun(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: {
    botId: string;
    serverId: string;
    threadId: string;
    assignmentOnly?: boolean;
    allowAllTools?: boolean;
  },
): Promise<string | null> {
  const thread = await tx.thread.findFirst({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [
        { botId: input.botId },
        { group: { archivedAt: null, members: { some: { botId: input.botId } } } },
      ],
    },
    select: { id: true },
  });
  if (!thread) return null;
  const [bot, busy, server] = await Promise.all([
    tx.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    }),
    tx.run.findFirst({
      where: {
        threadId: thread.id,
        botId: input.botId,
        status: { in: [...QUEUE_HOLDING_RUN_STATUSES] },
      },
      select: { id: true },
    }),
    tx.mcpServer.findFirst({
      where: { id: input.serverId, ...availableInSpace(actor) },
      select: { name: true },
    }),
  ]);
  if (!bot || busy || !server) return null;
  const task = await tx.task.create({
    data: {
      spaceId: actor.spaceId,
      botId: input.botId,
      threadId: thread.id,
      userId: actor.userId,
      prompt: mcpConnectedPrompt(server.name, input),
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: actor.spaceId,
      botId: input.botId,
      threadId: thread.id,
      taskId: task.id,
      userId: actor.userId,
      status: "queued",
      trigger: "user",
    },
    select: { id: true },
  });
  return run.id;
}
