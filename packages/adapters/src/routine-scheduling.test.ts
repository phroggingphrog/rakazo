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
});

function pendingTimerFixture(reuse = true, currentGeneration = "2", gateEnabled = true) {
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
    $queryRaw: vi.fn(
      async (sql: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
        const text = sql.join("");
        if (text.includes("current_setting")) return [{ bypass: "off" }];
        if (text.includes("routine_schedule_gate")) return [{ enabled: gateEnabled }];
        if (text.includes('"scheduleGeneration"') && values[1] !== currentGeneration) return [];
        return [{ id: "routine-1" }];
      },
    ),
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
    $queryRaw: vi.fn(async () => [{ id: "routine-1" }]),
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
    agentSkill: { findMany: vi.fn(async () => []) },
    connection: { findMany: vi.fn(async () => []) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    userActionApprovalRule: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
  };
  const enqueue = vi.fn(async (_job: BackgroundJob) => undefined);
  const append = vi.fn();
  const connector = {
    discoverTools: vi.fn(async () => [{ name: "sample_read", readOnly: true }]),
    execute: vi.fn(async function* () {
      yield { type: "result", data: "new value" };
    }),
  };
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue, cancel: vi.fn(), close: vi.fn() },
    events: { append },
    connector,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { executor, tx, enqueue, append, scheduledAt, routine, prisma, connector };
}

describe("versioned routine wakes", () => {
  it("does not claim a versioned wake while the scheduler gate is off", async () => {
    const { executor, tx, enqueue, scheduledAt } = pendingTimerFixture(false, "2", false);
    await expect(executor.wakeRoutine("routine-1", scheduledAt.toISOString(), "2")).rejects.toThrow(
      "awaiting scheduler cutover",
    );
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("does not claim a stale generation even when the scheduled time is the same", async () => {
    const { executor, tx, enqueue, scheduledAt } = pendingTimerFixture(false, "2");
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString(), "1");
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
    expect(tx.run.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("claims the matching generation and does not publish a legacy routine wake", async () => {
    const { executor, tx, enqueue, scheduledAt } = pendingTimerFixture(false, "2");
    await executor.wakeRoutine("routine-1", scheduledAt.toISOString(), "2");
    expect(tx.routine.updateMany).toHaveBeenCalledOnce();
    expect(tx.run.create).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "run.continue" }));
    expect(enqueue.mock.calls.some(([job]) => job.name === "routine.wakeup")).toBe(false);
  });

  it("does not enqueue an unversioned wake when a versioned job arrives early", async () => {
    const { executor, routine, enqueue } = pendingTimerFixture();
    routine.nextRunAt = new Date(Date.now() + 60_000);
    await expect(
      executor.wakeRoutine("routine-1", routine.nextRunAt.toISOString(), "2"),
    ).rejects.toThrow("before its scheduled time");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not replay an uncertain versioned watch", async () => {
    const { executor, routine, tx, enqueue } = pendingTimerFixture();
    Object.assign(routine, { watch: { kind: "command", command: "example" } });
    const query = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation(async (sql, ...values) => {
      if (sql.join("").includes("AS matches")) return [{ matches: true }];
      if (sql.join("").includes("SELECT state FROM routine_watch_attempts"))
        return [{ state: "uncertain" }];
      return query(sql, ...values);
    });
    await executor.wakeRoutine("routine-1", routine.nextRunAt.toISOString(), "2");
    expect(enqueue).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
  });

  it("claims, reads, and atomically advances a changed versioned watch", async () => {
    const { executor, routine, tx, connector, enqueue } = pendingTimerFixture(false);
    Object.assign(routine, {
      watch: { kind: "tool", tool: "sample_read", everyMinutes: 5 },
      watchState: {
        fingerprint: "previous",
        outcome: "unchanged",
        checkedAt: "2020-01-01T00:00:00.000Z",
        detail: null,
      },
    });
    const query = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation(async (sql, ...values) => {
      const text = sql.join("");
      if (text.includes("AS matches")) return [{ matches: true }];
      if (text.includes("SELECT state FROM routine_watch_attempts")) return [];
      if (text.includes("INSERT INTO routine_watch_attempts")) return [{ routineId: "routine-1" }];
      if (text.includes("UPDATE routine_watch_attempts")) return [{ routineId: "routine-1" }];
      return query(sql, ...values);
    });
    await executor.wakeRoutine("routine-1", routine.nextRunAt.toISOString(), "2");
    const insert = tx.$queryRaw.mock.calls.findIndex(([sql]) =>
      sql.join("").includes("INSERT INTO routine_watch_attempts"),
    );
    const remove = tx.$queryRaw.mock.calls.findIndex(([sql]) =>
      sql.join("").includes("UPDATE routine_watch_attempts"),
    );
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(insert);
    expect(tx.$queryRaw.mock.invocationCallOrder[insert]).toBeLessThan(
      connector.execute.mock.invocationCallOrder[0]!,
    );
    expect(connector.execute.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[remove]!,
    );
    expect(tx.routine.updateMany).toHaveBeenCalledOnce();
    expect(tx.run.create).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls.some(([job]) => job.name === "routine.wakeup")).toBe(false);
  });

  it("drops a stale versioned watch without attempting the watch or a legacy wake", async () => {
    const { executor, routine, tx, enqueue } = pendingTimerFixture();
    Object.assign(routine, { watch: { kind: "command", command: "example" } });
    const query = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation(async (sql, ...values) => {
      if (sql.join("").includes("AS matches")) return [{ matches: false }];
      if (sql.join("").includes("SELECT state FROM routine_watch_attempts")) return [];
      return query(sql, ...values);
    });
    await executor.wakeRoutine("routine-1", routine.nextRunAt.toISOString(), "1");
    expect(enqueue).not.toHaveBeenCalled();
    expect(tx.routine.updateMany).not.toHaveBeenCalled();
  });
});

describe("recurring routine catch-up", () => {
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
