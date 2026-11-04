import { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { findTools, partitionTools } from "./builtin-tool-bridge.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectExistingMcpFromTool } from "./mcp-server-tool.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const mock = vi.hoisted(() => ({ persist: vi.fn() }));
vi.mock("./run-messages.js", async (load) => ({
  ...(await load<typeof import("./run-messages.js")>()),
  persistMessageInTransaction: mock.persist,
}));

const run = { id: "run", userId: "owner", spaceId: "space", botId: "bot", threadId: "thread" };
function fixture() {
  const rows = [
    {
      id: "existing",
      name: "Mail",
      userId: "owner",
      spaceId: "space",
      enabled: true,
      allSpaces: false,
      allBots: false,
      transport: "streamable_http",
      endpoint: "https://example.invalid/private/path?token=synthetic-secret",
    },
    {
      id: "restricted",
      name: "Limited",
      userId: "owner",
      spaceId: "space",
      enabled: true,
      allSpaces: false,
      allBots: true,
      transport: "stdio",
      endpoint: null,
    },
    {
      id: "shared",
      name: "Shared",
      userId: "owner",
      spaceId: "space",
      enabled: true,
      allSpaces: false,
      allBots: true,
      transport: "stdio",
      endpoint: null,
    },
    {
      id: "other-owner",
      name: "Private",
      userId: "other",
      spaceId: "space",
      enabled: true,
      allSpaces: false,
      allBots: false,
      transport: "stdio",
      endpoint: null,
    },
    {
      id: "other-space",
      name: "Other space",
      userId: "owner",
      spaceId: "other",
      enabled: true,
      allSpaces: false,
      allBots: false,
      transport: "stdio",
      endpoint: null,
    },
    {
      id: "disabled",
      name: "Disabled",
      userId: "owner",
      spaceId: "space",
      enabled: false,
      allSpaces: false,
      allBots: false,
      transport: "stdio",
      endpoint: null,
    },
  ];
  const assignments = [
    {
      userId: "owner",
      spaceId: "space",
      botId: "bot",
      serverId: "restricted",
      allowAllTools: false,
    },
  ];
  const messages = new Map<string, { runId: string; botId: string; blocks: any[] }>();
  const canSee = (row: (typeof rows)[number], where: any) =>
    row.enabled === where.enabled &&
    row.userId === where.userId &&
    (row.spaceId === "space" || row.allSpaces);
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "thread" }]),
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
    bot: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === "bot" && where.userId === "owner" && where.spaceId === "space"
          ? { id: "bot" }
          : null,
      ),
    },
    mcpServer: {
      findMany: vi.fn(async ({ where }: any) =>
        rows.filter(
          (row) =>
            canSee(row, where) &&
            (!where.name || row.name.toLowerCase().includes(where.name.contains.toLowerCase())),
        ),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          rows.find((row) => row.id === where.id && canSee(row, where)) ?? null,
      ),
    },
    botMcpServer: {
      findMany: vi.fn(async ({ where }: any) =>
        assignments.filter(
          (row) =>
            row.userId === where.userId &&
            row.spaceId === where.spaceId &&
            row.botId === where.botId &&
            where.serverId.in.includes(row.serverId),
        ),
      ),
      findFirst: vi.fn(
        async ({ where }: any) =>
          assignments.find(
            (row) =>
              row.userId === where.userId &&
              row.spaceId === where.spaceId &&
              row.botId === where.botId &&
              row.serverId === where.serverId,
          ) ?? null,
      ),
    },
    message: {
      findUnique: vi.fn(
        async ({ where }: any) => messages.get(where.threadId_clientNonce.clientNonce) ?? null,
      ),
    },
  };
  mock.persist.mockReset();
  mock.persist.mockImplementation(async (_tx, data, _role, blocks, _unread, nonce) => {
    messages.set(nonce, { runId: data.id, botId: data.botId, blocks });
    return { eventSeq: 1, firstResponseRunId: undefined };
  });
  const notify = vi.fn(async () => undefined);
  const deps = {
    prisma: { ...tx, $transaction: async (callback: any) => callback(tx) },
    events: { notify },
  } as unknown as ExecutorDeps;
  return { deps, tx, notify, messages };
}

