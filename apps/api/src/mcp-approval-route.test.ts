import { createRouterClient } from "@orpc/server";
import type * as db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof db>()),
  appendEventInTransaction: vi.fn(async () => ({ seq: 1 })),
  recordSecurityEvent: vi.fn(async () => undefined),
}));

describe("existing integration approval RPC", () => {
  it("preserves a restricted assignment and creates a durable assignment-only intent", async () => {
    const now = new Date();
    const assignment = {
      id: "assignment",
      botId: "bot",
      serverId: "server",
      allowAllTools: false,
      allowedTools: ["read"],
      createdAt: now,
      updatedAt: now,
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "thread" }]),
      message: {
        findMany: vi.fn(async () => [
          {
            id: "message",
            botId: "bot",
            blocks: [
              {
                kind: "mcp_approval",
                name: "Mail",
                serverId: "server",
                status: "pending",
                assignmentOnly: true,
              },
            ],
          },
        ]),
        update: vi.fn(),
      },
      bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
      mcpServer: { findFirst: vi.fn(async () => ({ id: "server", name: "Mail" })) },
      botMcpServer: { upsert: vi.fn(async () => assignment) },
      mcpApprovalContinuation: {
        findFirst: vi.fn(async () => null),
        upsert: vi.fn(async () => ({})),
      },
      thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
      run: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "run" })) },
      task: { create: vi.fn(async (_arg: { data: { prompt: string } }) => ({ id: "task" })) },
    };
    const prisma = {
      thread: { findMany: vi.fn(async () => [{ id: "thread", botId: "bot" }]) },
      $transaction: vi.fn(async (fn: (value: unknown) => unknown) => fn(tx)),
    };
    const deps = {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
      env: {},
      secrets: {},
    } as unknown as RouterDeps;
    const actor = {
      userId: "owner",
      spaceId: "space",
      email: "owner@example.invalid",
      isDeploymentOwner: false,
    };
    const client = createRouterClient(createRouter(deps), { context: { actor } });
    const result = await client.mcp.assignments.approve({
      botId: "bot",
      serverId: "server",
      threadId: "thread",
    });
    expect(result).toMatchObject({ allowAllTools: false, allowedTools: ["read"] });
    expect(tx.botMcpServer.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(tx.mcpApprovalContinuation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          messageId: "message",
          botId: "bot",
          serverId: "server",
          assignmentOnly: true,
          decisionSeq: 1,
        }),
        update: {},
      }),
    );
    expect(tx.task.create).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });
});
