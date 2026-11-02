export type McpFailureKind =
  | "authentication"
  | "authorization"
  | "missing_assignment"
  | "unreachable_host"
  | "timeout"
  | "unsupported_transport"
  | "configuration"
  | "provider_error"
  | "output_limit";
/** Classify sanitized messages only. Never include credentials or endpoint paths in recovery text. */
export function mcpFailureReason(message: string): { kind: McpFailureKind; recovery: string } {
  if (/not assigned|missing assignment/i.test(message))
    return {
      kind: "missing_assignment",
      recovery:
        "Ask the owner to grant this MCP server to this bot. Do not change grants automatically.",
    };
  if (
    /401|unauthorized|invalid.token|authorization expired|oauth.*expired|credential.*missing/i.test(
      message,
    )
  )
    return {
      kind: "authentication",
      recovery:
        "Repair this server's saved credential or reconnect its authorization. Retrying the same call cannot repair it.",
    };
  if (/403|forbidden|permission denied|not authorized|allowlist|isn.t allowed/i.test(message))
    return {
      kind: "authorization",
      recovery:
        "Check the bot grant and deployment command policy. Ask the owner for the specific missing permission.",
    };
  if (/ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|fetch failed/i.test(message))
    return {
      kind: "unreachable_host",
      recovery:
        "Check DNS and the endpoint from both API and worker containers. Container localhost is not host localhost.",
    };
  if (/timeout|timed out|deadline/i.test(message))
    return {
      kind: "timeout",
      recovery:
        "Check server health and execution time before 1 bounded retry. Do not repeat mutating calls with an uncertain outcome.",
    };
  if (/unsupported.*transport|method not allowed|405|content.type/i.test(message))
    return {
      kind: "unsupported_transport",
      recovery: "Select the transport supported by the MCP endpoint and verify its URL.",
    };
  if (/output.*limit|result.*large|payload.*large/i.test(message))
    return {
      kind: "output_limit",
      recovery:
        "Use bounded pagination or the authorized full-result receipt. Do not retry the same oversized request.",
    };
  if (/client.*required|dynamic client registration|not configured|stdio.*available/i.test(message))
    return {
      kind: "configuration",
      recovery:
        "Correct this server's OAuth client or STDIO deployment configuration before retrying.",
    };
  return {
    kind: "provider_error",
    recovery:
      "Inspect the sanitized server error. Retry only if the failure is transient and the previous call has no uncertain side effect.",
  };
}
export function actionableMcpFailure(message: string): string {
  const { kind, recovery } = mcpFailureReason(message);
  return `[${kind}] ${message}\nRecovery: ${recovery}`;
}
