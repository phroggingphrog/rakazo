import { runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  checkRoutineJobLockSettlement,
  inspectRoutineScheduleCutover,
  planRoutineScheduleBootstrap,
} from "./routine-schedule-cutover.js";

const candidate = {
  routineId: "routine-a",
  generation: 0n,
  priorIntentGeneration: null,
  active: true,
  nextRunAt: new Date("2030-01-01T00:00:00.000Z"),
  hasWatch: false,
};

describe("routine schedule bootstrap proposal", () => {
  it("advances beyond both the row and retained tombstone to avoid same-id ABA", () => {
    const result = planRoutineScheduleBootstrap([
      { ...candidate, generation: 2n, priorIntentGeneration: 8n },
    ]);
    expect(result).toEqual([
      {
        routineId: "routine-a",
        generation: 9n,
        active: true,
        nextRunAt: candidate.nextRunAt,
        operation: "upsert",
      },
    ]);
    expect(result[0]?.nextRunAt).not.toBe(candidate.nextRunAt);
  });

  it("rejects watch routines instead of silently skipping them", () => {
    expect(() => planRoutineScheduleBootstrap([{ ...candidate, hasWatch: true }])).toThrow(
      "Watch routines require a supported cutover path",
    );
  });

  it("refuses duplicate ids, overflow, invalid time and oversized batches", () => {
    expect(() => planRoutineScheduleBootstrap([candidate, candidate])).toThrow();
    expect(() =>
      planRoutineScheduleBootstrap([{ ...candidate, generation: 9_223_372_036_854_775_807n }]),
    ).toThrow();
    expect(() =>
      planRoutineScheduleBootstrap([{ ...candidate, nextRunAt: new Date(NaN) }]),
    ).toThrow();
    expect(() => planRoutineScheduleBootstrap(Array(201).fill(candidate))).toThrow();
  });
});

describe("routine scheduler cutover inventory", () => {
  it("uses a read-only snapshot and never labels an empty queue as drained", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT enabled"))
        return { rows: [{ enabled: false, unsettledLegacyWakes: false }] };
      if (sql.includes("AS legacy")) return { rows: [{ legacy: false, versioned: false }] };
      if (sql.includes("graphile_worker.jobs")) return { rows: [{ queued: "0", locked: "0" }] };
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const result = await runAsSystem("test scheduler inventory", () =>
      inspectRoutineScheduleCutover({ connect: async () => ({ query, release }) } as never),
    );
    expect(result).toMatchObject({
      gateEnabled: false,
      unsettledBridgeLegacyWakes: false,
      allLegacyWorkersDrained: "unverified",
      bootstrapAvailable: false,
      rollbackAvailable: false,
      tombstoneCleanupAvailable: false,
      allVersionedWorkersDrained: "unverified",
      queuedLegacyJobs: 0,
      lockedLegacyJobs: 0,
    });
    expect(query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and fails closed if the scheduler gate is missing", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const release = vi.fn();
    await expect(
      runAsSystem("test scheduler inventory", () =>
        inspectRoutineScheduleCutover({ connect: async () => ({ query, release }) } as never),
      ),
    ).rejects.toThrow("gate is unavailable");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not interpret a malformed inventory as an empty queue", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT enabled"))
        return { rows: [{ enabled: false, unsettledLegacyWakes: false }] };
      if (sql.includes("graphile_worker.jobs")) return { rows: [] };
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(
      runAsSystem("test scheduler inventory", () =>
        inspectRoutineScheduleCutover({ connect: async () => ({ query, release }) } as never),
      ),
    ).rejects.toThrow("Invalid routine cutover inventory");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses tenant and context-free inventory without connecting", async () => {
    const connect = vi.fn();
    const pool = { connect } as never;
    await expect(inspectRoutineScheduleCutover(pool)).rejects.toThrow("system context");
    await expect(
      runAsTenant({ spaceId: "space", userId: "user" }, () => inspectRoutineScheduleCutover(pool)),
    ).rejects.toThrow("system context");
    expect(connect).not.toHaveBeenCalled();
  });

  it("fails closed if Graphile is unavailable", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT enabled"))
        return { rows: [{ enabled: false, unsettledLegacyWakes: false }] };
      if (sql.includes("AS legacy")) return { rows: [{ legacy: false, versioned: false }] };
      if (sql.includes("graphile_worker.jobs")) throw new Error("synthetic Graphile unavailable");
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(
      runAsSystem("test scheduler inventory", () =>
        inspectRoutineScheduleCutover({ connect: async () => ({ query, release }) } as never),
      ),
    ).rejects.toThrow("synthetic Graphile unavailable");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports bounded rollback residue as aggregate counts only", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("SELECT enabled"))
        return { rows: [{ enabled: false, unsettledLegacyWakes: true }] };
      if (sql.includes("AS legacy")) return { rows: [{ legacy: false, versioned: true }] };
      if (sql.includes("graphile_worker.jobs")) {
        return {
          rows: [
            sql.includes("routine.wakeup.v2")
              ? { queued: "2", locked: "1" }
              : { queued: "0", locked: "0" },
          ],
        };
      }
      if (sql.includes("intent.operation")) return { rows: [{ count: "3" }] };
      if (sql.includes('"publishedGeneration" >= generation')) return { rows: [{ count: "4" }] };
      if (sql.includes('"publishedGeneration" < generation')) return { rows: [{ count: "5" }] };
      if (sql.includes("operation = 'delete'")) return { rows: [{ count: "6" }] };
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const result = await runAsSystem("test scheduler inventory", () =>
      inspectRoutineScheduleCutover({
        connect: async () => ({ query, release: vi.fn() }),
      } as never),
    );
    expect(result).toMatchObject({
      unsettledBridgeLegacyWakes: true,
      unlockedVersionedJobs: 2,
      lockedVersionedJobs: 1,
      orphanedUpserts: 3,
      acknowledgedTombstones: 4,
      pendingIntents: 5,
      tombstones: 6,
      allLegacyWorkersDrained: "unverified",
      allVersionedWorkersDrained: "unverified",
      rollbackAvailable: false,
      tombstoneCleanupAvailable: false,
    });
    expect(
      query.mock.calls
        .filter(([sql]) => sql.includes("count(*)"))
        .every(([, params]) => JSON.stringify(params) === "[200]"),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("routineId");
    expect(result.anyLockedVersionedJob).toBe(true);
  });

  it.each([false, true])("observes v2 locks=%s without asserting a fleet drain", async (locked) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT enabled"))
        return { rows: [{ enabled: false, unsettledLegacyWakes: false }] };
      if (sql.includes("AS legacy")) return { rows: [{ legacy: false, versioned: locked }] };
      if (sql.includes("graphile_worker.jobs")) return { rows: [{ queued: "200", locked: "0" }] };
      if (sql.includes("count(*)")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const result = await runAsSystem("test scheduler lock settlement", () =>
      checkRoutineJobLockSettlement({
        connect: async () => ({ query, release: vi.fn() }),
      } as never),
    );
    expect(result).toEqual({
      gateEnabled: false,
      noLockedRoutineJobsObserved: !locked,
      admissionStopped: "unverified",
      allWorkersDrained: "unverified",
    });
  });
});
