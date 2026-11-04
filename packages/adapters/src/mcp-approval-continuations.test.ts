import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileMcpApprovalContinuations } from "./mcp-approval-continuations.js";

function fixture(
  options: {
    busy?: boolean;
    missingGrant?: boolean;
    otherFirst?: boolean;
    revoked?: boolean;
    legacyGroupCard?: boolean;
  } = {},
) {
  const intent = {
    id: "intent",
    threadId: "thread",
    botId: "bot",
    userId: "user",
    spaceId: "space",
    serverId: "server",
    messageId: "message",
    assignmentOnly: true,
    status: "pending",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    mcpApprovalContinuation: {
      findUnique: vi.fn(async () => intent),
      findFirst: vi.fn(async () => ({ id: options.otherFirst ? "older" : intent.id })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    thread: {
      findFirst: vi.fn(async () => ({
        id: "thread",
        botId: options.legacyGroupCard ? null : "bot",
      })),
    },
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    mcpServer: { findFirst: vi.fn(async () => ({ name: "Notes", allBots: false, enabled: true })) },
    botMcpServer: {
      findFirst: vi.fn(async () => (options.missingGrant ? null : { allowAllTools: false })),
    },
    message: {
      findFirst: vi.fn(async () => ({
        botId: options.legacyGroupCard ? null : "bot",
        blocks: [
          {
            kind: "mcp_approval",
            serverId: "server",
            status: options.revoked ? "pending" : "connected",
          },
        ],
      })),
    },
    run: {
      findFirst: vi.fn(async () => (options.busy ? { id: "running" } : null)),
      create: vi.fn(async () => ({ id: "new-run" })),
    },
    task: { create: vi.fn(async (_input: unknown) => ({ id: "new-task" })) },
  };
  const prisma = {
    mcpApprovalContinuation: { findMany: vi.fn(async (_input: unknown) => [intent]) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    scan: prisma.mcpApprovalContinuation.findMany,
    tx,
    intent,
  };
}

describe("MCP approval continuation reconciliation", () => {
  it("materializes a restricted approval into one queued run with truthful context", async () => {
    const f = fixture();
    await reconcileMcpApprovalContinuations(f.prisma, 10);
    expect(f.tx.mcpApprovalContinuation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ decisionSeq: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      }),
    );
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.tx.task.create.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user",
          botId: "bot",
          threadId: "thread",
          status: "queued",
          prompt: expect.stringContaining("restricted to its allowed tools"),
        }),
      }),
    );
    expect(f.tx.run.create).toHaveBeenCalledOnce();
    expect(f.tx.mcpApprovalContinuation.update).toHaveBeenCalledWith({
      where: { id: "intent" },
      data: { status: "materialized", materializedAt: expect.any(Date), runId: "new-run" },
    });
  });

  it.each([{ busy: true }, { otherFirst: true }])(
    "leaves a held or out-of-order intent pending: %j",
    async (options) => {
      const f = fixture(options);
      await reconcileMcpApprovalContinuations(f.prisma, 10);
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.tx.mcpApprovalContinuation.update).not.toHaveBeenCalled();
    },
  );

  it.each([{ missingGrant: true }, { revoked: true }, { legacyGroupCard: true }])(
    "cancels a no-longer-authorized intent: %j",
    async (options) => {
      const f = fixture(options);
      await reconcileMcpApprovalContinuations(f.prisma, 10);
      expect(f.tx.task.create).not.toHaveBeenCalled();
      expect(f.tx.mcpApprovalContinuation.updateMany).toHaveBeenCalledWith({
        where: { id: "intent", status: "pending" },
        data: { status: "cancelled", cancelledAt: expect.any(Date) },
      });
    },
  );

  it("advances a bounded cursor past held rows and wraps after the final page", async () => {
    const f = fixture({ busy: true });
    const cursor = await reconcileMcpApprovalContinuations(f.prisma, 1);
    expect(cursor).toMatchObject({ id: "intent", createdAt: f.intent.createdAt });
    f.scan.mockResolvedValueOnce([]);
    expect(await reconcileMcpApprovalContinuations(f.prisma, 1, cursor)).toBeUndefined();
    expect(f.scan.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
        take: 1,
      }),
    );
  });

  it("holds an otherwise valid disabled server and resumes after it is enabled", async () => {
    const f = fixture();
    f.tx.mcpServer.findFirst.mockResolvedValueOnce({
      name: "Notes",
      allBots: false,
      enabled: false,
    });
    await reconcileMcpApprovalContinuations(f.prisma, 10);
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.tx.mcpApprovalContinuation.updateMany).not.toHaveBeenCalled();
    await reconcileMcpApprovalContinuations(f.prisma, 10);
    expect(f.tx.task.create).toHaveBeenCalledOnce();
    expect(f.tx.run.create).toHaveBeenCalledOnce();
  });

  it("still cancels a revoked grant while its server is disabled", async () => {
    const f = fixture({ missingGrant: true });
    f.tx.mcpServer.findFirst.mockResolvedValueOnce({
      name: "Notes",
      allBots: false,
      enabled: false,
    });
    await reconcileMcpApprovalContinuations(f.prisma, 10);
    expect(f.tx.task.create).not.toHaveBeenCalled();
    expect(f.tx.mcpApprovalContinuation.updateMany).toHaveBeenCalledOnce();
  });
});
