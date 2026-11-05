import { createJobReconciler, ExpoPushProvider } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { workerRoutineNotifications } from "./routine-notifications.js";

function fixture() {
  const row = {
    id: "intent",
    spaceId: "space",
    userId: "owner",
    status: "pending",
    claimToken: null as string | null,
    claimExpiresAt: null as Date | null,
    messageId: "message",
    message: { blocks: [{ kind: "text", text: "Reminder" }] },
    run: {
      status: "completed",
      trigger: "routine",
      routineId: "routine",
      spaceId: "space",
      userId: "owner",
      botId: "bot",
      threadId: "thread",
      bot: { name: "Bot", notifyOnFinish: true },
      thread: { groupId: null },
    },
  };
  const prisma = {
    routineNotificationIntent: {
      findMany: vi.fn(async ({ where }: { where: { status: string } }) =>
        row.status === where.status
          ? [{ id: row.id, spaceId: row.spaceId, userId: row.userId }]
          : [],
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status: string; claimToken?: string };
          data: object;
        }) => {
          if (
            where.status !== row.status ||
            (where.claimToken && where.claimToken !== row.claimToken)
          )
            return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      findFirst: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { status: string; claimToken: string };
          select: { id?: boolean };
        }) => {
          if (row.status !== where.status || row.claimToken !== where.claimToken) return null;
          return select.id ? { id: row.id } : row;
        },
      ),
    },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    message: { findMany: vi.fn(async () => []) },
    run: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    messagingOutbound: { findFirst: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  const notifications = new ExpoPushProvider({} as never);
  const deliver = vi
    .spyOn(notifications, "deliver")
    .mockImplementation(async (_message, _context, accepted) => {
      await accepted?.("ticket", "digest");
      return "delivered";
    });
  const jobs = { enqueue: vi.fn(async () => undefined), cancel: vi.fn(), close: vi.fn() };
  return { row, prisma, notifications, deliver, jobs };
}

describe("worker routine notification composition", () => {
  it("enables and actually reconciles a durable pending intent", async () => {
    const f = fixture();
    const wiring = workerRoutineNotifications({ ...f, durable: true });
    expect(wiring.executor.routineNotificationOutbox).toBe(true);
    await createJobReconciler({ ...f, ...wiring.reconciler }).reconcileOnce();
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.row.status).toBe("accepted");
  });

  it("keeps memory mode on the legacy path without a durable reconciler", async () => {
    const f = fixture();
    const wiring = workerRoutineNotifications({ ...f, durable: false });
    expect(wiring.executor.routineNotificationOutbox).toBe(false);
    await createJobReconciler({ ...f, ...wiring.reconciler }).reconcileOnce();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.row.status).toBe("pending");
  });
});
