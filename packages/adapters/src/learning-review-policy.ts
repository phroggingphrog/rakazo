import type { LearningOwnerDecision, LearningReviewPolicy } from "@rakazo/core";

/**
 * What a bot that was never given a learning profile gets: reviews off, no budget. Reading a
 * profile that predates this feature must never widen it, so this is the fallback shape.
 */
export const DEFAULT_LEARNING_POLICY: LearningReviewPolicy = {
  mode: "off",
  maxReviewsPerDay: 0,
  maxCandidatesPerReview: 0,
  maxTokensPerReview: 0,
  maxReviewSeconds: 0,
  maxRetries: 0,
};

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countWithin(value: unknown, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

/**
 * Reads the learning block out of a stored profile without trusting it: an unknown mode is
 * "off" and a limit outside its range is clamped, so a hand-edited row cannot widen the policy.
 * The contracts schema already enforces these bounds on write; this is the read-time guard.
 */
export function learningPolicyFromProfile(settings: unknown): LearningReviewPolicy {
  const learning = recordOf(recordOf(settings).learning);
  const mode =
    learning.mode === "proposals-only" || learning.mode === "automatic-private"
      ? learning.mode
      : "off";
  return {
    mode,
    maxReviewsPerDay: countWithin(learning.maxReviewsPerDay, 24, 0),
    maxCandidatesPerReview: countWithin(learning.maxCandidatesPerReview, 20, 0),
    maxTokensPerReview: countWithin(learning.maxTokensPerReview, 100_000, 0),
    maxReviewSeconds: countWithin(learning.maxReviewSeconds, 3_600, 0),
    maxRetries: countWithin(learning.maxRetries, 5, 0),
  };
}

/**
 * Who wrote the stored profile revision. Only a revision the owner authored counts as the owner
 * decision that automatic-private needs; a profile written by the bot or by a migration does not,
 * so the same settings still review but stop at proposals.
 */
export function ownerDecisionFromProfile(input: {
  revision: number;
  actorUserId?: string | null;
  ownerUserId?: string | null;
}): LearningOwnerDecision | null {
  const actor = input.actorUserId?.trim();
  if (!actor) return null;
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) return null;
  const owner = input.ownerUserId?.trim();
  return { actor: owner && actor === owner ? "owner" : "system", revision: input.revision };
}
