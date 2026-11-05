import type {
  AdapterContext,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  createJevLearningReviewCompletion,
  createLearningReviewCompletion,
  LEARNING_REVIEW_DECISION_QUESTION,
} from "./learning-review-judge.js";

const context = async () =>
  ({
    operationId: "op-1",
    traceId: "trace-1",
    spaceId: "space-1",
    userId: "user-1",
    signal: new AbortController().signal,
  }) as AdapterContext;

function fakeProvider(answer: DecisionResult["answers"], usage?: DecisionResult["usage"]) {
  const decide = vi.fn(async (_request: DecisionRequest, _context: AdapterContext) => ({
    model: "fake",
    answers: answer,
    ...(usage ? { usage } : {}),
  }));
  return { decide } as unknown as DecisionProvider & { decide: typeof decide };
}

describe("learning review judge", () => {
  it("turns the reviewer's choice into the JSON verdict the parser reads", async () => {
    const provider = fakeProvider(
      {
        [LEARNING_REVIEW_DECISION_QUESTION]: {
          type: "choice",
          choice: "qualified",
          confidence: 0.8,
        },
      },
      { inputTokens: 120, outputTokens: 8, costUsd: 0.002 },
    );
    const complete = createLearningReviewCompletion({ provider, model: "fake", context });

    const result = await complete("Is this worth promoting?", {});

    expect(JSON.parse(result.text)).toEqual({
      qualified: true,
      reason: "The reviewer chose qualified (confidence 0.8).",
    });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 8, costUsd: 0.002 });
    const request = provider.decide.mock.calls[0]?.[0] as DecisionRequest;
    expect(Object.keys(request.questions)).toEqual([LEARNING_REVIEW_DECISION_QUESTION]);
    expect(request.questions[LEARNING_REVIEW_DECISION_QUESTION]?.instructions).toBe(
      "Is this worth promoting?",
    );
  });

  it("reports an unqualified verdict as not qualified", async () => {
    const provider = fakeProvider({
      [LEARNING_REVIEW_DECISION_QUESTION]: { type: "choice", choice: "not-worth-promoting" },
    });
    const complete = createLearningReviewCompletion({ provider, model: "fake", context });

    const result = await complete("prompt", {});

    expect(JSON.parse(result.text).qualified).toBe(false);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  it("fails loudly on a choice the review never asked for", async () => {
    const provider = fakeProvider({
      [LEARNING_REVIEW_DECISION_QUESTION]: { type: "choice", choice: "maybe" },
    });
    const complete = createLearningReviewCompletion({ provider, model: "fake", context });

    await expect(complete("prompt", {})).rejects.toThrow("Invalid learning review choice: maybe");
  });

  it("has no judge at all without a deployment key", () => {
    expect(createJevLearningReviewCompletion({ apiKey: "", context })).toBeNull();
  });
});
