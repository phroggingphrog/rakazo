import { RPCHandler } from "@orpc/server/fetch";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "owner-1",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const other = { ...actor, userId: "owner-2" };
const key = "5cb756ab-4cb0-4b3b-af5b-e7476b78b6d5";
const draft = {
  kind: "email_monitor",
  purpose: "Monitor mail",
  botId: "bot-1",
  source: { serverId: "server-1", revision: 1, toolName: "read_mail" },
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  notify: true,
};

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  requestKey: string;
  requestPayload: unknown;
  draft: unknown;
  revision: number;
  status: string;
  routineId?: string | null;
  configureRequestKey?: string | null;
  configuredFromRevision?: number | null;
  createdAt: Date;
  updatedAt: Date;
};
function fixture() {
  const rows: Row[] = [];
  const attempts: Array<Record<string, unknown>> = [];
  let savedRoutine: Record<string, unknown> | undefined;
  let routineContent: Record<string, unknown> | undefined;
  const read = {
    name: "mcp__mail__read",
    description: "Read",
    inputSchema: { type: "object" },
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: "server-1",
      resourceRevision: 1,
      toolName: "read_mail",
    },
  };
  const discover = vi.fn(async () => ({
    status: "ok" as "ok" | "unavailable" | "not_assigned",
    tools: [
      read,
      { ...read, readOnly: false, route: { ...read.route, toolName: "send_mail" } },
      { ...read, route: { ...read.route, resourceId: "other-server", toolName: "other" } },
      { ...read, route: { ...read.route, resourceRevision: 2, toolName: "stale" } },
      { ...read, batch: true, route: { ...read.route, toolName: "batch" } },
      { ...read, route: { ...read.route, connectorId: "other", toolName: "foreign_connector" } },
      { ...read, route: { ...read.route, toolName: "__rakazo_internal" } },
    ],
  }));
  const state = {
    botAvailable: true,
    serverAvailable: true,
    revision: 1,
    transport: "http",
    allBots: false,
    assigned: false,
    assignmentAllTools: true,
    allowedTools: [] as string[],
    encryption: true,
  };
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "id" && value && typeof value === "object")
        return row.id < String((value as { lt: unknown }).lt);
      return row[key as keyof Row] === value;
    });
  const setupPlan = {
    create: vi.fn(
      async ({
        data,
      }: {
        data: Omit<Row, "id" | "revision" | "status" | "createdAt" | "updatedAt">;
      }) => {
        if (
          rows.some(
            (row) =>
              row.spaceId === data.spaceId &&
              row.userId === data.userId &&
              row.requestKey === data.requestKey,
          )
        )
          throw Object.assign(new Error("unique"), { code: "P2002" });
        const row: Row = {
          ...data,
          id: `plan-${rows.length + 1}`,
          revision: 1,
          status: "draft",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
        rows.push(row);
        return { ...row };
      },
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
    ),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = rows.find((row) => matches(row, where));
      if (!row) throw new Error("missing");
      return { ...row };
    }),
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
      rows
        .filter((row) => matches(row, where))
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, take),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        if (!row) return { count: 0 };
        if ("draft" in data) row.draft = data.draft;
        if ("status" in data) row.status = String(data.status);
        if ("routineId" in data) row.routineId = String(data.routineId);
        if ("configureRequestKey" in data)
          row.configureRequestKey = String(data.configureRequestKey);
        if ("configuredFromRevision" in data)
          row.configuredFromRevision = Number(data.configuredFromRevision);
        row.revision++;
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    setupPlan,
    bot: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.botAvailable &&
        where.id === "bot-1" &&
        where.spaceId === actor.spaceId &&
        where.userId === actor.userId
          ? { id: "bot-1" }
          : null,
      ),
    },
    mcpServer: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.serverAvailable &&
        where.id === "server-1" &&
        where.userId === actor.userId &&
        where.enabled === true
          ? {
              id: "server-1",
              revision: state.revision,
              transport: state.transport,
              allBots: state.allBots,
            }
          : null,
      ),
    },
    botMcpServer: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.assigned &&
        where.botId === "bot-1" &&
        where.serverId === "server-1" &&
        where.spaceId === actor.spaceId &&
        where.userId === actor.userId
          ? {
              botId: "bot-1",
              allowAllTools: state.assignmentAllTools,
              allowedTools: state.allowedTools,
            }
          : null,
      ),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: string[]) => {
      const sql = strings.join("?");
      if (sql.includes("app.scheduler_protocol")) return [];
      if (sql.includes("FROM setup_plans"))
        return rows
          .filter(
            (row) => row.id === values[0] && row.spaceId === values[1] && row.userId === values[2],
          )
          .map((row) => ({ id: row.id, revision: row.revision, status: row.status }));
      if (sql.includes("FROM bots"))
        return state.botAvailable &&
          values[0] === "bot-1" &&
          values[1] === actor.spaceId &&
          values[2] === actor.userId
          ? [{ id: "bot-1" }]
          : [];
      if (sql.includes("FROM mcp_servers"))
        return state.serverAvailable && values[0] === "server-1" && values[1] === actor.userId
          ? [
              {
                id: "server-1",
                spaceId: actor.spaceId,
                allSpaces: false,
                revision: state.revision,
                transport: state.transport,
              },
            ]
          : [];
      if (sql.includes("FROM mcp_server_spaces")) return [];
      if (sql.includes("FROM routines")) return savedRoutine ? [{ id: "routine-1" }] : [];
      if (sql.includes("FROM protected_execution_content"))
        return routineContent ? [{ id: "content-1" }] : [];
      throw new Error("Unexpected fixture query");
    },
    routine: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        savedRoutine = { ...data, id: "routine-1", updatedAt: new Date(0) };
        return { id: "routine-1" };
      }),
      findFirst: vi.fn(async () =>
        savedRoutine ? { ...savedRoutine, protectedContent: routineContent } : null,
      ),
    },
    protectedExecutionContent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (data.routineId)
          routineContent = { id: "content-1", text: data.text, updatedAt: new Date(0) };
        return { id: "content-1" };
      }),
    },
    thread: { findFirst: vi.fn(async () => ({ id: "thread-1" })) },
    task: { create: vi.fn(async () => ({ id: "task-1" })) },
    setupTestAttempt: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          attempts.find((row) =>
            Object.entries(where).every(([key, value]) => row[key] === value),
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: "attempt-1", status: "prepared", createdAt: new Date(0) };
        attempts.push(row);
        return row;
      }),
    },
    $contentEncryption: () => ({ ring: { encryptWrites: state.encryption } }),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  const handler = new RPCHandler(
    createRouter({
      prisma,
      mcp: { probe: vi.fn(), discoverMonitorTools: discover },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake",
        webOrigin: "http://127.0.0.1",
        screenProxySecret: "fake",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/router-test",
    } as unknown as RouterDeps),
  );
  async function call(
    method: string,
    input: unknown,
    identity: typeof actor | null = actor,
    stillAuthorized?: () => Promise<boolean>,
  ) {
    const request = new Request(`http://127.0.0.1/rpc/setupPlans/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    });
    const handle = () =>
      handler.handle(request, {
        prefix: "/rpc",
        context: { actor: identity, sessionId: "session", stillAuthorized },
      });
    const { response } = identity ? await runAsTenant(identity, handle) : await handle();
    if (!response) throw new Error("missing response");
    return {
      status: response.status,
      body: (await response.json()) as { json: { id: string; status: string; revision: number } },
    };
  }
  return {
    call,
    setupPlan,
    rows,
    state,
    prisma,
    discover,
    useLegacyProtectedRoutine(purpose: string) {
      if (!savedRoutine) throw new Error("routine missing");
      savedRoutine.protected = true;
      routineContent = { id: "content-1", text: purpose, updatedAt: new Date(0) };
    },
  };
}

describe("owner-scoped setup proposal RPC", () => {
  it("accepts provider argument names without treating them as authentication fields", async () => {
    const f = fixture();
    const response = await f.call("create", {
      requestKey: key,
      draft: { ...draft, arguments: { nested: { access_token: "example" } } },
    });
    expect(response.status).toBe(200);
    expect(f.setupPlan.create).toHaveBeenCalledOnce();
  });
  it("creates and updates proposals when optional content encryption is off", async () => {
    const f = fixture();
    f.state.encryption = false;
    const created = await f.call("create", { requestKey: key, draft });
    expect(created.status).toBe(200);
    expect(
      (
        await f.call("update", {
          id: created.body.json.id,
          expectedRevision: 1,
          draft: { ...draft, purpose: "Updated" },
        })
      ).status,
    ).toBe(200);
  });
  it("revisions argument edits and binds prepared snapshots to those arguments", async () => {
    const f = fixture();
    const created = await f.call("create", {
      requestKey: key,
      draft: { ...draft, arguments: { query: "first" } },
    });
    const id = created.body.json.id;
    expect((await f.call("propose", { id, expectedRevision: 1 })).status).toBe(200);
    expect(
      (
        await f.call("update", {
          id,
          expectedRevision: 1,
          draft: { ...draft, arguments: { query: "stale" } },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.call("update", {
          id,
          expectedRevision: 2,
          draft: { ...draft, arguments: { query: "second" } },
        })
      ).body.json,
    ).toMatchObject({ revision: 3, status: "draft" });
    expect((await f.call("propose", { id, expectedRevision: 3 })).status).toBe(200);
    expect((await f.call("configure", { id, expectedRevision: 4, requestKey: key })).status).toBe(
      200,
    );
    expect(f.prisma.routine.create.mock.calls[0]![0].data.prompt).toContain('"query":"second"');
    f.useLegacyProtectedRoutine(draft.purpose);
    expect((await f.call("prepareTest", { id, expectedRevision: 5, requestKey: key })).status).toBe(
      200,
    );
    expect(f.prisma.setupTestAttempt.create.mock.calls[0]![0].data.snapshot).toMatchObject({
      arguments: { query: "second" },
      planRevision: 5,
    });
    expect((await f.call("get", { id }, other)).status).toBe(404);
    expect(f.discover).not.toHaveBeenCalled();
  });
  it("requires arguments to be cleared when changing the operation", async () => {
    const f = fixture();
    const created = await f.call("create", {
      requestKey: key,
      draft: { ...draft, arguments: { query: "example" } },
    });
    const id = created.body.json.id;
    const changed = { ...draft, source: { ...draft.source, toolName: "another_read" } };
    expect(
      (
        await f.call("update", {
          id,
          expectedRevision: 1,
          draft: { ...changed, arguments: { query: "example" } },
        })
      ).status,
    ).toBe(400);
    expect((await f.call("update", { id, expectedRevision: 1, draft: changed })).status).toBe(200);
    expect(
      (
        await f.call("update", {
          id,
          expectedRevision: 2,
          draft: { ...changed, arguments: { query: "reviewed" } },
        })
      ).status,
    ).toBe(200);
  });
  it("prepares a protected draft once without creating or executing a run", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    expect((await f.call("prepareTest", { id, expectedRevision: 1, requestKey: key })).status).toBe(
      409,
    );
    expect((await f.call("propose", { id, expectedRevision: 1 })).status).toBe(200);
    expect((await f.call("configure", { id, expectedRevision: 2, requestKey: key })).status).toBe(
      200,
    );
    f.useLegacyProtectedRoutine(draft.purpose);
    expect((await f.call("preparedTest", { id }, other)).status).toBe(404);
    expect((await f.call("preparedTest", { id })).body.json).toBeNull();
    const result = await f.call("prepareTest", { id, expectedRevision: 3, requestKey: key });
    expect(result.status).toBe(200);
    expect(result.body.json).toMatchObject({
      status: "prepared",
      taskId: "task-1",
      execution: "not_started",
      sourceAccess: "not_verified",
    });
    expect(f.prisma.task.create).toHaveBeenCalledOnce();
    const createdAttempt = f.prisma.setupTestAttempt.create.mock.calls[0]![0].data;
    expect(createdAttempt.snapshot).toMatchObject({
      assignment: "not_checked",
      operation: "not_verified",
      sourceAccess: "not_verified",
    });
    expect(JSON.stringify(createdAttempt.snapshot)).not.toContain(draft.purpose);
    expect((await f.call("preparedTest", { id })).body.json).toMatchObject({
      id: result.body.json.id,
    });
    expect(
      (await f.call("prepareTest", { id, expectedRevision: 3, requestKey: key })).body.json.id,
    ).toBe(result.body.json.id);
    expect(f.prisma.task.create).toHaveBeenCalledOnce();
    expect(
      (
        await f.call("prepareTest", {
          id,
          expectedRevision: 3,
          requestKey: "b646527a-960f-42e5-b9b5-4e05b87c3f43",
        })
      ).status,
    ).toBe(409);
    expect(f.discover).not.toHaveBeenCalled();
  });
  it("does not prepare when the integration changed or encryption is off", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    expect((await f.call("propose", { id, expectedRevision: 1 })).status).toBe(200);
    expect((await f.call("configure", { id, expectedRevision: 2, requestKey: key })).status).toBe(
      200,
    );
    f.state.encryption = false;
    expect((await f.call("prepareTest", { id, expectedRevision: 3, requestKey: key })).status).toBe(
      503,
    );
    f.state.encryption = true;
    f.state.revision = 2;
    expect((await f.call("prepareTest", { id, expectedRevision: 3, requestKey: key })).status).toBe(
      409,
    );
    expect(f.prisma.task.create).not.toHaveBeenCalled();
    expect(f.prisma.setupTestAttempt.create).not.toHaveBeenCalled();
  });
  it("creates one runnable paused routine after explicit confirmation and replays safely", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    expect((await f.call("configure", { id, expectedRevision: 1, requestKey: key })).status).toBe(
      409,
    );
    expect((await f.call("propose", { id, expectedRevision: 1 })).status).toBe(200);
    f.state.encryption = false;
    const result = await f.call("configure", { id, expectedRevision: 2, requestKey: key });
    f.state.encryption = true;
    expect(result.status).toBe(200);
    expect(result.body.json).toMatchObject({
      status: "configured",
      revision: 3,
      routineId: "routine-1",
      sourceAccess: "not_verified",
    });
    expect(f.prisma.routine.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botId: "bot-1",
          active: false,
          nextRunAt: null,
          prompt: expect.stringContaining(draft.purpose),
          monitor: {
            kind: "email",
            mode: "report_only",
            source: {
              connectorId: "mcp",
              resourceId: "server-1",
              resourceRevision: 1,
              toolName: "read_mail",
            },
          },
        }),
      }),
    );
    expect((await f.call("configure", { id, expectedRevision: 2, requestKey: key })).status).toBe(
      200,
    );
    expect(f.prisma.routine.create).toHaveBeenCalledOnce();
    expect(f.prisma.protectedExecutionContent.create).not.toHaveBeenCalled();
    expect(f.prisma.routine.create.mock.calls[0]![0].data).not.toHaveProperty("protected", true);
    expect(
      (
        await f.call("configure", {
          id,
          expectedRevision: 2,
          requestKey: "b646527a-960f-42e5-b9b5-4e05b87c3f43",
        })
      ).status,
    ).toBe(409);
    expect((await f.call("update", { id, expectedRevision: 3, draft })).status).toBe(409);
    expect(f.discover).not.toHaveBeenCalled();
  });
  it("does not configure a changed integration or another owner's proposal", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    expect((await f.call("propose", { id, expectedRevision: 1 })).status).toBe(200);
    expect(
      (await f.call("configure", { id, expectedRevision: 2, requestKey: key }, other)).status,
    ).toBe(404);
    f.state.revision = 2;
    expect((await f.call("configure", { id, expectedRevision: 2, requestKey: key })).status).toBe(
      409,
    );
    expect(f.prisma.routine.create).not.toHaveBeenCalled();
  });
  it("honors an explicit restrictive assignment over the all-bots default", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    f.state.allBots = true;
    f.state.assigned = true;
    f.state.assignmentAllTools = false;
    f.state.allowedTools = ["another_read"];
    expect(
      (await f.call("prerequisites", { id: created.body.json.id, expectedRevision: 1 })).body.json,
    ).toMatchObject({
      assignment: "configured",
      selectedTool: "blocked",
      sourceAccess: "not_verified",
    });
    f.state.allowedTools = ["read_mail"];
    expect(
      (await f.call("prerequisites", { id: created.body.json.id, expectedRevision: 1 })).body.json,
    ).toMatchObject({ selectedTool: "allowed" });
  });
  it("discovers only the selected bot's declared candidate reads, without claiming access", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const input = { id: created.body.json.id, expectedRevision: 1 };
    f.state.assigned = true;
    const result = await f.call("discoverCandidates", input);
    expect(result.status).toBe(200);
    expect(result.body.json).toMatchObject({
      planRevision: 1,
      sourceRevision: 1,
      status: "ok",
      selectedOperation: "declared_read",
      tools: [{ name: "read_mail" }],
      sourceAccess: "not_verified",
      read: "not_performed",
    });
    expect((result.body.json as unknown as { tools: unknown[] }).tools).toHaveLength(1);
    expect(f.discover).toHaveBeenCalledOnce();
    expect(f.discover).toHaveBeenCalledWith(
      expect.objectContaining({ ...actor, botId: "bot-1" }),
      "server-1",
    );
    expect(f.rows[0]).toMatchObject({ revision: 1, status: "draft" });
    expect(f.setupPlan.updateMany).not.toHaveBeenCalled();
  });
  it("does not contact a connector for foreign, unassigned, stale or unavailable selections", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const input = { id: created.body.json.id, expectedRevision: 1 };
    expect((await f.call("discoverCandidates", input, other)).status).toBe(404);
    expect((await f.call("discoverCandidates", input)).status).toBe(409);
    f.state.assigned = true;
    f.state.revision = 2;
    expect((await f.call("discoverCandidates", input)).status).toBe(409);
    f.state.revision = 1;
    f.state.botAvailable = false;
    expect((await f.call("discoverCandidates", input)).status).toBe(404);
    f.state.botAvailable = true;
    f.state.serverAvailable = false;
    expect((await f.call("discoverCandidates", input)).status).toBe(404);
    expect(f.discover).not.toHaveBeenCalled();
  });
  it("discovers an assigned local integration through the existing connector", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    f.state.assigned = true;
    f.state.transport = "stdio";
    const result = await f.call("discoverCandidates", {
      id: created.body.json.id,
      expectedRevision: 1,
    });
    expect(result.status).toBe(200);
    expect(f.discover).toHaveBeenCalledOnce();
    expect(result.body.json).toMatchObject({ selectedOperation: "declared_read" });
  });
  it("rejects results if the proposal, integration, or assignment changes during discovery", async () => {
    for (const change of ["plan", "server", "assignment", "bot"] as const) {
      const f = fixture();
      const created = await f.call("create", { requestKey: key, draft });
      f.state.assigned = true;
      f.discover.mockImplementationOnce(async () => {
        if (change === "plan") f.rows[0]!.revision++;
        if (change === "server") f.state.revision++;
        if (change === "assignment") f.state.assigned = false;
        if (change === "bot") f.state.botAvailable = false;
        return { status: "ok", tools: [] };
      });
      const result = await f.call("discoverCandidates", {
        id: created.body.json.id,
        expectedRevision: 1,
      });
      expect(result.status, change).toBe(change === "bot" ? 404 : 409);
      expect(f.discover).toHaveBeenCalledOnce();
    }
  });
  it("does not return discovered metadata after the session is revoked", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    f.state.assigned = true;
    const result = await f.call(
      "discoverCandidates",
      { id: created.body.json.id, expectedRevision: 1 },
      actor,
      async () => false,
    );
    expect(result.status).toBe(401);
    expect(f.discover).toHaveBeenCalledOnce();
  });
  it("distinguishes an absent operation from unavailable discovery", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    f.state.assigned = true;
    const input = { id: created.body.json.id, expectedRevision: 1 };
    f.discover.mockImplementationOnce(async () => ({ status: "ok", tools: [] }));
    expect((await f.call("discoverCandidates", input)).body.json).toMatchObject({
      status: "ok",
      selectedOperation: "not_found",
      tools: [],
      sourceAccess: "not_verified",
      read: "not_performed",
    });
    f.discover.mockImplementationOnce(async () => ({ status: "unavailable", tools: [] }));
    expect((await f.call("discoverCandidates", input)).body.json).toMatchObject({
      status: "unavailable",
      selectedOperation: "not_checked",
      tools: [],
      sourceAccess: "not_verified",
      read: "not_performed",
    });
  });
  it("inspects current local prerequisites without claiming provider access or changing the plan", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const input = { id: created.body.json.id, expectedRevision: 1 };
    expect((await f.call("prerequisites", input, other)).status).toBe(404);
    expect((await f.call("prerequisites", { ...input, expectedRevision: 2 })).status).toBe(409);
    expect((await f.call("prerequisites", input)).body.json).toMatchObject({
      planRevision: 1,
      bot: "available",
      source: "available",
      assignment: "not_configured",
      operation: "not_verified",
      sourceAccess: "not_verified",
    });
    expect(f.prisma.mcpServer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: actor.userId,
          enabled: true,
          OR: expect.any(Array),
        }),
      }),
    );
    f.state.assigned = true;
    expect((await f.call("prerequisites", input)).body.json).toMatchObject({
      assignment: "configured",
      sourceAccess: "not_verified",
    });
    f.state.assigned = false;
    f.state.allBots = true;
    expect((await f.call("prerequisites", input)).body.json).toMatchObject({
      assignment: "configured",
    });
    f.state.revision = 2;
    expect((await f.call("prerequisites", input)).body.json).toMatchObject({
      source: "changed",
      assignment: "not_checked",
    });
    f.state.revision = 1;
    f.state.transport = "stdio";
    expect((await f.call("prerequisites", input)).body.json).toMatchObject({
      source: "available",
      assignment: "configured",
    });
    f.state.serverAvailable = false;
    f.state.botAvailable = false;
    expect((await f.call("prerequisites", input)).body.json).toMatchObject({
      bot: "unavailable",
      source: "unavailable",
      assignment: "not_checked",
    });
    expect(f.rows[0]).toMatchObject({ revision: 1, status: "draft" });
    expect(f.setupPlan.updateMany).not.toHaveBeenCalled();
  });
  it("reports missing selections without treating them as available", async () => {
    const f = fixture();
    const created = await f.call("create", {
      requestKey: key,
      draft: { ...draft, botId: null, source: null },
    });
    expect(
      (await f.call("prerequisites", { id: created.body.json.id, expectedRevision: 1 })).body.json,
    ).toMatchObject({
      bot: "not_selected",
      source: "not_selected",
      assignment: "not_checked",
      operation: "not_verified",
      sourceAccess: "not_verified",
    });
    expect(f.prisma.bot.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.mcpServer.findFirst).not.toHaveBeenCalled();
  });
  it("requires authentication and does not trust another owner", async () => {
    const f = fixture();
    expect((await f.call("create", { requestKey: key, draft }, null)).status).toBe(401);
    expect(f.setupPlan.create).not.toHaveBeenCalled();
    const created = await f.call("create", { requestKey: key, draft, userId: other.userId });
    expect(created.status).toBe(400);
    const ok = await f.call("create", { requestKey: key, draft });
    expect(ok.status).toBe(200);
    expect((await f.call("get", { id: ok.body.json.id }, other)).status).toBe(404);
    expect((await f.call("update", { id: "missing", expectedRevision: 1, draft })).status).toBe(
      404,
    );
    expect(
      (await f.call("update", { id: ok.body.json.id, expectedRevision: 1, draft }, other)).status,
    ).toBe(404);
  });
  it("rejects invalid timezones for create, update, and an existing proposal", async () => {
    const f = fixture();
    const invalid = { ...draft, schedule: { ...draft.schedule, timezone: "Not/A_Zone" } };
    expect((await f.call("create", { requestKey: key, draft: invalid })).status).toBe(400);
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    expect((await f.call("update", { id, expectedRevision: 1, draft: invalid })).status).toBe(400);
    f.rows[0]!.draft = invalid;
    expect((await f.call("propose", { id, expectedRevision: 1 })).status).toBe(400);
    expect(f.rows[0]).toMatchObject({ status: "draft", revision: 1 });
  });
  it("rejects revisions that cannot be incremented in PostgreSQL", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    const tooLarge = 2_147_483_648;
    expect((await f.call("update", { id, expectedRevision: tooLarge, draft })).status).toBe(400);
    expect((await f.call("propose", { id, expectedRevision: tooLarge })).status).toBe(400);
    expect((await f.call("update", { id, expectedRevision: 2_147_483_646, draft })).status).toBe(
      409,
    );
    f.rows[0]!.revision = 2_147_483_647;
    expect((await f.call("update", { id, expectedRevision: 2_147_483_647, draft })).status).toBe(
      409,
    );
    expect((await f.call("propose", { id, expectedRevision: 2_147_483_647 })).status).toBe(409);
    expect(f.rows[0]).toMatchObject({ status: "draft", revision: 2_147_483_647 });
  });
  it("deduplicates creates, rejects key reuse and stale updates, and invalidates a proposal on edit", async () => {
    const f = fixture();
    const created = await f.call("create", { requestKey: key, draft });
    const id = created.body.json.id;
    expect((await f.call("create", { requestKey: key, draft })).body.json.id).toBe(id);
    expect(
      (await f.call("create", { requestKey: key, draft: { ...draft, purpose: "Different" } }))
        .status,
    ).toBe(409);
    expect((await f.call("propose", { id, expectedRevision: 1 })).body.json).toMatchObject({
      status: "proposed",
      sourceAccess: "not_verified",
      botAssignment: "not_checked",
    });
    expect((await f.call("update", { id, expectedRevision: 1, draft })).status).toBe(409);
    const edited = await f.call("update", { id, expectedRevision: 2, draft });
    expect(edited.body.json).toMatchObject({ status: "draft", revision: 3 });
    expect(
      (await f.call("update", { id, expectedRevision: 3, draft: { ...draft, status: "active" } }))
        .status,
    ).toBe(400);
  });
});
