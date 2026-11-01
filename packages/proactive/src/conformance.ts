import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { ProactiveEngine } from "./engine.js";
import { FakeClock, FakeJudge, FakeScheduler, FakeSink, FakeTarget } from "./fakes.js";
import type { Judge, Rule } from "./ports.js";
import type { ProactiveStore } from "./store.js";
import type { ProactiveConfig, ProactiveEvent } from "./types.js";

export interface StoreHandle {
  store: ProactiveStore;
  cleanup(): Promise<void>;
}

/**
 * The contract every ProactiveStore must meet. Invariants I1-I10 are in SPEC.md; each test
 * names the one it checks. Call once per store implementation.
 */
export function runConformance(label: string, open: () => Promise<StoreHandle>): void {
  describe(`proactive conformance: ${label}`, () => {
    let handle: StoreHandle | undefined;
    afterEach(async () => {
      await handle?.cleanup();
      handle = undefined;
    });

    async function setup(
      options: { judge?: Judge; rules?: Rule[]; config?: Partial<ProactiveConfig> } = {},
    ) {
      handle = await open();
      const clock = new FakeClock();
      const scheduler = new FakeScheduler(clock);
      const target = new FakeTarget();
      const store = handle.store;
      const make = (t = target) =>
        new ProactiveEngine({
          store,
          scheduler,
          target: t,
          clock,
          judge: options.judge,
          rules: options.rules,
          config: { fallbackMs: 0, ...options.config },
        });
      return { clock, scheduler, target, store, engine: make(), make };
    }

    const ev = (id: string, over: Partial<ProactiveEvent> = {}, at = 0): ProactiveEvent => ({
      source: "test",
      id,
      kind: "message",
      at,
      scope: "s1",
      text: id,
      ...over,
    });

    it("I1: a repeated event id is a no-op", async () => {
      const h = await setup();
      const a = await h.engine.receive(ev("e1", { addressed: "dm" }));
      const b = await h.engine.receive(ev("e1", { addressed: "dm" }));
      expect(a.duplicate).toBe(false);
      expect(b.duplicate).toBe(true);
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect(h.target.accepted.size).toBe(1);
      expect([...h.target.accepted.values()][0]?.events).toHaveLength(1);
    });

    it("I2: events are applied in arrival order", async () => {
      const h = await setup();
      for (const id of ["a", "b", "c", "d"]) await h.engine.receive(ev(id, { addressed: "dm" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      const wake = [...h.target.accepted.values()][0];
      expect(wake?.events.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("I3: events stored before a crash are applied on recovery", async () => {
      const h = await setup();
      h.scheduler.failNext = 1; // the apply job is never scheduled: the process "dies" here
      await h.engine.receive(ev("lost", { addressed: "mention" }));
      expect(h.scheduler.jobs.size).toBe(0);
      const restarted = h.make(new FakeTarget());
      await restarted.recover();
      await h.scheduler.runUntil(restarted, h.clock.t + 60_000);
      expect(h.target.accepted.size).toBe(0); // original target was replaced
      const next = await h.store.getWake("mention:s1:lost");
      expect(next?.state).toBe("delivered");
    });

    it("I4: waits for quiet, never past the cap, one group", async () => {
      const h = await setup({ rules: [() => ({ name: "all" })] });
      const t0 = h.clock.t;
      await h.engine.receive(ev("a"));
      await h.scheduler.runUntil(h.engine, t0 + 2_999);
      expect(h.target.accepted.size).toBe(0);
      await h.engine.receive(ev("b")); // pushes the group out
      await h.scheduler.runUntil(h.engine, t0 + 2_999 + 2_999);
      expect(h.target.accepted.size).toBe(0);
      await h.scheduler.runUntil(h.engine, t0 + 2_999 + 3_001);
      expect(h.target.accepted.size).toBe(1);
      expect([...h.target.accepted.values()][0]?.events.map((e) => e.id)).toEqual(["a", "b"]);
    });

    it("I4: a steady stream is decided at the cap", async () => {
      const h = await setup({ rules: [() => ({ name: "all" })] });
      const t0 = h.clock.t;
      for (let i = 0; i < 12; i++) {
        await h.engine.receive(ev(`e${i}`));
        await h.scheduler.runUntil(h.engine, t0 + (i + 1) * 2_000);
      }
      expect(h.target.accepted.size).toBeGreaterThanOrEqual(1);
      const first = [...h.target.accepted.values()][0];
      expect(first?.events.length).toBeGreaterThan(0);
      const all = [...h.target.accepted.values()].flatMap((w) => w.events.map((e) => e.id));
      expect(new Set(all).size).toBe(all.length); // every event in at most one group
    });

    it("I5: steer, then dm, then mention, then rules, then judge", async () => {
      const judge = new FakeJudge(() => 0.9);
      const h = await setup({
        judge,
        rules: [(e) => (e.some((x) => x.text === "rule") ? { name: "r" } : null)],
      });
      h.target.working.add("s1");
      await h.engine.receive(ev("x", { addressed: "dm" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect([...h.target.accepted.values()][0]?.reason).toBe("steer");
      h.target.working.clear();

      await h.engine.receive(ev("y", { addressed: "mention", scope: "s2" }));
      await h.engine.receive(ev("z", { addressed: "dm", scope: "s2" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect(h.target.accepted.get("dm:s2:z")?.reason).toBe("dm");

      await h.engine.receive(ev("rule", { scope: "s3" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect(h.target.accepted.get("rule:r:s3:rule")?.reason).toBe("rule:r");
      expect(judge.calls).toBe(0);

      await h.engine.receive(ev("plain", { scope: "s4" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect(judge.calls).toBe(1);
      expect(h.target.accepted.get("relevant:s4:plain")?.reason).toBe("relevant");
    });

    it("I5: no judge means heard, and a low score means judge_no", async () => {
      const a = await setup();
      await a.engine.receive(ev("q"));
      await a.scheduler.runUntil(a.engine, a.clock.t + 60_000);
      expect(a.target.accepted.size).toBe(0);
      await handle?.cleanup();

      const b = await setup({ judge: new FakeJudge(() => 0.2) });
      await b.engine.receive(ev("q"));
      await b.scheduler.runUntil(b.engine, b.clock.t + 60_000);
      expect(b.target.accepted.size).toBe(0);
    });

    it("I6: a failing judge never drops events", async () => {
      const judge = new FakeJudge(() => new Error("judge down"));
      const h = await setup({ judge });
      await h.engine.receive(ev("q"));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect(judge.calls).toBe(3); // first try plus retries at 2 s and 8 s
      const wake = [...h.target.accepted.values()][0];
      expect(wake?.reason).toBe("relevant");
      expect(wake?.judgeError).toBe("judge down");
    });

    it("I7: wake id is reason:scope:lastEventId", async () => {
      const h = await setup();
      await h.engine.receive(ev("a", { addressed: "dm" }));
      await h.engine.receive(ev("b", { addressed: "dm" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect([...h.target.accepted.keys()]).toEqual(["dm:s1:b"]);
    });

    it("I8: a failed hand-over is retried with the same id and counted once", async () => {
      const h = await setup();
      h.target.failNext = 1;
      await h.engine.receive(ev("a", { addressed: "dm" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 3_000);
      expect((await h.store.getWake("dm:s1:a"))?.state).toBe("pending");
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000); // the redeliver job fires itself
      expect((await h.store.getWake("dm:s1:a"))?.state).toBe("delivered");
      expect(h.target.accepted.size).toBe(1);
      expect(h.target.calls.every((w) => w.id === "dm:s1:a")).toBe(true);
    });

    it("I8: a crash after the target accepted redelivers the same id", async () => {
      const h = await setup();
      h.target.crashAfterAcceptNext = 1;
      await h.engine.receive(ev("a", { addressed: "mention" }));
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      h.clock.advance(5_000);
      await h.engine.redeliver();
      expect(h.target.calls).toHaveLength(2);
      expect(h.target.accepted.size).toBe(1);
      expect((await h.store.getWake("mention:s1:a"))?.state).toBe("delivered");
    });

    it("a trace follows event to decision to delivery by id, without message text", async () => {
      const h = await setup();
      const steps: string[] = [];
      const traced = new ProactiveEngine({
        store: h.store,
        scheduler: h.scheduler,
        target: h.target,
        clock: h.clock,
        config: { fallbackMs: 0 },
        trace: (step, fields) => steps.push(`${step} ${JSON.stringify(fields)}`),
      });
      await traced.receive(ev("secret-id", { addressed: "dm", text: "private words" }));
      await h.scheduler.runUntil(traced, h.clock.t + 60_000);
      expect(steps.map((s) => s.split(" ")[0])).toEqual([
        "received",
        "applied",
        "decided",
        "delivered",
      ]);
      expect(steps.join("\n")).toContain("dm:s1:secret-id");
      expect(steps.join("\n")).not.toContain("private words");
    });

    it("two engines deciding one scope produce one wake", async () => {
      const h = await setup();
      const other = h.make(new FakeTarget());
      await h.engine.receive(ev("a", { addressed: "dm" }));
      await h.engine.apply("s1");
      h.clock.advance(10_000);
      await Promise.all([h.engine.decide("s1"), other.decide("s1")]);
      expect(h.target.accepted.size).toBe(1);
    });

    it("I9: a send reaches the platform once, whatever crashes", async () => {
      const h = await setup();
      const sink = new FakeSink();
      sink.crashAfterSendNext = 1;
      await expect(h.engine.sendEffect(sink, "w1:0", "room", "hi")).rejects.toThrow();
      const r = await h.engine.sendEffect(sink, "w1:0", "room", "hi"); // finds it, no resend
      expect(r.externalId).toBe("found-0");
      await h.engine.sendEffect(sink, "w1:0", "room", "hi"); // already sent
      expect(sink.delivered).toEqual(["w1:0"]);
    });

    it("I9: a record that never reached the platform is sent once", async () => {
      const h = await setup();
      const sink = new FakeSink();
      await h.store.effectBegin("w2:0", "room", "hi", h.clock.t); // crashed after record, before send
      await h.engine.sendEffect(sink, "w2:0", "room", "hi");
      expect(sink.delivered).toEqual(["w2:0"]);
    });

    it("I9: a sink that cannot find a send is refused", async () => {
      const h = await setup();
      const bad = { name: "bad", send: async () => ({}) } as never;
      await expect(h.engine.sendEffect(bad, "x", "room", "hi")).rejects.toThrow(/send once/);
    });

    it("I10: a timer fires once, on time, and not after cancel", async () => {
      const h = await setup();
      const t0 = h.clock.t;
      await h.engine.setTimer({
        id: "t1",
        scope: "s1",
        dueAt: t0 + 10_000,
        note: "n1",
        setBy: "me",
      });
      await h.engine.setTimer({
        id: "t2",
        scope: "s1",
        dueAt: t0 + 5_000,
        note: "n2",
        setBy: "me",
      });
      await h.engine.setTimer({
        id: "t3",
        scope: "s2",
        dueAt: t0 + 7_000,
        note: "n3",
        setBy: "me",
      });
      expect(await h.engine.cancelTimer("t3")).toBe(true);
      await h.scheduler.runUntil(h.engine, t0 + 60_000);
      const wakes = [...h.target.accepted.values()];
      expect(wakes.map((w) => w.reason)).toEqual(["timer", "timer"]);
      expect(wakes.map((w) => w.events[0]?.id)).toEqual(["t2", "t1"]);
      expect((await h.store.timerGet("t3"))?.state).toBe("cancelled");
    });

    it("I10: a timer re-fired after a crash still wakes once", async () => {
      const h = await setup();
      const t0 = h.clock.t;
      await h.engine.setTimer({ id: "t1", scope: "s1", dueAt: t0 + 1_000, note: "n", setBy: "me" });
      h.clock.advance(2_000);
      // Crash: the event is stored, the timer is not marked fired.
      await h.store.receive(
        { source: "timer", id: "t1", kind: "timer", at: t0, scope: "s1" },
        h.clock.t,
      );
      await h.engine.fireTimers();
      await h.scheduler.runUntil(h.engine, h.clock.t + 60_000);
      expect(h.target.accepted.size).toBe(1);
    });

    it("I10: one fallback timer per scope, re-armed after it fires", async () => {
      const h = await setup({ config: { fallbackMs: 60_000 } });
      await h.engine.ensureFallback("s1");
      await h.engine.ensureFallback("s1");
      expect(await h.store.hasPendingTimer("s1", "fallback:")).toBe(true);
      const t0 = h.clock.t;
      await h.scheduler.runUntil(h.engine, t0 + 70_000);
      expect(h.target.accepted.size).toBe(1);
      expect(await h.store.hasPendingTimer("s1", "fallback:")).toBe(true);
    });

    it("property: any burst with duplicates and a crash lands every event in one group", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.integer({ min: 0, max: 8 }),
              scope: fc.constantFrom("s1", "s2"),
              gap: fc.integer({ min: 0, max: 6_000 }),
            }),
            { minLength: 1, maxLength: 14 },
          ),
          fc.integer({ min: -1, max: 10 }),
          async (burst, crashAt) => {
            const h = await setup({ rules: [() => ({ name: "all" })] });
            try {
              let n = 0;
              for (const item of burst) {
                if (n++ === crashAt) h.scheduler.failNext = 1;
                await h.engine.receive(ev(`${item.scope}-e${item.id}`, { scope: item.scope }));
                h.clock.advance(item.gap);
                await h.scheduler.runUntil(h.engine, h.clock.t);
              }
              await h.engine.recover();
              await h.scheduler.runUntil(h.engine, h.clock.t + 120_000);
              const unique = new Set(burst.map((b) => `${b.scope}/${b.scope}-e${b.id}`));
              const seen = [...h.target.accepted.values()].flatMap((w) =>
                w.events.map((e) => `${e.scope}/${e.id}`),
              );
              expect(new Set(seen)).toEqual(unique);
              expect(seen.length).toBe(unique.size);
            } finally {
              await handle?.cleanup();
              handle = undefined;
            }
          },
        ),
        { numRuns: 25 },
      );
    });
  });
}
