import { describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
  runAsTenant: (_tenant: unknown, fn: () => unknown) => fn(),
}));

import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { ExpoPushProvider } from "./expo-push.js";
import {
  checkRoutineNotificationReceipt,
  reconcileRoutineNotificationReceipts,
} from "./routine-notification-receipts.js";

function fixture() {
  const row = {
    id: "intent",
    userId: "owner",
    spaceId: "space",
    receiptStatus: "pending",
    receiptTicketId: "ticket",
    receiptTokenDigest: "digest",
    receiptCheckAt: new Date(Date.now() - 1),
    receiptExpiresAt: new Date(Date.now() + 60_000),
  };
  const matches = (where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = row[key as keyof typeof row];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const range = value as { lte?: Date; gt?: Date };
        return (
          actual instanceof Date &&
          (!range.lte || actual <= range.lte) &&
          (!range.gt || actual > range.gt)
        );
      }
      return actual instanceof Date && value instanceof Date
        ? actual.getTime() === value.getTime()
        : actual === value;
    });
  const table = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      matches(where) ? [{ ...row }] : [],
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      matches(where) ? { id: row.id } : null,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
      if (!matches(where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
  const prisma = { routineNotificationIntent: table } as unknown as PrismaClient;
  const enqueue = vi.fn(async (_job: Parameters<JobPublisher["enqueue"]>[0]) => undefined);
  const jobs = { enqueue } as unknown as JobPublisher;
  const checkReceipt = vi.fn(async (): Promise<"ok" | "error" | "device_not_registered"> => "ok");
  const notifications = { checkReceipt } as unknown as ExpoPushProvider;
  const payload = {
    userId: "owner",
    ticketId: "ticket",
    tokenDigest: "digest",
    routine: { intentId: "intent", spaceId: "space" },
  };
  return { row, table, prisma, jobs, enqueue, notifications, checkReceipt, payload };
}

describe("routine notification receipt recovery", () => {
  it("recovers a missing job with a stable key and does not reset an existing backoff", async () => {
    const f = fixture();
    await reconcileRoutineNotificationReceipts(f);
    expect(f.enqueue).toHaveBeenCalledOnce();
    expect(f.enqueue.mock.calls[0]?.[0]).toMatchObject({
      name: "push.receipt",
      payload: f.payload,
      replaceKey: "routine-receipt:intent",
      keepExisting: true,
    });
    await reconcileRoutineNotificationReceipts(f);
    expect(f.enqueue).toHaveBeenCalledOnce();
  });
  it("recovers after enqueue fails when its short reservation expires", async () => {
    const f = fixture();
    f.enqueue.mockRejectedValueOnce(new Error("offline"));
    await expect(reconcileRoutineNotificationReceipts(f)).rejects.toThrow("offline");
    expect(f.row.receiptStatus).toBe("pending");
    f.row.receiptCheckAt = new Date(Date.now() - 1);
    await reconcileRoutineNotificationReceipts(f);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it("persists a receipt once and discards the ticket reference and digest", async () => {
    const f = fixture();
    await checkRoutineNotificationReceipt(f, f.payload);
    await checkRoutineNotificationReceipt(f, f.payload);
    expect(f.checkReceipt).toHaveBeenCalledOnce();
    expect(f.row).toMatchObject({
      receiptStatus: "ok",
      receiptTicketId: null,
      receiptTokenDigest: null,
    });
  });
  it.each(["user", "space", "ticket", "digest"])(
    "rejects a mismatched %s before contacting Expo",
    async (part) => {
      const f = fixture();
      if (part === "user") f.payload.userId = "other";
      if (part === "space") f.payload.routine.spaceId = "other";
      if (part === "ticket") f.payload.ticketId = "other";
      if (part === "digest") f.payload.tokenDigest = "other";
      await checkRoutineNotificationReceipt(f, f.payload);
      expect(f.checkReceipt).not.toHaveBeenCalled();
      expect(f.row.receiptStatus).toBe("pending");
    },
  );
  it("keeps pending on a receipt lookup failure so the job can retry", async () => {
    const f = fixture();
    f.checkReceipt.mockRejectedValueOnce(new Error("offline"));
    await expect(checkRoutineNotificationReceipt(f, f.payload)).rejects.toThrow("offline");
    expect(f.row.receiptStatus).toBe("pending");
  });
  it.each(["error", "device_not_registered"] as const)(
    "persists a provider receipt %s",
    async (outcome) => {
      const f = fixture();
      f.checkReceipt.mockResolvedValueOnce(outcome);
      await checkRoutineNotificationReceipt(f, f.payload);
      expect(f.row).toMatchObject({
        receiptStatus: outcome,
        receiptTicketId: null,
        receiptTokenDigest: null,
      });
    },
  );
  it("expires receipt lookups without claiming a delivery result", async () => {
    const f = fixture();
    f.row.receiptExpiresAt = new Date(Date.now() - 1);
    await reconcileRoutineNotificationReceipts(f);
    expect(f.row).toMatchObject({
      receiptStatus: "unavailable",
      receiptTicketId: null,
      receiptTokenDigest: null,
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
