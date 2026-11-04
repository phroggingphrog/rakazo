import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import { SETUP_SOURCE_TEST_KIND } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeSetupSourceTest, setupSourceTestInstruction } from "./setup-source-test.js";

function fixture() {
  const effect = {
    id: "effect",
    runId: "run",
    spaceId: "space",
    kind: SETUP_SOURCE_TEST_KIND,
    status: "intended",
    result: null as unknown,
    request: {
      kind: "email_monitor",
      purpose: "test",
      botId: "bot",
      source: { serverId: "server", revision: 1, toolName: "read" },
      arguments: { query: "bookings" },
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      notify: true,
    },
  };
  const state = {
    liveLease: true,
    assigned: true,
    server: true,
    calls: 0,
    expireDuringCall: false,
    events: [] as ConnectorEvent[],
  };
  const prisma = {
    externalEffect: { findUnique: vi.fn(async () => ({ ...effect })) },
    mcpServer: {
      findFirst: vi.fn(async () =>
        state.server ? { id: "server", slug: "mail", allBots: false } : null,
      ),
    },
    botMcpServer: {
      findFirst: vi.fn(async () =>
        state.assigned ? { allowAllTools: true, allowedTools: [] } : null,
      ),
    },
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const [to, result, , id, from] = values;
      if (!state.liveLease || id !== effect.id || from !== effect.status) return 0;
      effect.status = String(to);
      if (typeof result === "string") effect.result = JSON.parse(result);
      return 1;
    }),
  };
  const calls: unknown[] = [];
  const connector = {
    execute: async function* (call: unknown) {
      state.calls++;
      calls.push(call);
      if (state.expireDuringCall) state.liveLease = false;
      for (const event of state.events) yield event;
    },
  };
  const context: AdapterContext = {
    operationId: "run",
    traceId: "run",
    runId: "run",
    userId: "user",
    spaceId: "space",
    botId: "bot",
    signal: AbortSignal.timeout(10000),
  };
  const finish = vi.fn(async () => true);
  const authorize = vi.fn(async () => ({ state: "allowed" as const, finish }));
  const run = () =>
    executeSetupSourceTest({
      prisma: prisma as never,
      connector: connector as never,
      context,
      runId: "run",
      workerId: "worker",
      fence: 1,
      secrets: ["secret-value"],
      authorize,
    });
  return { state, effect, prisma, calls, run, authorize, finish };
}

