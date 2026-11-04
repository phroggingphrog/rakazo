import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { learningReviewJob } from "@rakazo/adapter-kit";
import {
  LEARNING_REVIEW_RUBRIC_VERSION,
  type LearningArtifactKind,
  type LearningReviewCandidate,
  type LearningReviewJudgement,
  learningReviewDayStart,
  learningReviewSlots,
} from "@rakazo/core";
import {
  type PrismaClient,
  readBotRuntimeProfile,
  readBotRuntimeProfileRevision,
} from "@rakazo/db";
import { createJevLearningReviewCompletion } from "./learning-review-judge.js";
import {
  DEFAULT_LEARNING_POLICY,
  learningPolicyFromProfile,
  ownerDecisionFromProfile,
} from "./learning-review-policy.js";
import {
  createScheduledLearningReview,
  type LearningReviewCandidateEntry,
  type LearningReviewPorts,
  type LearningReviewRecord,
  type LearningReviewRun,
} from "./learning-reviews.js";

/** Candidate kinds the collector writes, and the artifact each one would change. */
const KIND_TO_ARTIFACT: Record<string, LearningArtifactKind> = {
  memory: "private-memory",
  skill: "private-skill",
  persona: "persona",
};

export type LearningReviewScope = { botId: string; spaceId: string; userId: string };

/**
 * Where an automatic promotion lands. The review never writes a skill, memory document or the
 * persona itself: it hands the candidate to the sink the composition root supplies, or, when no
 * sink is configured, records the decision as a proposal. A missing sink therefore weakens the
 * review to proposals-only instead of failing to run.
 */
export type LearningPromotionSink = {
  apply(input: {
    candidate: LearningReviewCandidateEntry;
    judgement: LearningReviewJudgement;
  }): Promise<void>;
};

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/**
 * The (bot, UTC day, slot) claim. The planner's slot is the instant of the occurrence, and
 * an instant in epoch milliseconds overflows an Int column, so the key stores its offset
 * from that day's midnight: unique inside the day, stable, and small enough to persist.
 */
