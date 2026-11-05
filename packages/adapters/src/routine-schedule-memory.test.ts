import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRoutineScheduleReconciler } from "./routine-schedule-memory.js";
import { InMemoryJobQueue } from "./wakeup.js";

type Row = {
  routineId: string;
  generation: bigint;
  active: boolean;
  nextRunAt: Date | null;
  operation: "upsert" | "delete";
  uncertain?: boolean;
};

function fixture() {
  let enabled = true;
  const rows = new Map<string, Row>();
  const tx = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const sql = strings.join("?");
      if (sql.includes("routine_schedule_gate")) return [{ enabled }];
      if (sql.includes("routine_schedule_outbox")) {
        return [...rows.values()]
          .filter((row) => row.routineId > String(values[0]))
          .sort((a, b) => a.routineId.localeCompare(b.routineId))
          .slice(0, Number(values[1]))
          .map((row) => ({ ...row, uncertain: row.uncertain ?? false }));
      }
      throw new Error("Unexpected query");
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) };
  return {
    prisma: prisma as never,
    rows,
    setEnabled(value: boolean) {
      enabled = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("in-memory routine schedule reconciliation", () => {
  it("does not fire a long-future wake when Node's timer limit is reached", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const duration = 40 * 24 * 60 * 60 * 1_000;
    const due = new Date(Date.now() + duration);
    f.rows.set("r", {
      routineId: "r",
      generation: 1n,
      active: true,
      nextRunAt: due,
      operation: "upsert",
    });
    const queue = new InMemoryJobQueue();
    const wake = vi.fn(async (_payload: unknown) => undefined);
    await queue.start({ "routine.wakeup": wake } as unknown as BackgroundJobHandlers);
    await createMemoryRoutineScheduleReconciler(f.prisma, queue)();
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(wake).not.toHaveBeenCalled();
    expect(queue.keyedJob("routine:v2:r")?.availableAt).toEqual(due);
    await vi.advanceTimersByTimeAsync(1);
    await queue.awaitIdle();
    expect(wake).toHaveBeenCalledOnce();
    await queue.close();
  });

  it("restores a future intent after restart without duplicating the queued job", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const due = new Date(Date.now() + 20_000);
    f.rows.set("r", {
      routineId: "r",
      generation: 1n,
      active: true,
      nextRunAt: due,
      operation: "upsert",
    });
    const first = new InMemoryJobQueue();
    const wake = vi.fn(async (_payload: unknown) => undefined);
    const handlers = { "routine.wakeup": wake } as unknown as BackgroundJobHandlers;
    await first.start(handlers);
    const reconcile = createMemoryRoutineScheduleReconciler(f.prisma, first);
    await reconcile();
    await reconcile();
    expect(first.keyedJob("routine:v2:r")?.availableAt).toEqual(due);
    await first.close();
    expect(wake).not.toHaveBeenCalled();

    const restarted = new InMemoryJobQueue();
    await restarted.start(handlers);
    await createMemoryRoutineScheduleReconciler(f.prisma, restarted)();
    await vi.advanceTimersByTimeAsync(20_000);
    await restarted.awaitIdle();
    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0]?.[0]).toMatchObject({ routineId: "r", generation: "1" });
    await restarted.close();
  });

  it("recovers an unclaimed wake after a handler failure but does not duplicate an active handler", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.rows.set("r", {
      routineId: "r",
      generation: 1n,
      active: true,
      nextRunAt: new Date(Date.now()),
      operation: "upsert",
    });
    const queue = new InMemoryJobQueue();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake = vi.fn(async () => {
      if (wake.mock.calls.length === 1) {
        await held;
        throw new Error("synthetic handler failure");
      }
    });
    await queue.start({ "routine.wakeup": wake } as unknown as BackgroundJobHandlers);
    const reconcile = createMemoryRoutineScheduleReconciler(f.prisma, queue);
    await reconcile();
    await vi.advanceTimersByTimeAsync(0);
    await reconcile();
    expect(wake).toHaveBeenCalledOnce();
    expect(queue.keyedJob("routine:v2:r")).toBeUndefined();
    release();
    await queue.awaitIdle();
    await reconcile();
    await queue.awaitIdle();
    expect(wake).toHaveBeenCalledTimes(2);
    await queue.close();
  });

  it("does not repeatedly publish an uncertain watch, including after restart", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const row: Row = {
      routineId: "r",
      generation: 1n,
      active: true,
      nextRunAt: new Date(Date.now()),
      operation: "upsert",
    };
    f.rows.set("r", row);
    const wake = vi.fn(async () => {
      row.uncertain = true;
    });
    const queue = new InMemoryJobQueue();
    await queue.start({ "routine.wakeup": wake } as unknown as BackgroundJobHandlers);
    const reconcile = createMemoryRoutineScheduleReconciler(f.prisma, queue);
    await reconcile();
    await queue.awaitIdle();
    await reconcile();
    await reconcile();
    await queue.awaitIdle();
    expect(wake).toHaveBeenCalledOnce();
    await queue.close();

    const restarted = new InMemoryJobQueue();
    await restarted.start({ "routine.wakeup": wake } as unknown as BackgroundJobHandlers);
    const reconcileAfterRestart = createMemoryRoutineScheduleReconciler(f.prisma, restarted);
    await reconcileAfterRestart();
    await restarted.awaitIdle();
    expect(wake).toHaveBeenCalledOnce();
    row.uncertain = false;
    row.generation = 2n;
    await reconcileAfterRestart();
    await restarted.awaitIdle();
    expect(wake).toHaveBeenCalledTimes(2);
    await restarted.close();
  });

  it("replaces same-time rearms and cancels on deletion or gate shutdown", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const due = new Date(Date.now() + 30_000);
    const row: Row = {
      routineId: "r",
      generation: 1n,
      active: true,
      nextRunAt: due,
      operation: "upsert",
    };
    f.rows.set("r", row);
    const queue = new InMemoryJobQueue();
    const wake = vi.fn(async (_payload: unknown) => undefined);
    await queue.start({ "routine.wakeup": wake } as unknown as BackgroundJobHandlers);
    const reconcile = createMemoryRoutineScheduleReconciler(f.prisma, queue);
    await reconcile();
    row.generation = 2n;
    await reconcile();
    await vi.advanceTimersByTimeAsync(30_000);
    await queue.awaitIdle();
    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0]?.[0]).toMatchObject({ generation: "2" });

    row.generation = 3n;
    row.nextRunAt = new Date(Date.now() + 30_000);
    await reconcile();
    row.generation = 4n;
    row.operation = "delete";
    row.active = false;
    row.nextRunAt = null;
    await reconcile();
    expect(queue.keyedJob("routine:v2:r")).toBeUndefined();
    row.operation = "upsert";
    row.active = true;
    row.generation = 5n;
    row.nextRunAt = new Date(Date.now() + 30_000);
    await reconcile();
    f.setEnabled(false);
    await reconcile();
    expect(queue.keyedJob("routine:v2:r")).toBeUndefined();
    await queue.close();
  });

  it("ignores a delayed stale publication at the handler's generation claim", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const row: Row = {
      routineId: "r",
      generation: 1n,
      active: true,
      nextRunAt: new Date(Date.now()),
      operation: "upsert",
    };
    f.rows.set("r", row);
    const queue = new InMemoryJobQueue();
    const effects: string[] = [];
    await queue.start({
      "routine.wakeup": async (payload: { generation?: string }) => {
        if (payload.generation === row.generation.toString() && row.active)
          effects.push(payload.generation);
      },
    } as unknown as BackgroundJobHandlers);
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (job) => {
      row.generation = 2n;
      await enqueue(job);
    };
    const reconcile = createMemoryRoutineScheduleReconciler(f.prisma, queue);
    await reconcile();
    await queue.awaitIdle();
    expect(effects).toEqual([]);
    queue.enqueue = enqueue;
    await reconcile();
    await queue.awaitIdle();
    expect(effects).toEqual(["2"]);
    await queue.close();
  });

  it("continues paginated recovery and retries a failed enqueue without skipping it", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const due = new Date(Date.now() + 20_000);
    for (let index = 0; index < 1_005; index += 1) {
      const routineId = `r${String(index).padStart(4, "0")}`;
      f.rows.set(routineId, {
        routineId,
        generation: 1n,
        active: true,
        nextRunAt: due,
        operation: "upsert",
      });
    }
    const queue = new InMemoryJobQueue();
    await queue.start({ "routine.wakeup": vi.fn() } as unknown as BackgroundJobHandlers);
    const enqueue = queue.enqueue.bind(queue);
    let failed = false;
    queue.enqueue = async (job) => {
      if (job.replaceKey === "routine:v2:r0050" && !failed) {
        failed = true;
        throw new Error("synthetic queue error");
      }
      await enqueue(job);
    };
    const reconcile = createMemoryRoutineScheduleReconciler(f.prisma, queue);
    await expect(reconcile()).rejects.toThrow("synthetic queue error");
    expect(queue.keyedJob("routine:v2:r0049")).toBeDefined();
    expect(queue.keyedJob("routine:v2:r0050")).toBeUndefined();
    await reconcile();
    expect(queue.keyedJob("routine:v2:r0050")).toBeDefined();
    expect(queue.keyedJob("routine:v2:r1004")).toBeDefined();
    await queue.close();
  });
});
