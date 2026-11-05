import type { ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { boundDirectApprovalDetails, isApprovalPausedResult } from "./approval-effect.js";
import type { RunContext } from "./run-context.js";
import { CATALOG_APPROVAL_TOOL } from "./run-effects.js";
import { auditToolCall, gateToolCall } from "./run-tool-gate.js";
import { resolveToolRequest } from "./run-tool-request.js";
import type { SourceAdmission } from "./setup-source-test.js";

type SelectedSource = {
  serverId: string;
  serverSlug: string;
  revision: number;
  toolName: string;
  args: Record<string, unknown>;
  executionId: string;
};

function sameRoute(tool: ConnectorTool, source: SelectedSource): boolean {
  return (
    tool.route?.connectorId === "mcp" &&
    tool.route.resourceId === source.serverId &&
    tool.route.resourceRevision === source.revision &&
    tool.route.toolName === source.toolName
  );
}

/** Apply the ordinary connector gate to the exact source and arguments of this run. */
export async function authorizeSetupSource(
  ctx: RunContext,
  source: SelectedSource,
): Promise<{ admission: SourceAdmission; consumedApprovalKey?: string }> {
  const connector = ctx.deps.connector;
  if (!connector) return { admission: { state: "denied" } };
  let tool = [...ctx.tools.connector.values()].find((candidate) => sameRoute(candidate, source));
  if (!tool && connector.resolveCall) {
    const call: ConnectorCall = {
      tool: `mcp__${source.serverSlug}__${source.toolName}`,
      args: source.args,
      executionId: source.executionId,
    };
    const resolved = await connector.resolveCall(call, ctx.context);
    if (resolved && sameRoute(resolved.tool, source)) tool = resolved.tool;
  }
  if (tool?.readOnly !== true || tool.batch || ctx.tools.disabled.has(tool.name))
    return { admission: { state: "denied" } };
  const scoped = {
    ...ctx,
    tools: { ...ctx.tools, connector: new Map(ctx.tools.connector).set(tool.name, tool) },
  };
  const pending = boundDirectApprovalDetails(
    ctx.tools.approvedReplays.nextRequest(),
    CATALOG_APPROVAL_TOOL,
  );
  if (pending && stableJsonValue(pending.args) !== stableJsonValue(source.args))
    return { admission: { state: "denied" } };
  const previousKey = ctx.tools.approvedReplays.nextIdempotencyKey();
  const request = await resolveToolRequest(scoped, tool.name, source.args, source.executionId);
  const consumedApprovalKey =
    previousKey && previousKey !== ctx.tools.approvedReplays.nextIdempotencyKey()
      ? previousKey
      : undefined;
  if (
    "error" in request ||
    request.connectorCall.route?.connectorId !== "mcp" ||
    request.connectorCall.route.resourceId !== source.serverId ||
    request.connectorCall.route.resourceRevision !== source.revision ||
    request.connectorCall.route.toolName !== source.toolName ||
    stableJsonValue(request.args) !== stableJsonValue(source.args)
  ) {
    return { admission: { state: "denied" }, consumedApprovalKey };
  }
  const gated = await gateToolCall(scoped, request, undefined);
  if ("result" in gated) {
    if (isApprovalPausedResult(gated.result))
      return { admission: { state: "paused" }, consumedApprovalKey };
    const denied = Boolean(
      gated.result &&
        typeof gated.result === "object" &&
        "error" in gated.result &&
        !("uncertain" in gated.result),
    );
    return { admission: { state: denied ? "denied" : "uncertain" }, consumedApprovalKey };
  }
  const call = gated.call;
  if (call.applied && !call.claimedEffect) {
    const earlier = await call.claimOrReturn("intended");
    if (earlier !== undefined) return { admission: { state: "uncertain" }, consumedApprovalKey };
  }
  return {
    admission: {
      state: "allowed",
      finish: async (outcome) => {
        const saved = await call.persistEffectResult({ state: outcome });
        if (call.applied)
          await auditToolCall(scoped, call.name, outcome === "succeeded" ? "success" : "failure", {
            effectId: call.applied.effect.id,
            autoApproved: call.bypassApproval,
          });
        return saved;
      },
    },
    consumedApprovalKey,
  };
}
