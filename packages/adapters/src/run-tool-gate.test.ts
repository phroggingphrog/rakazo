import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

function fixture(monitor: unknown, name: string, readOnly?: boolean) {
  const findUnique = vi.fn().mockResolvedValue({ monitor });
  const ctx = {
    deps: { prisma: { routine: { findUnique } } },
    run: { routineId: "routine-1", trigger: "routine" },
    tools: { connector: new Map() },
  } as unknown as RunContext;
  const request = {
    name,
    args: {},
    executionId: "execution-1",
    connectorCall: {},
    resolvedTool: readOnly === undefined ? undefined : { name, readOnly },
    nextApprovedTool: name,
    approvedEffectKey: "prior-approval",
  } as unknown as ToolRequest;
  return { ctx, request, findUnique };
}

describe("persisted monitor tool boundary", () => {
  it("rejects a different MCP source before dispatch even when it is read-only", async () => {
    const source = {
      connectorId: "mcp",
      resourceId: "mail-server",
      resourceRevision: 3,
      toolName: "read_mail",
    };
    for (const route of [
      { ...source, resourceId: "other-server" },
      { ...source, resourceRevision: 4 },
      { ...source, resourceRevision: undefined },
      { ...source, toolName: "other_tool" },
      undefined,
    ]) {
      const { ctx, request } = fixture({ kind: "email", source }, "mail_read", true);
      request.connectorCall.route = route;
      expect(await gateToolCall(ctx, request, undefined)).toEqual({
        result: { error: "Workspace monitor capability denied" },
      });
    }
  });
  it("rejects a source-matching batch even if all named actions are reads", async () => {
    const source = {
      connectorId: "mcp",
      resourceId: "mail-server",
      resourceRevision: 3,
      toolName: "read_mail",
    };
    const { ctx, request } = fixture({ kind: "email", source }, "mail_read", true);
    request.connectorCall.route = source;
    request.args = { tools: [{ tool_slug: "mail_read", arguments: {} }] };
    request.resolvedTool = {
      name: "mail_read",
      description: "Batch",
      inputSchema: {},
      readOnly: true,
      batch: { items: "tools", action: "tool_slug", arguments: "arguments" },
    };
    expect(await gateToolCall(ctx, request, undefined)).toEqual({
      result: { error: "Workspace monitor capability denied" },
    });
  });
  it.each(["email", "calendar", "subscriptions"])(
    "blocks writes for %s before prior approvals or trust can bypass policy",
    async (kind) => {
      const { ctx, request, findUnique } = fixture(
        { kind, mode: "approval_required" },
        "service_delete",
        false,
      );
      expect(await gateToolCall(ctx, request, undefined)).toEqual({
        result: { error: "Workspace monitor capability denied" },
      });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: "routine-1" },
        select: { monitor: true },
      });
    },
  );
  it.each(["shell", "execute_tool", "web_fetch", "delegate", "unknown_connector"])(
    "denies unresolved or bypass route %s",
    async (name) => {
      const { ctx, request } = fixture({ kind: "email" }, name);
      expect(await gateToolCall(ctx, request, undefined)).toEqual({
        result: { error: "Workspace monitor capability denied" },
      });
    },
  );
  it("rejects malformed persisted policy even for a declared read", async () => {
    const { ctx, request } = fixture({ kind: "calendar", extra: true }, "service_get", true);
    expect(await gateToolCall(ctx, request, undefined)).toEqual({
      result: { error: "Workspace monitor capability denied" },
    });
  });
  it("fails closed when the associated routine disappeared", async () => {
    const { ctx, request, findUnique } = fixture(null, "service_delete", false);
    findUnique.mockResolvedValue(null);
    expect(await gateToolCall(ctx, request, undefined)).toEqual({
      result: { error: "Routine policy unavailable" },
    });
  });
});
