import type { RpcInput, RpcOutput } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import * as SecureStore from "expo-secure-store";
import { captureApiRequestContext, rpc, spaceSelectionSeq } from "./api";
import { routineScope } from "./routine-store";

export type MonitorDraft = RpcInput<"setupPlans/create">["draft"];
export type MonitorPlan = RpcOutput<"setupPlans/get">;

const PENDING_KEY = "rakazo.email-monitor.pending-create";
type Pending = { scope: string; requestKey: string };
let pendingWrites: Promise<unknown> = Promise.resolve();

function withPendingLock<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingWrites.then(task, task);
  pendingWrites = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readPending(): Promise<Pending[]> {
  const value = await SecureStore.getItemAsync(PENDING_KEY);
  if (!value) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(value);
  } catch {
    throw new Error("Could not safely recover the previous draft save.");
  }
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        typeof row.scope !== "string" ||
        typeof row.requestKey !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.requestKey,
        ),
    )
  ) {
    throw new Error("Could not safely recover the previous draft save.");
  }
  return rows as Pending[];
}

async function reserveCreate(scope: string): Promise<string> {
  return withPendingLock(async () => {
    const rows = await readPending();
    const existing = rows.find((row) => row.scope === scope);
    if (existing) return existing.requestKey;
    if (rows.length >= 50)
      throw new Error("Resolve an earlier draft save before creating another.");
    const requestKey = newClientId();
    await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify([...rows, { scope, requestKey }]));
    return requestKey;
  });
}

async function finishCreate(scope: string, key: string): Promise<void> {
  await withPendingLock(async () => {
    const rows = await readPending();
    await SecureStore.setItemAsync(
      PENDING_KEY,
      JSON.stringify(rows.filter((row) => row.scope !== scope || row.requestKey !== key)),
    );
  });
}

