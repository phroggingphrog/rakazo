import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { connectExistingMcpFromTool } from "@rakazo/adapters";
import { MessageBlock } from "@rakazo/contracts";
import { createDb, LocalKeyProvider, runAsSystem, runAsTenant } from "@rakazo/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMcpApprovalContinuation,
  resolveMcpApprovalCards,
  revertConnectedMcpApprovals,
} from "./mcp-approval.js";

type ExecutorDeps = Parameters<typeof connectExistingMcpFromTool>[0];

const url = process.env.MCP_EXISTING_TEST_DATABASE_URL;
const docker = process.env.MCP_EXISTING_TEST_DOCKER;
const describeDatabase = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describeDatabase("existing integration tenant authorization (PostgreSQL)", () => {
  const children = new Set<ReturnType<typeof spawn>>();
  let restorePool: (() => void) | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    if (docker) {
      const original = pg.Pool.prototype.connect;
      const connect = vi.spyOn(pg.Pool.prototype, "connect");
      connect.mockImplementation(function (this: unknown, ...args: unknown[]) {
        const pool = this as unknown as { options: { stream?: () => Duplex } };
        pool.options.stream ??= () => {
          const child = spawn(
            "docker",
            [
              "exec",
              "-i",
              docker,
              "bash",
              "-c",
              'exec 3<>/dev/tcp/127.0.0.1/5432 || exit 1; printf "READY\\n" >&2; cat <&3 & reader=$!; cat >&3; wait "$reader"',
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          children.add(child);
          child.once("exit", () => children.delete(child));
          const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
          let ready = false,
            requested = false;
          child.stderr!.setEncoding("utf8");
          child.stderr!.on("data", (chunk: string) => {
            if (!chunk.includes("READY"))
              return stream.destroy(new Error("fixture transport failed"));
            ready = true;
            if (requested) stream.emit("connect");
          });
          child.on("error", (error) => stream.destroy(error));
          Object.assign(stream, {
            setNoDelay: () => stream,
            setKeepAlive: () => stream,
            ref: () => stream,
            unref: () => stream,
            connect: () => {
              requested = true;
              if (ready) process.nextTick(() => stream.emit("connect"));
              return stream;
            },
          });
          return stream;
        };
        return Reflect.apply(original, this, args);
      } as typeof pg.Pool.prototype.connect);
      restorePool = () => connect.mockRestore();
    }
    db = createDb(url!, { encryptContent: false, poolMax: 4 });
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    restorePool?.();
    for (const child of children) child.kill();
  });

  it("creates one replay-safe existing card within the owner scope", async () => {
    const id = randomUUID();
    const scope = { userId: `existing-user-${id}`, spaceId: `existing-space-${id}` };
    const other = { userId: `existing-other-${id}`, spaceId: `existing-other-space-${id}` };
    const movedSpaceId = `existing-moved-space-${id}`;
    const botId = randomUUID(),
      threadId = randomUUID(),
      serverId = randomUUID(),
      otherServerId = randomUUID(),
      taskId = randomUUID(),
      runId = randomUUID();
    await runAsSystem("create synthetic existing integration owners", async () => {
      for (const item of [scope, other]) {
        const organizationId = `existing-org-${item.userId}`;
        await db.prisma.user.create({
          data: { id: item.userId, name: "Synthetic", email: `${item.userId}@example.invalid` },
        });
        await db.prisma.organization.create({
          data: {
            id: organizationId,
            name: "Synthetic",
            slug: organizationId,
            createdAt: new Date(),
          },
        });
        await db.prisma.space.create({
          data: { id: item.spaceId, organizationId, name: "Synthetic", isDefault: true },
        });
      }
      await db.prisma.space.create({
        data: {
          id: movedSpaceId,
          organizationId: `existing-org-${scope.userId}`,
          name: "Synthetic moved",
        },
      });
    });
    await runAsTenant(scope, async () => {
      await db.prisma.bot.create({
        data: { id: botId, ...scope, name: "Synthetic", color: "blue" },
      });
      await db.prisma.thread.create({ data: { id: threadId, ...scope, botId } });
      await db.prisma.task.create({
        data: { id: taskId, ...scope, botId, threadId, prompt: "Synthetic", status: "running" },
      });
      await db.prisma.run.create({
        data: {
          id: runId,
          ...scope,
          botId,
          threadId,
          taskId,
          status: "running",
          trigger: "user",
          leaseOwner: "synthetic-worker",
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60000),
        },
      });
      await db.prisma.mcpServer.create({
        data: {
          id: serverId,
          ...scope,
          slug: `existing-${id}`,
          name: "Synthetic mail",
          transport: "stdio",
        },
      });
    });
    await runAsTenant(other, () =>
      db.prisma.mcpServer.create({
        data: {
          id: otherServerId,
          ...other,
          slug: `other-${id}`,
          name: "Other",
          transport: "stdio",
        },
      }),
    );
    const deps = {
      prisma: db.prisma,
      runLease: { runId, owner: "synthetic-worker", fence: 1 },
      events: { notify: vi.fn(async () => undefined) },
    } as unknown as ExecutorDeps;
    const run = { ...scope, id: runId, botId, threadId };
    await runAsTenant(scope, async () => {
      expect(
        await connectExistingMcpFromTool(deps, run, { server_id: otherServerId }, `effect-${id}`),
      ).toHaveProperty("error");
      const first = await connectExistingMcpFromTool(
        deps,
        run,
        { server_id: serverId },
        `effect-${id}`,
      );
      expect(first).toMatchObject({ ok: true, access: "pending" });
      expect(
        await connectExistingMcpFromTool(deps, run, { server_id: serverId }, `effect-${id}`),
      ).toMatchObject({ ok: true, access: "pending" });
      const messages = await db.prisma.message.findMany({ where: { threadId, runId } });
      expect(messages).toHaveLength(1);
      const blocks = messages[0]!.blocks as unknown[];
      expect(MessageBlock.parse(blocks[0])).toMatchObject({
        kind: "mcp_approval",
        serverId,
        endpoint: null,
        assignmentOnly: true,
      });
      expect(await db.prisma.botMcpServer.count({ where: { ...scope, botId, serverId } })).toBe(0);
      const concurrent = await Promise.all(
        [0, 1].map(() =>
          connectExistingMcpFromTool(deps, run, { server_id: serverId }, `concurrent-${id}`),
        ),
      );
      expect(concurrent).toEqual([
        expect.objectContaining({ ok: true, access: "pending" }),
        expect.objectContaining({ ok: true, access: "pending" }),
      ]);
      expect(await db.prisma.message.count({ where: { threadId, runId } })).toBe(2);

      for (const scenario of ["cancelled", "newer-fence"] as const) {
        const guardedRunId = randomUUID();
        await db.prisma.run.create({
          data: {
            id: guardedRunId,
            ...scope,
            botId,
            threadId,
            taskId,
            status: scenario === "cancelled" ? "cancelled" : "running",
            trigger: "user",
            leaseOwner: "synthetic-worker",
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 60000),
          },
        });
        if (scenario === "newer-fence") {
          await db.prisma.run.update({
            where: { id: guardedRunId },
            data: { leaseOwner: "new-worker", leaseFence: 2 },
          });
        }
        const before = await db.prisma.thread.findUniqueOrThrow({
          where: { id: threadId },
          select: { nextMessageSeq: true },
        });
        const staleDeps = {
          ...deps,
          runLease: { runId: guardedRunId, owner: "synthetic-worker", fence: 1 },
        } as ExecutorDeps;
        await expect(
          connectExistingMcpFromTool(
            staleDeps,
            { ...run, id: guardedRunId },
            { server_id: serverId },
            `${scenario}-${id}`,
          ),
        ).rejects.toThrow("Run cannot write thread history");
        expect(await db.prisma.message.count({ where: { threadId, runId: guardedRunId } })).toBe(0);
        expect(await db.prisma.event.count({ where: { threadId, runId: guardedRunId } })).toBe(0);
        expect(
          await db.prisma.thread.findUniqueOrThrow({
            where: { id: threadId },
            select: { nextMessageSeq: true },
          }),
        ).toEqual(before);
      }
      const actor = {
        ...scope,
        email: `${scope.userId}@example.invalid`,
        isDeploymentOwner: false,
      };
      const approvalDeps = {
        prisma: db.prisma,
        events: { notify: vi.fn(async () => undefined) },
      } as never;
      const approve = (fail: boolean, messageId?: string) =>
        resolveMcpApprovalCards(
          approvalDeps,
          actor,
          { botId, serverId, threadId, messageId, status: "connected" },
          async (tx, decision) => {
            await tx.botMcpServer.upsert({
              where: { botId_serverId: { botId, serverId } },
              create: { ...scope, botId, serverId, allowAllTools: true, allowedTools: [] },
              update: {},
            });
            if (decision.resolved && decision.messageId && decision.decisionSeq !== undefined)
              await createMcpApprovalContinuation(tx, actor, {
                botId,
                serverId,
                threadId,
                messageId: decision.messageId,
                decisionSeq: decision.decisionSeq,
                assignmentOnly: decision.assignmentOnly,
              });
            if (fail) throw new Error("synthetic rollback");
          },
        );
      await expect(approve(true)).rejects.toThrow("synthetic rollback");
      expect(await db.prisma.mcpApprovalContinuation.count({ where: { ...scope, serverId } })).toBe(
        0,
      );
      expect(await db.prisma.botMcpServer.count({ where: { ...scope, botId, serverId } })).toBe(0);
      expect(
        (await db.prisma.message.findUniqueOrThrow({ where: { id: messages[0]!.id } })).blocks,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "mcp_approval", status: "pending" }),
        ]),
      );
      const otherRun = randomUUID();
      const otherMessage = randomUUID();
      await db.prisma.run.create({
        data: {
          id: otherRun,
          ...scope,
          botId,
          threadId,
          taskId,
          status: "cancelled",
          trigger: "user",
        },
      });
      await db.prisma.message.create({
        data: {
          id: otherMessage,
          threadId,
          botId,
          runId: otherRun,
          seq: 1000000,
          role: "bot",
          blocks: blocks as never,
        },
      });
      await expect(approve(false)).rejects.toThrow("approve or dismiss each card separately");
      expect(await db.prisma.mcpApprovalContinuation.count({ where: { ...scope, serverId } })).toBe(
        0,
      );
      await expect(approve(false, "not-an-owned-message")).rejects.toThrow();
      await expect(
        runAsTenant(other, () =>
          resolveMcpApprovalCards(
            approvalDeps,
            {
              ...other,
              email: "other@example.invalid",
              isDeploymentOwner: false,
            },
            { botId, serverId, threadId, messageId: messages[0]!.id, status: "connected" },
          ),
        ),
      ).rejects.toThrow();
      await approve(false, messages[0]!.id);
      expect(
        (await db.prisma.message.findUniqueOrThrow({ where: { id: otherMessage } })).blocks,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "mcp_approval", status: "pending" }),
        ]),
      );
      await resolveMcpApprovalCards(approvalDeps, actor, {
        botId,
        serverId,
        threadId,
        messageId: otherMessage,
        status: "dismissed",
      });
      expect(
        (await db.prisma.message.findUniqueOrThrow({ where: { id: messages[0]!.id } })).blocks,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "mcp_approval", status: "connected" }),
        ]),
      );
      const produced = await db.prisma.mcpApprovalContinuation.findMany({
        where: { ...scope, serverId },
      });
      expect(produced).toHaveLength(1);
      const approvedEvent = await db.prisma.event.findFirstOrThrow({
        where: { threadId, seq: produced[0]!.decisionSeq },
      });
      expect(approvedEvent.type).toBe("thread.message.updated");
      await approve(false);
      expect(await db.prisma.mcpApprovalContinuation.count({ where: { ...scope, serverId } })).toBe(
        1,
      );
      await revertConnectedMcpApprovals(approvalDeps, actor, {
        botId,
        serverId,
        status: "pending",
      });
      expect(
        (
          await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
            where: { id: produced[0]!.id },
          })
        ).status,
      ).toBe("cancelled");
      await approve(false, messages[0]!.id);
      const reapproved = await db.prisma.mcpApprovalContinuation.findMany({
        where: { ...scope, serverId },
        orderBy: { decisionSeq: "asc" },
      });
      expect(reapproved).toHaveLength(2);
      expect(reapproved[1]!.messageId).toBe(produced[0]!.messageId);
      expect(reapproved[1]!.decisionSeq).toBeGreaterThan(produced[0]!.decisionSeq);
      expect(reapproved[1]!.status).toBe("pending");
      await approve(false);
      expect(await db.prisma.mcpApprovalContinuation.count({ where: { ...scope, serverId } })).toBe(
        2,
      );
      // Simulate a legacy API repainting a connected card without canceling its pending intent.
      await db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        const card = await tx.message.findUniqueOrThrow({
          where: { id: reapproved[1]!.messageId },
        });
        const blocks = MessageBlock.array()
          .parse(card.blocks)
          .map((block) =>
            block.kind === "mcp_approval" && block.serverId === serverId
              ? { ...block, status: "pending" as const }
              : block,
          );
        await tx.message.update({ where: { id: card.id }, data: { blocks } });
      });
      await Promise.all([approve(false), approve(false)]);
      const coalesced = await db.prisma.mcpApprovalContinuation.findMany({
        where: { ...scope, serverId },
        orderBy: { decisionSeq: "asc" },
      });
      expect(coalesced).toHaveLength(2);
      expect(coalesced[0]!.status).toBe("cancelled");
      expect(coalesced[1]!.id).toBe(reapproved[1]!.id);
      expect(coalesced[1]!.decisionSeq).toBeGreaterThan(reapproved[1]!.decisionSeq);
      const intent = coalesced[1]!;
      const decision = (decisionSeq: number) =>
        db.prisma.$transaction((tx) =>
          createMcpApprovalContinuation(tx, actor, {
            botId,
            serverId,
            threadId,
            messageId: intent.messageId,
            decisionSeq,
            assignmentOnly: true,
          }),
        );
      await Promise.all([decision(intent.decisionSeq + 100), decision(intent.decisionSeq + 101)]);
      await decision(intent.decisionSeq + 100);
      const latest = await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(latest.decisionSeq).toBe(intent.decisionSeq + 101);
      expect(latest.assignmentOnly).toBe(true);
      await expect(
        db.prisma.mcpApprovalContinuation.create({
          data: {
            ...scope,
            threadId,
            botId,
            serverId,
            messageId: intent.messageId,
            decisionSeq: latest.decisionSeq + 1,
          },
        }),
      ).rejects.toThrow();
      expect(await db.prisma.mcpApprovalContinuation.count({ where: { ...scope, serverId } })).toBe(
        2,
      );
      const secondCard = await db.prisma.message.findFirstOrThrow({
        where: { threadId, runId, id: { not: intent.messageId } },
      });
      const removedBotIntent = await db.prisma.mcpApprovalContinuation.create({
        data: {
          ...scope,
          threadId,
          botId,
          serverId,
          messageId: secondCard.id,
          assignmentOnly: true,
        },
      });
      const wrongOwner = await runAsTenant(other, () =>
        db.prisma.mcpApprovalContinuation.updateMany({
          where: { id: intent.id },
          data: { status: "cancelled", cancelledAt: new Date() },
        }),
      );
      expect(wrongOwner.count).toBe(0);
      await runAsSystem("move synthetic integration out of the approval space", () =>
        db.prisma.mcpServer.update({ where: { id: serverId }, data: { spaceId: movedSpaceId } }),
      );
      expect(
        await db.prisma.mcpServer.findFirst({ where: { id: serverId, spaceId: scope.spaceId } }),
      ).toBeNull();
      const cancelled = await db.prisma.mcpApprovalContinuation.updateMany({
        where: { id: intent.id, ...scope, threadId, botId, status: "pending" },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      expect(cancelled.count).toBe(1);
      await expect(
        db.prisma.mcpApprovalContinuation.update({
          where: { id: intent.id },
          data: { status: "pending", cancelledAt: null },
        }),
      ).rejects.toThrow();
      await runAsSystem("change a synthetic bot identity to simulate a missing original bot", () =>
        db.prisma.bot.update({ where: { id: botId }, data: { id: `moved-${id}` } }),
      );
      const afterBotRemoved = await db.prisma.mcpApprovalContinuation.updateMany({
        where: { id: removedBotIntent.id, ...scope, threadId, status: "pending" },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      expect(afterBotRemoved.count).toBe(1);
    });
  });

  it("selects only the matching encrypted request and same-run cards", async () => {
    const id = randomUUID();
    const scope = { userId: `encrypted-user-${id}`, spaceId: `encrypted-space-${id}` };
    const orgId = `encrypted-org-${id}`;
    const botId = randomUUID();
    const threadId = randomUUID();
    const taskId = randomUUID();
    const firstRun = randomUUID();
    const secondRun = randomUUID();
    const serverId = randomUUID();
    const otherServerId = randomUUID();
    const selected = randomUUID();
    const duplicate = randomUUID();
    const otherRequest = randomUUID();
    const otherServer = randomUUID();
    const keyProvider = new LocalKeyProvider([{ id: `synthetic-${id}`, key: randomBytes(32) }]);
    const encrypted = createDb(url!, { keyProvider, encryptContent: true, poolMax: 4 });
    try {
      await runAsSystem("create synthetic encrypted approval owner", async () => {
        await encrypted.prisma.user.create({
          data: { id: scope.userId, name: "Synthetic", email: `${scope.userId}@example.invalid` },
        });
        await encrypted.prisma.organization.create({
          data: { id: orgId, name: "Synthetic", slug: orgId, createdAt: new Date() },
        });
        await encrypted.prisma.space.create({
          data: { id: scope.spaceId, organizationId: orgId, name: "Synthetic", isDefault: true },
        });
      });
      await runAsTenant(scope, async () => {
        await encrypted.prisma.bot.create({
          data: { id: botId, ...scope, name: "Synthetic", color: "blue" },
        });
        await encrypted.prisma.thread.create({ data: { id: threadId, ...scope, botId } });
        await encrypted.prisma.task.create({
          data: {
            id: taskId,
            ...scope,
            botId,
            threadId,
            prompt: "Synthetic task",
            status: "queued",
          },
        });
        for (const runId of [firstRun, secondRun])
          await encrypted.prisma.run.create({
            data: {
              id: runId,
              ...scope,
              botId,
              threadId,
              taskId,
              status: "cancelled",
              trigger: "user",
            },
          });
        for (const server of [serverId, otherServerId])
          await encrypted.prisma.mcpServer.create({
            data: {
              id: server,
              ...scope,
              slug: `encrypted-${server}`,
              name: "Synthetic",
              transport: "stdio",
            },
          });
        for (const [messageId, runId, server, seq] of [
          [selected, firstRun, serverId, 1],
          [duplicate, firstRun, serverId, 2],
          [otherRequest, secondRun, serverId, 3],
          [otherServer, firstRun, otherServerId, 4],
        ] as const) {
          await encrypted.prisma.message.create({
            data: {
              id: messageId,
              threadId,
              botId,
              runId,
              seq,
              role: "bot",
              blocks: [
                {
                  kind: "mcp_approval",
                  serverId: server,
                  name: "Synthetic private integration",
                  transport: "stdio",
                  endpoint: null,
                  needsOAuth: false,
                  assignmentOnly: true,
                  status: "pending",
                },
              ],
            },
          });
        }
        const raw = await encrypted.pool.query<{ blocks: string }>(
          "SELECT blocks::text AS blocks FROM messages WHERE id = $1",
          [selected],
        );
        expect(raw.rows[0]!.blocks).toContain("rkz1:");
        expect(raw.rows[0]!.blocks).not.toContain("Synthetic private integration");
        const matching = await encrypted.prisma.message.findMany({
          where: {
            threadId,
            runId: firstRun,
            blocks: { array_contains: [{ kind: "mcp_approval", serverId }] },
          },
          select: { id: true, blocks: true },
        });
        expect(matching.map((message) => message.id).sort()).toEqual([selected, duplicate].sort());
        expect(matching[0]!.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "Synthetic private integration" }),
          ]),
        );
        const effect = vi.fn(async () => undefined);
        await resolveMcpApprovalCards(
          { prisma: encrypted.prisma, events: { notify: vi.fn(async () => undefined) } } as never,
          { ...scope, email: `${scope.userId}@example.invalid`, isDeploymentOwner: false },
          { botId, serverId, threadId, messageId: selected, status: "connected" },
          effect,
        );
        expect(effect).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ messageId: selected, assignmentOnly: true, resolved: true }),
        );
        const after = await encrypted.prisma.message.findMany({
          where: { id: { in: [selected, duplicate, otherRequest, otherServer] } },
          select: { id: true, blocks: true },
        });
        expect(after).toHaveLength(4);
        for (const message of after)
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                status:
                  message.id === selected || message.id === duplicate ? "connected" : "pending",
              }),
            ]),
          );
      });
    } finally {
      await encrypted.prisma.$disconnect();
      await encrypted.pool.end();
    }
  });
});
