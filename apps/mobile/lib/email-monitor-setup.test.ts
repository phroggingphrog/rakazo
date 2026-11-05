import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scope: "scope-a",
  selection: 1,
  data: null as string | null,
  rpc: vi.fn(),
  write: vi.fn(),
}));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: "https://example.invalid",
    headers: { "x-rakazo-space-id": "space-a" },
    sessionGeneration: 1,
  }),
  spaceSelectionSeq: () => state.selection,
  rpc: state.rpc,
}));
vi.mock("./routine-store", () => ({ routineScope: () => state.scope }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => state.data,
  setItemAsync: async (_key: string, value: string) => {
    await state.write(value);
    state.data = value;
  },
}));

const { openMonitorSetup } = await import("./email-monitor-setup");
const draft = {
  kind: "email_monitor" as const,
  purpose: "Find appointment updates",
  botId: "bot-1",
  source: { serverId: "server-1", revision: 3, toolName: "read_mail" },
  schedule: { cron: "0 9 * * *", timezone: "Australia/Melbourne" },
  notify: true,
};
const plan = {
  id: "plan-1",
  revision: 1,
  status: "draft" as const,
  routineId: null,
  draft,
  sourceAccess: "not_verified" as const,
  botAssignment: "not_checked" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
beforeEach(() => {
  state.scope = "scope-a";
  state.selection = 1;
  state.data = null;
  state.write.mockReset();
  state.rpc.mockReset();
  state.rpc.mockImplementation(async (path: string) => {
    if (path === "me") return { userId: "user-a", spaceId: "space-a" };
    if (path === "setupPlans/create") return plan;
    if (path === "setupPlans/configure")
      return { ...plan, status: "configured", routineId: "routine-1", revision: 3 };
    if (path === "setupPlans/list") return { plans: [plan], nextCursor: null };
    if (path === "mcp/servers/list") return [];
    throw new Error(`Unexpected path: ${path}`);
  });
});

describe("mobile monitor setup scope and idempotency", () => {
  it("interprets the backward-compatible unbound flag for latest and selected runs", async () => {
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: "user-a", spaceId: "space-a" };
      if (path === "routines/history")
        return {
          runs: [
            { id: "test", status: "completed", sourceTest: "not_started", sourceUnbound: true },
          ],
          nextCursor: null,
        };
      throw new Error(`Unexpected path: ${path}`);
    });
    const opened = await openMonitorSetup("bot-1");
    const configured = { ...plan, status: "configured" as const, routineId: "routine-1" };
    await expect(opened.latestSourceTest(configured)).resolves.toEqual({
      runId: "test",
      runStatus: "completed",
      sourceTest: "unbound",
    });
    await expect(opened.testStatus(configured, "test")).resolves.toEqual({
      runStatus: "completed",
      sourceTest: "unbound",
    });
  });
  it("reads only the latest explicitly recorded source test and rejects stale scope", async () => {
    let resolve!: (value: unknown) => void;
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: "user-a", spaceId: "space-a" };
      if (path === "routines/history")
        return new Promise((r) => {
          resolve = r;
        });
      throw new Error(`Unexpected path: ${path}`);
    });
    const opened = await openMonitorSetup("bot-1");
    const configured = { ...plan, status: "configured" as const, routineId: "routine-1" };
    const first = opened.latestSourceTest(configured);
    resolve({
      runs: [
        { id: "normal", status: "completed" },
        { id: "test", status: "failed", sourceTest: "uncertain" },
      ],
      nextCursor: null,
    });
    await expect(first).resolves.toEqual({
      runId: "test",
      runStatus: "failed",
      sourceTest: "uncertain",
    });
    const stale = opened.latestSourceTest(configured);
    state.selection += 1;
    resolve({
      runs: [{ id: "test", status: "completed", sourceTest: "succeeded" }],
      nextCursor: null,
    });
    await expect(stale).rejects.toThrow();
  });
  it("uses only the matching run's explicit source-test state", async () => {
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: "user-a", spaceId: "space-a" };
      if (path === "routines/history")
        return {
          runs: [
            { id: "other", status: "completed", sourceTest: "succeeded" },
            { id: "selected", status: "failed", sourceTest: "uncertain" },
          ],
          nextCursor: null,
        };
      throw new Error(`Unexpected path: ${path}`);
    });
    const opened = await openMonitorSetup("bot-1");
    const configured = { ...plan, status: "configured" as const, routineId: "routine-1" };
    await expect(opened.testStatus(configured, "selected")).resolves.toEqual({
      runStatus: "failed",
      sourceTest: "uncertain",
    });
    await expect(opened.testStatus(configured, "missing")).resolves.toEqual({
      runStatus: "unknown",
      sourceTest: "unavailable",
    });
  });
  it("offers enabled local integrations for setup", async () => {
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: "user-a", spaceId: "space-a" };
      if (path === "mcp/servers/list")
        return [
          { id: "local-1", enabled: true, transport: "stdio" },
          { id: "local-2", enabled: false, transport: "stdio" },
        ];
      if (path === "setupPlans/list") return { plans: [], nextCursor: null };
      throw new Error(`Unexpected path: ${path}`);
    });
    const loaded = await (await openMonitorSetup("bot-1")).load();
    expect(loaded.servers.map((server) => server.id)).toEqual(["local-1"]);
  });
  it("keeps a creation key across a lost response without storing draft text", async () => {
    const first = await openMonitorSetup("bot-1");
    state.rpc.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    await expect(first.save(draft, null)).rejects.toThrow("connection lost");
    const firstRequest = state.rpc.mock.calls.find((call) => call[0] === "setupPlans/create")![1];
    expect(state.data).not.toContain(draft.purpose);
    expect(state.data).not.toContain("read_mail");
    const reopened = await openMonitorSetup("bot-1");
    await expect(reopened.save(draft, null)).resolves.toMatchObject({ id: "plan-1" });
    const requests = state.rpc.mock.calls.filter((call) => call[0] === "setupPlans/create");
    expect(requests[1]![1].requestKey).toBe(firstRequest.requestKey);
    expect(JSON.parse(state.data!)).toEqual([]);
  });

  it("keeps separate create keys for different accounts", async () => {
    const first = await openMonitorSetup("bot-1");
    state.rpc.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    await expect(first.save(draft, null)).rejects.toThrow();
    const firstKey = state.rpc.mock.calls.find((call) => call[0] === "setupPlans/create")![1]
      .requestKey;
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: "user-b", spaceId: "space-a" };
      if (path === "setupPlans/create") return plan;
      throw new Error("Unexpected path");
    });
    const other = await openMonitorSetup("bot-1");
    await other.save(draft, null);
    const keys = state.rpc.mock.calls
      .filter((call) => call[0] === "setupPlans/create")
      .map((call) => call[1].requestKey);
    expect(keys[1]).not.toBe(firstKey);
    expect(JSON.parse(state.data!)).toHaveLength(1);
  });

  it("uses one key for concurrent creation attempts in the same scope", async () => {
    const first = await openMonitorSetup("bot-1");
    const second = await openMonitorSetup("bot-1");
    const releases: Array<(value: unknown) => void> = [];
    state.rpc.mockImplementation((path: string) => {
      if (path === "setupPlans/create")
        return new Promise((resolve) => {
          releases.push(resolve);
        });
      throw new Error("Unexpected path");
    });
    const a = first.save(draft, null);
    const b = second.save(draft, null);
    await vi.waitFor(() =>
      expect(state.rpc.mock.calls.filter((call) => call[0] === "setupPlans/create")).toHaveLength(
        2,
      ),
    );
    const calls = state.rpc.mock.calls.filter((call) => call[0] === "setupPlans/create");
    expect(calls[0]![1].requestKey).toBe(calls[1]![1].requestKey);
    // Both network calls represent the same server idempotency key.
    for (const release of releases) release(plan);
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it("fails closed when persisted retry metadata cannot be read", async () => {
    state.data = "not-json";
    const opened = await openMonitorSetup("bot-1");
    await expect(opened.save(draft, null)).rejects.toThrow("safely recover");
    expect(state.rpc.mock.calls.some((call) => call[0] === "setupPlans/create")).toBe(false);
  });

  it("does not submit a draft when the retry key cannot be stored", async () => {
    state.write.mockRejectedValueOnce(new Error("secure storage unavailable"));
    const opened = await openMonitorSetup("bot-1");
    await expect(opened.save(draft, null)).rejects.toThrow("secure storage unavailable");
    expect(state.rpc.mock.calls.some((call) => call[0] === "setupPlans/create")).toBe(false);
  });

  it("keeps a confirmed save even if retry-key cleanup fails", async () => {
    state.write
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("secure storage unavailable"));
    const opened = await openMonitorSetup("bot-1");
    await expect(opened.save(draft, null)).resolves.toMatchObject({ id: "plan-1" });
    expect(JSON.parse(state.data!)).toHaveLength(1);
  });

  it("does not send a stale write after switching spaces and back", async () => {
    const opened = await openMonitorSetup("bot-1");
    state.selection += 2;
    await expect(opened.save(draft, null)).rejects.toThrow("space changed");
    expect(state.rpc.mock.calls.filter((call) => call[0] === "setupPlans/create")).toHaveLength(0);
    expect(state.write).not.toHaveBeenCalled();
  });

  it("ignores a response that arrives after the session scope changes", async () => {
    const opened = await openMonitorSetup("bot-1");
    let finish!: (result: unknown) => void;
    state.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const waiting = opened.load();
    state.scope = "scope-b";
    finish([]);
    await expect(waiting).rejects.toThrow("space changed");
  });

  it("keeps a configure key for an ambiguous outcome and never auto-activates", async () => {
    const opened = await openMonitorSetup("bot-1");
    const proposed = { ...plan, status: "proposed" as const, revision: 2 };
    state.rpc.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    await expect(opened.configure(proposed)).rejects.toThrow("connection lost");
    await expect(opened.configure(proposed)).resolves.toMatchObject({ status: "configured" });
    const requests = state.rpc.mock.calls.filter((call) => call[0] === "setupPlans/configure");
    expect(requests).toHaveLength(2);
    expect(requests[0]![1]).toEqual(requests[1]![1]);
    expect(state.rpc.mock.calls.some((call) => call[0] === "routines/update")).toBe(false);
  });

  it("reuses the test nonce after a lost response and remount, scoped to owner and revision", async () => {
    const configured = {
      ...plan,
      status: "configured" as const,
      routineId: "routine-1",
      revision: 3,
    };
    const opened = await openMonitorSetup("bot-1");
    state.rpc.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });
    await expect(opened.runTest(configured)).rejects.toThrow("connection lost");
    const first = state.rpc.mock.calls.find((call) => call[0] === "routines/testRun")![1];
    expect(state.data).not.toContain(draft.purpose);
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: "user-a", spaceId: "space-a" };
      if (path === "routines/testRun") return { runId: "run-1" };
      throw new Error(`Unexpected path: ${path}`);
    });
    const reopened = await openMonitorSetup("bot-1");
    await reopened.runTest(configured);
    const requests = state.rpc.mock.calls.filter((call) => call[0] === "routines/testRun");
    expect(requests[1]![1]).toEqual(first);
    expect(state.rpc.mock.calls.some((call) => call[0] === "routines/update")).toBe(false);
  });

  it("keeps different owner and revision test nonces separate", async () => {
    const configured = {
      ...plan,
      status: "configured" as const,
      routineId: "routine-1",
      revision: 3,
    };
    let owner = "user-a";
    state.rpc.mockImplementation(async (path: string) => {
      if (path === "me") return { userId: owner, spaceId: "space-a" };
      if (path === "routines/testRun") throw new Error("connection lost");
      throw new Error(`Unexpected path: ${path}`);
    });
    const first = await openMonitorSetup("bot-1");
    await expect(first.runTest(configured)).rejects.toThrow();
    await expect(first.runTest({ ...configured, revision: 4 })).rejects.toThrow();
    owner = "user-b";
    const other = await openMonitorSetup("bot-1");
    await expect(other.runTest(configured)).rejects.toThrow();
    const keys = state.rpc.mock.calls
      .filter((call) => call[0] === "routines/testRun")
      .map((call) => call[1].clientNonce);
    expect(new Set(keys).size).toBe(3);
  });

  it("does not run when durable retry metadata cannot be saved", async () => {
    const configured = {
      ...plan,
      status: "configured" as const,
      routineId: "routine-1",
      revision: 3,
    };
    const opened = await openMonitorSetup("bot-1");
    state.write.mockRejectedValueOnce(new Error("secure storage unavailable"));
    await expect(opened.runTest(configured)).rejects.toThrow("secure storage unavailable");
    expect(state.rpc.mock.calls.some((call) => call[0] === "routines/testRun")).toBe(false);
  });
});
