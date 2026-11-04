import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import type { AdapterContext, ConnectorCall } from "@rakazo/adapter-kit";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { wakeRoutine } from "./run-routines.js";
import { taskTools } from "./run-tools-tasks.js";
import { executeSetupSourceTest } from "./setup-source-test.js";

// This is a dedicated synthetic database, never the application's DATABASE_URL.
const url = process.env.SCHEDULED_SOURCE_TEST_DATABASE_URL;
const docker = process.env.SCHEDULED_SOURCE_TEST_DOCKER;
const describeDatabase =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describeDatabase("scheduled setup source binding (PostgreSQL)", () => {
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
    // Keep every synthetic row and fixture artifact for inspection.
  });

  it("coalesces matching source snapshots and keeps an edited routine unbound", async () => {
    const suffix = randomUUID();
    const userId = `scheduled-user-${suffix}`;
    const spaceId = `scheduled-space-${suffix}`;
    const organizationId = `scheduled-org-${suffix}`;
    const botId = randomUUID(),
      threadId = randomUUID(),
      serverId = randomUUID();
    const scope = { userId, spaceId };
    const draft = {
      kind: "email_monitor" as const,
      purpose: "Find booking updates",
      botId,
      source: { serverId, revision: 1, toolName: "read_mail" },
      arguments: { query: "synthetic-booking" },
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      notify: true,
    };
    const due1 = new Date(Date.now() - 10_000);
    let routineId = "";
    const enqueue = vi.fn(async () => undefined);
    const deps = {
      prisma: db.prisma,
      jobs: { enqueue, cancel: async () => undefined },
      events: { append: async () => undefined, notify: async () => undefined },
    };
    await runAsSystem("create synthetic scheduled setup owner", async () => {
      await db.prisma.user.create({
        data: { id: userId, name: "Synthetic", email: `${userId}@example.invalid` },
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
        data: { id: spaceId, organizationId, name: "Synthetic", isDefault: true },
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
          slug: `mail-${suffix}`,
          name: "Synthetic mail",
          transport: "stdio",
        },
      });
      await db.prisma.botMcpServer.create({
        data: { ...scope, botId, serverId, allowAllTools: true, allowedTools: [] },
      });
    });
    const toolName = `mcp__mail-${suffix}__read_mail`;
    const selected = {
      name: toolName,
      description: "Synthetic read",
      inputSchema: {},
      readOnly: true,
      route: {
        connectorId: "mcp",
        resourceId: serverId,
        resourceRevision: 1,
        toolName: "read_mail",
      },
    };
    const ctx = {
      deps,
      run: scope,
      bot: { id: botId },
      thread: { id: threadId },
      computer: { graphical: false },
      tools: { connector: new Map([[toolName, selected]]), disabled: new Set() },
    };
    const call = {
      args: {
        name: "Synthetic monitor",
        prompt: draft.purpose,
        cron: draft.schedule.cron,
        timezone: "UTC",
        source: { tool: toolName, arguments: draft.arguments },
      },
      effectKey: `synthetic-${suffix}`,
      executionId: `synthetic-${suffix}`,
      finish: async (result: unknown) => result,
    };
    const unlabeled = { ...selected, readOnly: undefined };
    const unlabeledCtx = {
      ...ctx,
      tools: { ...ctx.tools, connector: new Map([[toolName, unlabeled]]) },
    };
    expect(
      await runAsTenant(scope, () =>
        taskTools.schedule_create!(unlabeledCtx as never, call as never),
      ),
    ).toMatchObject({ error: expect.stringContaining("not declared read-only") });
    await runAsTenant(scope, () =>
      db.prisma.botMcpServer.updateMany({
        where: { ...scope, botId, serverId },
        data: { allowAllTools: false, allowedTools: [] },
      }),
    );
    expect(
      await runAsTenant(scope, () => taskTools.schedule_create!(ctx as never, call as never)),
    ).toMatchObject({ error: expect.stringContaining("not assigned") });
    await runAsTenant(scope, () =>
      db.prisma.botMcpServer.updateMany({
        where: { ...scope, botId, serverId },
        data: { allowAllTools: true },
      }),
    );
    const created = (await runAsTenant(scope, () =>
      taskTools.schedule_create!(ctx as never, call as never),
    )) as { ok: boolean; routineId: string; sourceAccess: string };
    expect(created).toMatchObject({ ok: true, sourceAccess: "not_verified" });
    routineId = created.routineId;
    const plan = await runAsTenant(scope, () =>
      db.prisma.setupPlan.findFirstOrThrow({ where: { ...scope, routineId } }),
    );
    expect(plan).toMatchObject({ status: "configured", draft });
    const replayed = await runAsTenant(scope, () =>
      taskTools.schedule_create!(ctx as never, call as never),
    );
    expect(replayed).toMatchObject({ ok: true, routineId, replayed: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const competing = await Promise.all(
      ["a", "b"].map((key) =>
        runAsTenant(scope, () =>
          taskTools.schedule_create!(
            ctx as never,
            {
              ...call,
              effectKey: `competing-${suffix}-${key}`,
              args: { ...call.args, name: "Concurrent monitor" },
            } as never,
          ),
        ),
      ),
    );
    expect(competing.filter((result) => (result as { ok?: boolean }).ok)).toHaveLength(1);
    expect(
      competing.filter((result) =>
        (result as { error?: string }).error?.includes("already exists"),
      ),
    ).toHaveLength(1);
    const sharedCall = {
      ...call,
      effectKey: `shared-${suffix}`,
      args: { ...call.args, name: "Replay monitor" },
    };
    const shared = await Promise.all(
      [0, 1].map(() =>
        runAsTenant(scope, () => taskTools.schedule_create!(ctx as never, sharedCall as never)),
      ),
    );
    expect(shared[0]).toMatchObject({ ok: true });
    expect(shared[1]).toMatchObject({
      ok: true,
      routineId: (shared[0] as { routineId: string }).routineId,
    });
    const oneShotCall = {
      ...call,
      effectKey: `one-shot-${suffix}`,
      args: {
        ...call.args,
        name: "One-shot source",
        cron: undefined,
        delaySeconds: 60,
      },
    };
    const oneShot = (await runAsTenant(scope, () =>
      taskTools.schedule_create!(ctx as never, oneShotCall as never),
    )) as { routineId: string; ok: boolean };
    expect(oneShot.ok).toBe(true);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      const changedCtx = { ...ctx, tools: { ...ctx.tools, connector: new Map() } };
      expect(
        await runAsTenant(scope, () =>
          taskTools.schedule_create!(changedCtx as never, oneShotCall as never),
        ),
      ).toMatchObject({ ok: true, routineId: oneShot.routineId, replayed: true });
    } finally {
      now.mockRestore();
    }
    await runAsTenant(scope, () =>
      db.prisma.routine.update({ where: { id: routineId }, data: { nextRunAt: due1 } }),
    );
    const tick = (at: Date) =>
      runAsTenant(scope, () => wakeRoutine(deps as never, routineId, at.toISOString()));
    const scheduled = () =>
      runAsTenant(scope, () =>
        db.prisma.run.findMany({
          where: {
            ...scope,
            routineId,
            clientNonce: { startsWith: `routine-timer:${routineId}:` },
          },
          include: { effects: true, task: true },
        }),
      );
    await tick(due1);
    const first = await scheduled();
    expect(first).toHaveLength(1);
    expect(first[0]!.effects).toMatchObject([
      { kind: "setup_source_test", status: "intended", request: draft },
    ]);

    const due2 = new Date(due1.getTime() + 1000);
    await runAsTenant(scope, () =>
      db.prisma.routine.update({ where: { id: routineId }, data: { nextRunAt: due2 } }),
    );
    await tick(due2);
    expect((await scheduled()).map((run) => run.id)).toEqual([first[0]!.id]);

    const calls: ConnectorCall[] = [];
    const connector = {
      execute: async function* (call: ConnectorCall) {
        calls.push(call);
        yield { type: "result" as const, data: { content: [{ type: "text", text: "synthetic" }] } };
      },
    };
    const runId = first[0]!.id,
      workerId = "scheduled-test-worker";
    await runAsTenant(scope, () =>
      db.prisma.run.update({
        where: { id: runId },
        data: {
          status: "running",
          leaseOwner: workerId,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    const context: AdapterContext = {
      ...scope,
      botId,
      runId,
      operationId: runId,
      traceId: runId,
      signal: AbortSignal.timeout(10_000),
    };
    expect(
      (
        await runAsTenant(scope, () =>
          executeSetupSourceTest({
            prisma: db.prisma,
            connector: connector as never,
            context,
            runId,
            workerId,
            fence: 1,
            secrets: [],
            authorize: async () => ({ state: "allowed", finish: async () => true }),
          }),
        )
      )?.state,
    ).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: draft.arguments,
      route: { resourceId: serverId, resourceRevision: 1, toolName: "read_mail" },
    });

    const due3 = new Date(due1.getTime() + 2000);
    await runAsTenant(scope, () =>
      db.prisma.routine.update({
        where: { id: routineId },
        data: { prompt: "Owner changed the instructions", nextRunAt: due3 },
      }),
    );
    await tick(due3);
    const changed = (await scheduled()).find((run) => run.id !== runId)!;
    expect(changed.task.prompt).toBe("Owner changed the instructions");
    expect(changed.effects).toMatchObject([
      { kind: "setup_source_unbound", status: "completed", result: { state: "unbound" } },
    ]);
    const due4 = new Date(due1.getTime() + 3000);
    await runAsTenant(scope, () =>
      db.prisma.routine.update({ where: { id: routineId }, data: { nextRunAt: due4 } }),
    );
    await tick(due4);
    expect(await scheduled()).toHaveLength(2);
    expect(calls).toHaveLength(1);

    // An ordinary schedule and a source-bound schedule compete under the same bot lock.
    const { source: _source, ...ordinaryArgs } = call.args;
    const competeWhileBotLocked = async (ordinary: unknown, source: unknown) => {
      let release!: () => void;
      let locked!: () => void;
      let started!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const unlock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bothTransactions = new Promise<void>((resolve) => {
        started = resolve;
      });
      const holder = runAsTenant(scope, () =>
        db.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
          locked();
          await unlock;
        }),
      );
      await lockReady;
      let transactions = 0;
      const prisma = new Proxy(db.prisma, {
        get(target, key, receiver) {
          if (key === "$transaction")
            return (...args: unknown[]) => {
              if (++transactions === 2) started();
              return Reflect.apply(target.$transaction, target, args);
            };
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const raceCtx = { ...ctx, deps: { ...deps, prisma } };
      const pending = Promise.all([
        runAsTenant(scope, () => taskTools.schedule_create!(raceCtx as never, ordinary as never)),
        runAsTenant(scope, () => taskTools.schedule_create!(raceCtx as never, source as never)),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          bothTransactions,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Both creations must reach the bot lock")),
              3000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        release();
      }
      await holder;
      return pending;
    };
    const crossPath = await competeWhileBotLocked(
      {
        ...call,
        effectKey: `ordinary-${suffix}`,
        args: { ...ordinaryArgs, name: "Cross-path name" },
      },
      { ...call, effectKey: `source-${suffix}`, args: { ...call.args, name: "Cross-path name" } },
    );
    expect(crossPath.filter((result) => (result as { ok?: boolean }).ok)).toHaveLength(1);
    expect(
      crossPath.filter((result) =>
        (result as { error?: string }).error?.includes("already exists"),
      ),
    ).toHaveLength(1);
    expect(
      await runAsTenant(scope, () =>
        db.prisma.routine.count({
          where: { ...scope, botId, name: "Cross-path name", active: true },
        }),
      ),
    ).toBe(1);

    const activeCount = await runAsTenant(scope, () =>
      db.prisma.routine.count({ where: { ...scope, botId, active: true } }),
    );
    await runAsTenant(scope, () =>
      db.prisma.routine.createMany({
        data: Array.from({ length: 49 - activeCount }, (_, index) => ({
          ...scope,
          botId,
          threadId,
          name: `Capacity filler ${index}`,
          prompt: "Synthetic",
          crons: ["0 9 * * *"],
          timezone: "UTC",
          active: true,
        })),
      }),
    );
    const capacity = await competeWhileBotLocked(
      {
        ...call,
        effectKey: `ordinary-limit-${suffix}`,
        args: { ...ordinaryArgs, name: "Ordinary at limit" },
      },
      {
        ...call,
        effectKey: `source-limit-${suffix}`,
        args: { ...call.args, name: "Source at limit" },
      },
    );
    expect(capacity.filter((result) => (result as { ok?: boolean }).ok)).toHaveLength(1);
    expect(capacity.filter((result) => (result as { error?: string }).error)).toHaveLength(1);
    expect(
      await runAsTenant(scope, () =>
        db.prisma.routine.count({ where: { ...scope, botId, active: true } }),
      ),
    ).toBe(50);
  });
});
