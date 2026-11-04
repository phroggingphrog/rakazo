import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
  runAsTenant: (_owner: unknown, fn: () => unknown) => fn(),
}));

import { pgPoolExecutor } from "@rakazo/proactive";
import type { ProactiveRuntimeDeps } from "./proactive.js";
import { createProactiveRuntime } from "./proactive.js";
import { PgProactiveControls } from "./proactive-controls.js";

const url = process.env.PROACTIVE_TEST_DATABASE_URL;
describe.skipIf(!url)("proactive controls PostgreSQL", () => {
  const schema = `controls_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  const pool = new pg.Pool({ connectionString: url, max: 8, options: `-c search_path=${schema}` });
  const controls = new PgProactiveControls(pgPoolExecutor(pool));
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN CREATE ROLE rakazo_app NOLOGIN; END IF; END $$",
    );
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO rakazo_app`);
    await pool.query(
      readFileSync(
        new URL(
          "../../db/prisma/migrations/20261114000000_proactive_core/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query(
      readFileSync(
        new URL(
          "../../db/prisma/migrations/20261115000000_proactive_controls/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  it("serializes quota and audit across concurrent callers", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        controls.change("bot:quota", "bot", "wake", {}, async () => ({ result: true })),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
    expect((await controls.get("bot:quota")).revision).toBe(20);
    expect(
      Number(
        (
          await pool.query("SELECT count(*) FROM proactive_control_audit WHERE scope=$1", [
            "bot:quota",
          ])
        ).rows[0].count,
      ),
    ).toBe(20);
    await controls.change("bot:quota", "owner", "reset", {}, async () => ({
      config: {},
      result: true,
    }));
    await expect(
      controls.change("bot:quota", "bot", "wake", {}, async () => ({ result: true })),
    ).rejects.toThrow("limit");
  });
  it("sets, cancels and fires through the runtime controls on real storage", async () => {
    const executor = pgPoolExecutor(pool);
    const sql = {
      $queryRawUnsafe: async (text: string, ...params: unknown[]) =>
        (await pool.query(text, params)).rows,
    };
    const prisma = {
      ...sql,
      $transaction: async (fn: (tx: typeof sql) => Promise<unknown>) =>
        executor.transaction((tx) =>
          fn({ $queryRawUnsafe: async (text, ...params) => (await tx.query(text, params)).rows }),
        ),
      bot: { findFirst: async () => ({ id: "runtime" }) },
    };
    const runtime = createProactiveRuntime({
      prisma,
      enabledBots: "runtime",
      jobs: {
        enqueue: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
      events: { sendUserMessage: vi.fn() },
    } as unknown as ProactiveRuntimeDeps);
    const identity = { botId: "runtime", spaceId: "space", userId: "owner" };
    await runtime.control({ ...identity, action: "interval", fallbackMs: 600000 });
    await runtime.configure({ ...identity, config: { fallbackMs: 300000 } });
    const fallback = await pool.query(
      'SELECT "dueAt" FROM proactive_timers WHERE scope=$1 AND state=' +
        "'pending' AND id LIKE 'fallback:%'",
      ["bot:runtime"],
    );
    expect(Number(fallback.rows[0].dueAt) - Date.now()).toBeLessThanOrEqual(300000);
    const dueAt = Date.now() + 600000;
    await runtime.control({ ...identity, action: "timer", id: "fire", dueAt });
    await runtime.control({ ...identity, action: "timer", id: "cancel", dueAt });
    expect(await runtime.control({ ...identity, action: "cancel", id: "cancel" })).toEqual({
      cancelled: true,
    });
    await pool.query(
      "UPDATE proactive_timers SET \"dueAt\"=0 WHERE scope=$1 AND id LIKE 'self:%'",
      ["bot:runtime"],
    );
    expect(await runtime.engine.fireTimers()).toBe(1);
    expect(await runtime.engine.fireTimers()).toBe(0);
    await runtime.control({ ...identity, action: "timer", id: "reset", dueAt });
    await runtime.control({ ...identity, action: "reset" });
    expect(
      (
        await pool.query(
          "SELECT id FROM proactive_timers WHERE scope=$1 AND state='pending' AND id LIKE 'self:%'",
          ["bot:runtime"],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT id FROM proactive_timers WHERE scope=$1 AND state='pending' AND id LIKE 'fallback:%'",
          ["bot:runtime"],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rolls configuration and audit back on callback failure", async () => {
    await controls.change("bot:rollback", "owner", "configure", {}, async () => ({
      config: { fallbackMs: 600000 },
      result: true,
    }));
    await expect(
      controls.change("bot:rollback", "owner", "reset", {}, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await controls.get("bot:rollback")).toEqual({
      revision: 1,
      config: { fallbackMs: 600000 },
    });
  });
  it("denies ordinary role access and permits explicit system context", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE rakazo_app");
      expect((await client.query("SELECT * FROM proactive_controls")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM proactive_control_audit")).rows).toEqual([]);
      await expect(
        client.query("INSERT INTO proactive_controls(scope) VALUES ('forbidden')"),
      ).rejects.toThrow("row-level security");
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE rakazo_app");
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
      expect((await client.query("SELECT * FROM proactive_controls")).rows.length).toBeGreaterThan(
        0,
      );
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
