import type { ProactiveEvent, Wake } from "@rakazo/proactive";
import { describe, expect, it, vi } from "vitest";
import { RakazoWakeTarget, routineSourceFromEnv, routineWake } from "./proactive.js";

const routineEvent = (routineId: string, scheduledFor: string): ProactiveEvent => ({
  source: `routine:bot-1`,
  id: `${routineId}:${new Date(scheduledFor).getTime()}`,
  kind: "timer",
  at: Date.parse(scheduledFor),
  scope: "bot:bot-1",
  text: "Daily brief",
  raw: { routineId, scheduledFor },
});

const wake = (events: ProactiveEvent[]): Wake => ({
  id: "timer:bot:bot-1:e1",
  scope: "bot:bot-1",
  reason: "timer",
  events,
});

describe("routineSourceFromEnv", () => {
  it("is off unless explicitly switched on", () => {
    expect(routineSourceFromEnv({})).toBe(false);
    expect(routineSourceFromEnv({ PROACTIVE_ROUTINE_SOURCE: "" })).toBe(false);
    expect(routineSourceFromEnv({ PROACTIVE_ROUTINE_SOURCE: "0" })).toBe(false);
    expect(routineSourceFromEnv({ PROACTIVE_ROUTINE_SOURCE: "no" })).toBe(false);
  });

  it("accepts the usual ways of writing yes", () => {
    expect(routineSourceFromEnv({ PROACTIVE_ROUTINE_SOURCE: "1" })).toBe(true);
    expect(routineSourceFromEnv({ PROACTIVE_ROUTINE_SOURCE: " TRUE " })).toBe(true);
    expect(routineSourceFromEnv({ PROACTIVE_ROUTINE_SOURCE: "yes" })).toBe(true);
  });
});

describe("routineWake", () => {
  it("recognises a wake made only of one routine occurrence", () => {
    expect(
      routineWake(wake([routineEvent("routine-1", "2026-11-04T21:00:00.000Z")]).events),
    ).toEqual({
      routineId: "routine-1",
      scheduledFor: "2026-11-04T21:00:00.000Z",
    });
  });

  it("treats anything else as a normal wake", () => {
    const webhook: ProactiveEvent = {
      source: "webhook:bot-1",
      id: "abc",
      kind: "webhook",
      at: 0,
      scope: "bot:bot-1",
      text: "hello",
      raw: { prompt: "hello" },
    };
    expect(routineWake([webhook])).toBeNull();
    expect(
      routineWake([routineEvent("routine-1", "2026-11-04T21:00:00.000Z"), webhook]),
    ).toBeNull();
    expect(routineWake([])).toBeNull();
  });

  it("does not merge two different occurrences into one run", () => {
    expect(
      routineWake(
        wake([
          routineEvent("routine-1", "2026-11-04T21:00:00.000Z"),
          routineEvent("routine-1", "2026-11-05T21:00:00.000Z"),
        ]).events,
      ),
    ).toBeNull();
  });
});

describe("RakazoWakeTarget with a routine wake", () => {
  it("hands the occurrence to the routine runner instead of composing a prompt", async () => {
    const startRoutine = vi.fn(async () => ({ ref: "run-1" }));
    const sendUserMessage = vi.fn(async () => ({ runId: "run-2", messageId: "m-2" }));
    const target = new RakazoWakeTarget({
      prisma: {} as never,
      events: { sendUserMessage } as never,
      jobs: { enqueue: vi.fn() } as never,
      startRoutine,
    });
    const result = await target.deliver(
      wake([routineEvent("routine-1", "2026-11-04T21:00:00.000Z")]),
    );
    expect(result).toEqual({ ref: "run-1" });
    expect(startRoutine).toHaveBeenCalledWith("routine-1", "2026-11-04T21:00:00.000Z");
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("refuses a routine wake when no routine runner is wired", async () => {
    const target = new RakazoWakeTarget({
      prisma: {} as never,
      events: { sendUserMessage: vi.fn() } as never,
      jobs: { enqueue: vi.fn() } as never,
    });
    await expect(
      target.deliver(wake([routineEvent("routine-1", "2026-11-04T21:00:00.000Z")])),
    ).rejects.toThrow("A routine wake needs a routine starter");
  });
});
