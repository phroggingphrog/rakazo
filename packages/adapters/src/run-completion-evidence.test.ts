import { describe, expect, it, vi } from "vitest";
import { assertNoUnresolvedEffects } from "./run-completion-evidence.js";
import {
  evidenceForMonitorCall,
  monitorSourceEvidence,
  persistMonitorReadEvidence,
} from "./run-monitor-evidence.js";

const source = {
  connectorId: "mcp",
  resourceId: "server-1",
  resourceRevision: 1,
  toolName: "read_mail",
};

describe("completion evidence guard", () => {
  it.each([
    ["invalid_shared_memory", "did not run because its input was invalid"],
    ["computer_unavailable", "computer could not be reached"],
    ["stdio_mcp_forbidden", "local MCP server was not added"],
    ["instruction_precondition_failed", "instructions were not updated"],
  ])("reports a trusted %s rejection without claiming dispatch", async (reason, message) => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(1) },
      $queryRaw: vi.fn().mockResolvedValue([{ status: "failed", reason }]),
    };
    await expect(assertNoUnresolvedEffects(store, "run-1")).rejects.toThrow(message);
  });
  it("does not attribute mixed local failures to a single cause", async () => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(2) },
      $queryRaw: vi.fn().mockResolvedValue([
        { status: "failed", reason: "invalid_shared_memory" },
        { status: "failed", reason: "computer_unavailable" },
      ]),
    };
    await expect(assertNoUnresolvedEffects(store, "run-1")).rejects.toThrow(
      "One or more requested actions did not run",
    );
  });
  it("reports a trusted non-dispatch honestly instead of claiming the outcome is uncertain", async () => {
    const count = vi.fn().mockResolvedValue(1);
    const $queryRaw = vi
      .fn()
      .mockResolvedValue([{ status: "failed", reason: "invalid_screen_action" }]);
    await expect(
      assertNoUnresolvedEffects({ externalEffect: { count }, $queryRaw }, "run-1"),
    ).rejects.toThrow("The requested action did not run");
  });
  it("keeps legacy or mixed ambiguous effects conservative despite a trusted rejection", async () => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(2) },
      $queryRaw: vi.fn().mockResolvedValue([
        { status: "failed", reason: "invalid_screen_action" },
        { status: "uncertain", reason: null },
      ]),
    };
    await expect(assertNoUnresolvedEffects(store, "run-1")).rejects.toThrow(
      "reconcile destination evidence",
    );
    store.externalEffect.count.mockResolvedValue(1);
    store.$queryRaw.mockResolvedValue([{ status: "failed", reason: null }]);
    await expect(assertNoUnresolvedEffects(store, "run-1")).rejects.toThrow(
      "reconcile destination evidence",
    );
  });
  it("rejects an email monitor when the read evidence is not bound to its source", async () => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: { findUnique: vi.fn().mockResolvedValue({ monitor: { kind: "email" } }) },
      event: { count: vi.fn().mockResolvedValue(1) },
    };
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow(
      "Monitor source is not configured",
    );
  });
  it("requires a successful read of the configured source in the same run", async () => {
    const monitor = { kind: "email", source };
    const evidence: string[] = [];
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: { findUnique: vi.fn().mockResolvedValue({ monitor }) },
      event: {
        count: async ({ where }: { where: { runId: string; payload: { equals: string } } }) =>
          where.runId === "run-1" && evidence.includes(where.payload.equals) ? 1 : 0,
      },
    };
    const wrong = evidenceForMonitorCall(monitor, { ...source, resourceId: "other" }, false);
    if (wrong)
      await persistMonitorReadEvidence(
        {},
        async () => true,
        async () => evidence.push(wrong),
      );
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow(
      "successful declared external read",
    );
    const match = evidenceForMonitorCall(monitor, source, false);
    if (!match) throw new Error("matching source did not produce evidence");
    await persistMonitorReadEvidence(
      { isError: true },
      async () => true,
      async () => evidence.push(match),
    );
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow();
    await persistMonitorReadEvidence(
      {},
      async () => true,
      async () => evidence.push(match),
    );
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).resolves.toBeUndefined();
    await expect(assertNoUnresolvedEffects(store, "other-run", "routine-1")).rejects.toThrow();
  });
  it("rejects malformed persisted policy even when a read marker exists", async () => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: { findUnique: vi.fn().mockResolvedValue({ monitor: { kind: "unknown" } }) },
      event: { count: vi.fn().mockResolvedValue(1) },
    };
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow(
      "Routine policy invalid",
    );
  });
  it("does not borrow a successful read from another run", async () => {
    const count = vi.fn(async ({ where }: { where: { runId: string } }) =>
      where.runId === "other-run" ? 1 : 0,
    );
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: { findUnique: vi.fn().mockResolvedValue({ monitor: { kind: "email", source } }) },
      event: { count },
    };
    await expect(assertNoUnresolvedEffects(store, "current-run", "routine-1")).rejects.toThrow(
      "successful declared external read",
    );
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ runId: "current-run" }) }),
    );
  });
  it("rejects a persisted monitor with no successful declared external read", async () => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: {
        findUnique: vi.fn().mockResolvedValue({ monitor: { kind: "email", source } }),
      },
      event: { count: vi.fn().mockResolvedValue(0) },
    };
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow(
      "successful declared external read",
    );
  });
  it("accepts durable same-run evidence, including after a resumed attempt", async () => {
    const count = vi.fn().mockResolvedValue(1);
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: {
        findUnique: vi.fn().mockResolvedValue({ monitor: { kind: "email", source } }),
      },
      event: { count },
    };
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        type: "effect.recorded",
        payload: {
          path: ["evidence"],
          equals: monitorSourceEvidence(source),
        },
      },
    });
  });
  it("does not require inspection evidence for a nonmonitor routine", async () => {
    const count = vi.fn();
    await expect(
      assertNoUnresolvedEffects(
        {
          externalEffect: { count: vi.fn().mockResolvedValue(0) },
          routine: { findUnique: vi.fn().mockResolvedValue({ monitor: null }) },
          event: { count },
        },
        "run-1",
        "routine-1",
      ),
    ).resolves.toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });
  it("fails closed for missing persisted routine or evidence store", async () => {
    const store = {
      externalEffect: { count: vi.fn().mockResolvedValue(0) },
      routine: {
        findUnique: vi.fn<() => Promise<{ monitor: unknown } | null>>().mockResolvedValue(null),
      },
    };
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow(
      "Routine policy unavailable",
    );
    store.routine.findUnique.mockResolvedValue({ monitor: { kind: "email", source } });
    await expect(assertNoUnresolvedEffects(store, "run-1", "routine-1")).rejects.toThrow(
      "successful declared external read",
    );
  });
  it("rejects unresolved effects without disclosing destination content", async () => {
    const count = vi.fn().mockResolvedValue(1);
    await expect(assertNoUnresolvedEffects({ externalEffect: { count } }, "run-1")).rejects.toThrow(
      "reconcile destination evidence",
    );
    expect(count).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        status: { in: ["failed", "uncertain", "executing"] },
      },
    });
  });
  it("allows runs with no unresolved effects", async () => {
    await expect(
      assertNoUnresolvedEffects(
        { externalEffect: { count: vi.fn().mockResolvedValue(0) } },
        "run-1",
      ),
    ).resolves.toBeUndefined();
  });
});
