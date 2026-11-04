import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcileMcpApprovalContinuations } from "./mcp-approval-continuations.js";

const url = process.env.MCP_CONTINUATION_TEST_DATABASE_URL;
const docker = process.env.MCP_CONTINUATION_TEST_DOCKER;
const database = process.env.VERIFY_DATABASE === "1" && url && docker ? describe : describe.skip;

database("MCP continuation recovery (PostgreSQL)", () => {
  const children = new Set<ReturnType<typeof spawn>>();
  let restore: (() => void) | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
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
            docker!,
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
    restore = () => connect.mockRestore();
    db = createDb(url!, { encryptContent: false, poolMax: 4 });
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    restore?.();
    for (const child of children) child.kill();
  });

  it("preserves a pending continuation while held and materializes it once after resume", async () => {
    const id = randomUUID();
    const scope = { userId: `hold-user-${id}`, spaceId: `hold-space-${id}` };
    const organizationId = `hold-org-${id}`;
    const botId = randomUUID();
    const threadId = randomUUID();
    const serverId = randomUUID();
    const messageId = randomUUID();
    const intentId = randomUUID();
    await runAsSystem("create isolated hold fixture", async () => {
      await db.prisma.user.create({
        data: { id: scope.userId, name: "Synthetic", email: `${scope.userId}@example.invalid` },
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
        data: { id: scope.spaceId, organizationId, name: "Synthetic", isDefault: true },
      });
    });
    await runAsTenant(scope, async () => {
      await db.prisma.bot.create({
        data: { id: botId, ...scope, name: "Synthetic", color: "blue" },
      });
      await db.prisma.thread.create({ data: { id: threadId, ...scope, botId } });
      await db.prisma.mcpServer.create({
        data: { id: serverId, ...scope, slug: `hold-${id}`, name: "Synthetic", transport: "stdio" },
      });
      await db.prisma.botMcpServer.create({
        data: { ...scope, botId, serverId, allowAllTools: false, allowedTools: ["read"] },
      });
      await db.prisma.message.create({
        data: {
          id: messageId,
          threadId,
          seq: 1,
          botId,
          role: "bot",
          blocks: [
            {
              kind: "mcp_approval",
              name: "Synthetic",
              serverId,
              transport: "stdio",
              endpoint: null,
              needsOAuth: false,
              status: "connected",
              assignmentOnly: true,
            },
          ],
        },
      });
      await db.prisma.mcpApprovalContinuation.create({
        data: {
          id: intentId,
          ...scope,
          botId,
          threadId,
          serverId,
          messageId,
          assignmentOnly: true,
        },
      });
    });

    // Limit only the scan to this fixture; processing uses the real transaction and rows.
    const scopedPrisma = {
      mcpApprovalContinuation: {
        findMany: (args: Parameters<typeof db.prisma.mcpApprovalContinuation.findMany>[0]) =>
          db.prisma.mcpApprovalContinuation.findMany({
            ...args,
            where: { ...args?.where, id: intentId },
          }),
      },
      $transaction: db.prisma.$transaction.bind(db.prisma),
    } as unknown as PrismaClient;
    await runAsSystem("check held synthetic continuation", async () => {
      await reconcileMcpApprovalContinuations(scopedPrisma, 10, undefined, false);
      await reconcileMcpApprovalContinuations(scopedPrisma, 10, undefined, false);
      expect(
        await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: intentId } }),
      ).toMatchObject({ status: "pending", runId: null });
      expect(await db.prisma.run.count({ where: { threadId } })).toBe(0);

      await Promise.all([
        reconcileMcpApprovalContinuations(scopedPrisma, 10),
        reconcileMcpApprovalContinuations(scopedPrisma, 10),
      ]);
      const resumed = await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
        where: { id: intentId },
      });
      expect(resumed.status).toBe("materialized");
      expect(resumed.runId).not.toBeNull();
      expect(await db.prisma.run.count({ where: { threadId, status: "queued" } })).toBe(1);
    });
  });

  it("holds a live run, then atomically materializes once across concurrent reconciler passes", async () => {
    const id = randomUUID();
    const scope = { userId: `continuation-user-${id}`, spaceId: `continuation-space-${id}` };
    const other = { userId: `continuation-other-${id}`, spaceId: `continuation-other-space-${id}` };
    const botId = randomUUID(),
      threadId = randomUUID(),
      serverId = randomUUID(),
      messageId = randomUUID(),
      taskId = randomUUID(),
      runId = randomUUID();
    await runAsSystem("create synthetic continuation owners", async () => {
      for (const item of [scope, other]) {
        const organizationId = `continuation-org-${item.userId}`;
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
    });
    await runAsTenant(scope, async () => {
      await db.prisma.bot.create({
        data: { id: botId, ...scope, name: "Synthetic", color: "blue" },
      });
      await db.prisma.thread.create({ data: { id: threadId, ...scope, botId } });
      await db.prisma.mcpServer.create({
        data: {
          id: serverId,
          ...scope,
          slug: `source-${id}`,
          name: "Synthetic",
          transport: "stdio",
        },
      });
      await db.prisma.botMcpServer.create({
        data: { ...scope, botId, serverId, allowAllTools: false, allowedTools: ["read"] },
      });
      await db.prisma.message.create({
        data: {
          id: messageId,
          threadId,
          seq: 1,
          botId,
          role: "bot",
          blocks: [
            {
              kind: "mcp_approval",
              name: "Synthetic",
              serverId,
              transport: "stdio",
              endpoint: null,
              needsOAuth: false,
              status: "connected",
              assignmentOnly: true,
            },
          ],
        },
      });
      await db.prisma.task.create({
        data: {
          id: taskId,
          ...scope,
          botId,
          threadId,
          prompt: "Synthetic active task",
          status: "running",
        },
      });
      await db.prisma.run.create({
        data: {
          id: runId,
          ...scope,
          botId,
          threadId,
          taskId,
          status: "running",
          trigger: "routine",
        },
      });
      await db.prisma.mcpApprovalContinuation.create({
        data: { ...scope, botId, threadId, serverId, messageId, assignmentOnly: true },
      });
    });
    await runAsTenant(other, async () => {
      expect(await db.prisma.mcpApprovalContinuation.count({ where: { threadId } })).toBe(0);
    });
    await runAsSystem("drain synthetic continuation", async () => {
      await reconcileMcpApprovalContinuations(db.prisma, 10);
      expect(await db.prisma.run.count({ where: { threadId } })).toBe(1);
      await db.prisma.run.update({ where: { id: runId }, data: { status: "completed" } });
      await Promise.all([
        reconcileMcpApprovalContinuations(db.prisma, 10),
        reconcileMcpApprovalContinuations(db.prisma, 10),
      ]);
      const intent = await db.prisma.mcpApprovalContinuation.findFirstOrThrow({
        where: { threadId },
      });
      expect(intent.status).toBe("materialized");
      expect(intent.runId).not.toBeNull();
      const runs = await db.prisma.run.findMany({ where: { threadId }, include: { task: true } });
      expect(runs).toHaveLength(2);
      const queued = runs.find((run) => run.id === intent.runId);
      expect(queued?.status).toBe("queued");
      expect(queued?.task.prompt).toContain("restricted to its allowed tools");
      expect(queued?.task.prompt).toContain("have not been verified");
    });

    // Model the relevant database operations of an old API Stop, not a running old API image.
    const makePending = async (
      seq: number,
      occurrence?: { id: string; decisionSeq: number; createdAt: Date },
    ) => {
      const nextMessageId = randomUUID();
      await db.prisma.message.create({
        data: {
          id: nextMessageId,
          threadId,
          seq,
          botId,
          role: "bot",
          blocks: [
            {
              kind: "mcp_approval",
              name: "Synthetic",
              serverId,
              transport: "stdio",
              endpoint: null,
              needsOAuth: false,
              status: "connected",
              assignmentOnly: true,
            },
          ],
        },
      });
      return db.prisma.mcpApprovalContinuation.create({
        data: {
          ...scope,
          botId,
          threadId,
          serverId,
          messageId: nextMessageId,
          assignmentOnly: true,
          ...occurrence,
        },
      });
    };
    const oldStopWithNoRun = async () =>
      db.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        const stopped = await tx.run.updateMany({
          where: {
            threadId,
            status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          },
          data: { status: "cancelled", completedAt: new Date() },
        });
        await tx.steeringMessage.deleteMany({ where: { botId, message: { threadId } } });
        return stopped.count;
      });
    await runAsTenant(scope, async () => {
      await db.prisma.run.updateMany({
        where: { threadId, status: "queued" },
        data: { status: "completed" },
      });
      const unsafe = await makePending(2);
      expect(await oldStopWithNoRun()).toBe(0);
      expect(
        (await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: unsafe.id } }))
          .status,
      ).toBe("pending");
      await runAsSystem("characterize old Stop with new worker", () =>
        reconcileMcpApprovalContinuations(db.prisma, 10),
      );
      expect(
        (await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: unsafe.id } }))
          .status,
      ).toBe("materialized");

      // A compatible API explicitly cancels pending work while the drain is quiesced.
      await db.prisma.run.updateMany({
        where: { threadId, status: "queued" },
        data: { status: "completed" },
      });
      const safe = await makePending(3);
      await db.prisma.mcpApprovalContinuation.updateMany({
        where: { id: safe.id, status: "pending" },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      expect(await oldStopWithNoRun()).toBe(0);
      await runAsSystem("check cancelled synthetic intent", () =>
        reconcileMcpApprovalContinuations(db.prisma, 10),
      );
      const preserved = await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
        where: { id: safe.id },
      });
      expect(preserved.status).toBe("cancelled");
      expect(preserved.runId).toBeNull();

      const tiedAt = new Date("2026-11-01T00:00:00.000Z");
      const earlier = await makePending(4, {
        id: `z-earlier-${id}`,
        decisionSeq: 101,
        createdAt: tiedAt,
      });
      const later = await makePending(5, {
        id: `a-later-${id}`,
        decisionSeq: 102,
        createdAt: tiedAt,
      });
      await runAsSystem("check synthetic approval ordering", () =>
        reconcileMcpApprovalContinuations(db.prisma, 10),
      );
      expect(
        (await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: earlier.id } }))
          .status,
      ).toBe("materialized");
      expect(
        (await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: later.id } }))
          .status,
      ).toBe("pending");
      await db.prisma.run.updateMany({
        where: { threadId, status: "queued" },
        data: { status: "completed" },
      });
      await runAsSystem("check next synthetic approval", () =>
        reconcileMcpApprovalContinuations(db.prisma, 10),
      );
      expect(
        (await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: later.id } }))
          .status,
      ).toBe("materialized");

      await db.prisma.run.updateMany({
        where: { threadId, status: "queued" },
        data: { status: "completed" },
      });
      const held = await makePending(6);
      await db.prisma.mcpServer.update({ where: { id: serverId }, data: { enabled: false } });
      await runAsSystem("check disabled synthetic integration", () =>
        reconcileMcpApprovalContinuations(db.prisma, 10),
      );
      const waiting = await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
        where: { id: held.id },
      });
      expect(waiting.status).toBe("pending");
      expect(waiting.runId).toBeNull();
      await db.prisma.mcpServer.update({ where: { id: serverId }, data: { enabled: true } });
      await runAsSystem("check reenabled synthetic integration", () =>
        Promise.all([
          reconcileMcpApprovalContinuations(db.prisma, 10),
          reconcileMcpApprovalContinuations(db.prisma, 10),
        ]),
      );
      const resumed = await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
        where: { id: held.id },
      });
      expect(resumed.status).toBe("materialized");
      expect(resumed.runId).not.toBeNull();
      expect(await db.prisma.run.count({ where: { threadId, status: "queued" } })).toBe(1);
    });
  });
});
