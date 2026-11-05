import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueLearningReviewJobs,
  planLearningReviewJobs,
  runScheduledLearningReview,
} from "./learning-review-store.js";

const now = new Date("2026-11-04T12:00:00.000Z");
const automatic = {
  learning: {
    mode: "automatic-private",
    maxReviewsPerDay: 2,
    maxCandidatesPerReview: 3,
    maxTokensPerReview: 5_000,
    maxReviewSeconds: 30,
    maxRetries: 1,
  },
};

function bot(overrides: Partial<{ botId: string; settings: unknown; reviewsToday: number }> = {}) {
  return {
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    settings: automatic,
    reviewsToday: 0,
    ...overrides,
  };
}

describe("planning a bot's next review", () => {
  it("plans nothing for the off default every existing bot has", () => {
    expect(planLearningReviewJobs({ now, bots: [bot({ settings: {} })] })).toEqual([]);
    expect(planLearningReviewJobs({ now, bots: [] })).toEqual([]);
  });

  it("plans the first free slot with a key that names the day and slot", () => {
    const planned = planLearningReviewJobs({ now, bots: [bot()] });

    expect(planned).toHaveLength(1);
    expect(planned[0]?.botId).toBe("bot-1");
    expect(planned[0]?.runAt).toBeInstanceOf(Date);
    expect(planned[0]?.runAt.getTime()).toBeGreaterThan(now.getTime());
    expect(planned[0]?.replaceKey).toMatch(
      /^learning-review:bot-1:\d{4}-\d{2}-\d{2}T[\d:.]+Z:\d+$/u,
    );
  });

  it("plans no more reviews once the day's cap is spent", () => {
    expect(planLearningReviewJobs({ now, bots: [bot({ reviewsToday: 2 })] })).toEqual([]);
    expect(planLearningReviewJobs({ now, bots: [bot({ reviewsToday: 1 })] })).toHaveLength(1);
  });
});

describe("enqueueing reviews", () => {
  it("enqueues one job per due bot and nothing for an archived bot", async () => {
    const enqueue = vi.fn(async () => ({ id: "job-1" }));
    const prisma = {
      botRuntimeProfile: {
        findMany: vi.fn().mockResolvedValue([
          {
            botId: "bot-1",
            settings: automatic,
            bot: { spaceId: "space-1", userId: "user-1", archivedAt: null },
          },
          {
            botId: "bot-2",
            settings: automatic,
            bot: { spaceId: "space-1", userId: "user-1", archivedAt: new Date() },
          },
          {
            botId: "bot-3",
            settings: {},
            bot: { spaceId: "space-1", userId: "user-1", archivedAt: null },
          },
        ]),
      },
      learningReview: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient;

    const result = await enqueueLearningReviewJobs({ prisma, jobs: { enqueue } as never, now });

    expect(result).toEqual({ planned: 1, enqueued: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const job = (enqueue.mock.calls[0] as unknown[])[0] as {
      name: string;
      payload: { botId: string };
    };
    expect(job.name).toBe("learning.review");
    expect(job.payload).toEqual({ botId: "bot-1" });
  });
});

describe("one scheduled review", () => {
  it("reports judge-unavailable without a key and touches nothing", async () => {
    const prisma = {
      botRuntimeProfile: { findUnique: vi.fn() },
      learningCandidate: { findMany: vi.fn() },
      learningReview: { count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    } as unknown as PrismaClient;

    const result = await runScheduledLearningReview({
      prisma,
      apiKey: "",
      botId: "bot-1",
      spaceId: "space-1",
      userId: "user-1",
      now,
    });

    expect(result).toEqual({ ran: false, reason: "judge-unavailable" });
    expect(prisma.learningCandidate.findMany).not.toHaveBeenCalled();
  });
});
