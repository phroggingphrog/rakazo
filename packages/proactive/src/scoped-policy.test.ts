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
  it.each([
    { kind: "message", addressed: "dm", reason: "dm" },
    { kind: "message", addressed: "mention", reason: "mention" },
    { kind: "timer", addressed: undefined, reason: "timer" },
  ] as const)(
    "protects deterministic $reason from judge-first configuration",
    async ({ kind, addressed, reason }) => {
      const { engine, judge } = setup(async () => ({
        order: ["judge", "timer", "mention", "dm", "steer", "rules"],
      }));
      expect(await engine.policy(event.scope, [{ ...event, kind, addressed }])).toEqual({
        kind: "wake",
        reason,
      });
      expect(judge.calls).toBe(0);
    },
  );
  it("still judges unaddressed discretionary events with custom ordering", async () => {
    const { engine, judge } = setup(async () => ({ order: ["judge", "rules"] }));
    expect(await engine.policy(event.scope, [event])).toEqual({ kind: "drop", reason: "judge_no" });
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
  it("keeps fallback patrol disabled without affecting explicitly requested timers", async () => {
    const { engine, store, clock } = setup(async () => ({ fallbackMs: 0 }));
    await engine.ensureFallback(event.scope);
    expect(await store.hasPendingTimer(event.scope, "fallback:")).toBe(false);
    await engine.setTimer({ id: "explicit", scope: event.scope, dueAt: clock.now() + 300000, note: "requested", setBy: "bot" });
    expect(await store.nextTimerDue()).toBe(clock.now() + 300000);
  });
  it("ignores an already-queued fallback when patrol was disabled, while keeping explicit timers", async () => {
    const { engine } = setup(async () => ({ fallbackMs: 0 }));
    const stale = { ...event, source: "timer", kind: "timer", id: `fallback:${event.scope}:1` };
    expect(await engine.policy(event.scope, [stale])).toEqual({ kind: "drop", reason: "heard" });
    const requested = { ...stale, id: `self:${event.scope}:requested` };
    expect(await engine.policy(event.scope, [requested])).toEqual({ kind: "wake", reason: "timer" });
  });
});
