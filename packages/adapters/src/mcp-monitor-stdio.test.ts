import { describe, expect, it, vi } from "vitest";
import { McpConnector } from "./mcp-connector.js";

describe("targeted setup discovery", () => {
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
