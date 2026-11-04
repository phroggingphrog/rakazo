import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEARNING_POLICY,
  learningPolicyFromProfile,
  ownerDecisionFromProfile,
} from "./learning-review-policy.js";

describe("learning policy read from a stored profile", () => {
  it("gives a bot with no learning block the off default", () => {
    expect(learningPolicyFromProfile({})).toEqual(DEFAULT_LEARNING_POLICY);
    expect(learningPolicyFromProfile(null)).toEqual(DEFAULT_LEARNING_POLICY);
    expect(learningPolicyFromProfile({ persona: {} }).mode).toBe("off");
  });

  it("reads a complete learning block unchanged", () => {
    expect(
      learningPolicyFromProfile({
        learning: {
          mode: "automatic-private",
          maxReviewsPerDay: 4,
          maxCandidatesPerReview: 5,
          maxTokensPerReview: 20_000,
          maxReviewSeconds: 60,
          maxRetries: 2,
        },
      }),
    ).toEqual({
      mode: "automatic-private",
      maxReviewsPerDay: 4,
      maxCandidatesPerReview: 5,
      maxTokensPerReview: 20_000,
      maxReviewSeconds: 60,
      maxRetries: 2,
    });
  });

  it("clamps a hand-edited limit instead of trusting it", () => {
    const policy = learningPolicyFromProfile({
      learning: {
        mode: "proposals-only",
        maxReviewsPerDay: 999,
        maxCandidatesPerReview: -3,
        maxTokensPerReview: 1_000_000,
        maxReviewSeconds: "soon",
        maxRetries: 7.8,
      },
    });

    expect(policy.maxReviewsPerDay).toBe(24);
    expect(policy.maxCandidatesPerReview).toBe(0);
    expect(policy.maxTokensPerReview).toBe(100_000);
    expect(policy.maxReviewSeconds).toBe(0);
    expect(policy.maxRetries).toBe(5);
  });

  it("treats an unknown mode as off so a typo cannot enable reviews", () => {
    expect(learningPolicyFromProfile({ learning: { mode: "automatic" } }).mode).toBe("off");
    expect(learningPolicyFromProfile({ learning: { mode: 1 } }).mode).toBe("off");
  });
});

describe("owner decision recorded on the profile revision", () => {
  it("counts a revision the owner authored as the owner decision", () => {
    expect(
      ownerDecisionFromProfile({ revision: 3, actorUserId: "user-1", ownerUserId: "user-1" }),
    ).toEqual({
      actor: "owner",
      revision: 3,
    });
  });

  it("does not count a revision the bot or a migration wrote", () => {
    expect(
      ownerDecisionFromProfile({ revision: 3, actorUserId: "user-2", ownerUserId: "user-1" }),
    ).toEqual({
      actor: "system",
      revision: 3,
    });
  });

  it("has no decision without an author or a real revision", () => {
    expect(ownerDecisionFromProfile({ revision: 3 })).toBeNull();
    expect(ownerDecisionFromProfile({ revision: 0, actorUserId: "user-1" })).toBeNull();
    expect(ownerDecisionFromProfile({ revision: 1.5, actorUserId: "user-1" })).toBeNull();
  });
});
