import type { LearningReviewCompletion } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledLearningReview,
  type LearningReviewCandidateEntry,
  type LearningReviewPolicyRecord,
  type LearningReviewPorts,
  type LearningReviewRecord,
  nextLearningReviewAt,
} from "./learning-reviews.js";

const policy = {
  mode: "automatic-private" as const,
  maxReviewsPerDay: 2,
  maxCandidatesPerReview: 3,
  maxTokensPerReview: 1_000,
  maxReviewSeconds: 600,
  maxRetries: 2,
};

const candidate = (id: string): LearningReviewCandidateEntry => ({
  id,
  artifactKind: "private-memory",
  title: `Note ${id}`,
  body: "The owner asked for CSV exports twice.",
  evidence: "thread-1: export the invoice table as CSV",
  state: {
    hasEvidence: true,
    sourceGeneration: 4,
    currentGeneration: 4,
    expectedRevision: 7,
    currentRevision: 7,
    suppressed: false,
  },
});

const qualifiedAnswer = (input: { usageTokens?: number; costUsd?: number } = {}) => ({
  text: JSON.stringify({ qualified: true, reason: "Durable and evidenced." }),
  ...(input.usageTokens === undefined
    ? {}
    : {
        usage: {
          inputTokens: input.usageTokens,
          outputTokens: 0,
          ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
        },
      }),
});

type Harness = {
  ports: LearningReviewPorts;
  complete: ReturnType<typeof vi.fn>;
  propose: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
  drop: ReturnType<typeof vi.fn>;
  records: LearningReviewRecord[];
};

function harness(
  overrides: {
    policyRecord?: LearningReviewPolicyRecord;
    reviewsToday?: number;
    candidates?: readonly LearningReviewCandidateEntry[];
    claimed?: boolean;
    answer?: () => LearningReviewCompletion;
  } = {},
): Harness {
  const records: LearningReviewRecord[] = [];
  const complete = vi.fn(async () => (overrides.answer ?? qualifiedAnswer)());
  const propose = vi.fn(async () => {});
  const promote = vi.fn(async () => {});
  const drop = vi.fn(async () => {});
  const ports: LearningReviewPorts = {
    readPolicy: async () =>
      overrides.policyRecord ?? { policy, ownerDecision: { actor: "owner", revision: 3 } },
    reviewsToday: async () => overrides.reviewsToday ?? 0,
    claimReview: async () => overrides.claimed ?? true,
    loadCandidates: async (limit: number) =>
      (overrides.candidates ?? [candidate("a"), candidate("b")]).slice(0, limit),
    propose,
    promote,
    drop,
    recordReview: async (record) => {
      records.push(record);
    },
    complete,
  };
  return { ports, complete, propose, promote, drop, records };
}

const afterFirstSlot = new Date("2026-11-04T20:00:00.000Z");

