import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScheduledLearningReview } from "./learning-reviews.js";
import {
  createLearningReviewStore,
  enqueueLearningReviewJobs,
  runScheduledLearningReview,
} from "./learning-review-store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const spaceId = "learning-review-space";
const ownerUserId = "learning-review-owner";
const learningBotId = "learning-review-bot";
const plainBotId = "learning-review-plain-bot";
const now = new Date("2026-11-04T20:00:00.000Z");
// Planning only queues a slot still ahead of the clock, so it is read before the day's first slot.
const planNow = new Date("2026-11-04T07:00:00.000Z");
const day = new Date("2026-11-04T00:00:00.000Z");

function settings(mode: "off" | "proposals-only" | "automatic-private") {
  return {
    schemaVersion: 1,
    learning: {
      mode,
      maxReviewsPerDay: 2,
      maxCandidatesPerReview: 2,
      maxTokensPerReview: 1_000,
      maxReviewSeconds: 600,
      maxRetries: 1,
    },
  };
}

const answer = (body: object) => async () => ({ text: JSON.stringify(body), usage: { inputTokens: 100 } });

describePostgres("scheduled learning review (PostgreSQL)", () => {
  let prisma: ReturnType<typeof createDb>["prisma"];
  let close: () => Promise<void>;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await asSystem(prisma).organization.deleteMany({ where: { id: spaceId } });
    await asSystem(prisma).organization.create({
      data: {
        id: spaceId,
        name: "Learning Review Organization",
        slug: spaceId,
        createdAt: new Date(),
        spaces: {
          create: {
            id: spaceId,
            name: "Learning Review Space",
            bots: {
              create: [
                { id: learningBotId, userId: ownerUserId, name: "Learning Bot", color: "ink" },
                { id: plainBotId, userId: ownerUserId, name: "Plain Bot", color: "ink" },
              ],
            },
          },
        },
      },
    });
    await asSystem(prisma).botRuntimeProfile.createMany({
      data: [
        { botId: learningBotId, revision: 1, settings: settings("proposals-only") },
        { botId: plainBotId, revision: 1, settings: settings("off") },
      ],
    });
  });

  afterAll(async () => {
    await asSystem(prisma).organization.deleteMany({ where: { id: spaceId } });
    await close();
  });

  it("plans one review for a bot whose profile asks for it and none for a bot that is off", async () => {
    const queued: { name: string; payload: unknown; replaceKey?: string }[] = [];
    const jobs = {
      enqueue: async (job: { name: string; payload: unknown; replaceKey?: string }) => {
        queued.push(job);
      },
    };
    const first = await runAsSystem("plan learning reviews", () =>
      enqueueLearningReviewJobs({ prisma, jobs, now: planNow }),
    );
    expect(first).toEqual({ planned: 1, enqueued: 1 });
    expect(queued[0]).toMatchObject({ name: "learning.review", payload: { botId: learningBotId } });

    // A second tick before the slot replaces the pending job rather than queueing a second review.
    const again = await runAsSystem("plan learning reviews", () =>
      enqueueLearningReviewJobs({ prisma, jobs, now: planNow }),
    );
    expect(again).toEqual({ planned: 1, enqueued: 1 });
    expect(queued[1]?.replaceKey).toBe(queued[0]?.replaceKey);
  });

  it("returns judge-unavailable and writes no review when no judge is configured", async () => {
    const result = await runAsTenant({ spaceId, userId: ownerUserId }, () =>
      runScheduledLearningReview({
        prisma,
        botId: learningBotId,
        spaceId,
        userId: ownerUserId,
      }),
    );
    expect(result).toEqual({ ran: false, reason: "judge-unavailable" });
    expect(await asSystem(prisma).learningReview.count({ where: { botId: learningBotId } })).toBe(0);
  });

  it("records a judge failure as unqualified and never promotes", async () => {
    await asSystem(prisma).learningCandidate.createMany({
      data: [
        {
          spaceId,
          botId: learningBotId,
          kind: "memory",
          dedupeKey: "failure-a",
          payload: { title: "First", body: "Export the invoice table as CSV.", evidence: "thread-1" },
        },
        {
          spaceId,
          botId: learningBotId,
          kind: "memory",
          dedupeKey: "failure-b",
          payload: { title: "Second", body: "Use the weekly cadence.", evidence: "thread-2" },
        },
      ],
    });
    const store = createLearningReviewStore({
      prisma,
      botId: learningBotId,
      spaceId,
      userId: ownerUserId,
      complete: async () => {
        throw new Error("provider unavailable");
      },
    });
    const result = await runAsTenant({ spaceId, userId: ownerUserId }, () =>
      createScheduledLearningReview(store, { now: () => now }).runOnce(now),
    );
    expect(result).toMatchObject({ ran: true, examined: 2, promoted: 0, proposed: 0, dropped: 2 });
    const candidates = await asSystem(prisma).learningCandidate.findMany({
      where: { botId: learningBotId },
    });
    expect(candidates.map((candidate) => candidate.status)).toEqual(["dropped", "dropped"]);
    const review = await asSystem(prisma).learningReview.findFirst({
      where: { botId: learningBotId, day },
      orderBy: { createdAt: "desc" },
    });
    expect(review?.mode).toBe("proposals-only");
    expect(review?.outcome).toMatchObject({
      candidates: [
        { outcome: "drop", verdict: "unqualified" },
        { outcome: "drop", verdict: "unqualified" },
      ],
    });
  });

  it("proposes in proposals-only mode and promotes nothing without a sink", async () => {
    await asSystem(prisma).learningCandidate.createMany({
      data: ["proposal-a", "proposal-b"].map((dedupeKey) => ({
        spaceId,
        botId: learningBotId,
        kind: "memory" as const,
        dedupeKey,
        payload: { title: dedupeKey, body: "Durable and evidenced.", evidence: `thread-${dedupeKey}` },
      })),
    });
    const store = createLearningReviewStore({
      prisma,
      botId: learningBotId,
      spaceId,
      userId: ownerUserId,
      complete: answer({ qualified: true, reason: "Durable and evidenced." }),
    });
    const result = await runAsTenant({ spaceId, userId: ownerUserId }, () =>
      createScheduledLearningReview(store, { now: () => now }).runOnce(now),
    );
    expect(result).toMatchObject({ ran: true, examined: 2, promoted: 0, proposed: 2 });
    const proposed = await asSystem(prisma).learningCandidate.findMany({
      where: { botId: learningBotId, status: "proposed" },
    });
    expect(proposed).toHaveLength(2);
  });

  it("holds the (bot, day, slot) claim at the database", async () => {
    const claim = {
      botId: learningBotId,
      day,
      slot: 23,
      mode: "pending",
      rubricVersion: "2026-11-04.1",
      outcome: {},
    };
    await asSystem(prisma).learningReview.create({ data: claim });
    await expect(asSystem(prisma).learningReview.create({ data: claim })).rejects.toThrow();
  });
});
