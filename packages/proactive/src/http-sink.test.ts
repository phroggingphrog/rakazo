import { describe, expect, it } from "vitest";
import { ProactiveEngine } from "./engine.js";
import { FakeClock, FakeScheduler, FakeTarget } from "./fakes.js";
import { HttpIdempotentSink } from "./http-sink.js";
import { MemoryProactiveStore } from "./memory-store.js";

describe("HttpIdempotentSink", () => {
  it("sends the send id as the idempotency key and survives a crash before the record", async () => {
    const processed = new Set<string>();
    const received: string[] = [];
    let failRecord = true;
    const receiver = (async (_url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>)["idempotency-key"] as string;
      if (!processed.has(key)) {
        processed.add(key);
        received.push(key);
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const clock = new FakeClock();
    const store = new MemoryProactiveStore();
    const engine = new ProactiveEngine({
      store: {
        ...store,
        // The engine "dies" the first time it tries to record the result.
        effectDone: async (id, r) => {
          if (failRecord) {
            failRecord = false;
            throw new Error("crash before record");
          }
          return store.effectDone(id, r);
        },
        effectGet: (id) => store.effectGet(id),
        effectBegin: (...a) => store.effectBegin(...a),
      } as MemoryProactiveStore,
      scheduler: new FakeScheduler(clock),
      target: new FakeTarget(),
      clock,
    });
    const sink = new HttpIdempotentSink({ fetch: receiver });
    await expect(
      engine.sendEffect(sink, "w1:0", "https://x.test/hook", { a: 1 }),
    ).rejects.toThrow();
    await engine.sendEffect(sink, "w1:0", "https://x.test/hook", { a: 1 });
    expect(received).toEqual(["w1:0"]); // two requests, one effect at the receiver
  });

  it("fails on a non-2xx answer so the effect stays sending", async () => {
    const sink = new HttpIdempotentSink({
      fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(sink.send("s", "https://x.test", {})).rejects.toThrow("500");
  });
});