function slotKey(dayStart: Date, slot: number): number {
  return slot - dayStart.getTime();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * The durable half of the review: the profile the owner wrote, the day's count, the (day, slot)
 * claim the database enforces, the candidates, and where each outcome is written.
 */
export function createLearningReviewStore(
  input: {
    prisma: PrismaClient;
    sink?: LearningPromotionSink | null;
  } & LearningReviewScope &
    Pick<LearningReviewPorts, "complete">,
): LearningReviewPorts {
  const { prisma, botId, spaceId, userId } = input;
  const scope = { botId, spaceId, userId };

  const setStatus = async (
    candidate: LearningReviewCandidateEntry,
    status: "proposed" | "promoted" | "dropped",
    reviewReason: string,
  ) => {
    await prisma.learningCandidate.update({
      where: { id: candidate.id },
      data: { status, reviewReason, reviewedAt: new Date() },
    });
  };

  return {
    complete: input.complete,
    async readPolicy() {
      const profile = await readBotRuntimeProfile(prisma, scope);
      if (!profile) return { policy: DEFAULT_LEARNING_POLICY, ownerDecision: null };
      const policy = learningPolicyFromProfile(profile.settings);
      const revision = await readBotRuntimeProfileRevision(prisma, scope, profile.revision);
      return {
        policy,
        ownerDecision: ownerDecisionFromProfile({
          revision: profile.revision,
          actorUserId: revision?.actorUserId ?? null,
          ownerUserId: userId,
        }),
      };
    },
    async reviewsToday(dayStart) {
      return prisma.learningReview.count({ where: { botId, day: dayStart } });
    },
    async claimReview({ dayStart, slot }) {
      try {
        await prisma.learningReview.create({
          data: {
            botId,
            day: dayStart,
            slot: slotKey(dayStart, slot),
            mode: "pending",
            rubricVersion: LEARNING_REVIEW_RUBRIC_VERSION,
            outcome: {},
          },
        });
        return true;
      } catch (error) {
        // The unique (botId, day, slot) key is the claim: a racing worker loses here.
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
    async loadCandidates(limit) {
      const rows = await prisma.learningCandidate.findMany({
        where: { botId, status: "pending" },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map((row): LearningReviewCandidateEntry => {
        const payload = recordOf(row.payload);
        const candidate: LearningReviewCandidate = {
          id: row.id,
          artifactKind: KIND_TO_ARTIFACT[row.kind] ?? "private-memory",
          title: textField(payload, "title"),
          body: textField(payload, "body"),
          evidence: textField(payload, "evidence"),
        };
        return {
          ...candidate,
          // The evidence is the stored candidate itself; nothing in this table can be stale or
          // suppressed while it is still pending, so the promotion check sees matching numbers.
          state: {
            hasEvidence: candidate.evidence.length > 0,
            sourceGeneration: 0,
            currentGeneration: 0,
            expectedRevision: 0,
            currentRevision: 0,
            suppressed: false,
          },
        };
      });
    },
    async propose({ candidate, judgement, reason }) {
      await setStatus(candidate, "proposed", reason || (judgement.reason ?? ""));
    },
    async promote({ candidate, judgement }) {
      // A persona is the owner's to write, so automatic promotion stops at a proposal.
      if (candidate.artifactKind === "persona") {
        await setStatus(candidate, "proposed", "persona changes need the owner");
        return;
      }
      if (!input.sink) {
        await setStatus(candidate, "proposed", "no promotion sink is configured");
        return;
      }
      await input.sink.apply({ candidate, judgement });
      await setStatus(candidate, "promoted", judgement.reason);
    },
    async drop({ candidate, judgement, reason }) {
      await setStatus(candidate, "dropped", reason || (judgement.reason ?? ""));
    },
    async recordReview(record: LearningReviewRecord) {
      await prisma.learningReview.updateMany({
        where: { botId, day: record.dayStart, slot: slotKey(record.dayStart, record.slot) },
        data: {
          mode: record.mode,
          rubricVersion: record.rubricVersion,
          tokensSpent: record.tokensSpent,
          costUsd: record.costUsd ?? null,
          outcome: {
            examined: record.examined,
            promoted: record.promoted,
            proposed: record.proposed,
            dropped: record.dropped,
            stoppedBecause: record.stoppedBecause,
            candidates: record.candidates.map((entry) => ({
              id: entry.id,
              artifactKind: entry.artifactKind,
              outcome: entry.outcome,
              verdict: entry.verdict,
              reason: entry.reason ?? "",
            })),
          },
        },
      });
    },
  };
}

export type LearningReviewRuntimeResult =
  | { ran: false; reason: string }
  | {
      ran: true;
      dayStart: Date;
      slot: number;
      examined: number;
      promoted: number;
      proposed: number;
      dropped: number;
      tokensSpent: number;
      stoppedBecause: string;
    };

/**
 * One scheduled review for one bot, built from parts that already exist: the stored profile for
 * the policy, the shared decision seam for the judge, and the review queue for candidates.
 */
export async function runScheduledLearningReview(
  input: {
    prisma: PrismaClient;
    apiKey?: string;
    model?: string;
    now?: Date;
    timeoutMs?: number;
    sink?: LearningPromotionSink | null;
  } & LearningReviewScope,
): Promise<LearningReviewRuntimeResult> {
  const context = async (): Promise<AdapterContext> => ({
    operationId: `learning-review:${input.botId}`,
    traceId: `learning-review:${input.botId}`,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  });
  const complete = createJevLearningReviewCompletion({
    apiKey: input.apiKey,
    model: input.model,
    context,
    timeoutMs: input.timeoutMs,
  });
  if (!complete) return { ran: false, reason: "judge-unavailable" };
  const store = createLearningReviewStore({
    prisma: input.prisma,
    botId: input.botId,
    spaceId: input.spaceId,
    userId: input.userId,
    sink: input.sink,
    complete,
  });
  const review = createScheduledLearningReview(store, {
    // The scheduler reads the clock through a getter, so a caller-supplied date is wrapped once.
    ...(input.now ? { now: () => input.now as Date } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  const result: LearningReviewRun = await review.runOnce();
  if (!result.ran) return { ran: false, reason: result.reason };
  return {
    ran: true,
    dayStart: result.dayStart,
    slot: result.slot,
    examined: result.examined,
    promoted: result.promoted,
    proposed: result.proposed,
    dropped: result.dropped,
    tokensSpent: result.tokensSpent,
    stoppedBecause: result.stoppedBecause,
  };
}

export type LearningReviewBotState = {
  botId: string;
  spaceId: string;
  userId: string;
  settings: unknown;
  reviewsToday: number;
};

export type PlannedLearningReviewJob = {
  botId: string;
  spaceId: string;
  userId: string;
  runAt: Date;
  replaceKey: string;
};

/**
 * Which bot is due which review. A bot whose profile says "off" is never planned; the next slot
 * is the (count + 1)th of the day's evenly spaced slots, so the day's cap is the slot count and a
 * burst of ticks plans the same job again rather than a second one.
 */
export function planLearningReviewJobs(input: {
  now: Date;
  bots: readonly LearningReviewBotState[];
}): PlannedLearningReviewJob[] {
  const dayStart = learningReviewDayStart(input.now);
  const planned: PlannedLearningReviewJob[] = [];
  for (const bot of input.bots) {
    const policy = learningPolicyFromProfile(bot.settings);
    if (policy.mode === "off") continue;
    const slots = learningReviewSlots(dayStart, policy.maxReviewsPerDay);
    const index = Math.max(Math.trunc(bot.reviewsToday), 0);
    // Only a slot still ahead of the clock is worth queuing: a slot that already passed is either
    // the review now running or one the day's budget already skipped, and re-planning it would
    // fire a catch-up burst the moment a bot is switched on.
    const slot = slots.slice(index).find((candidate) => candidate > input.now.getTime());
    if (slot === undefined) continue;
    planned.push({
      botId: bot.botId,
      spaceId: bot.spaceId,
      userId: bot.userId,
      runAt: new Date(slot),
      replaceKey: `learning-review:${bot.botId}:${dayStart.toISOString()}:${slot}`,
    });
  }
  return planned;
}

/**
 * Plans and enqueues the next review for every bot that asks for one. Each queued job re-plans
 * when it runs, so the chain continues without a separate cron entry; nothing is enqueued for a
 * bot with learning mode "off", which is what every existing bot has.
 */
export async function enqueueLearningReviewJobs(input: {
  prisma: PrismaClient;
  jobs: Pick<JobPublisher, "enqueue">;
  now?: Date;
  botId?: string;
}): Promise<{ planned: number; enqueued: number }> {
  const now = input.now ?? new Date();
  const dayStart = learningReviewDayStart(now);
  const profiles = await input.prisma.botRuntimeProfile.findMany({
    where: {
      ...(input.botId ? { botId: input.botId } : {}),
      // A profile with no learning block has no such path, so this also excludes every bot that
      // predates the feature: the periodic planner costs one query that usually returns nothing.
      settings: { path: ["learning", "mode"], not: "off" },
    },
    select: {
      botId: true,
      settings: true,
      bot: { select: { spaceId: true, userId: true, archivedAt: true } },
    },
    take: input.botId ? 1 : 500,
  });
  const bots: LearningReviewBotState[] = [];
  for (const profile of profiles) {
    if (profile.bot.archivedAt) continue;
    const reviewsToday = await input.prisma.learningReview.count({
      where: { botId: profile.botId, day: dayStart },
    });
    bots.push({
      botId: profile.botId,
      spaceId: profile.bot.spaceId,
      userId: profile.bot.userId,
      settings: profile.settings,
      reviewsToday,
    });
  }
  const planned = planLearningReviewJobs({ now, bots });
  for (const job of planned) {
    await input.jobs.enqueue(learningReviewJob(job.botId, job.runAt, job.replaceKey));
  }
  return { planned: planned.length, enqueued: planned.length };
}
