import { randomUUID } from "node:crypto";
import type { JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import { MessageBlock, ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES } from "@rakazo/contracts";
import { displayName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { countUnreadInboxChats, runAsSystem, runAsTenant } from "@rakazo/db";
import { EXPO_RECEIPT_DELAY_MS, EXPO_RECEIPT_TTL_MS, ExpoPushProvider } from "./expo-push.js";
import { reconcileRoutineNotificationReceipts } from "./routine-notification-receipts.js";
import { completionNotificationBody, completionNotificationPreview } from "./run-notifications.js";

// Never re-claim an expired submission: the provider may already have accepted it.
const CLAIM_MS = 120_000;
const BATCH = 20;
const RETRY_BASE_MS = 60_000;

function preparationRetry(previousFailures: number, now: Date) {
  const failures = Math.min(previousFailures + 1, ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES);
  const exhausted = failures >= ROUTINE_NOTIFICATION_PRE_SUBMIT_MAX_FAILURES;
  return {
    status: exhausted ? "blocked" : "pending",
    claimToken: null,
    claimExpiresAt: null,
    preSubmitFailures: failures,
    nextPreSubmitAttemptAt: exhausted
      ? null
      : new Date(now.getTime() + RETRY_BASE_MS * 2 ** (failures - 1)),
  };
}

export async function reconcileRoutineNotificationIntents(deps: {
  prisma: PrismaClient;
  notifications: NotificationProvider;
  jobs?: JobPublisher;
}): Promise<void> {
  const { prisma, notifications } = deps;
  const now = new Date();
  await runAsSystem("recover routine notification submissions", async () => {
    const preparing = await prisma.routineNotificationIntent.findMany({
      where: { status: "preparing", claimExpiresAt: { lt: now } },
      orderBy: [{ claimExpiresAt: "asc" }, { id: "asc" }],
      take: BATCH,
      select: { id: true, claimToken: true, preSubmitFailures: true },
    });
    for (const row of preparing) {
      await prisma.routineNotificationIntent.updateMany({
        where: {
          id: row.id,
          status: "preparing",
          claimToken: row.claimToken,
          claimExpiresAt: { lt: now },
          preSubmitFailures: row.preSubmitFailures,
        },
        data: preparationRetry(row.preSubmitFailures, now),
      });
    }
    const expired = await prisma.routineNotificationIntent.findMany({
      where: { status: "submitting", claimExpiresAt: { lt: now } },
      orderBy: [{ claimExpiresAt: "asc" }, { id: "asc" }],
      take: BATCH,
      select: { id: true },
    });
    if (expired.length) {
      await prisma.routineNotificationIntent.updateMany({
        where: {
          id: { in: expired.map((row) => row.id) },
          status: "submitting",
          claimExpiresAt: { lt: now },
        },
        data: { status: "uncertain", claimToken: null, claimExpiresAt: null },
      });
    }
  });
  const pending = await runAsSystem("find pending routine notifications", () =>
    prisma.routineNotificationIntent.findMany({
      where: {
        status: "pending",
        OR: [{ nextPreSubmitAttemptAt: null }, { nextPreSubmitAttemptAt: { lte: now } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: BATCH,
      select: { id: true, userId: true, spaceId: true, preSubmitFailures: true },
    }),
  );
  for (const candidate of pending) {
    await runAsTenant({ spaceId: candidate.spaceId, userId: candidate.userId }, async () => {
      const claimToken = randomUUID();
      const claimed = await prisma.routineNotificationIntent.updateMany({
        where: {
          id: candidate.id,
          spaceId: candidate.spaceId,
          userId: candidate.userId,
          status: "pending",
          preSubmitFailures: candidate.preSubmitFailures,
          OR: [{ nextPreSubmitAttemptAt: null }, { nextPreSubmitAttemptAt: { lte: now } }],
        },
        data: {
          status: "preparing",
          claimToken,
          claimExpiresAt: new Date(Date.now() + CLAIM_MS),
          nextPreSubmitAttemptAt: null,
        },
      });
      if (claimed.count !== 1) return;
      const settle = (
        status: "accepted" | "undeliverable" | "uncertain" | "cancelled" | "blocked",
        phase: "preparing" | "submitting" = "preparing",
      ) =>
        prisma.routineNotificationIntent.updateMany({
          where: {
            id: candidate.id,
            status: phase,
            claimToken,
            claimExpiresAt: { gt: new Date() },
          },
          data: { status, claimToken: null, claimExpiresAt: null },
        });
      let submissionStarted = false;
      try {
        const intent = await prisma.routineNotificationIntent.findFirst({
          where: {
            id: candidate.id,
            spaceId: candidate.spaceId,
            userId: candidate.userId,
            status: "preparing",
            claimToken,
          },
          select: {
            message: { select: { blocks: true } },
            run: {
              select: {
                status: true,
                trigger: true,
                routineId: true,
                spaceId: true,
                userId: true,
                botId: true,
                threadId: true,
                bot: { select: { name: true, notifyOnFinish: true } },
                thread: { select: { groupId: true } },
              },
            },
          },
        });
        if (!intent?.message || (!intent.run.bot.notifyOnFinish && !intent.run.thread.groupId)) {
          await settle("cancelled");
          return;
        }
        if (
          intent.run.status !== "completed" ||
          intent.run.trigger !== "routine" ||
          !intent.run.routineId ||
          intent.run.spaceId !== candidate.spaceId ||
          intent.run.userId !== candidate.userId
        ) {
          await settle("blocked");
          return;
        }
        const blocks = MessageBlock.array().safeParse(intent.message.blocks);
        if (!blocks.success) {
          await settle("blocked");
          return;
        }
        const body = completionNotificationPreview(completionNotificationBody("", blocks.data));
        if (!body) {
          await settle("cancelled");
          return;
        }
        const badge = await countUnreadInboxChats(prisma, {
          userId: candidate.userId,
          spaceId: candidate.spaceId,
        }).catch(() => undefined);
        const message = {
          kind: "completion" as const,
          title: `${displayName(intent.run.bot.name, "Bot")} finished`,
          body,
          botId: intent.run.botId,
          threadId: intent.run.threadId,
          ...(badge === undefined ? {} : { badge }),
          ...(intent.run.thread.groupId ? { groupId: intent.run.thread.groupId } : {}),
        };
        const context = {
          operationId: "notify",
          traceId: intent.run.botId,
          spaceId: candidate.spaceId,
          userId: candidate.userId,
          botId: intent.run.botId,
          signal: new AbortController().signal,
        };
        const current = await prisma.routineNotificationIntent.findFirst({
          where: {
            id: candidate.id,
            status: "preparing",
            claimToken,
            claimExpiresAt: { gt: new Date() },
            messageId: { not: null },
          },
          select: { id: true },
        });
        if (!current) {
          await settle("cancelled");
          return;
        }
        const dispatched = await prisma.routineNotificationIntent.updateMany({
          where: {
            id: candidate.id,
            spaceId: candidate.spaceId,
            userId: candidate.userId,
            status: "preparing",
            claimToken,
            claimExpiresAt: { gt: new Date() },
            messageId: { not: null },
          },
          data: { status: "submitting" },
        });
        if (dispatched.count !== 1) return;
        submissionStarted = true;
        if (notifications instanceof ExpoPushProvider) {
          const result = await notifications.deliver(
            message,
            context,
            async (ticketId, tokenDigest) => {
              const acceptedAt = Date.now();
              const saved = await prisma.routineNotificationIntent.updateMany({
                where: {
                  id: candidate.id,
                  userId: candidate.userId,
                  spaceId: candidate.spaceId,
                  status: "submitting",
                  claimToken,
                  claimExpiresAt: { gt: new Date() },
                },
                data: {
                  status: "accepted",
                  claimToken: null,
                  claimExpiresAt: null,
                  receiptTicketId: ticketId,
                  receiptTokenDigest: tokenDigest,
                  receiptStatus: "pending",
                  receiptCheckAt: new Date(acceptedAt + EXPO_RECEIPT_DELAY_MS),
                  receiptExpiresAt: new Date(acceptedAt + EXPO_RECEIPT_TTL_MS),
                },
              });
              if (saved.count !== 1)
                throw new Error("Notification claim expired after acceptance.");
            },
          );
          if (result === "undeliverable") await settle("undeliverable", "submitting");
        } else {
          await notifications.send(message, context);
          // The generic provider exposes no acceptance or receipt evidence.
          await settle("uncertain", "submitting");
        }
      } catch {
        if (submissionStarted) {
          await settle("uncertain", "submitting");
        } else {
          await prisma.routineNotificationIntent.updateMany({
            where: {
              id: candidate.id,
              userId: candidate.userId,
              spaceId: candidate.spaceId,
              status: "preparing",
              claimToken,
              claimExpiresAt: { gt: new Date() },
              preSubmitFailures: candidate.preSubmitFailures,
            },
            data: preparationRetry(candidate.preSubmitFailures, new Date()),
          });
        }
      }
    });
  }
  if (deps.jobs) await reconcileRoutineNotificationReceipts({ prisma, jobs: deps.jobs });
}
