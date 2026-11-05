import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { dispatchVersionedRoutineWake } from "./wakeup.js";

describe("versioned routine queue dispatch", () => {
  it("requires a bounded generation and forwards it to the routine handler", async () => {
    const wake = vi.fn(async () => undefined);
    const handlers = { "routine.wakeup": wake } as unknown as BackgroundJobHandlers;
    const payload = { routineId: "routine-a", scheduledFor: "2030-01-01T00:00:00Z" };
    expect(() => dispatchVersionedRoutineWake(handlers, payload)).toThrow(
      "requires a schedule generation",
    );
    expect(() =>
      dispatchVersionedRoutineWake(handlers, { ...payload, generation: "9223372036854775808" }),
    ).toThrow();
    await dispatchVersionedRoutineWake(handlers, { ...payload, generation: "17" });
    expect(wake).toHaveBeenCalledExactlyOnceWith({ ...payload, generation: "17" });
  });
});
