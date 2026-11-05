import type { ConnectorRoute } from "@rakazo/adapter-kit";
import { WorkspaceMonitorSchema } from "@rakazo/contracts";

/** Bind evidence to the specific MCP operation and server settings revision. */
export function monitorSourceEvidence(source: {
  connectorId: string;
  resourceId: string;
  resourceRevision: number;
  toolName: string;
}): string {
  return JSON.stringify([
    "monitor-source-read-success-v2",
    source.connectorId,
    source.resourceId,
    source.resourceRevision,
    source.toolName,
  ]);
}

export function evidenceForMonitorCall(
  monitor: unknown,
  route: ConnectorRoute | undefined,
  batch: boolean,
): string | undefined {
  const source = WorkspaceMonitorSchema.safeParse(monitor).data?.source;
  if (
    !source ||
    batch ||
    route?.connectorId !== source.connectorId ||
    route.resourceId !== source.resourceId ||
    route.resourceRevision !== source.resourceRevision ||
    route.toolName !== source.toolName
  )
    return undefined;
  return monitorSourceEvidence(source);
}

export function explicitMonitorError(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("isError" in result && result.isError === true) return true;
  if (
    "error" in result &&
    result.error !== undefined &&
    result.error !== null &&
    result.error !== false &&
    result.error !== ""
  )
    return true;
  return "kind" in result && result.kind === "agent_tool_result" && "details" in result
    ? explicitMonitorError(result.details)
    : false;
}

/** Record only after the actual handler result and its effect state were persisted. */
export async function persistMonitorReadEvidence(
  result: unknown,
  persist: () => Promise<boolean>,
  record: () => Promise<unknown>,
): Promise<boolean> {
  const persisted = await persist();
  if (persisted && result !== undefined && !explicitMonitorError(result)) await record();
  return persisted;
}
