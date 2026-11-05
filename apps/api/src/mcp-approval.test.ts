import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  dismissMcpServerApprovals,
  queueMcpConnectedRun,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "./mcp-approval.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
}));

/** PostgreSQL jsonb `@>` containment, which Prisma `array_contains` compiles to. */
function jsonContains(value: unknown, needle: unknown): boolean {
  if (Array.isArray(needle)) {
    return (
      Array.isArray(value) &&
      needle.every((item) => value.some((candidate) => jsonContains(candidate, item)))
    );
  }
  if (needle !== null && typeof needle === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.entries(needle).every(([key, item]) => jsonContains(record[key], item));
  }
  return value === needle;
}

type MessageQuery = { where?: { blocks?: { array_contains?: unknown } } };

function fixture(blocks: unknown[]) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "group-thread" }]),
    mcpApprovalContinuation: { updateMany: vi.fn(async () => ({ count: 0 })) },
    message: {
      findMany: vi.fn(
        async (_query: MessageQuery): Promise<unknown[]> => [
          { id: "card-message", botId: "bot", blocks },
        ],
      ),
      update: vi.fn(),
    },
  };
  const deps = {
    prisma: {
      bot: { findFirst: vi.fn(async () => ({ id: "bot", thread: { id: "main-thread" } })) },
      thread: { findMany: vi.fn(async () => [{ id: "group-thread" }]) },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    },
    events: { notify: vi.fn() },
  } as unknown as Parameters<typeof resolveMcpApprovalCards>[0];
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  return { deps, actor, tx };
}

