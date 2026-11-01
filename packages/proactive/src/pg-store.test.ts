import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { runConformance } from "./conformance.js";
import { PgProactiveStore } from "./pg-store.js";
import { PROACTIVE_SCHEMA_SQL } from "./schema.js";

describe("migration", () => {
  it("is the same text as the package schema", () => {
    const file = fileURLToPath(
      new URL(
        "../../db/prisma/migrations/20261102000000_proactive_core/migration.sql",
        import.meta.url,
      ),
    );
    expect(readFileSync(file, "utf8")).toBe(PROACTIVE_SCHEMA_SQL);
  });
});

const url = process.env.PROACTIVE_TEST_DATABASE_URL;

if (url) {
  // Each conformance test gets its own schema, so tests never see each other's rows.
  let n = 0;
  runConformance("postgres store", async () => {
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
      store: new PgProactiveStore(pool),
      cleanup: async () => {
        await pool.end();
        const drop = new pg.Pool({ connectionString: url, max: 1 });
        await drop.query(`DROP SCHEMA "${schema}" CASCADE`);
        await drop.end();
      },
    };
  });
} else {
  describe.skip("proactive conformance: postgres store (set PROACTIVE_TEST_DATABASE_URL)", () => {
    it("skipped", () => undefined);
  });
}
