import { describe, expect, it, vi } from "vitest";
import {
  claimRoutineWatchAttempt,
  completeRoutineWatchAttempt,
  isRoutineWatchUncertainError,
} from "./routine-watch-attempt.js";

vi.mock("@rakazo/db", () => ({
  runAsSystemInTransaction: async (_tx: unknown, _reason: string, fn: () => unknown) => fn(),
}));

const input = {
  routineId: "routine-a",
  generation: "1",
  scheduledFor: new Date("2020-01-01T00:00:00.000Z"),
};

function fixture(
  options: {
    enabled?: boolean;
    missingGate?: boolean;
    visible?: boolean;
    matches?: boolean;
    existing?: "uncertain" | "completed";
  } = {},
) {
  let attempted = false;
  const queries: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      queries.push(sql);
      if (sql.includes("routine_schedule_gate"))
        return options.missingGate ? [] : [{ enabled: options.enabled ?? true }];
      if (sql.includes("FROM routines")) {
        return options.visible === false ? [] : [{ matches: options.matches ?? true }];
      }
      if (sql.includes("SELECT state FROM routine_watch_attempts")) {
        return options.existing
          ? [{ state: options.existing }]
          : attempted
            ? [{ state: "uncertain" }]
            : [];
      }
      if (sql.includes("INSERT INTO routine_watch_attempts")) {
        attempted = true;
        return [{ routineId: input.routineId }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const prisma = { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) };
  return { prisma: prisma as never, queries };
}

describe("routine watch attempt foundation", () => {
  it("does not create a claim while the scheduler gate is disabled", async () => {
    const { prisma, queries } = fixture({ enabled: false });
    expect(await claimRoutineWatchAttempt(prisma, input)).toBe("disabled");
    expect(queries).toHaveLength(1);
  });

  it("reports a missing scheduler gate without claiming a watch", async () => {
    const { prisma, queries } = fixture({ missingGate: true });
    await expect(claimRoutineWatchAttempt(prisma, input)).rejects.toThrow(
      "Routine scheduling gate is unavailable",
    );
    expect(queries).toHaveLength(1);
  });

  it("claims once and reports uncertainty after a simulated worker loss", async () => {
    const { prisma, queries } = fixture();
    expect(await claimRoutineWatchAttempt(prisma, input)).toBe("claimed");
    expect(await claimRoutineWatchAttempt(prisma, input)).toBe("uncertain");
    expect(queries.filter((sql) => sql.includes("INSERT INTO"))).toHaveLength(1);
  });

  it("treats a retained completed attempt as stale rather than uncertain", async () => {
    const { prisma, queries } = fixture({ existing: "completed" });
    expect(await claimRoutineWatchAttempt(prisma, input)).toBe("stale");
    expect(queries.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("does not inspect system-only attempts for a routine hidden by tenant RLS", async () => {
    const { prisma, queries } = fixture({ visible: false });
    expect(await claimRoutineWatchAttempt(prisma, input)).toBe("stale");
    expect(queries.some((sql) => sql.includes("routine_watch_attempts"))).toBe(false);
  });

  it("does not claim an obsolete or premature generation", async () => {
    const { prisma, queries } = fixture({ matches: false });
    expect(await claimRoutineWatchAttempt(prisma, input)).toBe("stale");
    expect(queries.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("rejects malformed generations and dates before opening a transaction", async () => {
    const { prisma, queries } = fixture();
    for (const generation of ["0", "-1", "1x", "9223372036854775808"]) {
      await expect(claimRoutineWatchAttempt(prisma, { ...input, generation })).rejects.toThrow();
    }
    await expect(
      claimRoutineWatchAttempt(prisma, { ...input, scheduledFor: new Date("invalid") }),
    ).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });

  it("recognizes the exact PostgreSQL conflict through the Prisma adapter", () => {
    expect(isRoutineWatchUncertainError({ code: "P4770" })).toBe(true);
    expect(
      isRoutineWatchUncertainError({
        code: "P2039",
        meta: { driverAdapterError: { cause: { originalCode: "P4770" } } },
      }),
    ).toBe(true);
    expect(isRoutineWatchUncertainError({ code: "P2039" })).toBe(false);
    expect(isRoutineWatchUncertainError(new Error("P4770"))).toBe(false);
  });
});

describe("completing routine watch attempts", () => {
  function transaction(options: { enabled?: boolean; visible?: boolean; exists?: boolean } = {}) {
    const query = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("routine_schedule_gate")) return [{ enabled: options.enabled ?? true }];
      if (sql.includes("FROM routines")) return options.visible === false ? [] : [{ id: "r" }];
      if (sql.includes("UPDATE routine_watch_attempts"))
        return options.exists === false ? [] : [{ routineId: "r" }];
      return [];
    });
    return { tx: { $queryRaw: query } as never, query };
  }

  it("marks only the uncertain attempt completed after checking the visible routine", async () => {
    const { tx, query } = transaction();
    await completeRoutineWatchAttempt(tx, input);
    const sql = query.mock.calls.map(([parts]) => parts.join("?"));
    expect(sql.findIndex((text) => text.includes("FROM routines"))).toBeLessThan(
      sql.findIndex((text) => text.includes("UPDATE routine_watch_attempts")),
    );
    expect(sql.find((text) => text.includes("UPDATE routine_watch_attempts"))).toContain(
      "state = 'completed'",
    );
    expect(sql.find((text) => text.includes("UPDATE routine_watch_attempts"))).toContain(
      "state = 'uncertain'",
    );
  });

  it("refuses to complete an invisible routine or an absent attempt", async () => {
    const hidden = transaction({ visible: false });
    await expect(completeRoutineWatchAttempt(hidden.tx, input)).rejects.toThrow("changed");
    expect(
      hidden.query.mock.calls.some(([parts]) =>
        parts.join("").includes("UPDATE routine_watch_attempts"),
      ),
    ).toBe(false);
    const absent = transaction({ exists: false });
    await expect(completeRoutineWatchAttempt(absent.tx, input)).rejects.toThrow("unavailable");
  });
});
