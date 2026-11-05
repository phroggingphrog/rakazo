import type { Actor } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import { runFailureError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listRoutineRuns } from "./routine-runs.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const at = new Date("2026-01-02T12:00:00Z");
function fixture() {
  const routine = vi.fn().mockResolvedValue({ botId: "bot-1" });
  const runs = vi.fn().mockResolvedValue([]);
  const messages = vi.fn().mockResolvedValue([]);
  const prisma = {
    routine: { findFirst: routine },
    run: { findMany: runs },
    $queryRaw: messages,
  } as unknown as PrismaClient;
  return { prisma, routine, runs, messages };
}
describe("routine history", () => {
  it.each([
    ["pending", "pending"],
    ["preparing", "pending"],
    ["submitting", "submitting"],
    ["uncertain", "uncertain"],
    ["undeliverable", "undeliverable"],
    ["cancelled", "cancelled"],
    ["blocked", "blocked"],
    ["unexpected", "unknown"],
    [null, "unknown"],
  ])("projects notification status %s for the owner", async (status, expected) => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue([
      {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        routineNotification: status ? { status, receiptStatus: null } : null,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    const result = RoutineHistorySchema.parse(await listRoutineRuns(prisma, actor, "routine-1"));
    expect(result.runs[0]?.notification).toBe(expected);
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
      }),
    );
  });
  it.each([
    ["ok", "expo_receipt_ok"],
    ["device_not_registered", "expo_receipt_error"],
    ["error", "expo_receipt_error"],
    ["unavailable", "expo_receipt_unavailable"],
    ["pending", "expo_accepted"],
  ])("maps receipt %s without exposing provider references", async (receiptStatus, expected) => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue([
      {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        routineNotification: { status: "accepted", receiptStatus },
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    expect((await listRoutineRuns(prisma, actor, "routine-1")).runs[0]?.notification).toBe(
      expected,
    );
  });
  it("exposes Expo acceptance only on the owner's scoped run without claiming a receipt", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue([
      {
        id: "run-1",
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        routineNotification: { status: "accepted" },
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history).runs[0]?.notification).toBe("expo_accepted");
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: actor.spaceId, userId: actor.userId }),
        select: expect.objectContaining({
          routineNotification: {
            select: { status: true, receiptStatus: true, preSubmitFailures: true },
          },
        }),
      }),
    );
    expect(JSON.stringify(history)).not.toContain("ticket");
  });

  it.each([
    ["blocked", 5, true],
    ["blocked", 4, false],
    ["accepted", 5, false],
  ])(
    "reports exhausted preparation only for a blocked intent",
    async (status, failures, expected) => {
      const { prisma, runs } = fixture();
      runs.mockResolvedValue([
        {
          id: "run-1",
          botId: "bot-1",
          threadId: "thread-1",
          thread: { groupId: null },
          status: "completed",
          routineNotification: { status, receiptStatus: null, preSubmitFailures: failures },
          createdAt: at,
          startedAt: at,
          completedAt: at,
        },
      ]);
      const result = RoutineHistorySchema.parse(await listRoutineRuns(prisma, actor, "routine-1"));
      expect(result.runs[0]?.notificationRetryExhausted).toBe(expected);
    },
  );
  it("refuses missing, foreign or archived routines before reading runs", async () => {
    const { prisma, routine, runs, messages } = fixture();
    routine.mockResolvedValue(null);
    await expect(listRoutineRuns(prisma, actor, "routine-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(routine).toHaveBeenCalledWith({
      where: {
        id: "routine-1",
        spaceId: actor.spaceId,
        userId: actor.userId,
        bot: { archivedAt: null },
      },
      select: { botId: true },
    });
    expect(runs).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });
  it("returns a bounded, newest-first history including silent, failed and queued runs", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockResolvedValue(
      ["completed", "failed", "queued"].map((status, i) => ({
        id: `run-${i}`,
        taskId: `task-${i}`,
        _count: { attempts: i + 1, effects: i === 1 ? 1 : 0 },
        trigger: "routine",
        wakeAt: status === "queued" ? at : null,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: i === 1 ? "group-1" : null },
        status,
        error: "504: request timed out",
        createdAt: at,
        startedAt: status === "queued" ? null : at,
        completedAt: status === "queued" ? null : new Date(at.getTime() + 82_000),
      })),
    );
    messages.mockResolvedValue([{ id: "reply-new", runId: "run-1", threadId: "thread-1" }]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history)).toEqual(history);
    expect(history.runs.map((row) => row.taskId)).toEqual(["task-0", "task-1", "task-2"]);
    expect(history.runs.map((row) => row.nextAttemptAt)).toEqual([null, null, at.toISOString()]);
    expect(history.runs.every((row) => row.trigger === "routine")).toBe(true);
    expect(history.runs.map((row) => row.lifecycle)).toEqual(["completed", "failed", "retrying"]);
    expect(history.runs.map((row) => row.attemptCount)).toEqual([1, 2, 3]);
    expect(history.runs.map((row) => row.unresolvedEffectCount)).toEqual([0, 1, 0]);
    expect(history.runs.map((row) => row.messageId)).toEqual([null, "reply-new", null]);
    expect(history.runs.map((row) => row.groupId)).toEqual([null, "group-1", null]);
    expect(history.runs[2]?.startedAt).toBeNull();
    expect(history.runs.map((row) => row.error)).toEqual([null, "504: request timed out", null]);
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ error: true }) }),
    );
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          routineId: "routine-1",
          botId: "bot-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        take: 21,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    const sql = messages.mock.calls[0]?.[0];
    expect(sql.sql).toContain('DISTINCT ON (m."runId")');
    expect(sql.sql).toContain('r."threadId" = m."threadId"');
    expect(sql.values).toEqual([
      "run-0",
      "run-1",
      "run-2",
      actor.spaceId,
      actor.userId,
      actor.spaceId,
      actor.userId,
    ]);
  });
  it("returns a shorter page with a cursor when asked for fewer runs", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: `run-${i}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        error: null,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      })),
    );
    const history = await listRoutineRuns(prisma, actor, "routine-1", undefined, 2);
    expect(runs).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(history.runs.map((row) => row.id)).toEqual(["run-0", "run-1"]);
    expect(history.nextCursor).toEqual({ id: "run-1", createdAt: at.toISOString() });
  });
  it("bounds stored errors like thread failures", async () => {
    const { prisma, runs } = fixture();
    const error = "x".repeat(400);
    runs.mockResolvedValue([
      {
        id: "failed-run",
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "failed",
        error,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(history.runs[0]?.error).toBe(`${"x".repeat(300)}…`);
    expect(history.runs[0]?.error).toBe(
      runFailureError({ type: "run.failed", payload: { error } }),
    );
  });
  it("does not confuse a database failure with an empty history", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockRejectedValue(new Error("database unavailable"));
    await expect(listRoutineRuns(prisma, actor, "routine-1")).rejects.toThrow(
      "database unavailable",
    );
    expect(messages).not.toHaveBeenCalled();
  });
  it("skips the message query when the routine has never run", async () => {
    const { prisma, messages } = fixture();
    await expect(listRoutineRuns(prisma, actor, "routine-1")).resolves.toEqual({
      runs: [],
      nextCursor: null,
    });
    expect(messages).not.toHaveBeenCalled();
  });
  it("pages all history using stable timestamp/id boundaries without including the lookahead row", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({
        id: `run-${String(30 - i).padStart(2, "0")}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        createdAt: at,
        startedAt: at,
        completedAt: at,
      })),
    );
    const first = await listRoutineRuns(prisma, actor, "routine-1");
    expect(first.runs).toHaveLength(20);
    expect(first.nextCursor).toEqual({ id: "run-11", createdAt: at.toISOString() });
    runs.mockResolvedValue([]);
    const next = await listRoutineRuns(prisma, actor, "routine-1", first.nextCursor!);
    expect(next).toEqual({ runs: [], nextCursor: null });
    expect(runs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          routineId: "routine-1",
          botId: "bot-1",
          spaceId: actor.spaceId,
          userId: actor.userId,
          OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: "run-11" } }],
        },
      }),
    );
  });
  it("keeps the group destination of a routine execution", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockResolvedValue([
      {
        id: "group-run",
        botId: "bot-1",
        threadId: "group-thread",
        thread: { groupId: "group-1" },
        status: "completed",
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    messages.mockResolvedValue([
      { id: "group-reply", runId: "group-run", threadId: "group-thread" },
    ]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history).runs[0]).toMatchObject({
      groupId: "group-1",
      messageId: "group-reply",
    });
  });
});
