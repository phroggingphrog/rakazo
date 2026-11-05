import { describe, expect, it } from "vitest";
import { ProactiveEngine } from "./engine.js";
import { FakeClock, FakeJudge, FakeScheduler, FakeTarget } from "./fakes.js";
import { MemoryProactiveStore } from "./memory-store.js";

const event = {
  source: "test",
  id: "deploy-failed",
  scope: "bot:test",
  kind: "message" as const,
  at: 1,
  text: "the deploy failed",
};

function setup(answer: number | Error) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const target = new FakeTarget();
  const judge = new FakeJudge(() => answer);
  const engine = new ProactiveEngine({
    store: new MemoryProactiveStore(),
    target,
    judge,
    clock,
    scheduler,
    // The outcome is what matters here, not the retry ladder.
    config: { judgeRetryMs: [] },
  });
  return { engine, target, judge, scheduler, clock };
}

describe("judge failures", () => {
  it("wakes the bot when the judge cannot answer", async () => {
    const { engine, target, judge, scheduler, clock } = setup(new Error("model down"));
    await engine.receive(event);
    await scheduler.runUntil(engine, clock.now() + 600_000);

    expect(judge.calls).toBe(1);
    expect(target.calls).toHaveLength(1);
    expect(target.calls[0]?.events.map((e) => e.id)).toEqual(["deploy-failed"]);
  });

  it("honours a judge that says no", async () => {
    const { engine, target, scheduler, clock } = setup(0);
    await engine.receive(event);
    await scheduler.runUntil(engine, clock.now() + 600_000);

    expect(target.calls).toHaveLength(0);
  });

  it("wakes the bot after the retry ladder is exhausted, not before", async () => {
    const clock = new FakeClock();
    const scheduler = new FakeScheduler(clock);
    const target = new FakeTarget();
    const judge = new FakeJudge(() => new Error("model down"));
    const engine = new ProactiveEngine({
      store: new MemoryProactiveStore(),
      target,
      judge,
      clock,
      scheduler,
      config: { judgeRetryMs: [1_000, 2_000] },
    });
    await engine.receive(event);
    await scheduler.runUntil(engine, clock.now() + 600_000);

    expect(judge.calls).toBe(3);
    expect(target.calls).toHaveLength(1);
  });
});