describe("existing MCP integration", () => {
  it("lists only enabled owner integrations in the space, identifying restricted and shared grants", async () => {
    const { deps } = fixture();
    const result = await connectExistingMcpFromTool(deps, run, {}, "list");
    expect(result).toMatchObject({
      integrations: [
        { id: "existing", access: "not_assigned" },
        { id: "restricted", access: "restricted" },
        { id: "shared", access: "shared" },
      ],
      more: false,
    });
    expect(mock.persist).not.toHaveBeenCalled();
  });
  it("posts one existing approval card on replay without touching credentials or grants", async () => {
    const { deps, notify } = fixture();
    expect(
      await connectExistingMcpFromTool(deps, run, { server_id: "existing" }, "same-effect"),
    ).toMatchObject({ ok: true, access: "pending" });
    expect(mock.persist.mock.calls[0]![3]).toEqual([
      expect.objectContaining({
        kind: "mcp_approval",
        serverId: "existing",
        endpoint: "https://example.invalid",
        needsOAuth: false,
        assignmentOnly: true,
        status: "pending",
      }),
    ]);
    expect(MessageBlock.safeParse(mock.persist.mock.calls[0]![3][0]).success).toBe(true);
    expect(JSON.stringify(mock.persist.mock.calls[0]![3])).not.toContain("synthetic-secret");
    expect(
      await connectExistingMcpFromTool(deps, run, { server_id: "existing" }, "same-effect"),
    ).toMatchObject({ ok: true, access: "pending" });
    expect(mock.persist).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });
  it("does not call a dismissed card pending or reuse a key for a different server", async () => {
    const { deps, messages } = fixture();
    await connectExistingMcpFromTool(deps, run, { server_id: "existing" }, "same-effect");
    const saved = [...messages.values()][0]!;
    saved.blocks[0].status = "dismissed";
    expect(
      await connectExistingMcpFromTool(deps, run, { server_id: "existing" }, "same-effect"),
    ).toMatchObject({ access: "dismissed" });
    saved.blocks[0].serverId = "another";
    expect(
      await connectExistingMcpFromTool(deps, run, { server_id: "existing" }, "same-effect"),
    ).toHaveProperty("error");
  });
  it("is discoverable through the deferred built-in tool catalog", () => {
    const tools = selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "user",
      semanticMemoryEnabled: false,
      historyRetrievalEnabled: true,
      messagingChannelRun: false,
      fleetManagement: true,
      followUpFromUser: true,
    });
    const catalog = partitionTools(tools);
    expect(catalog.listed.some((item) => item.name === "connect_existing_mcp")).toBe(false);
    expect(findTools(catalog.deferred, { names: ["connect_existing_mcp"] }).tools).toEqual([
      expect.objectContaining({ name: "connect_existing_mcp" }),
    ]);
    expect(
      findTools(catalog.deferred, { query: "connect existing mcp integration" }).tools,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "connect_existing_mcp" })]));
  });
  it("never widens a restricted assignment, including when shared with all bots", async () => {
    const { deps } = fixture();
    expect(
      await connectExistingMcpFromTool(deps, run, { server_id: "restricted" }, "key"),
    ).toMatchObject({ ok: true, access: "restricted" });
    expect(
      await connectExistingMcpFromTool(deps, run, { server_id: "shared" }, "key2"),
    ).toMatchObject({ ok: true, access: "shared" });
    expect(mock.persist).not.toHaveBeenCalled();
  });
  it.each(["other-owner", "other-space", "disabled"])(
    "does not request access to %s",
    async (server_id) => {
      const { deps } = fixture();
      expect(await connectExistingMcpFromTool(deps, run, { server_id }, "key")).toHaveProperty(
        "error",
      );
      expect(mock.persist).not.toHaveBeenCalled();
    },
  );
  it("rejects a bot that does not belong to the current owner and space", async () => {
    const { deps } = fixture();
    expect(
      await connectExistingMcpFromTool(
        deps,
        { ...run, botId: "other" },
        { server_id: "existing" },
        "key",
      ),
    ).toHaveProperty("error");
    expect(mock.persist).not.toHaveBeenCalled();
  });
});
