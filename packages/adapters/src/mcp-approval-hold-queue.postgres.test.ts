import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { makeWorkerUtils } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcileMcpApprovalContinuations } from "./mcp-approval-continuations.js";
import { RunStarter } from "./run-wakeup.js";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

const url = process.env.MCP_HOLD_QUEUE_TEST_DATABASE_URL;
const docker = process.env.MCP_HOLD_QUEUE_TEST_DOCKER;
const database = process.env.VERIFY_DATABASE === "1" && url && docker ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

database("approval continuation hold and queue (isolated PostgreSQL)", () => {
  const children = new Set<ReturnType<typeof spawn>>();
  let restore: (() => void) | undefined;
  let db: ReturnType<typeof createDb>;
  let pool: pg.Pool;
  const inventory = () =>
    JSON.parse(
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          docker!,
          "psql",
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          new URL(url!).pathname.slice(1),
        ],
        { input: readFileSync("scripts/mcp-continuation-inventory.sql"), encoding: "utf8" },
      ),
    ) as {
      fleet_drain: string;
      pending_intents: number;
      all_nonterminal_runs: number;
      all_run_jobs: number;
      locked_run_jobs: number;
      unkeyed_run_jobs: number;
      nonterminal_linked_runs: number;
      linked_jobs: number;
      locked_linked_jobs: number;
      unattributable_run_jobs: number;
    };
  beforeAll(async () => {
    const fixture = new URL(url!);
    if (
      !["postgres:", "postgresql:"].includes(fixture.protocol) ||
      !/^\/rakazo_test_mcp_hold_queue_[a-z0-9_]+$/.test(fixture.pathname) ||
      fixture.hostname !== "localhost" ||
      fixture.username !== "postgres" ||
      fixture.password !== "" ||
      (fixture.port !== "" && fixture.port !== "5432") ||
      fixture.search !== "" ||
      fixture.hash !== ""
    ) {
      throw new Error(
        "Graphile migration is permitted only in an explicitly named local test fixture",
      );
    }
    const isolation = execFileSync(
      "docker",
      ["inspect", "--format", "{{.HostConfig.NetworkMode}} {{len .Mounts}}", docker!],
      { encoding: "utf8" },
    ).trim();
    if (isolation !== "none 0") {
      throw new Error("Graphile migration requires an isolated fixture with no network or mounts");
    }
    const missingQueue = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        docker!,
        "psql",
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        fixture.pathname.slice(1),
      ],
      { input: readFileSync("scripts/mcp-continuation-inventory.sql"), encoding: "utf8" },
    );
    expect(missingQueue.status).not.toBe(0);
    expect(missingQueue.stdout).not.toContain("fleet_drain");
    expect(missingQueue.stderr).toContain("graphile_worker");
    const original = pg.Pool.prototype.connect;
    const connect = vi.spyOn(pg.Pool.prototype, "connect");
    connect.mockImplementation(function (this: unknown, ...args: unknown[]) {
      const p = this as unknown as { options: { stream?: () => Duplex } };
      p.options.stream ??= () => {
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
        let ready = false;
        let requested = false;
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
    pool = new pg.Pool({ connectionString: url!, max: 4 });
    const utils = await makeWorkerUtils({ pgPool: pool });
    try {
      await utils.migrate();
    } finally {
      await utils.release();
    }
  });
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    if (pool) await pool.end();
    restore?.();
    for (const child of children) child.kill();
  });

  it("holds new intent, preserves queued dispatch, drains both hosts and resumes once", async () => {
    const existingJobs = await pool.query(
      "SELECT count(*)::integer AS count FROM graphile_worker._private_jobs",
    );
    expect(existingJobs.rows[0].count).toBe(0);
    const baseline = inventory();
    const id = randomUUID();
    const scope = { userId: `queue-hold-user-${id}`, spaceId: `queue-hold-space-${id}` };
    const organizationId = `queue-hold-org-${id}`;
    const botId = randomUUID(),
      threadId = randomUUID(),
      serverId = randomUUID(),
      messageId = randomUUID(),
      intentId = randomUUID();
    await runAsSystem("create isolated hold owner", async () => {
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
        data: {
          id: serverId,
          ...scope,
          slug: `queue-hold-${id}`,
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
    const scopedPrismaFor = (selectedId: string) =>
      ({
        mcpApprovalContinuation: {
          findMany: (args: Parameters<typeof db.prisma.mcpApprovalContinuation.findMany>[0]) =>
            db.prisma.mcpApprovalContinuation.findMany({
              ...args,
              where: { ...args?.where, id: selectedId },
            }),
        },
        $transaction: db.prisma.$transaction.bind(db.prisma),
      }) as unknown as PrismaClient;
    const scopedPrisma = scopedPrismaFor(intentId);
    await runAsSystem("hold and release synthetic approval", async () => {
      await reconcileMcpApprovalContinuations(scopedPrisma, 10, undefined, false);
      expect(await db.prisma.run.count({ where: { threadId } })).toBe(0);
      expect(
        (await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: intentId } }))
          .status,
      ).toBe("pending");
      await reconcileMcpApprovalContinuations(scopedPrisma, 10);
    });
    const first = await runAsSystem("inspect synthetic approval", () =>
      db.prisma.mcpApprovalContinuation.findUniqueOrThrow({ where: { id: intentId } }),
    );
    expect(first.status).toBe("materialized");
    expect(first.runId).not.toBeNull();
    const pendingMessageId = randomUUID();
    const pendingIntentId = randomUUID();
    await runAsTenant(scope, async () => {
      await db.prisma.message.create({
        data: {
          id: pendingMessageId,
          threadId,
          seq: 2,
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
          id: pendingIntentId,
          ...scope,
          botId,
          threadId,
          serverId,
          messageId: pendingMessageId,
          assignmentOnly: true,
        },
      });
    });
    const pendingPrisma = scopedPrismaFor(pendingIntentId);
    await runAsSystem("hold second synthetic approval", async () => {
      await reconcileMcpApprovalContinuations(pendingPrisma, 10, undefined, false);
      expect(
        (
          await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
            where: { id: pendingIntentId },
          })
        ).status,
      ).toBe("pending");
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: first.runId! } })).status).toBe(
        "queued",
      );
    });
    const publisher = new GraphileJobPublisher(pool, db.prisma);
    const host = new GraphileJobWorkerHost(pool, {
      workload: "interactive",
      concurrency: 1,
      pollInterval: 50,
    });
    const entered = deferred(),
      release = deferred();
    let received: string | undefined;
    const handlers = {
      "run.continue": async ({ runId }: { runId: string }) => {
        received = runId;
        entered.resolve();
        await release.promise;
        throw new Error("synthetic retained failure");
      },
    };
    try {
      await runAsSystem("publish synthetic continuation run", () =>
        publisher.enqueue(runContinueJob(first.runId!)),
      );
      const queued = inventory();
      expect(queued.fleet_drain).toBe("not_verified");
      expect(queued.pending_intents).toBe(baseline.pending_intents + 1);
      expect(queued.all_nonterminal_runs).toBeGreaterThanOrEqual(baseline.all_nonterminal_runs + 1);
      expect(queued.all_run_jobs).toBe(1);
      expect(queued.locked_run_jobs).toBe(0);
      expect(queued.unkeyed_run_jobs).toBe(0);
      expect(queued.linked_jobs).toBe(1);
      await host.start(handlers as never);
      await Promise.race([
        entered.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("queue dispatch timeout")), 15000),
        ),
      ]);
      expect(received).toBe(first.runId);
      const locked = inventory();
      expect(locked.pending_intents).toBe(baseline.pending_intents + 1);
      expect(locked.all_run_jobs).toBe(1);
      expect(locked.locked_run_jobs).toBe(1);
      expect(locked.locked_linked_jobs).toBe(1);
      let stopped = false;
      const stop = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      release.resolve();
      await stop;
      const rows = await pool.query(
        "SELECT j.key, j.attempts, t.identifier FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id=j.task_id",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].key).toBe(`run:${first.runId}`);
      expect(rows.rows[0].identifier).toBe("run.interactive");
      expect(Number(rows.rows[0].attempts)).toBeGreaterThan(0);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }

    const directEntered = deferred(),
      directRelease = deferred();
    const starter = new RunStarter({ publish: async () => {} } as never);
    starter.attach({
      "run.continue": async () => {
        directEntered.resolve();
        await directRelease.promise;
        throw new Error("synthetic direct failure");
      },
    } as never);
    try {
      starter.take(first.runId!);
      await Promise.race([
        directEntered.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("direct dispatch timeout")), 5000),
        ),
      ]);
      let stopped = false;
      const stop = starter.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      directRelease.resolve();
      await stop;
    } finally {
      directRelease.resolve();
      await starter.stop();
    }
    await runAsSystem("resume second synthetic approval", async () => {
      // This status change models a drained run; it does not exercise the executor or provider.
      // The deliberately failed Graphile job is retained and needs accounting during rollback.
      await db.prisma.run.update({ where: { id: first.runId! }, data: { status: "completed" } });
      await reconcileMcpApprovalContinuations(pendingPrisma, 10, undefined, false);
      expect(
        (
          await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
            where: { id: pendingIntentId },
          })
        ).status,
      ).toBe("pending");
      await Promise.all([
        reconcileMcpApprovalContinuations(pendingPrisma, 10),
        reconcileMcpApprovalContinuations(pendingPrisma, 10),
      ]);
      const resumed = await db.prisma.mcpApprovalContinuation.findUniqueOrThrow({
        where: { id: pendingIntentId },
      });
      expect(resumed.status).toBe("materialized");
      expect(resumed.runId).not.toBeNull();
      expect(await db.prisma.run.count({ where: { threadId, status: "queued" } })).toBe(1);
    });
    // Only test-owned jobs are changed; the linked failed row stays present after detachment.
    await pool.query("UPDATE graphile_worker._private_jobs SET key = NULL WHERE key = $1", [
      `run:${first.runId}`,
    ]);
    await pool.query(
      "SELECT graphile_worker.add_job(identifier := 'run.continue', payload := $1::json, job_key := $2)",
      [JSON.stringify({ unexpected: true }), `malformed-${id}`],
    );
    await pool.query(
      "SELECT graphile_worker.add_job(identifier := 'run.interactive', payload := $1::json, job_key := $2)",
      [
        JSON.stringify({ runId: `missing-${id}`, payload: { runId: first.runId } }),
        `conflict-${id}`,
      ],
    );
    const report = inventory();
    expect(report.fleet_drain).toBe("not_verified");
    expect(report.all_nonterminal_runs).toBeGreaterThanOrEqual(1);
    expect(report.all_run_jobs).toBe(3);
    expect(report.locked_run_jobs).toBe(0);
    expect(report.unkeyed_run_jobs).toBe(1);
    expect(report.nonterminal_linked_runs).toBeGreaterThanOrEqual(1);
    expect(report.linked_jobs).toBe(1);
    expect(report.locked_linked_jobs).toBe(0);
    expect(report.unattributable_run_jobs).toBe(2);
  });
});
