import type { ActionApprovalRule } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "./approval-effect.js";
import { authorizeSetupSource } from "./setup-source-authorization.js";

const source = {
  serverId: "server",
  serverSlug: "mail",
  revision: 1,
  toolName: "read",
  args: { query: "bookings" },
  executionId: "source-effect",
};
const tool = {
  name: "mcp__mail__read",
  description: "Read",
  readOnly: true,
  inputSchema: { type: "object" },
  route: { connectorId: "mcp", resourceId: "server", resourceRevision: 1, toolName: "read" },
};

type Effect = {
  id: string;
  runId: string;
  spaceId: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
};

function fixture(rules: ActionApprovalRule[] = [], skipApprovals = false) {
  const effects: Effect[] = [];
  const externalEffect = {
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    findMany: vi.fn(
      async ({ where }: { where?: { status?: string | { in: string[] }; kind?: string } } = {}) =>
        effects.filter((effect) => {
          const status = where?.status;
          if (typeof status === "string" && effect.status !== status) return false;
          if (status && typeof status === "object" && !status.in.includes(effect.status))
            return false;
          return !where?.kind || effect.kind === where.kind;
        }),
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return effect;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; status: string }; data: Partial<Effect> }) => {
        const effect = effects.find(
          (candidate) => candidate.id === where.id && candidate.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const pause = vi.fn(async () => ({ continuationRunId: null }));
  const prisma = {
    externalEffect,
    attempt: { count: vi.fn(async () => 1) },
    run: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ status: "running" })),
    },
  };
  const connector = { resolveCall: vi.fn(async () => undefined) };
  function context(approved: Effect[] = []) {
    return {
      deps: {
        prisma,
        connector,
        events: { append: vi.fn(async () => undefined), pauseRunForInput: pause },
        jobs: { enqueue: vi.fn() },
      },
      run: {
        id: "run",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        threadId: "thread",
        trigger: "routine",
      },
      runId: "run",
      workerId: "worker",
      fence: 1,
      attempt: { id: "attempt" },
      bot: { id: "bot", name: "Bot" },
      thread: { id: "thread" },
      context: {
        spaceId: "space",
        userId: "user",
        botId: "bot",
        signal: new AbortController().signal,
      },
      secrets: [],
      source: { ownerStartedRun: true },
      tools: {
        connector: new Map([[tool.name, { ...tool }]]),
        disabled: new Set(),
        connectedPlugins: [],
        approvedReplays: createApprovedEffectReplayQueue(approved),
      },
      trust: {
        loadApprovalRules: async () => rules,
        loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals }),
        loadTrustedConnectors: async () => new Set(),
        receivedOutsideMessage: async () => false,
        searchResultUrls: new Set(),
      },
      state: {
        tainted: false,
        approval: { pausePending: false },
        effects: {
          counts: new Map(),
          occurrences: [],
          consumedIds: new Set(),
          pendingTurnCheckpoints: new Map(),
          storedTurnCheckpoint: false,
        },
      },
      computer: { checkpoint: { flush: async () => {} } },
      settleRunningHelpers: async () => {},
    } as never;
  }
  return { effects, pause, context };
}

describe("scheduled source authorization", () => {
  it("honors a deny rule even in Never ask", async () => {
    const f = fixture([{ effect: "deny", matchKind: "tool", matchValue: tool.name }], true);
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("denied");
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(0);
  });
  it("pauses for approval and resumes the bound request once", async () => {
    const f = fixture([{ effect: "require_approval", matchKind: "tool", matchValue: tool.name }]);
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("paused");
    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.effects).toHaveLength(1);
    f.effects[0]!.status = "approved";
    const resumed = await authorizeSetupSource(f.context(f.effects), source);
    expect(resumed.admission.state).toBe("allowed");
    expect(resumed.consumedApprovalKey).toBe(f.effects[0]!.idempotencyKey);
    if (resumed.admission.state === "allowed")
      expect(await resumed.admission.finish("succeeded")).toBe(true);
    expect(f.effects[0]!.status).toBe("completed");
    expect(f.effects[0]!.result).toEqual({ state: "succeeded" });
  });
  it("honors rejection on resume without asking again", async () => {
    const f = fixture([{ effect: "require_approval", matchKind: "tool", matchValue: tool.name }]);
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("paused");
    f.effects[0]!.status = "denied";
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("denied");
    expect(f.pause).toHaveBeenCalledOnce();
  });
  it("uses Never ask for an ask rule", async () => {
    const f = fixture(
      [{ effect: "require_approval", matchKind: "tool", matchValue: tool.name }],
      true,
    );
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("allowed");
    expect(f.pause).not.toHaveBeenCalled();
  });
  it("treats an interrupted gate claim as uncertain instead of redispatching", async () => {
    const f = fixture([], true);
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("allowed");
    expect(f.effects[0]!.status).toBe("executing");
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("uncertain");
    expect(f.effects[0]!.status).toBe("uncertain");
  });
  it("does not infer source success from an already-completed gate effect", async () => {
    const f = fixture([], true);
    const first = await authorizeSetupSource(f.context(), source);
    expect(first.admission.state).toBe("allowed");
    if (first.admission.state === "allowed") await first.admission.finish("succeeded");
    expect(f.effects[0]!.status).toBe("completed");
    expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("uncertain");
  });
  it.each([
    { readOnly: false },
    { readOnly: undefined },
    { batch: { items: "items", action: "action", arguments: "args" } },
  ])("rejects metadata drift: %s", async (change) => {
    const f = fixture();
    const ctx = f.context() as any;
    ctx.tools.connector.set(tool.name, { ...tool, ...change });
    expect((await authorizeSetupSource(ctx, source)).admission.state).toBe("denied");
    expect(f.effects).toHaveLength(0);
  });
  it("does not consume an unrelated approved effect", async () => {
    const f = fixture();
    const unrelated = {
      id: "other",
      runId: "run",
      spaceId: "space",
      kind: "other_tool",
      idempotencyKey: "other-key",
      status: "approved",
      request: {},
    };
    const ctx = f.context([unrelated]) as any;
    expect((await authorizeSetupSource(ctx, source)).admission.state).toBe("denied");
    expect(ctx.tools.approvedReplays.nextToolName()).toBe("other_tool");
  });
  it.each(["arguments", "revision", "tool"] as const)(
    "does not dispatch or consume approval after the selected %s changes",
    async (change) => {
      const f = fixture([{ effect: "require_approval", matchKind: "tool", matchValue: tool.name }]);
      expect((await authorizeSetupSource(f.context(), source)).admission.state).toBe("paused");
      f.effects[0]!.status = "approved";
      const ctx = f.context(f.effects) as any;
      const selected = { ...source, args: { ...source.args } };
      if (change === "arguments") selected.args.query = "different";
      if (change === "revision") {
        selected.revision = 2;
        ctx.tools.connector.set(tool.name, {
          ...tool,
          route: { ...tool.route, resourceRevision: 2 },
        });
      }
      if (change === "tool") {
        selected.toolName = "other";
        ctx.tools.connector.set("mcp__mail__other", {
          ...tool,
          name: "mcp__mail__other",
          route: { ...tool.route, toolName: "other" },
        });
      }
      const decision = await authorizeSetupSource(ctx, selected);
      expect(decision.admission.state).toBe("denied");
      expect(ctx.tools.approvedReplays.nextIdempotencyKey()).toBe(f.effects[0]!.idempotencyKey);
      expect(f.effects[0]!.status).toBe("approved");
    },
  );
});
