import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { retryRoutineNotification } from "./routine-runs.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "synthetic@example.test",
  isDeploymentOwner: false,
};

describe("owner-triggered notification retry", () => {
  it("updates only a still-unsent scoped intent and leaves the schedule alone", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = { routineNotificationIntent: { updateMany } } as unknown as PrismaClient;
    await expect(retryRoutineNotification(prisma, actor, "routine", "run")).resolves.toEqual({
      ok: true,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        runId: "run",
        spaceId: "space",
        userId: "owner",
        messageId: { not: null },
        claimToken: null,
        receiptTicketId: null,
        receiptStatus: null,
        OR: [
          { status: "no_recipient" },
          { status: "device_rejected" },
          { status: "blocked", preSubmitFailures: { gte: 5 } },
        ],
        run: {
          is: {
            routineId: "routine",
            spaceId: "space",
            userId: "owner",
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
  });
  it("reports a conflict when an intent is missing, changed, claimed, deleted or outside scope", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const prisma = { routineNotificationIntent: { updateMany } } as unknown as PrismaClient;
    await expect(retryRoutineNotification(prisma, actor, "routine", "run")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("permits only one concurrent conditional retry", async () => {
    let status = "no_recipient";
    const updateMany = vi.fn(async () => {
      if (status !== "no_recipient") return { count: 0 };
      status = "pending";
      return { count: 1 };
    });
    const prisma = { routineNotificationIntent: { updateMany } } as unknown as PrismaClient;
    const result = await Promise.allSettled([
      retryRoutineNotification(prisma, actor, "routine", "run"),
      retryRoutineNotification(prisma, actor, "routine", "run"),
    ]);
    expect(result.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(status).toBe("pending");
  });
});