describe("resolveMcpApprovalCards", () => {
  it("targets the selected request and its same-run duplicates, leaving another run open", async () => {
    const { deps, actor, tx } = fixture([]);
    const card = (id: string, runId: string, assignmentOnly = true) => ({
      id,
      botId: "bot",
      runId,
      blocks: [
        {
          kind: "mcp_approval",
          serverId: "srv-a",
          name: "Mail",
          status: "pending",
          assignmentOnly,
        },
      ],
    });
    const rows = [
      card("other", "run-b", false),
      card("duplicate", "run-a"),
      card("selected", "run-a"),
    ];
    tx.message.findMany.mockImplementation(async () => rows);
    const effect = vi.fn(async () => "saved");
    await resolveMcpApprovalCards(
      deps,
      actor,
      {
        botId: "bot",
        serverId: "srv-a",
        status: "connected",
        threadId: "group-thread",
        messageId: "selected",
      },
      effect,
    );
    expect(
      (tx.message.update.mock.calls as unknown as Array<[{ where: { id: string } }]>)
        .map(([arg]) => arg.where.id)
        .sort(),
    ).toEqual(["duplicate", "selected"]);
    expect(effect).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ messageId: "selected", assignmentOnly: true }),
    );
  });

  it("leaves distinct legacy requests untouched when the clicked card is unknown", async () => {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany.mockResolvedValue([
      {
        id: "first",
        botId: "bot",
        runId: "run-a",
        blocks: [{ kind: "mcp_approval", serverId: "srv-a", name: "Mail", status: "pending" }],
      },
      {
        id: "second",
        botId: "bot",
        runId: "run-b",
        blocks: [{ kind: "mcp_approval", serverId: "srv-a", name: "Mail", status: "pending" }],
      },
    ]);
    const effect = vi.fn();
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        {
          botId: "bot",
          serverId: "srv-a",
          status: "dismissed",
          threadId: "group-thread",
        },
        effect,
      ),
    ).rejects.toThrow("approve or dismiss each card separately");
    expect(effect).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it.each(["dismissed", "connected"] as const)(
    "does not repaint a same-run pending card when the selected card was already %s",
    async (status) => {
      const { deps, actor, tx } = fixture([]);
      tx.message.findMany.mockResolvedValue([
        {
          id: "selected",
          botId: "bot",
          runId: "run",
          blocks: [{ kind: "mcp_approval", serverId: "srv-a", name: "Mail", status }],
        },
        {
          id: "pending",
          botId: "bot",
          runId: "run",
          blocks: [{ kind: "mcp_approval", serverId: "srv-a", name: "Mail", status: "pending" }],
        },
      ]);
      const effect = vi.fn();
      await resolveMcpApprovalCards(
        deps,
        actor,
        {
          botId: "bot",
          serverId: "srv-a",
          status: "connected",
          threadId: "group-thread",
          messageId: "selected",
        },
        effect,
      );
      expect(tx.message.update).not.toHaveBeenCalled();
      expect(effect).toHaveBeenCalledWith(tx, { assign: status === "connected", resolved: false });
    },
  );

  it("rejects a card outside the authorized conversation", async () => {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany.mockResolvedValue([
      {
        id: "foreign",
        botId: "another-bot",
        runId: "run",
        blocks: [{ kind: "mcp_approval", serverId: "srv-a", name: "Mail", status: "pending" }],
      },
    ]);
    await expect(
      resolveMcpApprovalCards(deps, actor, {
        botId: "bot",
        serverId: "srv-a",
        status: "connected",
        threadId: "group-thread",
        messageId: "foreign",
      }),
    ).rejects.toThrow();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("does not guess when a bounded legacy scan cannot cover the thread", async () => {
    const { deps, actor, tx } = fixture([]);
    tx.message.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => ({
        id: `message-${index}`,
        botId: "bot",
        runId: null,
        blocks: [],
      })),
    );
    const effect = vi.fn();
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        {
          botId: "bot",
          serverId: "srv-a",
          status: "connected",
          threadId: "group-thread",
        },
        effect,
      ),
    ).rejects.toThrow("too many messages");
    expect(effect).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("flips pending and pre-upgrade cards for the matching server", async () => {
    const blocks = [
      { kind: "text", text: "before" },
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "Legacy", serverId: "srv-a" },
      { kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
      threadId: "group-thread",
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [
          blocks[0],
          { ...blocks[1], status: "connected" },
          { ...blocks[2], status: "connected" },
          blocks[3],
          blocks[4],
        ],
      },
    });
  });

  it("scans the requested chat when a threadId is given", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "dismissed",
      threadId: "group-thread",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledWith({
      where: {
        id: "group-thread",
        spaceId: "space",
        userId: "user",
        OR: [{ botId: "bot" }, { group: { members: { some: { botId: "bot" } } } }],
      },
      select: { id: true, botId: true },
    });
    expect(tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ threadId: "group-thread" }) }),
    );
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "dismissed" }] },
    });
  });

  it("falls back to owner scope for chats the bot was removed from", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    deps.prisma.thread.findMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "group-thread" }]);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
      threadId: "group-thread",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledTimes(2);
    expect(deps.prisma.thread.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "group-thread",
        spaceId: "space",
        userId: "user",
        groupId: { not: null },
      },
      select: { id: true, botId: true },
    });
    expect(deps.prisma.bot.findFirst).toHaveBeenCalled();
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "connected" }] },
    });
  });

  it("leaves untouched messages alone when nothing matches", async () => {
    const blocks = [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "connected",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("writes the assignment in the same transaction when a card connects", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        { botId: "bot", serverId: "srv-a", status: "connected" },
        effect,
      ),
    ).resolves.toBe("saved");
    expect(effect).toHaveBeenCalledWith(tx, { assign: true, resolved: true });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "connected" }] },
    });
  });

  it("reports whether a resolved card was for an existing integration", async () => {
    const blocks = [
      {
        kind: "mcp_approval",
        name: "A",
        serverId: "srv-a",
        status: "pending",
        assignmentOnly: true,
      },
    ];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await resolveMcpApprovalCards(
      deps,
      actor,
      { botId: "bot", serverId: "srv-a", status: "connected", threadId: "group-thread" },
      effect,
    );
    expect(effect).toHaveBeenCalledWith(tx, {
      assign: true,
      resolved: true,
      assignmentOnly: true,
      messageId: "card-message",
      decisionSeq: 1,
    });
  });

  it("does not infer an author for an unattributed legacy group card", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    tx.message.findMany.mockResolvedValue([{ id: "legacy", botId: null, blocks }]);
    vi.mocked(deps.prisma.thread.findMany).mockResolvedValue([
      { id: "group-thread", botId: null },
    ] as never);
    const effect = vi.fn(async () => "saved");
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        { botId: "bot", serverId: "srv-a", status: "connected", threadId: "group-thread" },
        effect,
      ),
    ).rejects.toThrow("older card cannot be linked");
    expect(effect).not.toHaveBeenCalled();
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("attributes an unattributed legacy card in a direct bot thread", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    tx.message.findMany.mockResolvedValue([{ id: "legacy", botId: null, blocks }]);
    vi.mocked(deps.prisma.thread.findMany).mockResolvedValue([
      { id: "direct-thread", botId: "bot" },
    ] as never);
    const effect = vi.fn(async () => "saved");
    await resolveMcpApprovalCards(
      deps,
      actor,
      { botId: "bot", serverId: "srv-a", status: "connected", threadId: "direct-thread" },
      effect,
    );
    expect(effect).toHaveBeenCalledWith(tx, {
      assign: true,
      resolved: true,
      messageId: "legacy",
      decisionSeq: 1,
    });
  });

  it("does not inherit an assignment-only flag from a dismissed card", async () => {
    const blocks = [
      {
        kind: "mcp_approval",
        name: "A",
        serverId: "srv-a",
        status: "dismissed",
        assignmentOnly: true,
      },
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await resolveMcpApprovalCards(
      deps,
      actor,
      { botId: "bot", serverId: "srv-a", status: "connected", threadId: "group-thread" },
      effect,
    );
    expect(effect).toHaveBeenCalledWith(tx, {
      assign: true,
      resolved: true,
      messageId: "card-message",
      decisionSeq: 1,
    });
  });

  it("does not assign when a dismissed card already won", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "dismissed" }];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await resolveMcpApprovalCards(
      deps,
      actor,
      { botId: "bot", serverId: "srv-a", status: "connected", threadId: "group-thread" },
      effect,
    );
    expect(effect).toHaveBeenCalledWith(tx, { assign: false, resolved: false });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("still assigns from settings after a card was dismissed", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "dismissed" }];
    const { deps, actor, tx } = fixture(blocks);
    const effect = vi.fn(async () => "saved");
    await expect(
      resolveMcpApprovalCards(
        deps,
        actor,
        { botId: "bot", serverId: "srv-a", status: "connected" },
        effect,
      ),
    ).resolves.toBe("saved");
    expect(effect).toHaveBeenCalledWith(tx, { assign: true, resolved: true });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: { blocks: [{ ...blocks[0], status: "connected" }] },
    });
  });

  it("returns a connected card to pending when the assignment is removed", async () => {
    const blocks = [
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" },
      { kind: "mcp_approval", name: "B", serverId: "srv-b", status: "connected" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const { deps, actor, tx } = fixture(blocks);
    await revertConnectedMcpApprovals(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "pending",
    });
    expect(deps.prisma.thread.findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        userId: "user",
        OR: [{ botId: "bot" }, { groupId: { not: null }, messages: { some: { botId: "bot" } } }],
      },
      select: { id: true, botId: true },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [{ ...blocks[0], status: "pending" }, blocks[1], blocks[2]],
      },
    });
    expect(tx.mcpApprovalContinuation.updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: "space",
        userId: "user",
        botId: "bot",
        serverId: "srv-a",
        status: "pending",
      },
      data: { status: "cancelled", cancelledAt: expect.any(Date) },
    });
  });

  it("dismisses connected and pending cards when the server is deleted", async () => {
    const blocks = [
      { kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" },
      { kind: "mcp_approval", name: "Open", serverId: "srv-a", status: "pending" },
      { kind: "mcp_approval", name: "C", serverId: "srv-a", status: "dismissed" },
    ];
    const rows = [
      {
        id: "card-message",
        botId: null,
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks,
      },
      {
        id: "mention",
        botId: "bot",
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks: [{ kind: "text", text: "server srv-a is gone" }],
      },
      {
        id: "other-server",
        botId: "bot",
        threadId: "group-thread",
        thread: { botId: "bot" },
        blocks: [{ kind: "mcp_approval", name: "B", serverId: "srv-b", status: "connected" }],
      },
    ];
    const { deps, actor, tx } = fixture(blocks);
    tx.message.findMany.mockImplementation(async (query) => {
      const needle = query.where?.blocks?.array_contains;
      if (needle === undefined) return [];
      return rows.filter((row) => jsonContains(row.blocks, needle));
    });
    await dismissMcpServerApprovals(deps, actor, "srv-a");
    expect(deps.prisma.thread.findMany).not.toHaveBeenCalled();
    expect(tx.message.findMany).toHaveBeenCalledWith({
      where: {
        thread: { spaceId: "space", userId: "user" },
        blocks: { array_contains: [{ kind: "mcp_approval", serverId: "srv-a" }] },
      },
      select: {
        id: true,
        botId: true,
        blocks: true,
        threadId: true,
        thread: { select: { botId: true } },
      },
    });
    expect(tx.message.update).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "card-message" },
      data: {
        blocks: [
          { ...blocks[0], status: "dismissed" },
          { ...blocks[1], status: "dismissed" },
          blocks[2],
        ],
      },
    });
  });

  it("does not reset another bot's card in a shared group", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "connected" }];
    const { deps, actor, tx } = fixture(blocks);
    tx.message.findMany.mockResolvedValue([{ id: "card-message", botId: "other-bot", blocks }]);
    await revertConnectedMcpApprovals(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "pending",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it("does not repaint another bot's direct chat when the bot has left", async () => {
    const blocks = [{ kind: "mcp_approval", name: "A", serverId: "srv-a", status: "pending" }];
    const { deps, actor, tx } = fixture(blocks);
    vi.mocked(deps.prisma.thread.findMany).mockResolvedValue([]);
    vi.mocked(deps.prisma.bot.findFirst).mockResolvedValue(null);
    await resolveMcpApprovalCards(deps, actor, {
      botId: "bot",
      serverId: "srv-a",
      status: "dismissed",
      threadId: "other-thread",
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });
});

describe("queueMcpConnectedRun", () => {
  const actor = {
    userId: "user",
    spaceId: "space",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  };
  const input = { botId: "bot", serverId: "srv-a", threadId: "thread" };

  function connectedFixture(state: { thread?: boolean; busy?: boolean; archived?: boolean } = {}) {
    const tx = {
      bot: { findFirst: vi.fn(async () => (state.archived ? null : { id: "bot" })) },
      thread: { findFirst: vi.fn(async () => (state.thread === false ? null : { id: "thread" })) },
      run: {
        findFirst: vi.fn(async () => (state.busy ? { id: "active" } : null)),
        create: vi.fn(async () => ({ id: "run" })),
      },
      mcpServer: { findFirst: vi.fn(async () => ({ name: "Axiom" })) },
      task: { create: vi.fn(async (_args: { data: { prompt: string } }) => ({ id: "task" })) },
    };
    return tx as typeof tx & Parameters<typeof queueMcpConnectedRun>[0];
  }

  it("queues a turn for the bot in the card's chat", async () => {
    const tx = connectedFixture();
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBe("run");
    expect(tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "bot",
        threadId: "thread",
        prompt: expect.stringContaining('"Axiom"'),
      }),
    });
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ taskId: "task", trigger: "user", status: "queued" }),
      select: { id: true },
    });
  });

  it("does not claim a newly assigned existing integration is ready", async () => {
    const tx = connectedFixture();
    await expect(
      queueMcpConnectedRun(tx, actor, { ...input, assignmentOnly: true, allowAllTools: true }),
    ).resolves.toBe("run");
    const prompt = tx.task.create.mock.calls[0]![0].data.prompt;
    expect(prompt).toContain("assignment was saved");
    expect(prompt).toContain("provider sign-in and tool availability have not been verified");
    expect(prompt).not.toContain("tools are available now");
  });

  it("tells the bot when the actual existing assignment is restricted", async () => {
    const tx = connectedFixture();
    await expect(
      queueMcpConnectedRun(tx, actor, { ...input, assignmentOnly: true, allowAllTools: false }),
    ).resolves.toBe("run");
    const prompt = tx.task.create.mock.calls[0]![0].data.prompt;
    expect(prompt).toContain("restricted to its allowed tools");
    expect(prompt).toContain("have not been verified");
  });

  it("also describes restricted assignments on legacy cards without claiming all tools are available", async () => {
    const tx = connectedFixture();
    await queueMcpConnectedRun(tx, actor, { ...input, allowAllTools: false });
    const prompt = tx.task.create.mock.calls[0]![0].data.prompt;
    expect(prompt).toContain("restricted to its allowed tools");
    expect(prompt).not.toContain("tools are available now");
  });

  it("does not queue while the bot is still busy in that chat", async () => {
    const tx = connectedFixture({ busy: true });
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBeNull();
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("does not restart an archived bot", async () => {
    const tx = connectedFixture({ archived: true });
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBeNull();
    expect(tx.bot.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "bot", archivedAt: null }),
      select: { id: true },
    });
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it("does not queue in a chat the bot is not part of", async () => {
    const tx = connectedFixture({ thread: false });
    await expect(queueMcpConnectedRun(tx, actor, input)).resolves.toBeNull();
    expect(tx.task.create).not.toHaveBeenCalled();
  });
});