describe("scheduled learning review", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing while the bot's policy is off", async () => {
    const h = harness({ policyRecord: { policy: { ...policy, mode: "off" } } });
    const run = await createScheduledLearningReview(h.ports).runOnce(afterFirstSlot);
    expect(run).toEqual({ ran: false, reason: "mode-off" });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(0);
  });

  it("records a qualified candidate as a proposal in proposals-only mode and changes nothing", async () => {
    const h = harness({ policyRecord: { policy: { ...policy, mode: "proposals-only" } } });
    const run = await createScheduledLearningReview(h.ports, {
      now: () => afterFirstSlot,
    }).runOnce(afterFirstSlot);
    expect(run).toMatchObject({
      ran: true,
      mode: "proposals-only",
      examined: 2,
      proposed: 2,
      promoted: 0,
    });
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.propose).toHaveBeenCalledTimes(2);
    expect(h.records[0]).toMatchObject({ mode: "proposals-only", examined: 2, proposed: 2 });
    expect(h.records[0]?.candidates[0]).toMatchObject({
      outcome: "propose",
      reason: "owner-review",
    });
  });

  it("stays proposals-only when a bot asks for automatic promotion but no owner decided", async () => {
    const h = harness({ policyRecord: { policy, ownerDecision: { actor: "bot", revision: 2 } } });
    const run = await createScheduledLearningReview(h.ports, {
      now: () => afterFirstSlot,
    }).runOnce(afterFirstSlot);
    expect(run).toMatchObject({ ran: true, mode: "proposals-only", promoted: 0 });
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.propose).toHaveBeenCalledTimes(2);
  });

  it("promotes a qualified private candidate once the owner approved automatic promotion", async () => {
    const h = harness();
    const run = await createScheduledLearningReview(h.ports, { now: () => afterFirstSlot }).runOnce(
      afterFirstSlot,
    );
    expect(run).toMatchObject({ ran: true, mode: "automatic-private", examined: 2, promoted: 2 });
    expect(h.promote).toHaveBeenCalledTimes(2);
    expect(h.records[0]?.candidates[0]).toMatchObject({ outcome: "promote", verdict: "qualified" });
  });

  it("records a judge failure as unqualified, retries within the limit and never promotes", async () => {
    const h = harness({
      answer: () => {
        throw new Error("provider unavailable");
      },
    });
    const run = await createScheduledLearningReview(h.ports, { now: () => afterFirstSlot }).runOnce(
      afterFirstSlot,
    );
    expect(run).toMatchObject({ ran: true, examined: 2, promoted: 0, proposed: 0, dropped: 2 });
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(6);
    expect(h.records[0]?.candidates[0]).toMatchObject({ outcome: "drop", reason: "unqualified" });
  });

  it("keeps the per-review candidate and token caps and stops when the budget is spent", async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(`c${index}`));
    const h = harness({
      candidates,
      policyRecord: {
        policy: { ...policy, maxCandidatesPerReview: 5 },
        ownerDecision: { actor: "owner", revision: 3 },
      },
      answer: () => qualifiedAnswer({ usageTokens: 400, costUsd: 0.001 }),
    });
    const run = await createScheduledLearningReview(h.ports, { now: () => afterFirstSlot }).runOnce(
      afterFirstSlot,
    );
    expect(run).toMatchObject({ ran: true, examined: 3, stoppedBecause: "tokens" });
    expect(h.complete.mock.calls.length).toBeLessThanOrEqual(3);
    expect(h.records[0]?.tokensSpent).toBe(1_200);
    expect(h.records[0]?.costUsd).toBeCloseTo(0.003, 6);
  });

  it("holds the daily cap and lets only one instance take a slot", async () => {
    const spent = harness({ reviewsToday: 2 });
    const spentRun = await createScheduledLearningReview(spent.ports).runOnce(afterFirstSlot);
    expect(spentRun).toEqual({ ran: false, reason: "reviews-per-day-reached" });
    expect(spent.complete).not.toHaveBeenCalled();

    let claims = 0;
    const h = harness();
    const ports: LearningReviewPorts = {
      ...h.ports,
      claimReview: async () => {
        claims += 1;
        return claims === 1;
      },
    };
    const runner = createScheduledLearningReview(ports, { now: () => afterFirstSlot });
    const runs = await Promise.all([
      runner.runOnce(afterFirstSlot),
      runner.runOnce(afterFirstSlot),
      runner.runOnce(afterFirstSlot),
    ]);
    expect(runs.filter((run) => run.ran)).toHaveLength(1);
    expect(runs.filter((run) => !run.ran && run.reason === "slot-claimed")).toHaveLength(2);
    expect(h.records).toHaveLength(1);
  });

  it("stops at the review deadline even when candidates remain", async () => {
    vi.useFakeTimers();
    const at = new Date("2026-11-04T20:00:00.000Z");
    vi.setSystemTime(at);
    const h = harness({
      policyRecord: {
        policy: { ...policy, maxReviewSeconds: 1 },
        ownerDecision: { actor: "owner", revision: 3 },
      },
      candidates: [candidate("a"), candidate("b")],
    });
    const slow: LearningReviewPorts = {
      ...h.ports,
      complete: async () => {
        vi.setSystemTime(new Date(at.getTime() + 2_000));
        return qualifiedAnswer();
      },
    };
    const run = await createScheduledLearningReview(slow, { now: () => at }).runOnce(at);
    expect(run).toMatchObject({ ran: true, stoppedBecause: "deadline" });
  });

  it("does not run before the day's first slot", async () => {
    const h = harness();
    const run = await createScheduledLearningReview(h.ports).runOnce(
      new Date("2026-11-04T01:00:00.000Z"),
    );
    expect(run).toEqual({ ran: false, reason: "review-not-due" });
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe("nextLearningReviewAt", () => {
  it("returns the slot still ahead, or now once it has passed", () => {
    const beforeSlot = new Date("2026-11-04T01:00:00.000Z");
    expect(nextLearningReviewAt({ policy, now: beforeSlot, reviewsToday: 0 })?.toISOString()).toBe(
      "2026-11-04T08:00:00.000Z",
    );
    expect(
      nextLearningReviewAt({ policy, now: afterFirstSlot, reviewsToday: 0 })?.toISOString(),
    ).toBe(afterFirstSlot.toISOString());
    expect(
      nextLearningReviewAt({ policy, now: afterFirstSlot, reviewsToday: 1 })?.toISOString(),
    ).toBe(afterFirstSlot.toISOString());
    expect(
      nextLearningReviewAt({
        policy,
        now: new Date("2026-11-04T09:00:00.000Z"),
        reviewsToday: 1,
      })?.toISOString(),
    ).toBe("2026-11-04T16:00:00.000Z");
    expect(
      nextLearningReviewAt({ policy, now: afterFirstSlot, reviewsToday: 2 })?.toISOString(),
    ).toBe("2026-11-05T08:00:00.000Z");
    expect(
      nextLearningReviewAt({
        policy: { ...policy, maxReviewsPerDay: 0 },
        now: afterFirstSlot,
        reviewsToday: 0,
      }),
    ).toBeNull();
  });
});
