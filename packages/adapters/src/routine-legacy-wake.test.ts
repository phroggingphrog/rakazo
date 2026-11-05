import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runLegacyRoutineWake } from "./routine-legacy-wake.js";

function fixture(failure?: "begin" | "finish") {
  let checkedOut = 0;
  const query = vi.fn(async (sql: string) => {
    if (failure && sql.includes(`wake_${failure}`)) throw new Error(`${failure} failed`);
  });
  const pool = {
    connect: vi.fn(async () => {
      checkedOut += 1;
      return {
        query,
        release: () => {
          checkedOut -= 1;
        },
      };
    }),
  } as unknown as Pool;
  return { pool, query, checkedOut: () => checkedOut };
}

describe("bridge-aware legacy routine wake", () => {
  it("releases its pool connection before handler work and settles after return", async () => {
    const f = fixture();
    const result = await runLegacyRoutineWake(
      f.pool,
      "routine-a",
      "2026-01-01T00:00:00Z",
      async () => {
        expect(f.checkedOut()).toBe(0);
        expect(f.query).toHaveBeenCalledTimes(1);
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(f.checkedOut()).toBe(0);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT routine_legacy_wake_begin($1, $2, $3::timestamptz)",
      "SELECT routine_legacy_wake_finish($1)",
    ]);
  });

  it("does not dispatch if admission fails", async () => {
    const f = fixture("begin");
    const run = vi.fn(async () => undefined);
    await expect(
      runLegacyRoutineWake(f.pool, "routine-a", "2026-01-01T00:00:00Z", run),
    ).rejects.toThrow("begin failed");
    expect(run).not.toHaveBeenCalled();
    expect(f.checkedOut()).toBe(0);
  });

  it("does not settle a failed handler", async () => {
    const f = fixture();
    await expect(
      runLegacyRoutineWake(f.pool, "routine-a", "2026-01-01T00:00:00Z", async () => {
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.checkedOut()).toBe(0);
  });

  it("propagates settlement failure after handler return", async () => {
    const f = fixture("finish");
    await expect(
      runLegacyRoutineWake(f.pool, "routine-a", "2026-01-01T00:00:00Z", async () => undefined),
    ).rejects.toThrow("finish failed");
    expect(f.checkedOut()).toBe(0);
  });
});
