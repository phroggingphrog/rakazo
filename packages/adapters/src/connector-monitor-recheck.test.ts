import { describe, expect, it, vi } from "vitest";
import { persistMonitorReadEvidence } from "./run-monitor-evidence.js";
import { connectorTool } from "./run-tools-integrations.js";

describe("monitor source recheck context", () => {
  it.each([true, false])("passes the monitor decision to the connector: %s", async (monitor) => {
    const execute = vi.fn(async function* (
      _call: unknown,
      ctx: { monitorSourceRecheck?: boolean },
    ) {
      expect(ctx.monitorSourceRecheck).toBe(monitor ? true : undefined);
      yield { type: "result", data: { content: [] } };
    });
    const call = {
      name: "mail_read",
      args: {},
      effectKey: "effect",
      connectorCall: {},
      monitorSourceRecheck: monitor,
      finish: vi.fn(async (value: unknown) => value),
    };
    const ctx = {
      deps: { connector: { execute } },
      run: {},
      bot: {},
      thread: {},
      context: {},
    };
    await expect(connectorTool(ctx as never, call as never)).resolves.toEqual({ content: [] });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not record read evidence for an unverified changed-source result", async () => {
    const record = vi.fn();
    const execute = async function* () {
      yield {
        type: "error",
        outcome: "unknown",
        message: "MCP source or assignment changed during the read; its result is unverified.",
      };
      yield { type: "result", data: { content: [{ type: "text", text: "synthetic output" }] } };
    };
    const call = {
      name: "mail_read",
      args: {},
      effectKey: "effect",
      connectorCall: {},
      monitorSourceRecheck: true,
      finishMonitorUncertain: vi.fn(async () => ({ error: "unverified", uncertain: true })),
      finish: async (value: unknown) => {
        await persistMonitorReadEvidence(value, async () => true, record);
        return value;
      },
    };
    const ctx = {
      deps: { connector: { execute } },
      run: {},
      bot: {},
      thread: {},
      context: {},
    };
    await expect(connectorTool(ctx as never, call as never)).resolves.toEqual({
      error: "unverified",
      uncertain: true,
    });
    expect(call.finishMonitorUncertain).toHaveBeenCalledOnce();
    expect(record).not.toHaveBeenCalled();
  });
});
