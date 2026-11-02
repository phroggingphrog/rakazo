import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runConformance } from "./conformance.js";
import { ProactiveEngine } from "./engine.js";
import { FakeClock, FakeScheduler, FakeTarget } from "./fakes.js";
import type { PayloadCodec } from "./ports.js";
import { SqliteProactiveStore } from "./sqlite-store.js";

/** A stand-in for a real key ring: hides the value, keeps it per scope. */
const testCodec: PayloadCodec = {
  async seal(scope, value) {
    return { $sealed: `t1|${scope}|${Buffer.from(JSON.stringify(value)).toString("base64")}` };
  },
  async open(scope, value) {
    const sealed = (value as { $sealed?: string } | null)?.$sealed;
    if (typeof sealed !== "string") return value;
    const [, owner, body] = sealed.split("|");
    if (owner !== scope) throw new Error("sealed for another scope");
    return JSON.parse(Buffer.from(body ?? "", "base64").toString("utf8"));
  },
};

const openStore = (codec?: PayloadCodec) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-sqlite-"));
  const store = new SqliteProactiveStore(join(dir, "proactive.db"), codec);
  return {
    store,
    cleanup: async () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

runConformance("sqlite store", openStore());
runConformance("sqlite store with a payload codec", openStore(testCodec));

describe("sqlite store", () => {
  it("keeps text out of the file when a codec seals it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proactive-sqlite-"));
    const path = join(dir, "proactive.db");
    const store = new SqliteProactiveStore(path, testCodec);
    const secret = "the-launch-code-is-4242";
    const event = {
      source: "s",
      id: "e1",
      kind: "webhook",
      at: 1,
      scope: "bot:1",
      text: secret,
      addressed: "mention" as const,
    };
    await store.receive(event, 1);
    await store.applyScope("bot:1", 2, 3000, 20000);
    const claimed = await store.claimGroup("bot:1", 10_000, 3000, 20000);
    if (claimed.kind !== "group") throw new Error("expected a group");
    expect(claimed.events[0]?.text).toBe(secret);
    await store.recordDecision("bot:1", claimed.events, { kind: "wake", reason: "mention" }, 3);
    await store.timerSet({ id: "t1", scope: "bot:1", dueAt: 5, note: secret, setBy: "agent" });
    expect((await store.pendingWakes(10_000, 10))[0]?.events[0]?.text).toBe(secret);
    expect((await store.timerGet("t1"))?.note).toBe(secret);
    store.close();
    // checkpoint happened on close; the raw file never saw the text
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path).includes(secret)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives a process dying mid-flight: recover finds unapplied and undecided work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proactive-sqlite-"));
    const path = join(dir, "proactive.db");
    try {
      // The first "process" writes and is dropped without close().
      const first = new SqliteProactiveStore(path);
      await first.receive(
        { source: "t", id: "stored", kind: "m", at: 0, scope: "a", addressed: "dm" },
        1,
      );
      await first.receive(
        { source: "t", id: "applied", kind: "m", at: 0, scope: "b", addressed: "dm" },
        1,
      );
      await first.applyScope("b", 2, 3000, 20000);

      const second = new SqliteProactiveStore(path);
      expect(await second.unappliedScopes(10)).toEqual(["a"]);
      expect(await second.scopesWithUndecided(10)).toEqual(["b"]);

      const clock = new FakeClock();
      const scheduler = new FakeScheduler(clock);
      const target = new FakeTarget();
      const engine = new ProactiveEngine({
        store: second,
        scheduler,
        target,
        clock,
        config: { fallbackMs: 0 },
      });
      await engine.recover();
      await scheduler.runUntil(engine, clock.now() + 60_000);
      expect([...target.accepted.keys()].sort()).toEqual(["dm:a:stored", "dm:b:applied"]);
      expect(await second.unappliedScopes(10)).toEqual([]);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
