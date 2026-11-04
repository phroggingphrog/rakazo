import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { deferFutureRoutine } from "./run-routines.js";

describe("routine scheduling", () => {
  it("never fires a future occurrence early", async () => {
    const scheduledAt = new Date(Date.now() + 60_000);
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    const jobs: JobPublisher = {
      enqueue,
      cancel: async () => undefined,
      close: async () => undefined,
    };

    expect(await deferFutureRoutine(jobs, "routine-1", scheduledAt)).toBe(true);

    expect(enqueue).toHaveBeenCalledWith({
      name: "routine.wakeup",
      payload: { routineId: "routine-1", scheduledFor: scheduledAt.toISOString() },
      availableAt: scheduledAt,
      replaceKey: "routine:routine-1",
    });
  });

  it("defers an occurrence even when it is less than one second away", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
    try {
      expect(
        await deferFutureRoutine(
          { enqueue, cancel: vi.fn(), close: vi.fn() },
          "routine-1",
          new Date(1_000_500),
        ),
      ).toBe(true);
      expect(enqueue).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
});

function pendingTimerFixture(reuse = true) {
  const scheduledAt = new Date(Date.now() - 1_000);
  const routine = {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    prompt: "check current work",
    crons: ["* * * * *"],
    timezone: "UTC",
    active: true,
    nextRunAt: scheduledAt,
    watch: null,
  };
  const pending = {
    id: "pending-1",
    taskId: "task-1",
    leaseFence: 0,
    updatedAt: scheduledAt,
  };
  const tx = {
    setupPlan: { findFirst: vi.fn(async () => null) },
    computerExecutionLease: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    routine: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ modelProvider: null, modelId: null, thinkingLevel: null })),
    },
    run: {
      findMany: vi.fn(async () => (reuse ? [pending] : [])),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async () => ({ id: "new-1", taskId: "task-1" })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    task: {
      create: vi.fn(async () => ({ id: "task-1" })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    routine: { findUnique: vi.fn(async () => routine) },
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    agentSkill: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const append = vi.fn();
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue, cancel: vi.fn(), close: vi.fn() },
    events: { append },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { executor, prisma, routine, tx, enqueue, append, scheduledAt };
}

describe("recurring routine catch-up", () => {
  it.each([
    { before: ["* * * * *"], crons: ["0 9 * * *"], timezone: "UTC" },
    { before: ["* * * * *"], crons: ["* * * * *"], timezone: "Australia/Melbourne" },
    { before: ["* * * * *"], crons: ["@once"], timezone: "UTC" },
    { before: ["@once"], crons: ["0 9 * * *"], timezone: "UTC" },
  ])(
    "does not overwrite a concurrent schedule edit: $before to $crons in $timezone",
    async (edit) => {
      const { executor, prisma, routine, tx, enqueue, scheduledAt } = pendingTimerFixture(false);
      routine.crons = edit.before;
      prisma.routine.findUnique.mockImplementationOnce(async () => ({ ...routine }));
      prisma.agentSkill.findMany.mockImplementationOnce(async () => {
        routine.crons = edit.crons;
        routine.timezone = edit.timezone;
        return [];
      });
      tx.routine.updateMany.mockImplementationOnce(async (...args: unknown[]) => {
        const input = args[0] as { where: { crons?: { equals: string[] }; timezone?: string } };
        const cronMatches =
          !input.where.crons ||
          JSON.stringify(input.where.crons.equals) === JSON.stringify(routine.crons);
        const timezoneMatches = !input.where.timezone || input.where.timezone === routine.timezone;
        return { count: cronMatches && timezoneMatches ? 1 : 0 };
      });

      await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

      expect(tx.task.create).not.toHaveBeenCalled();
      expect(tx.run.create).not.toHaveBeenCalled();
      expect(routine.crons).toEqual(edit.crons);
      expect(routine.timezone).toBe(edit.timezone);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "routine.wakeup",
          payload: { routineId: "routine-1", scheduledFor: scheduledAt.toISOString() },
        }),
      );
    },
  );
  it("does not republish a failed claim if the schedule was paused", async () => {
    const { executor, prisma, routine, tx, enqueue, scheduledAt } = pendingTimerFixture(false);
    prisma.routine.findUnique.mockImplementationOnce(async () => ({ ...routine }));
    prisma.agentSkill.findMany.mockImplementationOnce(async () => {
      routine.active = false;
      return [];
    });
    tx.routine.updateMany.mockResolvedValueOnce({ count: 0 });

    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());

    expect(enqueue).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
  });
  it("keeps one pending run and advances the next tick without a duplicate firing event", async () => {
    const { executor, tx, enqueue, append, scheduledAt } = pendingTimerFixture();
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: "pending-1" },
        keepExisting: true,
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
    expect(append).not.toHaveBeenCalled();
  });
  it("keeps the advanced schedule when publishing a reused run's wakeup fails", async () => {
    const { executor, tx, enqueue, scheduledAt } = pendingTimerFixture();
    enqueue.mockRejectedValueOnce(new Error("publisher unavailable"));
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.run.deleteMany).not.toHaveBeenCalled();
    expect(tx.task.deleteMany).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });
  it("preserves unclaimed durable work and advances scheduling when publication fails", async () => {
    const { executor, tx, enqueue, append, scheduledAt } = pendingTimerFixture(false);
    enqueue.mockRejectedValueOnce(new Error("publisher unavailable"));
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.run.deleteMany).not.toHaveBeenCalled();
    expect(tx.task.deleteMany).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.fired", runId: "new-1" }),
    );
    expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });
  it("advances past an occurrence that already fired instead of firing it again", async () => {
    const { executor, tx, enqueue, append, scheduledAt } = pendingTimerFixture(false);
    tx.run.findUnique.mockResolvedValueOnce({ id: "fired-1" });
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString());
    expect(tx.routine.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  });
});
