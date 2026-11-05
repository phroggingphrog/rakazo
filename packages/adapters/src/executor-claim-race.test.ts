import { describe, expect, it } from "vitest";
import { createRunExecutor } from "./executor.js";
import { writeComputerRunRequeue } from "./run-lifecycle.js";

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  checkpoint: string | null;
  leaseFence: number;
  leaseOwner: string | null;
};

// Only the predicates emitted by the real executor and requeue helper are supported.
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(where)) {
    if (field === "AND" || field === "OR") {
      if (!Array.isArray(expected)) throw new Error(`Unsupported ${field}`);
      const values = expected.map((part) => matches(row, part as Record<string, unknown>));
      if (field === "AND" ? !values.every(Boolean) : !values.some(Boolean)) return false;
      continue;
    }
    if (!Object.hasOwn(row, field)) throw new Error(`Unsupported field ${field}`);
    const actual = row[field];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      for (const [op, value] of Object.entries(expected)) {
        if (op === "in") {
          if (!Array.isArray(value)) throw new Error("Unsupported in");
          if (!value.includes(actual)) return false;
        } else if (op === "lte") {
          if (!(value instanceof Date)) throw new Error("Unsupported lte value");
          if (!(actual instanceof Date) || actual.getTime() > value.getTime()) return false;
        } else throw new Error(`Unsupported operator ${op}`);
      }
    } else if (actual !== expected) return false;
  }
  return true;
}

describe("run acquisition generation", () => {
  it("rejects a stale claimant after another attempt claims and requeues the run", async () => {
    const worker = "synthetic-same-worker";
    const sentinel = "stop before computer lookup";
    const row: Row = {
      id: "synthetic-run",
      status: "queued",
      checkpoint: null,
      wakeAt: null,
      leaseFence: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      botId: "synthetic-bot",
      threadId: "synthetic-thread",
      spaceId: "synthetic-space",
      userId: "synthetic-user",
    };
    let stops = 0;
    let release!: () => void;
    let notice!: () => void;
    const paused = new Promise<void>((resolve) => {
      notice = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        matches(row, where) ? structuredClone(row) : null,
      findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        if (!matches(row, where)) throw new Error("Synthetic run missing");
        return structuredClone(row);
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!matches(row, where)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      },
    };
    const executor = (pause: boolean) => {
      const runDelegate = {
        ...run,
        findUnique: pause
          ? async (input: { where: Record<string, unknown> }) => {
              const snapshot = await run.findUnique(input);
              notice();
              await released;
              return snapshot;
            }
          : run.findUnique,
      };
      return createRunExecutor({
        prisma: {
          run: runDelegate,
          bot: {
            findUniqueOrThrow: async () => {
              stops++;
              throw new Error(sentinel);
            },
          },
        },
        events: {},
        web: {},
        browser: {},
        mediaGeneration: {},
      } as never);
    };
    const a = executor(true);
    const b = executor(false);
    const pending = a.continueRun(row.id, worker).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Promise.race([
      paused,
      pending.then((result) => {
        if (!result.ok) throw result.error;
        throw new Error("The first claimant did not pause");
      }),
    ]);
    await expect(b.continueRun(row.id, worker)).rejects.toThrow(sentinel);
    expect(row).toMatchObject({ status: "running", leaseOwner: worker, leaseFence: 1 });
    expect(
      await writeComputerRunRequeue(
        { prisma: { run } } as never,
        row.id,
        worker,
        1,
        null,
        false,
        null,
        null,
      ),
    ).toBe(true);
    expect(row).toMatchObject({ status: "queued", leaseOwner: null, leaseFence: 1 });
    release();
    expect(await pending).toEqual({ ok: true });
    expect(row).toMatchObject({ status: "queued", leaseOwner: null, leaseFence: 1 });
    expect(stops).toBe(1);
    await expect(executor(false).continueRun(row.id, worker)).rejects.toThrow(sentinel);
    expect(row).toMatchObject({ status: "running", leaseOwner: worker, leaseFence: 2 });
    expect(stops).toBe(2);
  });
});
