import type { Actor } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listRoutineRuns } from "./routine-runs.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "synthetic@example.test",
  isDeploymentOwner: false,
};
const at = new Date("2026-01-02T12:00:00Z");

describe("routine notification history", () => {
  it.each([
    ["preparing", null, 1, "pending", false, false],
    ["blocked", null, 5, "blocked", true, true],
    ["blocked", null, 0, "blocked", false, false],
    ["accepted", "ok", 0, "expo_receipt_ok", false, false],
    ["accepted", "device_not_registered", 0, "expo_receipt_error", false, false],
    ["accepted", "unavailable", 0, "expo_receipt_unavailable", false, false],
    ["accepted", "pending", 0, "expo_accepted", false, false],
    ["uncertain", null, 0, "uncertain", false, false],
    ["undeliverable", null, 0, "uncertain", false, false],
    ["no_recipient", null, 0, "undeliverable", false, true],
    ["device_rejected", null, 0, "undeliverable", false, true],
  ])(
    "reports %s without exposing provider references",
    async (status, receiptStatus, failures, expected, exhausted, retryable) => {
      const findFirst = vi.fn(async () => ({
        botId: "bot",
        notify: true,
        bot: { notifyOnFinish: true },
      }));
      const findMany = vi.fn(async () => [
        {
          id: "run",
          botId: "bot",
          threadId: "thread",
          thread: { groupId: null },
          status: "completed",
          trigger: "routine",
          effects: [],
          routineNotification: {
            status,
            receiptStatus,
            receiptTicketId: null,
            messageId: "message",
            preSubmitFailures: failures,
          },
          createdAt: at,
          startedAt: at,
          completedAt: at,
        },
      ]);
      const prisma = {
        routine: { findFirst },
        run: { findMany },
        $queryRaw: vi.fn(async () => []),
      } as unknown as PrismaClient;
      const history = RoutineHistorySchema.parse(await listRoutineRuns(prisma, actor, "routine"));
      expect(history.runs[0]).toMatchObject({
        notification: expected,
        notificationRetryExhausted: exhausted,
        notificationCanRetry: retryable,
      });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ spaceId: "space", userId: "owner" }),
        }),
      );
      expect(JSON.stringify(history)).not.toContain("ticket");
    },
  );
});
