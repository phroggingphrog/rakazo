import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import * as effects from "./run-effects.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

const source = {
  connectorId: "mcp",
  resourceId: "server-1",
  resourceRevision: 3,
  toolName: "read_mail",
};

describe("monitor dispatch effect claim", () => {
  it("claims before dispatch and leaves a lost read for uncertain recovery", async () => {
    const effect = { id: "effect-1", status: "intended" };
    const recorded = vi
      .spyOn(effects, "recordEffect")
      .mockResolvedValueOnce({ effect, duplicate: false } as never)
      .mockResolvedValue({ effect, duplicate: true } as never);
    const claim = vi.spyOn(effects, "claimEffect").mockImplementation(async () => {
      effect.status = "executing";
      return true;
    });
    const settle = vi
      .spyOn(effects, "settleRunEffectUncertainty")
      .mockRejectedValueOnce(new Error("lease lost"))
      .mockResolvedValue({ error: "unverified", uncertain: true });
    const trusted = new Set<string>();
    const ctx = {
      deps: {
        prisma: {
          routine: { findUnique: vi.fn(async () => ({ monitor: { kind: "email", source } })) },
          attempt: { count: vi.fn(async () => 1) },
          externalEffect: { findMany: vi.fn(async () => []) },
        },
      },
      run: { id: "run-1", routineId: "routine-1", trigger: "routine" },
      runId: "run-1",
      bot: { id: "bot-1", name: "Bot" },
      context: { signal: new AbortController().signal },
      tools: { connectedPlugins: [], connector: new Map() },
      source: { ownerStartedRun: true },
      state: {
        tainted: false,
        effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
      },
      trust: {
        receivedOutsideMessage: async () => false,
        loadTrustedConnectors: async () => trusted,
        loadApprovalRules: async () => [],
        loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: true }),
      },
    } as unknown as RunContext;
    const request = {
      name: "mail_read",
      args: {},
      executionId: "call-1",
      connectorCall: { route: source },
      resolvedTool: { name: "mail_read", readOnly: true },
    } as unknown as ToolRequest;
    try {
      const gated = await gateToolCall(ctx, request, undefined);
      expect("call" in gated).toBe(true);
      if (!("call" in gated)) return;
      expect(recorded).toHaveBeenCalledOnce();
      expect(claim).toHaveBeenCalledOnce();
      expect(gated.call.claimedEffect).toBe(true);
      expect(gated.call.monitorSourceRecheck).toBe(true);
      await expect(gated.call.finishMonitorUncertain()).rejects.toThrow("lease lost");
      expect(effect.status).toBe("executing");
      // The old worker could not settle after lease loss. A later attempt must
      // settle the existing executing effect instead of dispatching again.
      await expect(gateToolCall(ctx, request, undefined)).resolves.toEqual({
        result: { error: "unverified", uncertain: true },
      });
      expect(settle).toHaveBeenCalledTimes(2);
      expect(settle).toHaveBeenCalledWith(ctx.deps, "run-1", "effect-1", "mail_read", {});
      expect(claim).toHaveBeenCalledOnce();
    } finally {
      recorded.mockRestore();
      claim.mockRestore();
      settle.mockRestore();
    }
  });
});
