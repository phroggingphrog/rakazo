import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.invalid",
  isDeploymentOwner: false,
};
const input = { botId: "bot", serverId: "server", revision: 3, toolName: "read_mail" };
const offered = [
  {
    readOnly: true,
    batch: false,
    description: "Read",
    inputSchema: {},
    route: { connectorId: "mcp", resourceId: "server", resourceRevision: 3, toolName: "read_mail" },
  },
  {
    readOnly: false,
    batch: false,
    description: "Write",
    inputSchema: {},
    route: { connectorId: "mcp", resourceId: "server", resourceRevision: 3, toolName: "send_mail" },
  },
];
function fixture(assignment: unknown = null, allBots = false) {
  const row = {
    id: "server",
    revision: 3,
    spaceId: "space",
    allSpaces: false,
    allBots,
    transport: "streamable_http",
    slug: "mail",
    name: "Mail",
  };
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: "bot" }])
      .mockResolvedValueOnce([row]),
    botMcpServer: {
      findFirst: vi.fn(async () => assignment),
      create: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    mcpServer: { findFirst: vi.fn(async () => row) },
    $transaction: vi.fn(async (fn: (value: unknown) => unknown) => fn(tx)),
  };
  const mcp = { discoverSetupMonitorTools: vi.fn(async () => ({ status: "ok", tools: offered })) };
  const deps = { prisma, mcp, env: {} } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } });
  return { client, prisma, mcp, tx };
}

describe("setup read access", () => {
  it("previews only declared reads without assigning a bot", async () => {
    const f = fixture();
    const result = await f.client.setupPlans.previewReads({ botId: "bot", serverId: "server" });
    expect(result.tools.map((tool) => tool.name)).toEqual(["read_mail"]);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.mcp.discoverSetupMonitorTools).toHaveBeenCalledOnce();
  });
  it("adds only the selected read for an unassigned bot", async () => {
    const f = fixture();
    expect(await f.client.setupPlans.grantRead(input)).toEqual({ status: "allowed" });
    expect(f.tx.botMcpServer.create).toHaveBeenCalledWith({
      data: {
        userId: "owner",
        spaceId: "space",
        botId: "bot",
        serverId: "server",
        allowAllTools: false,
        allowedTools: ["read_mail"],
      },
    });
    expect(f.tx.botMcpServer.updateMany).not.toHaveBeenCalled();
  });
  it("preserves other restricted tools and detects concurrent changes", async () => {
    const existing = {
      id: "assignment",
      allowAllTools: false,
      allowedTools: ["other_read"],
      updatedAt: new Date("2026-01-01"),
    };
    const f = fixture(existing);
    expect(await f.client.setupPlans.grantRead(input)).toEqual({ status: "allowed" });
    expect(f.tx.botMcpServer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "assignment",
        userId: "owner",
        spaceId: "space",
        allowAllTools: false,
        updatedAt: existing.updatedAt,
        allowedTools: { equals: ["other_read"] },
      },
      data: { allowedTools: ["other_read", "read_mail"] },
    });
    const conflict = fixture(existing);
    conflict.tx.botMcpServer.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(conflict.client.setupPlans.grantRead(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("preserves all-bot access and rejects a write operation", async () => {
    const f = fixture(null, true);
    expect(await f.client.setupPlans.grantRead(input)).toEqual({ status: "allowed" });
    expect(f.tx.botMcpServer.create).not.toHaveBeenCalled();
    const write = fixture();
    await expect(
      write.client.setupPlans.grantRead({ ...input, toolName: "send_mail" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(write.prisma.$transaction).not.toHaveBeenCalled();
  });
  it("rejects a missing or cross-owner bot before discovery", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      f.client.setupPlans.previewReads({ botId: "bot", serverId: "server" }),
    ).rejects.toBeDefined();
    expect(f.prisma.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "bot", spaceId: "space", userId: "owner", archivedAt: null },
      select: { id: true },
    });
    expect(f.mcp.discoverSetupMonitorTools).not.toHaveBeenCalled();
  });
});
