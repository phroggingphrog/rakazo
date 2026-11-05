import type { Actor } from "@rakazo/contracts";
import { CreateRoutineInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { mapRoutine, routineRowData, routineTestTarget } from "./routines.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

describe("routine monitor persistence", () => {
  it("does not enqueue a protected routine test while protected execution is unavailable", async () => {
    const getBot = vi.fn();
    const prisma = { routine: { findFirst: vi.fn(async () => ({ protected: true })) } };
    await expect(
      routineTestTarget(prisma as never, { getBot } as never, actor, "routine-1"),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Protected setup execution is not available yet.",
    });
    expect(getBot).not.toHaveBeenCalled();
  });
  it("keeps old create requests unchanged and defaults selected monitors to report-only", () => {
    const base = { botId: "bot-1", name: "Monitor", prompt: "Observe", crons: ["0 9 * * *"] };
    const legacy = routineRowData(actor, CreateRoutineInput.parse(base), null);
    expect(legacy).not.toHaveProperty("monitor");
    const selected = routineRowData(
      actor,
      CreateRoutineInput.parse({ ...base, monitor: { kind: "calendar" } }),
      null,
    );
    expect(selected.monitor).toEqual({ kind: "calendar", mode: "report_only" });
  });
  it("returns persisted monitor configuration and maps legacy rows to null", () => {
    const row = {
      id: "routine-1",
      botId: "bot-1",
      name: "Monitor",
      prompt: "Observe",
      crons: [],
      timezone: "UTC",
      active: false,
      notify: true,
      webhookEnabled: false,
      githubEnabled: false,
      messageProvider: null,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      watch: null,
      watchState: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date("2026-11-04T00:00:00Z"),
    };
    expect(mapRoutine(row).monitor).toBeNull();
    expect(
      mapRoutine({ ...row, monitor: { kind: "subscriptions", mode: "approval_required" } }).monitor,
    ).toEqual({ kind: "subscriptions", mode: "approval_required" });
    expect(() => mapRoutine({ ...row, monitor: { kind: "calendar", mode: "unsafe" } })).toThrow();
  });
});
