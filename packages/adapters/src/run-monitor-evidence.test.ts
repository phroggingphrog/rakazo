import { describe, expect, it, vi } from "vitest";
import {
  evidenceForMonitorCall,
  monitorSourceEvidence,
  persistMonitorReadEvidence,
} from "./run-monitor-evidence.js";

describe("monitor read execution evidence", () => {
  it("binds evidence to the configured MCP server, revision and operation", () => {
    const source = {
      connectorId: "mcp",
      resourceId: "mail-server",
      resourceRevision: 3,
      toolName: "read_mail",
    };
    const monitor = { kind: "email", source };
    expect(evidenceForMonitorCall(monitor, source, false)).toBe(monitorSourceEvidence(source));
    for (const route of [
      { ...source, connectorId: "other" },
      { ...source, resourceId: "calendar-server" },
      { ...source, resourceRevision: 4 },
      { ...source, resourceRevision: undefined },
      { ...source, toolName: "other_tool" },
      undefined,
    ])
      expect(evidenceForMonitorCall(monitor, route, false)).toBeUndefined();
    expect(evidenceForMonitorCall(monitor, source, true)).toBeUndefined();
    expect(evidenceForMonitorCall({ kind: "email" }, source, false)).toBeUndefined();
  });
  it.each([[], {}, null, "", { items: [] }, { error: null }, { error: false }, { error: "" }])(
    "counts empty successful result %j",
    async (result) => {
      const record = vi.fn();
      await expect(persistMonitorReadEvidence(result, async () => true, record)).resolves.toBe(
        true,
      );
      expect(record).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { error: "failed" },
    { isError: true },
    { receipt: "opaque", truncated: true, isError: true },
    { kind: "agent_tool_result", details: { receipt: "opaque", isError: true } },
    { kind: "agent_tool_result", details: { error: "failed" } },
  ])("excludes explicit error %j", async (result) => {
    const record = vi.fn();
    await persistMonitorReadEvidence(result, async () => true, record);
    expect(record).not.toHaveBeenCalled();
  });
  it("does not count unpersisted or thrown execution", async () => {
    const record = vi.fn();
    await expect(persistMonitorReadEvidence([], async () => false, record)).resolves.toBe(false);
    await expect(
      persistMonitorReadEvidence(
        [],
        async () => {
          throw new Error("storage unavailable");
        },
        record,
      ),
    ).rejects.toThrow("storage unavailable");
    expect(record).not.toHaveBeenCalled();
  });
  it("does not count an absent connector result as a successful source read", async () => {
    const record = vi.fn();
    await expect(persistMonitorReadEvidence(undefined, async () => true, record)).resolves.toBe(
      true,
    );
    expect(record).not.toHaveBeenCalled();
  });
  it("propagates evidence storage failure instead of returning success", async () => {
    await expect(
      persistMonitorReadEvidence(
        [],
        async () => true,
        async () => {
          throw new Error("storage unavailable");
        },
      ),
    ).rejects.toThrow("storage unavailable");
  });
});
