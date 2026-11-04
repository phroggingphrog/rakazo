import { randomUUID } from "node:crypto";
import type { AdapterContext, DecisionProvider } from "@rakazo/adapter-kit";
import type { LearningReviewComplete } from "@rakazo/core";
import { DEFAULT_JEV_MODEL, typesafeApiKey } from "./auto-review.js";
import { HttpDecisionProvider } from "./http-decisions.js";

/** The one question a review asks. Two criteria, because a third label is a third policy. */
export const LEARNING_REVIEW_DECISION_QUESTION = "verdict";
export const LEARNING_REVIEW_JUDGE_TIMEOUT_MS = 15_000;

const QUESTION = {
  type: "choice" as const,
  instructions: "",
  criteria: {
    qualified:
      "The lesson is specific, reusable, and supported by the evidence in the candidate, and promoting it would not contradict what the bot already knows.",
    "not-worth-promoting":
      "The lesson is vague, one-off, already covered by existing knowledge, contradicted by the evidence, or would change owner-set rules instead of the bot's own knowledge.",
  },
};

/**
 * Adapts the shared decision seam to the review's one model call. The prompt is the rubric; the
 * answer is a choice, serialised back into the JSON shape the core parser expects, so retries,
 * timeouts and the token budget stay in core where the tests already cover them.
 */
export function createLearningReviewCompletion(options: {
  provider: DecisionProvider;
  model: string;
  context: () => Promise<AdapterContext>;
  timeoutMs?: number;
}): LearningReviewComplete {
  return async (prompt, callOptions) => {
    const context = await options.context();
    const signals = [
      context.signal,
      AbortSignal.timeout(options.timeoutMs ?? LEARNING_REVIEW_JUDGE_TIMEOUT_MS),
    ];
    if (callOptions?.signal) signals.push(callOptions.signal);
    const result = await options.provider.decide(
      {
        model: options.model,
        state: { prompt },
        questions: {
          [LEARNING_REVIEW_DECISION_QUESTION]: { ...QUESTION, instructions: prompt },
        },
      },
      {
        ...context,
        operationId: `learning-review:${randomUUID()}`,
        signal: AbortSignal.any(signals),
      },
    );
    const answer = result.answers[LEARNING_REVIEW_DECISION_QUESTION];
    const choice = answer?.choice;
    if (choice !== "qualified" && choice !== "not-worth-promoting") {
      throw new Error(`Invalid learning review choice: ${String(choice)}`);
    }
    const confidence = answer?.confidence;
    if (
      confidence !== undefined &&
      (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      throw new Error("Invalid learning review confidence");
    }
    const reason =
      confidence === undefined
        ? `The reviewer chose ${choice}.`
        : `The reviewer chose ${choice} (confidence ${confidence}).`;
    return {
      text: JSON.stringify({ qualified: choice === "qualified", reason }),
      usage: {
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        costUsd: result.usage?.costUsd ?? null,
      },
    };
  };
}

/**
 * The judge this deployment can actually run: the same credential and model the proactive judge
 * uses. No key means no judge, and a review without a judge proposes nothing.
 */
export function createJevLearningReviewCompletion(options: {
  apiKey?: string;
  model?: string;
  context: () => Promise<AdapterContext>;
  timeoutMs?: number;
}): LearningReviewComplete | null {
  const apiKey = options.apiKey ?? typesafeApiKey();
  if (!apiKey) return null;
  return createLearningReviewCompletion({
    provider: new HttpDecisionProvider("typesafe", { apiKey }),
    model: options.model ?? DEFAULT_JEV_MODEL,
    context: options.context,
    timeoutMs: options.timeoutMs,
  });
}
