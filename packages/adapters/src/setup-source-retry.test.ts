import { TransientModelError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { scheduleRoutineRetry } from "./run-routines.js";

describe("routine retries after setup source tests", () => {
  it("does not automatically retry a source test, while an ordinary routine can retry", async () => {
    const source = vi.fn().mockResolvedValue({ id: "source-effect" });
    const enqueue = vi.fn();
    const deps = {
      prisma: {
        routine: { findUnique: vi.fn(async () => ({ nextRunAt: null })) },
        event: { count: vi.fn(async () => 0) },
        message: { count: vi.fn(async () => 0) },
        externalEffect: { findFirst: source },
      },
      jobs: { enqueue },
    };
    const run = {
      id: "run",
      threadId: "thread",
      trigger: "routine",
      routineId: "routine",
      retryOfRunId: null,
    };
    const error = new TransientModelError("temporary model failure");
    expect(await scheduleRoutineRetry(deps as never, run, error)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    source.mockResolvedValue(null);
    expect(await scheduleRoutineRetry(deps as never, run, error)).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
