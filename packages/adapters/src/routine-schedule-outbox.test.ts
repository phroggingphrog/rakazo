import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  assertLegacyRoutineWakeAllowed,
  publishRoutineScheduleIntent,
  publishRoutineScheduleIntents,
} from "./routine-schedule-outbox.js";

function fixture(
  options: {
    enabled?: boolean;
    intent?: {
      routineId: string;
      generation: string;
      active: boolean;
      nextRunAt: Date | null;
      operation: "upsert" | "delete";
    };
    failAcknowledgement?: boolean;
    missingGate?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.startsWith('SELECT "enabled"'))
      return { rows: options.missingGate ? [] : [{ enabled: options.enabled ?? false }] };
    if (sql.startsWith('SELECT "routineId"'))
      return { rows: options.intent ? [options.intent] : [] };
    if (sql.startsWith('UPDATE "routine_schedule_outbox"') && options.failAcknowledgement) {
      throw new Error("acknowledgement failed");
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { pool, query, release };
}

describe("transactional schedule intent publication", () => {
  it("permits legacy wakes only while the cutover gate is off", async () => {
    await expect(assertLegacyRoutineWakeAllowed(fixture().pool)).resolves.toBeUndefined();
    const f = fixture({ enabled: true });
    await expect(assertLegacyRoutineWakeAllowed(f.pool)).rejects.toThrow(
      "Legacy routine wakes require cutover recovery",
    );
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it("does not publish while the gate is off", async () => {
    const f = fixture();
    expect(await publishRoutineScheduleIntent(f.pool)).toBe(false);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("graphile_worker"))).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("reports a missing gate instead of treating it as an idle scheduler", async () => {
    const f = fixture({ missingGate: true });
    await expect(publishRoutineScheduleIntent(f.pool)).rejects.toThrow(
      "Routine scheduling gate is unavailable",
    );
    expect(f.query.mock.calls.some(([sql]) => sql.includes("graphile_worker"))).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("uses a versioned task and acknowledges only after publishing", async () => {
    const f = fixture({
      enabled: true,
      intent: {
        routineId: "routine-a",
        generation: "9",
        active: true,
        nextRunAt: new Date("2030-01-01T00:00:00Z"),
        operation: "upsert",
      },
    });
    expect(await publishRoutineScheduleIntent(f.pool)).toBe(true);
    const jobCall = f.query.mock.calls.find(([sql]) => sql.includes("graphile_worker.add_job"));
    expect(jobCall?.[1]).toMatchObject([
      "routine.wakeup.v2",
      expect.stringContaining('"generation":"9"'),
      expect.any(Date),
      "routine:v2:routine-a",
    ]);
    const calls = f.query.mock.calls.map(([sql]) => sql);
    expect(calls.findIndex((sql) => sql.includes("graphile_worker.add_job"))).toBeLessThan(
      calls.findIndex((sql) => sql.startsWith('UPDATE "routine_schedule_outbox"')),
    );
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("rolls back queue changes if acknowledgement fails", async () => {
    const f = fixture({
      enabled: true,
      failAcknowledgement: true,
      intent: {
        routineId: "routine-a",
        generation: "10",
        active: false,
        nextRunAt: null,
        operation: "delete",
      },
    });
    await expect(publishRoutineScheduleIntent(f.pool)).rejects.toThrow("acknowledgement failed");
    expect(f.query).toHaveBeenCalledWith("SELECT graphile_worker.remove_job($1::text)", [
      "routine:v2:routine-a",
    ]);
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("bounds each recovery pass even when more work remains", async () => {
    const f = fixture({
      enabled: true,
      intent: {
        routineId: "routine-a",
        generation: "9",
        active: false,
        nextRunAt: null,
        operation: "delete",
      },
    });
    await publishRoutineScheduleIntents(f.pool);
    expect(f.release).toHaveBeenCalledTimes(20);
  });
});
