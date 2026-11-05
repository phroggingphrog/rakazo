import { expect, it } from "vitest";
import { diagnosticExecutionResult, freshDiscoveryHealth } from "./mcp-diagnostic-health.js";

it("accepts only fresh same revision successful discovery", () => {
  const start = new Date("2026-11-04T00:00:00Z");
  const good = { healthStatus: "ok", revision: 2, healthCheckedAt: start };
  expect(freshDiscoveryHealth(good, 2, start)).toBe(true);
  for (const health of [
    null,
    { ...good, revision: 1 },
    { ...good, healthStatus: "error" },
    { ...good, healthCheckedAt: null },
    { ...good, healthCheckedAt: new Date(start.getTime() - 1) },
  ])
    expect(freshDiscoveryHealth(health, 2, start)).toBe(false);
});

it("does not report a failed or absent tool result as a successful execution", () => {
  expect(diagnosticExecutionResult([])).toEqual({ code: "execution_failed", result: false });
  expect(diagnosticExecutionResult([{ type: "error", message: "failed" }])).toEqual({
    code: "execution_failed",
    result: false,
  });
  for (const data of [
    { isError: true },
    { ok: false },
    { error: "failed" },
    { structuredContent: { ok: false } },
  ])
    expect(diagnosticExecutionResult([{ type: "result", data }]).code).toBe("execution_failed");
  expect(diagnosticExecutionResult([{ type: "result", data: { content: [] } }])).toEqual({
    code: "read_only_execution_checked",
    result: true,
  });
});
