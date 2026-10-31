import { describe, expect, it } from "vitest";
import { planToolEscalation } from "./tool-escalation-policy.js";
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
  maxCostUsd: 0.1,
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
  it("requires the exact connection grant and cost limit", () => {
    expect(
      planToolEscalation(evidence, { ...eligible, connectionAllowsExactModel: false }, 0, signal)
        .enabled,
    ).toBe(false);
    expect(
      planToolEscalation(evidence, { ...eligible, maxCostUsd: undefined }, 0, signal).enabled,
    ).toBe(false);
  });
  it("plans exactly 1 bounded attempt without changing permissions", () => {
    expect(planToolEscalation(evidence, eligible, 0, signal)).toMatchObject({
      enabled: true,
      target: { modelId: "openai/sol", thinkingLevel: "low" },
      maxAttempts: 1,
      preserveToolGrants: true,
      preserveApprovals: true,
    });
    expect(planToolEscalation(evidence, eligible, 1, signal).enabled).toBe(false);
  });
  it("preserves cancellation", () => {
    const c = new AbortController();
    c.abort();
    expect(() => planToolEscalation(evidence, eligible, 0, c.signal)).toThrow();
  });
});
