import type { Actor } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listRoutineRuns } from "./routine-runs.js";

const actor: Actor = { userId: "owner", spaceId: "space", email: "synthetic@example.test", isDeploymentOwner: false };
const at = new Date("2026-01-02T12:00:00Z");

describe("routine notification history", () => {
  it.each([
    ["preparing", null, 1, "pending", false],
    ["blocked", null, 5, "blocked", true],
    ["blocked", null, 0, "blocked", false],
    ["accepted", "ok", 0, "expo_receipt_ok", false],
    ["accepted", "device_not_registered", 0, "expo_receipt_error", false],
    ["accepted", "unavailable", 0, "expo_receipt_unavailable", false],
    ["accepted", "pending", 0, "expo_accepted", false],
    ["uncertain", null, 0, "uncertain", false],
  ])("reports %s without exposing provider references", async (status, receiptStatus, failures, expected, exhausted) => {
    const findFirst = vi.fn(async () => ({ botId: "bot" }));
    const findMany = vi.fn(async () => [{
      id: "run", botId: "bot", threadId: "thread", thread: { groupId: null }, status: "completed",
      routineNotification: { status, receiptStatus, preSubmitFailures: failures },
      createdAt: at, startedAt: at, completedAt: at,
    }]);
    const prisma = { routine: { findFirst }, run: { findMany }, $queryRaw: vi.fn(async () => []) } as unknown as PrismaClient;
    const history = RoutineHistorySchema.parse(await listRoutineRuns(prisma, actor, "routine"));
    expect(history.runs[0]).toMatchObject({ notification: expected, notificationRetryExhausted: exhausted });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ spaceId: "space", userId: "owner" }) }));
    expect(JSON.stringify(history)).not.toContain("ticket");
  });
});
