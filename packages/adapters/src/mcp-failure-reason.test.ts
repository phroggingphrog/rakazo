import { expect, it } from "vitest";
import { actionableMcpFailure, mcpFailureReason } from "./mcp-failure-reason.js";

it.each([
  ["Unauthorized 401", "authentication"],
  ["permission denied", "authorization"],
  ["MCP tool is not assigned to this bot", "missing_assignment"],
  ["ECONNREFUSED", "unreachable_host"],
  ["request timed out", "timeout"],
  ["405 method not allowed", "unsupported_transport"],
  ["dynamic client registration unsupported", "configuration"],
  ["output limit exceeded", "output_limit"],
  ["provider internal error", "provider_error"],
])("classifies %s", (message, kind) => expect(mcpFailureReason(message).kind).toBe(kind));
it("does not add private endpoint or credential information", () => {
  const result = actionableMcpFailure("[REDACTED]");
  expect(result).toContain("Recovery:");
  expect(result).not.toContain("Bearer");
});
