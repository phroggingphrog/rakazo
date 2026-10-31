import type { NoProgressEvidence } from "./tool-progress.js";

/** Owner-selected target. Never substitute a provider or a model. */
export const SOL_LOW_TARGET = {
  provider: "openai-compatible",
  modelId: "openai/sol",
  thinkingLevel: "low",
} as const;
export interface EscalationEligibility {
  catalogContainsExactModel: boolean;
  authenticatedConnection: boolean;
  connectionAllowsExactModel: boolean;
  supportsLowReasoning: boolean;
  ownerApproved: boolean;
  maxCostUsd?: number;
}
/** A plan is not permission to execute. The runtime must retain the same tool grants. */
export function planToolEscalation(
  evidence: NoProgressEvidence | undefined,
  eligibility: EscalationEligibility,
  attempts: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!evidence) return { enabled: false, reason: "No verified no-progress evidence" } as const;
  if (evidence.failureClass === "nontransient")
    return {
      enabled: false,
      reason: "Correct tool authorization, configuration, or input before escalation",
    } as const;
  if (attempts >= 1)
    return { enabled: false, reason: "The 1-attempt escalation limit is reached" } as const;
  if (
    !eligibility.ownerApproved ||
    !eligibility.catalogContainsExactModel ||
    !eligibility.authenticatedConnection ||
    !eligibility.supportsLowReasoning
  )
    return {
      enabled: false,
      reason: "Verify the exact owner-approved Sol low model and connection",
    } as const;
  if (!eligibility.connectionAllowsExactModel)
    return {
      enabled: false,
      reason: "Enable openai/sol in the existing connection model allowlist",
    } as const;
  if (!Number.isFinite(eligibility.maxCostUsd) || eligibility.maxCostUsd! <= 0)
    return { enabled: false, reason: "Set an explicit positive escalation cost limit" } as const;
  return {
    enabled: true,
    target: SOL_LOW_TARGET,
    maxAttempts: 1,
    maxOutputTokens: 2048,
    maxCostUsd: eligibility.maxCostUsd!,
    preserveToolGrants: true,
    preserveApprovals: true,
    reason: evidence.code,
  } as const;
}
