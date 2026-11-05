import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function checkedStatuses(file: URL) {
  const sql = readFileSync(file, "utf8");
  const check = /CHECK\s*\(\s*"status"\s+IN\s*\(([\s\S]*?)\)\s*\)/i.exec(sql);
  if (!check) throw new Error("Missing notification status constraint");
  return [...check[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

describe("notification evidence migration", () => {
  it("keeps all previous worker states valid and adds the two explicit non-delivery states", () => {
    const previous = new URL(
      "../../../packages/db/prisma/migrations/20261127000000_routine_notification_retry/migration.sql",
      import.meta.url,
    );
    const next = new URL(
      "../../../packages/db/prisma/migrations/20261208000000_routine_notification_retry_evidence/migration.sql",
      import.meta.url,
    );
    const before = checkedStatuses(previous);
    const after = checkedStatuses(next);
    expect(after).toEqual([...before, "device_rejected", "no_recipient"].sort());
    const sql = readFileSync(next, "utf8");
    expect(sql).toMatch(/NOT VALID/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT\s+"routine_notification_intents_status_check"/i);
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
  });
});
