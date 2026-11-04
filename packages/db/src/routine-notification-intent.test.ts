import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finalizeRun } from "./events.js";

function fixture(options: { stale?: boolean; failIntent?: boolean } = {}) {
  const tx = {
    externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => ({ status: "running", userId: "owner", startedAt: null })),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: options.stale ? 0 : 1 })),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1, nextMessageSeq: 1 })) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        threadId: "thread",
        seq: 0,
        createdAt: new Date(),
      })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    steeringMessage: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    message: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "protected-message" })),
    },
    bot: { update: vi.fn(async () => ({})) },
    routineNotificationIntent: {
      create: vi.fn(async () => {
        if (options.failIntent) throw new Error("intent write failed");
        return {};
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (inner: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaClient;
  const input = {
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    runId: "run",
    taskId: "task",
    attemptId: "attempt",
    leaseOwner: "worker",
    leaseFence: 1,
    outcome: "completed" as const,
    blocks: [{ kind: "text" as const, text: "private reply" }],
    routineCompletionNotification: true,
  };
  return { tx, prisma, input };
}

describe("routine completion notification intent", () => {
  it("writes only an owner-scoped message reference in the finalization transaction", async () => {
    const f = fixture();
    await expect(finalizeRun(f.prisma, f.input)).resolves.toEqual({ continuationRunId: null });
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          trigger: "routine",
          routineId: { not: null },
          leaseFence: 1,
        }),
      }),
    );
    expect(f.tx.routineNotificationIntent.create).toHaveBeenCalledExactlyOnceWith({
      data: { spaceId: "space", userId: "owner", runId: "run", messageId: "protected-message" },
    });
    expect(JSON.stringify(f.tx.routineNotificationIntent.create.mock.calls)).not.toContain(
      "private reply",
    );
  });

  it("does not create an intent for a superseded run lease", async () => {
    const f = fixture({ stale: true });
    await expect(finalizeRun(f.prisma, f.input)).resolves.toBe(false);
    expect(f.tx.message.create).not.toHaveBeenCalled();
    expect(f.tx.routineNotificationIntent.create).not.toHaveBeenCalled();
  });

  it("propagates an intent write failure from the finalization transaction", async () => {
    const f = fixture({ failIntent: true });
    await expect(finalizeRun(f.prisma, f.input)).rejects.toThrow("intent write failed");
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
  });
});
