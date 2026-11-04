import { describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
  runAsTenant: (_tenant: unknown, fn: () => unknown) => fn(),
  countUnreadInboxChats: async () => 0,
}));

import type { PrismaClient } from "@rakazo/db";
import { ExpoPushProvider } from "./expo-push.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";
import { reconcileRoutineNotificationIntents } from "./routine-notification-intents.js";

function fixture(options: { noMessage?: boolean; initialStatus?: string } = {}) {
  const row = {
    id: "intent",
    spaceId: "space",
    userId: "owner",
    status: options.initialStatus ?? "pending",
    claimToken: null as string | null,
    claimExpiresAt: null as Date | null,
    preSubmitFailures: 0,
    nextPreSubmitAttemptAt: null as Date | null,
    messageId: options.noMessage ? null : "message",
    message: options.noMessage ? null : { blocks: [{ kind: "text", text: "private reply" }] },
    run: {
      status: "completed",
      trigger: "routine",
      routineId: "routine",
      routineNotify: true,
      spaceId: "space",
      userId: "owner",
      botId: "bot",
      threadId: "thread",
      bot: { name: "Bot", notifyOnFinish: true },
      thread: { groupId: null },
    },
  };
  const table = {
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.status !== row.status) return { count: 0 };
        if (
          typeof where.preSubmitFailures === "number" &&
          where.preSubmitFailures !== row.preSubmitFailures
        )
          return { count: 0 };
        if (Array.isArray(where.OR)) {
          const due = (where.OR[1] as { nextPreSubmitAttemptAt: { lte: Date } })
            .nextPreSubmitAttemptAt.lte;
          if (row.nextPreSubmitAttemptAt && row.nextPreSubmitAttemptAt > due) return { count: 0 };
        }
        if (typeof where.id === "string" && where.id !== row.id) return { count: 0 };
        if (where.messageId && typeof where.messageId === "object" && !row.messageId)
          return { count: 0 };
        if (typeof where.claimToken === "string" && where.claimToken !== row.claimToken)
          return { count: 0 };
        if (where.claimExpiresAt && typeof where.claimExpiresAt === "object") {
          const limit = where.claimExpiresAt as { lt?: Date; gt?: Date };
          if (
            !row.claimExpiresAt ||
            (limit.lt && row.claimExpiresAt >= limit.lt) ||
            (limit.gt && row.claimExpiresAt <= limit.gt)
          )
            return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    ),
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: {
          status: string;
          claimExpiresAt?: { lt: Date };
          OR?: Array<{ nextPreSubmitAttemptAt: null | { lte: Date } }>;
        };
      }) =>
        row.status === where.status &&
        (!where.claimExpiresAt ||
          (row.claimExpiresAt && row.claimExpiresAt < where.claimExpiresAt.lt)) &&
        (!where.OR ||
          !row.nextPreSubmitAttemptAt ||
          row.nextPreSubmitAttemptAt <= (where.OR[1]!.nextPreSubmitAttemptAt as { lte: Date }).lte)
          ? [
              {
                id: row.id,
                spaceId: row.spaceId,
                userId: row.userId,
                preSubmitFailures: row.preSubmitFailures,
                claimToken: row.claimToken,
              },
            ]
          : [],
    ),
    findFirst: vi.fn(
      async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select: Record<string, unknown>;
      }) => {
        if (where.status !== row.status || where.claimToken !== row.claimToken) return null;
        if (select.id) return row.messageId ? { id: row.id } : null;
        return row;
      },
    ),
  };
  const prisma = {
    routineNotificationIntent: table,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        routineNotificationIntent: table,
        $queryRaw: async (strings: TemplateStringsArray) =>
          strings.join("").includes("FROM bots")
            ? [{ notifyOnFinish: row.run.bot.notifyOnFinish }]
            : [{ notify: row.run.routineNotify }],
      }),
    ),
  } as unknown as PrismaClient;
  const notifications = new ExpoPushProvider({} as never);
  const deliver = vi
    .spyOn(notifications, "deliver")
    .mockImplementation(async (_message, _context, accepted) => {
      await accepted?.("ticket", "digest");
      return "delivered";
    });
  return { row, table, prisma, notifications, deliver };
}

