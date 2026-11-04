import { describe, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";

describe("targeted setup discovery", () => {
  it("previews declared reads outside an existing bot allowlist without granting them", async () => {
    const server = { id: "local-1", slug: "local", transport: "stdio", revision: 2 };
    const assignment = {
      botId: "bot-1",
      serverId: server.id,
      server,
      allowAllTools: false,
      allowedTools: ["old"],
    };
    const prisma = {
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1" })) },
      botMcpServer: { findMany: vi.fn(async () => [assignment]) },
      mcpServer: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => server) },
    };
    const connector = new McpConnector(prisma as never, {} as never);
    const internal = connector as unknown as {
      withSession: (...args: unknown[]) => Promise<unknown>;
      recordHealth: (...args: unknown[]) => Promise<void>;
    };
    vi.spyOn(internal, "withSession").mockImplementation(async (_server, _context, fn) =>
      (fn as (session: unknown) => Promise<unknown>)({
        listTools: async () => ({
          tools: [
            { name: "old", inputSchema: {}, annotations: { readOnlyHint: true } },
            { name: "new_read", inputSchema: {}, annotations: { readOnlyHint: true } },
            { name: "send", inputSchema: {}, annotations: { readOnlyHint: false } },
          ],
        }),
      }),
    );
    vi.spyOn(internal, "recordHealth").mockResolvedValue();
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      signal: AbortSignal.timeout(1000),
    };
    const preview = await connector.discoverSetupMonitorTools(context, server.id);
    expect(preview.tools.map((tool) => tool.route?.toolName)).toEqual(["old", "new_read"]);
    const botTools = await connector.discoverMonitorTools(context, server.id);
    expect(botTools.tools.map((tool) => tool.route?.toolName)).toEqual(["old"]);
    prisma.botMcpServer.findMany.mockResolvedValueOnce([]);
    const unassignedPreview = await connector.discoverSetupMonitorTools(context, server.id);
    expect(unassignedPreview.tools.map((tool) => tool.route?.toolName)).toEqual([
      "old",
      "new_read",
    ]);
    prisma.botMcpServer.findMany.mockResolvedValueOnce([]);
    expect((await connector.discoverMonitorTools(context, server.id)).status).toBe("not_assigned");
    expect(assignment.allowedTools).toEqual(["old"]);
    expect(prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1", userId: "user-1", archivedAt: null },
      select: { id: true },
    });
  });
  it("discovers the selected assigned stdio server through the normal session path", async () => {
    const server = { id: "local-1", slug: "local", transport: "stdio", revision: 2 };
    const other = { id: "local-2", slug: "other", transport: "stdio", revision: 1 };
    const assignment = (value: typeof server) => ({
      botId: "bot-1",
      serverId: value.id,
      spaceId: "space-1",
      userId: "user-1",
      server: value,
      allowAllTools: true,
      allowedTools: [],
    });
    const prisma = {
      botMcpServer: { findMany: vi.fn(async () => [assignment(server), assignment(other)]) },
      mcpServer: { findMany: vi.fn(async () => []) },
    };
    const connector = new McpConnector(prisma as never, {} as never);
    const listTools = vi.fn(async () => ({
      tools: [
        { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      ],
    }));
    const internal = connector as unknown as {
      withSession: (
        server: unknown,
        context: unknown,
        fn: (session: unknown) => Promise<unknown>,
      ) => Promise<unknown>;
      recordHealth: (...args: unknown[]) => Promise<void>;
    };
    const session = vi
      .spyOn(internal, "withSession")
      .mockImplementation(async (_server, _context, fn) => fn({ listTools }));
    vi.spyOn(internal, "recordHealth").mockResolvedValue();
    const result = await connector.discoverMonitorTools(
      {
        operationId: "test",
        traceId: "test",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        signal: AbortSignal.timeout(1000),
      },
      "local-1",
    );
    expect(result.status).toBe("ok");
    expect(result.tools.map((tool) => tool.route?.toolName)).toEqual(["read"]);
    expect(session).toHaveBeenCalledOnce();
    expect(session.mock.calls[0]?.[0]).toEqual(server);
    expect(prisma.botMcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botId: "bot-1", spaceId: "space-1", userId: "user-1" }),
      }),
    );
  });
});
