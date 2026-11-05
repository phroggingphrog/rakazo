import { type BackgroundJobPayloads, type JobPublisher, pushReceiptJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import type { ExpoPushProvider } from "./expo-push.js";

// A crashed scheduler releases this local reservation without resetting the job's backoff.
const RESCAN_MS = 60_000;

export async function reconcileRoutineNotificationReceipts(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
}): Promise<void> {
  const now = new Date();
  await runAsSystem("expire routine notification receipt lookups", () =>
    deps.prisma.routineNotificationIntent.updateMany({
      where: { receiptStatus: "pending", receiptExpiresAt: { lte: now } },
      data: {
        receiptStatus: "unavailable",
        receiptTicketId: null,
        receiptTokenDigest: null,
        receiptCheckAt: null,
      },
    }),
  );
  const due = await runAsSystem("find routine notification receipt lookups", () =>
    deps.prisma.routineNotificationIntent.findMany({
      where: {
        receiptStatus: "pending",
        receiptCheckAt: { lte: now },
        receiptExpiresAt: { gt: now },
      },
      orderBy: [{ receiptCheckAt: "asc" }, { id: "asc" }],
      take: 20,
      select: {
        id: true,
        userId: true,
        spaceId: true,
        receiptTicketId: true,
        receiptTokenDigest: true,
        receiptCheckAt: true,
      },
    }),
  );
  for (const row of due) {
    if (!row.receiptTicketId || !row.receiptTokenDigest) continue;
    await runAsTenant({ userId: row.userId, spaceId: row.spaceId }, async () => {
      const reserved = await deps.prisma.routineNotificationIntent.updateMany({
        where: {
          id: row.id,
          userId: row.userId,
          spaceId: row.spaceId,
          receiptStatus: "pending",
          receiptCheckAt: row.receiptCheckAt,
        },
        data: { receiptCheckAt: new Date(now.getTime() + RESCAN_MS) },
      });
      if (!reserved.count) return;
      await deps.jobs.enqueue(
        pushReceiptJob(
          {
            userId: row.userId,
            ticketId: row.receiptTicketId!,
            tokenDigest: row.receiptTokenDigest!,
            routine: { intentId: row.id, spaceId: row.spaceId },
          },
          now,
        ),
      );
    });
  }
}

/** Validate the exact tenant and ticket before a read-only provider request or state update. */
export async function checkRoutineNotificationReceipt(
  deps: {
    prisma: PrismaClient;
    notifications: ExpoPushProvider;
  },
  payload: BackgroundJobPayloads["push.receipt"],
): Promise<void> {
  if (!payload.routine) return;
  const { intentId, spaceId } = payload.routine;
  await runAsTenant({ userId: payload.userId, spaceId }, async () => {
    const where = {
      id: intentId,
      userId: payload.userId,
      spaceId,
      receiptStatus: "pending",
      receiptTicketId: payload.ticketId,
      receiptTokenDigest: payload.tokenDigest,
      receiptExpiresAt: { gt: new Date() },
    };
    const current = await deps.prisma.routineNotificationIntent.findFirst({
      where,
      select: { id: true },
    });
    if (!current) return;
    const outcome = await deps.notifications.checkReceipt(payload);
    await deps.prisma.routineNotificationIntent.updateMany({
      where,
      data: {
        receiptStatus: outcome,
        receiptTicketId: null,
        receiptTokenDigest: null,
        receiptCheckAt: null,
      },
    });
  });
}
