import { ORPCError } from "@orpc/server";
import type { Actor, RoutineHistory, RoutineRun, RoutineRunCursor } from "@rakazo/contracts";
import {
  ROUTINE_HISTORY_PAGE_SIZE,
  ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES,
  SETUP_SOURCE_TEST_KIND,
  SETUP_SOURCE_UNBOUND_KIND,
} from "@rakazo/contracts";
import { runFailureError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";

function notificationStatus(
  intent: { status: string; receiptStatus: string | null } | null | undefined,
): NonNullable<RoutineRun["notification"]> {
  switch (intent?.status) {
    case "preparing":
      return "pending";
    case "pending":
    case "submitting":
    case "uncertain":
    case "cancelled":
    case "blocked":
      return intent.status;
    case "undeliverable":
      // Older workers did not retain enough evidence to rule out acceptance.
      return "uncertain";
    case "no_recipient":
    case "device_rejected":
      return "undeliverable";
    case "accepted":
      if (intent.receiptStatus === "ok") return "expo_receipt_ok";
      if (intent.receiptStatus === "error" || intent.receiptStatus === "device_not_registered")
        return "expo_receipt_error";
      if (intent.receiptStatus === "unavailable") return "expo_receipt_unavailable";
      return "expo_accepted";
    default:
      return "unknown";
  }
}

function sourceTestStatus(
  effect: { kind: string; status: string; result: unknown },
  runStatus: string,
): NonNullable<RoutineRun["sourceTest"]> {
  if (effect.kind === SETUP_SOURCE_UNBOUND_KIND) return "not_started";
  const terminal = ["completed", "failed", "cancelled"].includes(runStatus);
  if (effect.status === "intended") return terminal ? "not_started" : "pending";
  if (effect.status === "executing") return terminal ? "uncertain" : "running";
  const value = (effect.result as { state?: unknown } | null)?.state;
  if (effect.status === "completed" && value === "failed") return "failed";
  if (
    effect.status === "completed" &&
    value === "succeeded" &&
    effect.result &&
    typeof effect.result === "object" &&
    Object.hasOwn(effect.result, "data") &&
    (effect.result as { data: unknown }).data != null &&
    Buffer.byteLength(JSON.stringify((effect.result as { data: unknown }).data)) <= 8448
  )
    return "succeeded";
  return "uncertain";
}

/** Requeue only an owner-selected intent with evidence that no push was accepted. */
export async function retryRoutineNotification(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  runId: string,
): Promise<{ ok: true }> {
  const result = await prisma.routineNotificationIntent.updateMany({
    where: {
      runId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      messageId: { not: null },
      claimToken: null,
      receiptTicketId: null,
      receiptStatus: null,
      OR: [
        { status: "no_recipient" },
        { status: "device_rejected" },
        {
          status: "blocked",
          preSubmitFailures: { gte: ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES },
        },
      ],
      run: {
        is: {
          routineId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          trigger: "routine",
          status: "completed",
          routine: { is: { notify: true } },
          bot: { is: { archivedAt: null } },
          OR: [
            { bot: { is: { notifyOnFinish: true } } },
            { thread: { is: { groupId: { not: null } } } },
          ],
        },
      },
    },
    data: { status: "pending", preSubmitFailures: 0, nextPreSubmitAttemptAt: null },
  });
  if (result.count !== 1)
    throw new ORPCError("CONFLICT", {
      message: "This notification cannot be retried. Refresh its history.",
    });
  return { ok: true };
}

export async function listRoutineRuns(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  before?: RoutineRunCursor,
  limit = ROUTINE_HISTORY_PAGE_SIZE,
): Promise<RoutineHistory> {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
    select: { botId: true, notify: true, bot: { select: { notifyOnFinish: true } } },
  });
  if (!routine) throw new ORPCError("NOT_FOUND");

  const rows = await prisma.run.findMany({
    where: {
      routineId,
      botId: routine.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: new Date(before.createdAt) } },
              { createdAt: new Date(before.createdAt), id: { lt: before.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      botId: true,
      threadId: true,
      thread: { select: { groupId: true } },
      status: true,
      trigger: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      routineNotification: {
        select: {
          status: true,
          receiptStatus: true,
          receiptTicketId: true,
          claimToken: true,
          preSubmitFailures: true,
          messageId: true,
        },
      },
      effects: {
        where: { kind: { in: [SETUP_SOURCE_TEST_KIND, SETUP_SOURCE_UNBOUND_KIND] } },
        select: { kind: true, status: true, result: true },
        take: 1,
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const runs = rows.slice(0, limit);
  const last = runs.at(-1);
  const nextCursor =
    rows.length > limit && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null;
  // Routine runs can finish silently. A chat link opens the first message a run posted.
  const messages = runs.length
    ? await prisma.$queryRaw<Array<{ id: string; runId: string; threadId: string }>>(Prisma.sql`
        SELECT DISTINCT ON (m."runId") m.id, m."runId", m."threadId"
        FROM messages m
        INNER JOIN runs r ON r.id = m."runId" AND r."threadId" = m."threadId"
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE r.id IN (${Prisma.join(runs.map((run) => run.id))})
          AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
          AND t."spaceId" = ${actor.spaceId} AND t."userId" = ${actor.userId}
          AND m.role = 'bot'
        ORDER BY m."runId", m.seq
      `)
    : [];
  const replyByRun = new Map(messages.map((message) => [message.runId, message.id]));
  return {
    nextCursor,
    runs: runs.map((run) => ({
      id: run.id,
      ...(run.effects[0]
        ? {
            sourceTest: sourceTestStatus(run.effects[0], run.status),
            ...(run.effects[0].kind === SETUP_SOURCE_UNBOUND_KIND ? { sourceUnbound: true } : {}),
          }
        : {}),
      notification: notificationStatus(run.routineNotification),
      notificationRetryExhausted:
        run.routineNotification?.status === "blocked" &&
        run.routineNotification.preSubmitFailures >= ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES,
      notificationCanRetry: Boolean(
        routine.notify &&
          (routine.bot.notifyOnFinish || run.thread.groupId) &&
          run.status === "completed" &&
          run.trigger === "routine" &&
          run.routineNotification?.messageId &&
          !run.routineNotification.claimToken &&
          !run.routineNotification.receiptStatus &&
          !run.routineNotification.receiptTicketId &&
          (run.routineNotification.status === "no_recipient" ||
            run.routineNotification.status === "device_rejected" ||
            (run.routineNotification.status === "blocked" &&
              run.routineNotification.preSubmitFailures >=
                ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES)),
      ),
      botId: run.botId,
      groupId: run.thread.groupId,
      status: run.status as RoutineRun["status"],
      error: runFailureError({ type: `run.${run.status}`, payload: { error: run.error } }),
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      messageId: replyByRun.get(run.id) ?? null,
    })),
  };
}