/** Pins this sheet's requests to the bot, selected space, server and authenticated session. */
export async function openMonitorSetup(botId: string) {
  const startScope = routineScope(botId);
  const selection = spaceSelectionSeq();
  const context = await captureApiRequestContext();
  const current = () => routineScope(botId) === startScope && spaceSelectionSeq() === selection;
  const assertCurrent = () => {
    if (!current()) throw new Error("The account or space changed. Open setup again.");
  };
  assertCurrent();
  const me = await rpc("me", {}, { requestContext: context });
  assertCurrent();
  const selectedSpace = context.headers["x-rakazo-space-id"];
  if (selectedSpace && me.spaceId !== selectedSpace)
    throw new Error("The account or space changed. Open setup again.");
  const saveScope = JSON.stringify([context.apiBase, me.userId, me.spaceId, botId]);
  const options = { requestContext: context };

  return {
    current,
    async load(cursor?: string) {
      assertCurrent();
      const [servers, result] = await Promise.all([
        rpc("mcp/servers/list", {}, options),
        rpc("setupPlans/list", { limit: 100, ...(cursor ? { cursor } : {}) }, options),
      ]);
      assertCurrent();
      return {
        servers: servers.filter((server) => server.enabled),
        plans: result.plans.filter((plan) => plan.draft.botId === botId),
        nextCursor: result.nextCursor,
      };
    },
    async discover(serverId: string) {
      assertCurrent();
      const result = await rpc("setupPlans/previewReads", { serverId, botId }, options);
      assertCurrent();
      return result;
    },
    async grantRead(serverId: string, revision: number, toolName: string) {
      assertCurrent();
      const result = await rpc(
        "setupPlans/grantRead",
        { serverId, botId, revision, toolName },
        options,
      );
      assertCurrent();
      return result;
    },
    async save(draft: MonitorDraft, plan: MonitorPlan | null) {
      assertCurrent();
      if (plan) {
        const result = await rpc(
          "setupPlans/update",
          {
            id: plan.id,
            expectedRevision: plan.revision,
            draft,
          },
          options,
        );
        assertCurrent();
        return result;
      }
      const requestKey = await reserveCreate(saveScope);
      assertCurrent();
      const result = await rpc("setupPlans/create", { requestKey, draft }, options);
      assertCurrent();
      // A cleanup failure must not turn a confirmed save into a claimed failure.
      await finishCreate(saveScope, requestKey).catch(() => undefined);
      return result;
    },
    async prerequisites(plan: MonitorPlan) {
      assertCurrent();
      const result = await rpc(
        "setupPlans/prerequisites",
        {
          id: plan.id,
          expectedRevision: plan.revision,
        },
        options,
      );
      assertCurrent();
      return result;
    },
    async candidates(plan: MonitorPlan) {
      assertCurrent();
      const result = await rpc(
        "setupPlans/discoverCandidates",
        {
          id: plan.id,
          expectedRevision: plan.revision,
        },
        options,
      );
      assertCurrent();
      return result;
    },
    async propose(plan: MonitorPlan) {
      assertCurrent();
      const result = await rpc(
        "setupPlans/propose",
        {
          id: plan.id,
          expectedRevision: plan.revision,
        },
        options,
      );
      assertCurrent();
      return result;
    },
    async configure(plan: MonitorPlan) {
      assertCurrent();
      const configureScope = JSON.stringify([saveScope, "configure", plan.id, plan.revision]);
      const requestKey = await reserveCreate(configureScope);
      assertCurrent();
      const result = await rpc(
        "setupPlans/configure",
        {
          id: plan.id,
          expectedRevision: plan.revision,
          requestKey,
        },
        options,
      );
      assertCurrent();
      await finishCreate(configureScope, requestKey).catch(() => undefined);
      return result;
    },
    async runTest(plan: MonitorPlan) {
      assertCurrent();
      if (!plan.routineId) throw new Error("The routine is unavailable.");
      const scope = JSON.stringify([saveScope, "run-test", plan.id, plan.revision]);
      const clientNonce = await reserveCreate(scope);
      assertCurrent();
      const result = await rpc(
        "routines/testRun",
        { routineId: plan.routineId, clientNonce },
        options,
      );
      assertCurrent();
      await finishCreate(scope, clientNonce).catch(() => undefined);
      return result;
    },
    async testStatus(plan: MonitorPlan, runId: string) {
      assertCurrent();
      if (!plan.routineId) throw new Error("The routine is unavailable.");
      const history = await rpc(
        "routines/history",
        { routineId: plan.routineId, limit: 20 },
        options,
      );
      assertCurrent();
      const run = history.runs.find((item) => item.id === runId);
      return {
        runStatus: run?.status ?? "unknown",
        sourceTest: run?.sourceUnbound
          ? ("unbound" as const)
          : (run?.sourceTest ?? ("unavailable" as const)),
      };
    },
    async latestSourceTest(plan: MonitorPlan) {
      assertCurrent();
      if (!plan.routineId) throw new Error("The routine is unavailable.");
      const history = await rpc(
        "routines/history",
        { routineId: plan.routineId, limit: 20 },
        options,
      );
      assertCurrent();
      const run = history.runs.find((item) => item.sourceTest !== undefined);
      return run?.sourceTest === undefined
        ? null
        : {
            runId: run.id,
            runStatus: run.status,
            sourceTest: run.sourceUnbound ? ("unbound" as const) : run.sourceTest,
          };
    },
    async routineState(plan: MonitorPlan) {
      assertCurrent();
      if (!plan.routineId) throw new Error("The routine is unavailable.");
      const routines = await rpc("routines/list", { botId }, options);
      assertCurrent();
      const routine = routines.find((item) => item.id === plan.routineId);
      if (!routine) throw new Error("The routine is unavailable.");
      return routine.active;
    },
    async setRoutineActive(plan: MonitorPlan, active: boolean) {
      assertCurrent();
      if (!plan.routineId) throw new Error("The routine is unavailable.");
      const routine = await rpc("routines/update", { routineId: plan.routineId, active }, options);
      assertCurrent();
      return routine.active;
    },
  };
}

export type MonitorSetupSession = Awaited<ReturnType<typeof openMonitorSetup>>;
