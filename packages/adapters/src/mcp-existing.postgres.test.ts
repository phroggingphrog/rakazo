import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { MessageBlock } from "@rakazo/contracts";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectExistingMcpFromTool } from "./mcp-server-tool.js";

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
    });
  });
});
