import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { runConformance } from "./conformance.js";
import { PgProactiveStore, pgPoolExecutor } from "./pg-store.js";
import type { PayloadCodec } from "./ports.js";
import { PROACTIVE_SCHEMA_SQL } from "./schema.js";

describe("migration", () => {
  it("is the same text as the package schema", () => {
    const file = fileURLToPath(
      new URL(
        "../../db/prisma/migrations/20261114000000_proactive_core/migration.sql",
        import.meta.url,
      ),
    );
    // The migration is the package schema plus Rakazo's row-level security tail.
    expect(readFileSync(file, "utf8").startsWith(PROACTIVE_SCHEMA_SQL)).toBe(true);
  });

  it("limits every proactive table to system contexts", () => {
    const file = fileURLToPath(
      new URL(
        "../../db/prisma/migrations/20261114000000_proactive_core/migration.sql",
        import.meta.url,
      ),
    );
    const sql = readFileSync(file, "utf8");
    const tables = [...PROACTIVE_SCHEMA_SQL.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(tables).toHaveLength(6);
    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY ${table}_system ON "${table}"`);
    }
  });
});

const url = process.env.PROACTIVE_TEST_DATABASE_URL;

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

if (url) {
  // Each conformance test gets its own schema, so tests never see each other's rows.
  let n = 0;
  const openStore = (codec?: PayloadCodec) => async () => {
    const schema = `proactive_${process.pid}_${Date.now()}_${n++}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({
      connectionString: url,
      max: 8,
      options: `-c search_path=${schema}`,
    });
    await pool.query(PROACTIVE_SCHEMA_SQL);
    return {
      pool,
      store: new PgProactiveStore(pgPoolExecutor(pool), codec),
      cleanup: async () => {
        await pool.end();
        const drop = new pg.Pool({ connectionString: url, max: 1 });
        await drop.query(`DROP SCHEMA "${schema}" CASCADE`);
        await drop.end();
      },
    };
  };
  runConformance("postgres store", openStore());
  runConformance("postgres store with a payload codec", openStore(testCodec));

  describe("postgres store with a payload codec", () => {
    it("keeps text out of every table and reads it back", async () => {
      const h = await openStore(testCodec)();
      try {
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
        await h.store.receive(event, 1);
        await h.store.applyScope("bot:1", 2, 3000, 20000);
        const claimed = await h.store.claimGroup("bot:1", 10_000, 3000, 20000);
        if (claimed.kind !== "group") throw new Error("expected a group");
        expect(claimed.events[0]?.text).toBe(secret);
        await h.store.recordDecision(
          "bot:1",
          claimed.events,
          { kind: "wake", reason: "mention" },
          3,
        );
        await h.store.timerSet({
          id: "t1",
          scope: "bot:1",
          dueAt: 5,
          note: secret,
          setBy: "agent",
        });
        for (const table of [
          "proactive_inbox",
          "proactive_events",
          "proactive_wakes",
          "proactive_timers",
        ]) {
          const raw = await h.pool.query(`SELECT row_to_json(t)::text AS body FROM ${table} t`);
          expect(raw.rows.length, table).toBeGreaterThan(0);
          for (const row of raw.rows) expect(String(row.body), table).not.toContain(secret);
        }
        const wakes = await h.store.pendingWakes(10_000, 10);
        expect(wakes[0]?.events[0]?.text).toBe(secret);
        expect((await h.store.timerGet("t1"))?.note).toBe(secret);
      } finally {
        await h.cleanup();
      }
    });
  });
} else {
  describe.skip("proactive conformance: postgres store (set PROACTIVE_TEST_DATABASE_URL)", () => {
    it("skipped", () => undefined);
  });
}
