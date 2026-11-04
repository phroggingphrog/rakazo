import { describe, expect, it } from "vitest";
import type { PgExecutor, PgQueryable } from "@rakazo/proactive";
import { PgProactiveControls, validateProactiveConfig, DEFAULT_POLICY_ORDER } from "./proactive-controls.js";

function fixture() {
  let row = { revision: 0, config: {}, day: "", wakeCount: 0 };
  let audits = 0;
  const query: PgQueryable["query"] = async (sql, args = []) => {
    if (sql.startsWith("SELECT")) return { rows: [{ ...row }] };
    if (sql.includes('SET "day"')) row = { ...row, day: String(args[1]), wakeCount: Number(args[2]) };
    if (sql.includes('SET "revision"')) row = { ...row, revision: Number(args[1]), config: JSON.parse(String(args[2])) };
    if (sql.startsWith('INSERT INTO "proactive_control_audit"')) audits++;
    return { rows: [] };
  };
  const db: PgExecutor = { query, transaction: async fn => {
    const before = structuredClone(row); const count = audits;
    try { return await fn({ query }); } catch (error) { row = before; audits = count; throw error; }
  } };
  return { controls: new PgProactiveControls(db), snapshot: () => ({ ...row, audits }) };
}
describe("proactive configuration", () => {
  it("accepts default and complete owner order, rejects partial order", () => {
    expect(() => validateProactiveConfig({})).not.toThrow();
    expect(() => validateProactiveConfig({ decisionOrder: [...DEFAULT_POLICY_ORDER].reverse() })).not.toThrow();
    expect(() => validateProactiveConfig({ decisionOrder: ["judge"] })).toThrow("every policy stage");
    expect(() => validateProactiveConfig({ fallbackMs: 299999 })).toThrow("five minutes");
    expect(() => validateProactiveConfig({ fallbackMs: 0 })).not.toThrow();
    expect(() => validateProactiveConfig({ hooks: Array.from({length: 21}, (_, i) => ({ id: String(i), source: "test" })) })).toThrow("twenty");
  });
  it("versions and audits mutations atomically", async () => {
    const { controls, snapshot } = fixture();
    await controls.change("bot:a", "owner", "configure", {}, async () => ({ config: { fallbackMs: 300000 }, result: true }));
    expect(snapshot()).toMatchObject({ revision: 1, audits: 1, config: { fallbackMs: 300000 } });
    await expect(controls.change("bot:a", "owner", "timer", {}, async () => { throw new Error("failed timer"); })).rejects.toThrow("failed timer");
    expect(snapshot()).toMatchObject({ revision: 1, audits: 1, wakeCount: 0 });
  });
  it("caps daily wakes, preserves quota across reset and rolls over next day", async () => {
    const { controls, snapshot } = fixture();
    const now = Date.UTC(2026, 10, 4);
    const change = (action: string, time = now) => controls.change("bot:a", "owner", action, {}, async () => ({ result: true }), time);
    for (let i = 0; i < 20; i++) await change("wake");
    await change("reset");
    await expect(change("timer")).rejects.toThrow("twenty");
    expect(snapshot().wakeCount).toBe(20);
    await change("timer", now + 86400000);
    expect(snapshot().wakeCount).toBe(1);
  });
});