describe("setup source execution", () => {
  it("separates returned source data from the instruction with a newline", () => {
    expect(setupSourceTestInstruction({ state: "succeeded", data: { value: 1 } })).toContain(
      'instructions:\n{"value":1}',
    );
  });
  it("calls the exact selected integration and arguments once and redacts its result", async () => {
    const f = fixture();
    f.state.events = [
      { type: "result", data: { content: [{ type: "text", text: "secret-value" }] } },
    ];
    expect(await f.run()).toEqual({
      state: "succeeded",
      data: { content: [{ type: "text", text: "[redacted]" }] },
    });
    expect(f.calls[0]).toMatchObject({
      tool: "read",
      args: { query: "bookings" },
      enforceResourceRevision: true,
      route: { resourceId: "server", resourceRevision: 1, toolName: "read" },
    });
    expect((await f.run())?.state).toBe("succeeded");
    expect(f.state.calls).toBe(1);
  });
  it("does not dispatch after an expired claim or accept a late response", async () => {
    const expired = fixture();
    expired.state.liveLease = false;
    expect((await expired.run())?.state).toBe("uncertain");
    expect(expired.state.calls).toBe(0);
    const late = fixture();
    late.state.expireDuringCall = true;
    late.state.events = [{ type: "result", data: { content: [] } }];
    expect((await late.run())?.state).toBe("uncertain");
    late.state.liveLease = true;
    expect((await late.run())?.state).toBe("uncertain");
    expect(late.state.calls).toBe(1);
  });
  it("leaves the source unclaimed while approval is pending, then dispatches once after approval", async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce({ state: "paused" } as never);
    f.state.events = [{ type: "result", data: { value: "synthetic" } }];
    expect(await f.run()).toEqual({ state: "paused" });
    expect(f.effect.status).toBe("intended");
    expect(f.state.calls).toBe(0);
    expect((await f.run())?.state).toBe("succeeded");
    expect(f.state.calls).toBe(1);
    expect(f.finish).toHaveBeenCalledWith("succeeded");
  });
  it("records a denied source without dispatch or later replay", async () => {
    const f = fixture();
    f.authorize.mockResolvedValueOnce({ state: "denied" } as never);
    expect(await f.run()).toEqual({ state: "failed" });
    expect(f.effect.status).toBe("completed");
    expect((await f.run())?.state).toBe("failed");
    expect(f.state.calls).toBe(0);
  });
  it("does not replay an interrupted source claim", async () => {
    const f = fixture();
    f.effect.status = "executing";
    expect(await f.run()).toEqual({ state: "uncertain" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.state.calls).toBe(0);
  });
  it("returns uncertainty if the gate cannot settle after the source result", async () => {
    const f = fixture();
    f.state.events = [{ type: "result", data: { value: "synthetic" } }];
    f.finish.mockResolvedValueOnce(false);
    expect(await f.run()).toEqual({ state: "uncertain" });
    expect(f.effect.status).toBe("uncertain");
    expect(f.state.calls).toBe(1);
    expect((await f.run())?.state).toBe("uncertain");
    expect(f.state.calls).toBe(1);
  });
  it("never labels absent, failed, changed or malformed results successful", async () => {
    const absent = fixture();
    expect((await absent.run())?.state).toBe("uncertain");
    const failed = fixture();
    failed.state.events = [{ type: "result", data: { isError: true, content: [] } }];
    expect((await failed.run())?.state).toBe("failed");
    const changed = fixture();
    changed.state.events = [{ type: "result", data: {} }];
    changed.prisma.botMcpServer.findFirst.mockResolvedValueOnce(null);
    expect((await changed.run())?.state).toBe("uncertain");
    const invalid = fixture();
    invalid.effect.status = "completed";
    invalid.effect.result = { state: "succeeded" };
    expect((await invalid.run())?.state).toBe("uncertain");
  });
  it("bounds the returned source data", async () => {
    const f = fixture();
    f.state.events = [{ type: "result", data: { text: "x".repeat(20000) } }];
    const result = await f.run();
    expect(result).toMatchObject({ state: "succeeded", data: { truncated: true } });
    expect(JSON.stringify(f.effect.result).length).toBeLessThan(5000);
  });
});

it("rejects a changed integration revision before dispatch for a bound source test", async () => {
  const { McpConnector } = await import("./mcp-connector.js");
  const server = { id: "server", slug: "mail", revision: 2 };
  const prisma = {
    botMcpServer: {
      findFirst: vi.fn(async () => ({
        server,
        serverId: "server",
        allowAllTools: true,
        allowedTools: [],
      })),
    },
  };
  const connector = new McpConnector(prisma as never, {} as never);
  const internal = connector as unknown as {
    withSession: (...args: unknown[]) => Promise<unknown>;
  };
  const session = vi.spyOn(internal, "withSession");
  const context: AdapterContext = {
    operationId: "run",
    traceId: "run",
    runId: "run",
    userId: "user",
    spaceId: "space",
    botId: "bot",
    signal: AbortSignal.timeout(10000),
  };
  const events = [];
  for await (const event of connector.execute(
    {
      tool: "read",
      args: {},
      executionId: "test",
      enforceResourceRevision: true,
      route: { connectorId: "mcp", resourceId: "server", resourceRevision: 1, toolName: "read" },
    },
    context,
  ))
    events.push(event);
  expect(events).toEqual([expect.objectContaining({ type: "error" })]);
  expect(session).not.toHaveBeenCalled();
});
