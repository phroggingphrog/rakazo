import type {
  AdapterContext,
  ConnectedConnector,
  ConnectorCall,
  ManagedConnectorProvider,
  PipedreamAccountBinding,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  pipedreamAccountBinding,
} from "./approval-effect.js";
import { prepareManagedConnectorForTransaction } from "./integration-provider-settings.js";
import { retireChangedPipedreamApproval } from "./mcp-effect-claim.js";
import type { RunContext } from "./run-context.js";
import { CATALOG_APPROVAL_TOOL } from "./run-effects.js";

export type PreparedPipedreamBinding = {
  binding: PipedreamAccountBinding;
  account: ConnectedConnector;
  provider: ManagedConnectorProvider;
  recheck: (tx: Prisma.TransactionClient) => Promise<boolean>;
};

type Row = {
  id: string;
  providerRef: string | null;
  displayName: string;
  generation: string;
};

type PreparationContext = Pick<RunContext, "context"> & {
  run: Pick<RunContext["run"], "spaceId" | "userId">;
  deps: Pick<RunContext["deps"], "prisma" | "connectors">;
};

/** Capture a fresh owner-scoped local account and pin the provider configuration. */
export async function preparePipedreamBinding(
  ctx: PreparationContext,
  call: ConnectorCall,
  args: Record<string, unknown>,
  previous?: PipedreamAccountBinding,
): Promise<PreparedPipedreamBinding | undefined> {
  const app = call.route?.resourceId;
  const selector = call.route?.pipedreamAccountSelector;
  if (!app || selector === undefined || call.route?.pipedreamAccountSelectorUnsupported)
    return undefined;
  const connector = ctx.deps.connectors?.managed("pipedream");
  if (!connector) return undefined;
  const before = await ctx.deps.prisma.$queryRaw<Array<{ epoch: string }>>`
    SELECT epoch::text AS epoch FROM integration_provider_epochs WHERE "providerId" = 'pipedream'`;
  const prepared = await prepareManagedConnectorForTransaction(connector);
  const after = await ctx.deps.prisma.$queryRaw<Array<{ epoch: string }>>`
    SELECT epoch::text AS epoch FROM integration_provider_epochs WHERE "providerId" = 'pipedream'`;
  const providerEpoch = before[0]?.epoch;
  if (
    !providerEpoch ||
    after[0]?.epoch !== providerEpoch ||
    (previous && previous.providerEpoch !== providerEpoch)
  )
    return undefined;
  const provider = prepared.provider;
  if (!provider?.pipedreamAccountNamespace) return undefined;
  const namespace = await provider.pipedreamAccountNamespace(ctx.context);
  if (!/^[a-f0-9]{64}$/.test(namespace) || (previous && previous.namespace !== namespace))
    return undefined;
  const rows = await ctx.deps.prisma.$queryRaw<Row[]>`
    SELECT id, "providerRef", "displayName", "accountGeneration"::text AS generation
    FROM connections WHERE "spaceId" = ${ctx.run.spaceId} AND "userId" = ${ctx.run.userId}
      AND "connectorId" = 'pipedream' AND provider = ${app} AND status = 'connected'
    ORDER BY id`;
  const accounts = rows.filter((row) => row.providerRef && row.providerRef.trim() !== app);
  const distinctRefs = new Set(accounts.map((row) => row.providerRef?.trim()));
  const chosen = previous
    ? accounts.find(
        (row) => row.id === previous.connectionId && row.generation === previous.generation,
      )
    : typeof selector === "string"
      ? accounts.find((row) => row.id === args[selector])
      : distinctRefs.size === 1
        ? accounts.find((row) => row.id === call.route?.pipedreamSingletonConnectionId)
        : undefined;
  if (!chosen || (typeof selector === "string" && args[selector] !== chosen.id)) return undefined;
  const binding: PipedreamAccountBinding = {
    version: 1,
    connectionId: chosen.id,
    generation: chosen.generation,
    namespace,
    providerEpoch,
  };
  const account: ConnectedConnector = {
    id: chosen.id,
    connectorId: "pipedream",
    externalId: app,
    displayName: chosen.displayName,
    providerRef: chosen.providerRef ?? undefined,
  };
  return {
    binding,
    account,
    provider,
    recheck: async (tx) => {
      const epochs = await tx.$queryRaw<Array<{ epoch: string }>>`
        SELECT epoch::text AS epoch FROM integration_provider_epochs
        WHERE "providerId" = 'pipedream' FOR SHARE`;
      if (epochs[0]?.epoch !== binding.providerEpoch) return false;
      if (prepared.recheck && !(await prepared.recheck(tx))) return false;
      const current = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM connections WHERE id = ${binding.connectionId}
          AND "spaceId" = ${ctx.run.spaceId} AND "userId" = ${ctx.run.userId}
          AND "connectorId" = 'pipedream' AND provider = ${app} AND status = 'connected'
          AND "accountGeneration"::text = ${binding.generation} FOR SHARE`;
      return current.length === 1;
    },
  };
}

/** Prepare an explicitly selected account without using provider arguments as a selector. */
export function preparePipedreamAccount(input: {
  prisma: PrismaClient;
  connector: ManagedConnectorProvider;
  context: AdapterContext;
  app: string;
  connectionId: string;
  previous?: PipedreamAccountBinding;
}): Promise<PreparedPipedreamBinding | undefined> {
  if (
    !input.app ||
    !input.connectionId ||
    (input.previous && input.previous.connectionId !== input.connectionId)
  )
    return Promise.resolve(undefined);
  const selector = "__rakazo_selected_connection";
  const args = { [selector]: input.connectionId };
  return preparePipedreamBinding(
    {
      context: input.context,
      run: { spaceId: input.context.spaceId, userId: input.context.userId },
      deps: {
        prisma: input.prisma,
        connectors: { managed: (id) => (id === "pipedream" ? input.connector : undefined) },
      },
    },
    {
      tool: "",
      executionId: "",
      args,
      route: {
        connectorId: "pipedream",
        resourceId: input.app,
        toolName: "",
        pipedreamAccountSelector: selector,
      },
    },
    args,
    input.previous,
  );
}

export async function retireUnavailablePipedreamApproval(
  ctx: RunContext,
  app: string,
  idempotencyKey: string,
  binding: PipedreamAccountBinding,
  expectedRequest: unknown,
): Promise<boolean> {
  return retireChangedPipedreamApproval(
    ctx.deps,
    ctx.run,
    idempotencyKey,
    expectedRequest,
    async (tx, request) => {
      const route =
        boundDirectApprovalDetails(request, CATALOG_APPROVAL_TOOL)?.route ??
        catalogApprovalDetails(request, CATALOG_APPROVAL_TOOL)?.route;
      const stored = pipedreamAccountBinding(route?.pipedreamAccountBinding);
      if (
        !stored ||
        route?.connectorId !== "pipedream" ||
        route.resourceId !== app ||
        stored.connectionId !== binding.connectionId ||
        stored.generation !== binding.generation ||
        stored.namespace !== binding.namespace ||
        stored.providerEpoch !== binding.providerEpoch
      )
        return false;
      const epochs = await tx.$queryRaw<Array<{ epoch: string }>>`
      SELECT epoch::text AS epoch FROM integration_provider_epochs
      WHERE "providerId" = 'pipedream' FOR SHARE`;
      if (epochs.length !== 1) return false;
      if (epochs[0]?.epoch !== binding.providerEpoch) return true;
      const current = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM connections WHERE id = ${binding.connectionId}
        AND "spaceId" = ${ctx.run.spaceId} AND "userId" = ${ctx.run.userId}
        AND "connectorId" = 'pipedream' AND provider = ${app} AND status = 'connected'
        AND "accountGeneration"::text = ${binding.generation} FOR SHARE`;
      return current.length === 0;
    },
  );
}

/** Lock the saved effect and verify it still names the same account before claim or settlement. */
export async function recheckPipedreamEffect(
  tx: Prisma.TransactionClient,
  effectId: string,
  selection: PreparedPipedreamBinding,
): Promise<boolean> {
  if (!(await selection.recheck(tx))) return false;
  const rows = await tx.$queryRaw<Array<{ request: unknown }>>`
    SELECT request FROM external_effects WHERE id = ${effectId} FOR UPDATE`;
  if (rows.length !== 1) return false;
  const route =
    boundDirectApprovalDetails(rows[0]?.request, CATALOG_APPROVAL_TOOL)?.route ??
    catalogApprovalDetails(rows[0]?.request, CATALOG_APPROVAL_TOOL)?.route;
  const stored = pipedreamAccountBinding(route?.pipedreamAccountBinding);
  return Boolean(
    stored &&
      stored.connectionId === selection.binding.connectionId &&
      stored.generation === selection.binding.generation &&
      stored.namespace === selection.binding.namespace &&
      stored.providerEpoch === selection.binding.providerEpoch,
  );
}
