import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";
import { McpSession } from "./mcp-transport.js";

const server = {
  id: "server-1",
  slug: "mail",
  revision: 4,
  transport: "streamable_http",
  endpoint: "https://example.invalid/mcp",
  secretId: null,
  args: [],
};
const context = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "owner",
  botId: "bot",
  signal: AbortSignal.timeout(5000),
};

function fixture() {
  const assignment = { serverId: server.id, server, allowAllTools: true, allowedTools: [] };
  const prisma = {
    botMcpServer: { findFirst: vi.fn(async () => assignment) },
    mcpServer: { findFirst: vi.fn(async () => null) },
  };
  const retrieve = vi.fn(async () => ({}));
  const connector = new McpConnector(prisma as never, {} as never, {
    outputStore: { retrieve } as never,
  });
  const connect = vi.spyOn(McpSession.prototype, "connectRemote").mockResolvedValue({
    transport: "streamable-http",
    usedFallback: false,
  });
  const callTool = vi.spyOn(McpSession.prototype, "callTool").mockResolvedValue({ content: [] });
  vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
  return { connector, connect, callTool, retrieve, prisma };
}

async function events(
  connector: McpConnector,
  revision: number | undefined,
  toolName = "read",
  monitorSourceRecheck = false,
) {
  const result = [];
  for await (const event of connector.execute(
    {
      tool: "mcp__mail__read",
      executionId: "execution",
      args: {},
      route: { connectorId: "mcp", resourceId: server.id, resourceRevision: revision, toolName },
    },
    { ...context, monitorSourceRecheck },
  ))
    result.push(event);
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("MCP source revision at execution", () => {
  it("does not connect or call a server whose revision changed after discovery", async () => {
    const f = fixture();
    const result = await events(f.connector, server.revision - 1);
    expect(result).toEqual([expect.objectContaining({ type: "error" })]);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("does not retrieve retained output with a stale route", async () => {
    const f = fixture();
    const result = await events(f.connector, server.revision - 1, "__rakazo_read_output");
    expect(result).toEqual([expect.objectContaining({ type: "error" })]);
    expect(f.retrieve).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([server.revision, undefined])(
    "preserves matching and legacy routes: %s",
    async (revision) => {
      const f = fixture();
      const result = await events(f.connector, revision);
      expect(result).toEqual([expect.objectContaining({ type: "result" })]);
      expect(f.callTool).toHaveBeenCalledOnce();
      await f.connector.close();
    },
  );

  it("does not dispatch a monitor read after assignment is revoked during session setup", async () => {
    const f = fixture();
    f.connect.mockImplementationOnce(async () => {
      f.prisma.botMcpServer.findFirst.mockResolvedValue(null as never);
      return { transport: "streamable-http", usedFallback: false };
    });
    const result = await events(f.connector, server.revision, "read", true);
    expect(result).toEqual([expect.objectContaining({ type: "error" })]);
    expect(result[0]).not.toHaveProperty("outcome");
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("does not return a monitor result after assignment is revoked during a call", async () => {
    const f = fixture();
    f.callTool.mockImplementationOnce(async () => {
      f.prisma.botMcpServer.findFirst.mockResolvedValue(null as never);
      return { content: [{ type: "text", text: "synthetic private output" }] };
    });
    const result = await events(f.connector, server.revision, "read", true);
    expect(result).toEqual([expect.objectContaining({ type: "error", outcome: "unknown" })]);
    expect(JSON.stringify(result)).not.toContain("synthetic private output");
    expect(f.callTool).toHaveBeenCalledOnce();
  });

  it("does not return a monitor result when the integration revision changes during a call", async () => {
    const f = fixture();
    f.callTool.mockImplementationOnce(async () => {
      f.prisma.botMcpServer.findFirst.mockResolvedValue({
        serverId: server.id,
        server: { ...server, revision: server.revision + 1 },
        allowAllTools: true,
        allowedTools: [],
      });
      return { content: [{ type: "text", text: "synthetic private output" }] };
    });
    const result = await events(f.connector, server.revision, "read", true);
    expect(result).toEqual([expect.objectContaining({ type: "error", outcome: "unknown" })]);
    expect(JSON.stringify(result)).not.toContain("synthetic private output");
    expect(f.callTool).toHaveBeenCalledOnce();
  });

  it("does not return a monitor result when assignment revalidation fails", async () => {
    const f = fixture();
    f.callTool.mockImplementationOnce(async () => {
      f.prisma.botMcpServer.findFirst.mockRejectedValue(new Error("synthetic database error"));
      return { content: [{ type: "text", text: "synthetic private output" }] };
    });
    const result = await events(f.connector, server.revision, "read", true);
    expect(result).toEqual([expect.objectContaining({ type: "error", outcome: "unknown" })]);
    expect(JSON.stringify(result)).not.toContain("synthetic private output");
    expect(f.callTool).toHaveBeenCalledOnce();
  });

  it("does not replay an expired-session monitor call automatically", async () => {
    const f = fixture();
    f.callTool.mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found"));
    const result = await events(f.connector, server.revision, "read", true);
    expect(result).toEqual([expect.objectContaining({ type: "error", outcome: "unknown" })]);
    expect(f.callTool).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
