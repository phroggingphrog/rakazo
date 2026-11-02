import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";
process.env.PROACTIVE_WEBHOOK_BOTS = "*";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("proactive core behind the bot webhook", () => {
  let handles: AppHandles;
  let app: App;
  let prisma: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-proactive-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
      signupsEnabled: "true",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function newBot(label: string) {
    const cookie = await signup(app, `proactive-${label}-${stamp}@rakazo.test`, "Proactive Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: `Pro ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const hook = await rpc<{ secret: string; path: string }>(
      app,
      cookie,
      "bots/rotateWebhookSecret",
      { botId: bot.id },
    );
    return { botId: bot.id, secret: hook.secret, path: hook.path };
  }

  const post = (bot: { secret: string; path: string }, body: unknown, key?: string) =>
    app.request(`https://rakazo.test${bot.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bot.secret}`,
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    });

  const webhookRuns = (botId: string) => prisma.run.count({ where: { botId, trigger: "webhook" } });

  async function settle(botId: string, expected: number, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await webhookRuns(botId)) >= expected) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // Give a wrong extra run time to appear before asserting there is none.
    await new Promise((r) => setTimeout(r, 1_500));
    return webhookRuns(botId);
  }

  it("stores the event, answers 202 and starts one run", async () => {
    const bot = await newBot("one");
    const res = await post(bot, { event: "deploy", note: "failed" }, `k-${stamp}-1`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      ok: true,
      accepted: true,
      duplicate: false,
      eventId: expect.any(String),
    });
    expect(await settle(bot.botId, 1)).toBe(1);
  });

  it("the same delivery twice starts one run", async () => {
    const bot = await newBot("dup");
    const a = await post(bot, { event: "deploy" }, `k-${stamp}-2`);
    const b = await post(bot, { event: "deploy" }, `k-${stamp}-2`);
    expect(a.status).toBe(202);
    expect(((await b.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(await settle(bot.botId, 1)).toBe(1);
  });

  it("a burst of different deliveries is one wake, one run", async () => {
    const bot = await newBot("burst");
    for (const n of [1, 2, 3]) await post(bot, { event: "tick", n }, `k-${stamp}-burst-${n}`);
    expect(await settle(bot.botId, 1)).toBe(1);
    const message = await prisma.message.findFirst({
      where: { thread: { bot: { id: bot.botId } }, role: "user" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(message?.blocks)).toContain("3 events arrived together");
  });

  it("a wake whose hand-over crashed is handed over again and runs once", async () => {
    const bot = await newBot("crash");
    const { createProactiveRuntime } = await import("@rakazo/adapters");
    let failures = 1;
    const runtime = createProactiveRuntime({
      prisma: handles.prisma,
      events: {
        sendUserMessage: async (input) => {
          if (failures-- > 0) throw new Error("crash between record and hand-over");
          return handles.events.sendUserMessage(input);
        },
      },
      jobs: handles.jobs,
      config: { debounceMs: 0, debounceMaxMs: 0, redeliverAfterMs: 0 },
      enabledBots: "*",
    });
    await runtime.receiveWebhook({
      botId: bot.botId,
      deliveryKey: `k-${stamp}-crash`,
      prompt: "crashy event",
    });
    await runtime.handlers.apply(`bot:${bot.botId}`);
    await runtime.handlers.decide(`bot:${bot.botId}`);
    expect(await webhookRuns(bot.botId)).toBe(0); // hand-over failed; wake is recorded
    await runtime.reconcile(); // the reconciler hands it over again
    await runtime.reconcile(); // and a second pass finds nothing left to do
    expect(await webhookRuns(bot.botId)).toBe(1);
  });

  const PROACTIVE_TABLES = [
    "proactive_inbox",
    "proactive_events",
    "proactive_scopes",
    "proactive_wakes",
    "proactive_effects",
    "proactive_timers",
  ];

  const rowsFor = async (table: string, botId: string) =>
    (await prisma.$queryRawUnsafe(
      `SELECT row_to_json(t)::text AS body FROM ${table} t WHERE "scope" = $1`,
      `bot:${botId}`,
    )) as Array<{ body: string }>;

  it("keeps the webhook body out of every proactive table, sealed under the bot's key", async () => {
    const bot = await newBot("sealed");
    const secret = `launch-code-${stamp}`;
    await post(bot, { note: secret }, `k-${stamp}-sealed`);
    expect(await settle(bot.botId, 1)).toBe(1);
    for (const table of ["proactive_inbox", "proactive_events", "proactive_wakes"]) {
      const rows = await rowsFor(table, bot.botId);
      expect(rows.length, table).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.body, table).not.toContain(secret);
        expect(row.body, table).toContain("rkz1:");
      }
    }
  });

  it("a tenant context sees none of the proactive tables", async () => {
    const bot = await newBot("tenant");
    await post(bot, { note: "x" }, `k-${stamp}-tenant`);
    expect(await settle(bot.botId, 1)).toBe(1);
    const row = await prisma.bot.findUnique({
      where: { id: bot.botId },
      select: { spaceId: true, userId: true },
    });
    const [role] = (await prisma.$queryRawUnsafe(
      `SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`,
    )) as Array<{ bypass: boolean }>;
    // A superuser or BYPASSRLS login ignores policies, so there is nothing to check.
    if (role?.bypass) return;
    for (const table of PROACTIVE_TABLES) {
      const seen = await runAsTenant(
        { spaceId: row!.spaceId, userId: row!.userId },
        () =>
          handles.prisma.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`) as Promise<unknown[]>,
      );
      expect(seen, table).toHaveLength(0);
    }
  });

  it("maintain removes the rows of a deleted bot and leaves other bots alone", async () => {
    const gone = await newBot("gone");
    const kept = await newBot("kept");
    await post(gone, { note: "a" }, `k-${stamp}-gone`);
    await post(kept, { note: "b" }, `k-${stamp}-kept`);
    expect(await settle(gone.botId, 1)).toBe(1);
    expect(await settle(kept.botId, 1)).toBe(1);
    expect((await rowsFor("proactive_inbox", gone.botId)).length).toBeGreaterThan(0);
    await prisma.bot.delete({ where: { id: gone.botId } });
    const result = await handles.proactive.maintain();
    expect(result.forgotten).toBeGreaterThanOrEqual(1);
    for (const table of PROACTIVE_TABLES.filter((t) => t !== "proactive_effects")) {
      expect(await rowsFor(table, gone.botId), table).toHaveLength(0);
    }
    expect((await rowsFor("proactive_inbox", kept.botId)).length).toBeGreaterThan(0);
  });

  it("maintain prunes finished work past the retention window", async () => {
    const bot = await newBot("prune");
    await post(bot, { note: "old" }, `k-${stamp}-prune`);
    expect(await settle(bot.botId, 1)).toBe(1);
    expect((await rowsFor("proactive_events", bot.botId)).length).toBeGreaterThan(0);
    const { createProactiveRuntime } = await import("@rakazo/adapters");
    const short = createProactiveRuntime({
      prisma: handles.prisma,
      events: handles.events,
      jobs: handles.jobs,
      config: { retentionMs: 1 },
    });
    await new Promise((r) => setTimeout(r, 20));
    const result = await short.maintain();
    expect(result.pruned.events).toBeGreaterThanOrEqual(1);
    expect(await rowsFor("proactive_events", bot.botId)).toHaveLength(0);
    expect(await rowsFor("proactive_inbox", bot.botId)).toHaveLength(0);
  });

  it("rejects a bad bearer token before the core sees anything", async () => {
    const bot = await newBot("auth");
    const res = await post({ ...bot, secret: "wrong-secret-wrong-secret-wrong-secret" }, {});
    expect(res.status).toBe(401);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return sessionCookieHeader(res);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
