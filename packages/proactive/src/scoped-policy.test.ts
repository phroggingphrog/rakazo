import { describe, expect, it } from "vitest";
import { ProactiveEngine } from "./engine.js";
import { FakeClock, FakeJudge, FakeScheduler, FakeTarget } from "./fakes.js";
import { MemoryProactiveStore } from "./memory-store.js";

const event = {
  source: "test",
  id: "one",
  scope: "bot:test",
  kind: "message",
  at: 1,
  text: "help",
};
function setup(scopePolicy?: ConstructorParameters<typeof ProactiveEngine>[0]["scopePolicy"]) {
  const target = new FakeTarget();
  const judge = new FakeJudge(() => 0);
  const clock = new FakeClock();
  const store = new MemoryProactiveStore();
  const engine = new ProactiveEngine({
    store,
    target,
    judge,
    clock,
    scheduler: new FakeScheduler(clock),
    scopePolicy,
  });
  return { engine, target, judge, store, clock };
}
describe("scoped proactive policy", () => {
  it("preserves default direct-message precedence", async () => {
    const { engine, judge } = setup();
    expect(await engine.policy(event.scope, [{ ...event, addressed: "dm" }])).toEqual({
      kind: "wake",
      reason: "dm",
    });
    expect(judge.calls).toBe(0);
  });
  it("supports owner-defined decision order", async () => {
    const { engine, judge } = setup(async () => ({ order: ["judge", "dm"] }));
    expect(await engine.policy(event.scope, [{ ...event, addressed: "dm" }])).toEqual({
      kind: "drop",
      reason: "judge_no",
    });
    expect(judge.calls).toBe(1);
  });
  it("does not react to sent feedback even while working", async () => {
    const { engine, target, judge } = setup();
    target.working.add(event.scope);
    expect(await engine.policy(event.scope, [{ ...event, kind: "sent" }])).toEqual({
      kind: "drop",
      reason: "heard",
    });
    expect(judge.calls).toBe(0);
  });
  it("evaluates scope hooks before the judge", async () => {
    const { engine } = setup(async () => ({
      rules: [(events) => (events[0]?.source === "test" ? { name: "hook" } : null)],
    }));
    expect(await engine.policy(event.scope, [event])).toEqual({
      kind: "wake",
      reason: "rule:hook",
    });
  });
  it("fires a self-set timer once and never fires a cancelled timer", async () => {
    const { engine, clock } = setup();
    await engine.setTimer({
      id: "one",
      scope: event.scope,
      dueAt: clock.now() + 300000,
      note: "check task",
      setBy: "bot",
    });
    await engine.setTimer({
      id: "two",
      scope: event.scope,
      dueAt: clock.now() + 300000,
      note: "cancelled",
      setBy: "bot",
    });
    expect(await engine.cancelTimer("two")).toBe(true);
    clock.advance(300000);
    expect(await engine.fireTimers()).toBe(1);
    expect(await engine.fireTimers()).toBe(0);
  });
  it("uses scoped fallback interval and avoids repeat arming", async () => {
    const { engine, store, clock } = setup(async () => ({ fallbackMs: 300_000 }));
    await engine.ensureFallback(event.scope);
    await engine.ensureFallback(event.scope);
    expect(await store.nextTimerDue()).toBe(clock.now() + 300_000);
    expect(await store.hasPendingTimer(event.scope, "fallback:")).toBe(true);
  });
});
