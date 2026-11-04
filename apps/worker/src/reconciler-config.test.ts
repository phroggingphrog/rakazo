import { describe, expect, it } from "vitest";
import { workerReconcilerOptions } from "./reconciler-config.js";

describe("worker reconciliation configuration", () => {
  it("passes the startup hold through to the worker reconciler", () => {
    expect(workerReconcilerOptions({})).toEqual({ mcpContinuationScanEnabled: true });
    expect(workerReconcilerOptions({ MCP_APPROVAL_CONTINUATION_SCAN_ENABLED: "false" })).toEqual({
      mcpContinuationScanEnabled: false,
    });
    expect(() =>
      workerReconcilerOptions({ MCP_APPROVAL_CONTINUATION_SCAN_ENABLED: "off" }),
    ).toThrow("MCP_APPROVAL_CONTINUATION_SCAN_ENABLED");
  });
});