describe("routine notification intent recovery", () => {
  it("retries a transient lookup failure that occurred before provider submission", async () => {
    const f = fixture();
    f.table.findFirst.mockRejectedValueOnce(new Error("synthetic database interruption"));
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("pending");
    expect(f.row.preSubmitFailures).toBe(1);
    expect(f.row.nextPreSubmitAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(f.deliver).not.toHaveBeenCalled();
    await reconcileRoutineNotificationIntents(f);
    expect(f.deliver).not.toHaveBeenCalled();
    f.row.nextPreSubmitAttemptAt = new Date(0);
    await Promise.all([
      reconcileRoutineNotificationIntents(f),
      reconcileRoutineNotificationIntents(f),
    ]);
    expect(f.row.status).toBe("accepted");
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it("backs off each failure and stops after the fifth without calling the provider", async () => {
    const f = fixture();
    f.table.findFirst.mockRejectedValue(new Error("synthetic database interruption"));
    for (let failures = 1; failures <= 5; failures++) {
      await reconcileRoutineNotificationIntents(f);
      expect(f.row.preSubmitFailures).toBe(failures);
      if (failures < 5) {
        expect(f.row.status).toBe("pending");
        const delay = f.row.nextPreSubmitAttemptAt!.getTime() - Date.now();
        expect(delay).toBeGreaterThan(60_000 * 2 ** (failures - 1) - 1_000);
        await reconcileRoutineNotificationIntents(f);
        expect(f.row.preSubmitFailures).toBe(failures);
        f.row.nextPreSubmitAttemptAt = new Date(0);
      }
    }
    expect(f.row.status).toBe("blocked");
    expect(f.row.nextPreSubmitAttemptAt).toBeNull();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("does not revive an expired or superseded claim after a lookup failure", async () => {
    const f = fixture();
    let rejectLookup!: (error: Error) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.table.findFirst.mockImplementationOnce(async () => {
      entered();
      return new Promise((_resolve, reject) => {
        rejectLookup = reject;
      });
    });
    const first = reconcileRoutineNotificationIntents(f);
    await waiting;
    f.row.claimExpiresAt = new Date(0);
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("pending");
    expect(f.row.preSubmitFailures).toBe(1);
    rejectLookup(new Error("synthetic database interruption"));
    await first;
    expect(f.row.status).toBe("pending");
    expect(f.row.preSubmitFailures).toBe(1);
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("claims once across concurrent recovery and records provider acceptance", async () => {
    const f = fixture();
    await Promise.all([
      reconcileRoutineNotificationIntents(f),
      reconcileRoutineNotificationIntents(f),
    ]);
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.row.status).toBe("accepted");
    expect(f.row.claimToken).toBeNull();
    expect(f.row).toMatchObject({
      receiptTicketId: "ticket",
      receiptTokenDigest: "digest",
      receiptStatus: "pending",
    });
  });
  it("never replays an expired submission of unknown outcome", async () => {
    const f = fixture({ initialStatus: "submitting" });
    f.row.claimToken = "lost-worker";
    f.row.claimExpiresAt = new Date(0);
    await reconcileRoutineNotificationIntents(f);
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("uncertain");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("cancels pending delivery after its protected message is cleared", async () => {
    const f = fixture({ noMessage: true });
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("cancelled");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("honors a disabled bot notification preference", async () => {
    const f = fixture();
    f.row.run.bot.notifyOnFinish = false;
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("cancelled");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("honors a disabled routine notification preference before submission", async () => {
    const f = fixture();
    f.row.run.routineNotify = false;
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("cancelled");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("honors a preference disabled after preparation but before submission", async () => {
    const f = fixture();
    f.table.findFirst.mockImplementationOnce(async () => structuredClone(f.row));
    f.table.findFirst.mockImplementationOnce(async () => {
      f.row.run.bot.notifyOnFinish = false;
      return { id: f.row.id };
    });

    await reconcileRoutineNotificationIntents(f);

    expect(f.row.status).toBe("cancelled");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("uses an enabled preference committed before submission", async () => {
    const f = fixture();
    f.row.run.bot.notifyOnFinish = false;
    f.table.findFirst.mockImplementationOnce(async () => structuredClone(f.row));
    f.table.findFirst.mockImplementationOnce(async () => {
      f.row.run.bot.notifyOnFinish = true;
      return { id: f.row.id };
    });

    await reconcileRoutineNotificationIntents(f);

    expect(f.row.status).toBe("accepted");
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("preserves group notifications when the bot preference is disabled", async () => {
    const f = fixture();
    f.row.run.bot.notifyOnFinish = false;
    (f.row.run.thread as { groupId: string | null }).groupId = "group";

    await reconcileRoutineNotificationIntents(f);

    expect(f.row.status).toBe("accepted");
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("does not submit after a claim expires before admission", async () => {
    const f = fixture();
    f.table.findFirst.mockImplementationOnce(async () => structuredClone(f.row));
    f.table.findFirst.mockImplementationOnce(async () => {
      f.row.claimExpiresAt = new Date(0);
      return { id: f.row.id };
    });

    await reconcileRoutineNotificationIntents(f);

    expect(f.row.status).toBe("preparing");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("keeps the outcome of a submission already admitted before the preference changes", async () => {
    const f = fixture();
    f.deliver.mockImplementationOnce(async (_message, _context, accepted) => {
      f.row.run.bot.notifyOnFinish = false;
      await accepted?.("ticket", "digest");
      return "delivered";
    });

    await reconcileRoutineNotificationIntents(f);

    expect(f.row.status).toBe("accepted");
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("does not call a provider for a mismatched run owner", async () => {
    const f = fixture();
    f.row.run.userId = "other-owner";
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("blocked");
    expect(f.deliver).not.toHaveBeenCalled();
  });
  it("records an uncertain provider error without replaying", async () => {
    const f = fixture();
    f.deliver.mockRejectedValue(new Error("unknown"));
    await reconcileRoutineNotificationIntents(f);
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("uncertain");
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("keeps an accepted but unrecorded ticket uncertain without resending", async () => {
    const f = fixture();
    const update = f.table.updateMany.getMockImplementation()!;
    f.table.updateMany.mockImplementation(async (input) => {
      if (input.data.status === "accepted") throw new Error("database unavailable");
      return update(input);
    });
    await reconcileRoutineNotificationIntents(f);
    await reconcileRoutineNotificationIntents(f);
    expect(f.row.status).toBe("uncertain");
    expect(f.deliver).toHaveBeenCalledOnce();
  });
  it("does not report an unavailable session lookup as an undeliverable recipient", async () => {
    const f = fixture();
    const tokens = new MemoryPushTokenStore();
    await tokens.save("owner", "ExponentPushToken[synthetic]", "session");
    const notifications = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async () => {
        throw new Error("database unavailable");
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await reconcileRoutineNotificationIntents({ ...f, notifications });
      expect(f.row.status).toBe("uncertain");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await tokens.load("owner"))?.token).toBe("ExponentPushToken[synthetic]");
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("does not let a late response overwrite an expired claim or cause another send", async () => {
    const f = fixture();
    let started!: () => void;
    let release!: (value: "delivered") => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.deliver.mockImplementation(async (_message, _context, accepted) => {
      started();
      await new Promise<"delivered">((resolve) => {
        release = resolve;
      });
      await accepted?.("ticket", "digest");
      return "delivered";
    });
    const first = reconcileRoutineNotificationIntents(f);
    await sent;
    f.row.claimExpiresAt = new Date(0);
    await reconcileRoutineNotificationIntents(f);
    release("delivered");
    await first;
    expect(f.row.status).toBe("uncertain");
    expect(f.deliver).toHaveBeenCalledOnce();
  });
});
