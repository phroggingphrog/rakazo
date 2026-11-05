import type { ConnectorEvent } from "@rakazo/adapter-kit";

function resultIsError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (
    result.isError === true ||
    result.ok === false ||
    (result.error !== undefined &&
      result.error !== null &&
      result.error !== false &&
      result.error !== "")
  )
    return true;
  const structured = result.structuredContent;
  return !!structured && typeof structured === "object" && resultIsError(structured);
}

export function diagnosticExecutionResult(events: ConnectorEvent[]): {
  code: "execution_failed" | "read_only_execution_checked";
  result: boolean;
} {
  const results = events.filter((event) => event.type === "result");
  const failed =
    !results.length ||
    events.some((event) => event.type === "error") ||
    results.some((event) => resultIsError(event.data));
  return {
    code: failed ? "execution_failed" : "read_only_execution_checked",
    result: results.length > 0,
  };
}

export function freshDiscoveryHealth(
  health: { healthStatus: string; healthCheckedAt: Date | null; revision: number } | null,
  revision: number,
  startedAt: Date,
): boolean {
  return (
    health?.healthStatus === "ok" &&
    health.revision === revision &&
    health.healthCheckedAt != null &&
    health.healthCheckedAt >= startedAt
  );
}
