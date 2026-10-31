import { describe, expect, it } from "vitest";
import { planToolEscalation, toolEscalationConfig } from "./tool-escalation-policy.js";
import type { NoProgressEvidence } from "./tool-progress.js";

const evidence: NoProgressEvidence = {
  code: "repeated_equivalent_failure",
  toolName: "read",
  failureClass: "transient",
  failedAttempts: 2,
  recoveryStep: "Check service health",
};
const eligible = {
  catalogContainsExactModel: true,
  authenticatedConnection: true,
  connectionAllowsExactModel: true,
  supportsLowReasoning: true,
  ownerApproved: true,
  monetaryPolicy: "uncapped" as const,
};
const signal = new AbortController().signal;
describe("owner-selected Sol low escalation plan", () => {
  it("requires verified no progress", () =>
    expect(planToolEscalation(undefined, eligible, 0, signal).enabled).toBe(false));
  it("does not escalate permission failures", () =>
    expect(
      planToolEscalation({ ...evidence, failureClass: "nontransient" }, eligible, 0, signal)
        .enabled,
    ).toBe(false));
  it("requires the exact connection grant and an explicit monetary policy", () => {
    expect(
      planToolEscalation(evidence, { ...eligible, connectionAllowsExactModel: false }, 0, signal)
        .enabled,
    ).toBe(false);
    expect(
      planToolEscalation(evidence, { ...eligible, monetaryPolicy: "capped", maxCostUsd: undefined }, 0, signal).enabled,
    ).toBe(false);
    expect(
      planToolEscalation(evidence, { ...eligible, monetaryPolicy: "capped", maxCostUsd: 2 }, 0, signal),
    ).toMatchObject({ enabled: true, monetaryPolicy: "capped", maxCostUsd: 2 });
  });
  it("plans exactly 1 bounded attempt without changing permissions", () => {
    expect(planToolEscalation(evidence, eligible, 0, signal)).toMatchObject({
      enabled: true,
      target: { modelId: "openai/sol", thinkingLevel: "low" },
      maxAttempts: 1,
      maxOutputTokens: 2048,
      monetaryPolicy: "uncapped",
      preserveToolGrants: true,
      preserveApprovals: true,
    });
    expect(planToolEscalation(evidence, eligible, 1, signal).enabled).toBe(false);
  });
  it("requires explicit opt-in configuration and supports uncapped policy", () => {
    expect(toolEscalationConfig({})).toBeUndefined();
    expect(toolEscalationConfig({
      TOOL_NO_PROGRESS_ESCALATION_MODEL: "openai/sol",
      TOOL_NO_PROGRESS_ESCALATION_PROVIDER: "openai-compatible",
      TOOL_NO_PROGRESS_ESCALATION_THINKING: "low",
      TOOL_NO_PROGRESS_ESCALATION_MONETARY_POLICY: "uncapped",
    })).toMatchObject({ monetaryPolicy: "uncapped", target: { modelId: "openai/sol" } });
  });
  it("preserves cancellation", () => {
    const c = new AbortController();
    c.abort();
    expect(() => planToolEscalation(evidence, eligible, 0, c.signal)).toThrow();
  });
});
