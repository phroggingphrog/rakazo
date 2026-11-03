import { describe, expect, it, vi } from "vitest";
import { taskTools } from "./run-tools-tasks.js";
import type { ToolHandlers } from "./run-tool-gate.js";

type Context = Parameters<ToolHandlers[string]>[0];
type Call = Parameters<ToolHandlers[string]>[1];
describe("proactive tool entry points", () => {
  it.each([
    ["proactive_set_wake", "wake"], ["proactive_set_timer", "timer"],
    ["proactive_cancel_timer", "cancel"], ["proactive_set_interval", "interval"],
    ["proactive_hook", "hook"], ["proactive_get", "get"], ["proactive_reset", "reset"],
  ])("routes %s with trusted run identity", async (name, action) => {
    const control = vi.fn().mockResolvedValue({ updated: true });
    const finish = vi.fn();
    const ctx = { deps: { proactive: { control } }, bot: { id: "trusted-bot" }, run: { spaceId: "trusted-space", userId: "trusted-owner" } } as unknown as Context;
    const call = { args: { botId: "attacker", spaceId: "attacker", userId: "attacker", id: "timer", source: "webhook", contains: "literal", dueAt: 600000, fallbackMs: 600000 }, finish } as unknown as Call;
    await taskTools[name]!(ctx, call);
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ botId: "trusted-bot", spaceId: "trusted-space", userId: "trusted-owner", action, hook: { id: "timer", source: "webhook", contains: "literal" } }));
    expect(finish).toHaveBeenCalledWith({ updated: true });
  });
  it("returns runtime failures without reporting success", async () => {
    const finish = vi.fn();
    const ctx = { deps: { proactive: { control: vi.fn().mockRejectedValue(new Error("quota exceeded")) } }, bot: { id: "bot" }, run: { spaceId: "space", userId: "owner" } } as unknown as Context;
    await taskTools.proactive_set_timer!(ctx, { args: {}, finish } as unknown as Call);
    expect(finish).toHaveBeenCalledWith({ error: "quota exceeded" });
  });
});
