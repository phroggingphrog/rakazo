import {
  judgeLearningCandidate,
  LEARNING_REVIEW_RUBRIC_VERSION,
  type LearningOwnerDecision,
  type LearningReviewCandidate,
  type LearningReviewComplete,
  type LearningReviewJudgement,
  type LearningReviewPolicy,
  type LearningReviewRefusal,
  type LearningReviewUsage,
  learningReviewDayStart,
  learningReviewSlots,
  learningReviewTokensSpent,
  planLearningReview,
  resolveLearningCandidateOutcome,
  resolveLearningMode,
} from "@rakazo/core";

/**
 * What the promotion check needs to know about one candidate. The store that owns the
 * candidate fills this in; a candidate whose generations or revisions have moved on is
 * promoted at most as a proposal.
 */
export type LearningCandidateState = {
  hasEvidence: boolean;
  sourceGeneration: number;
  currentGeneration: number;
  expectedRevision: number;
  currentRevision: number;
  suppressed: boolean;
};

export type LearningReviewCandidateEntry = LearningReviewCandidate & {
  state: LearningCandidateState;
};

export type LearningReviewPolicyRecord = {
  policy: LearningReviewPolicy;
  ownerDecision?: LearningOwnerDecision | null;
};

/** How one candidate ended. Every candidate is recorded, promoted, proposed or dropped. */
export type LearningCandidateRecord = {
  id: string;
  artifactKind: LearningReviewCandidate["artifactKind"];
  outcome: "promote" | "propose" | "drop";
  reason?: string;
  verdict: LearningReviewJudgement["verdict"];
};

export type LearningReviewRecord = {
  dayStart: Date;
  slot: number;
  mode: "off" | "proposals-only" | "automatic-private";
  rubricVersion: string;
  examined: number;
  promoted: number;
  proposed: number;
  dropped: number;
  tokensSpent: number;
  costUsd?: number;
  stoppedBecause: LearningReviewStop;
  candidates: LearningCandidateRecord[];
};

export type LearningReviewStop = "all-candidates" | "tokens" | "deadline";

export type LearningReviewRun =
  | { ran: false; reason: LearningReviewRefusal | "mode-off" | "slot-claimed" }
  | {
      ran: true;
      dayStart: Date;
      slot: number;
      mode: LearningReviewRecord["mode"];
      examined: number;
      promoted: number;
      proposed: number;
      dropped: number;
      tokensSpent: number;
      stoppedBecause: LearningReviewStop;
    };

/**
 * Everything the scheduled review touches, injected so the schedule stays a schedule: the
 * profile store, the day's review count, the slot claim, the candidate stores, the promotion
 * paths and one model call. Nothing here is global state, so two instances may run at once.
 */
export type LearningReviewPorts = {
  /** The bot's stored learning policy and who wrote that revision. */
  readPolicy(): Promise<LearningReviewPolicyRecord>;
  /** Completed reviews for the UTC day that begins at dayStart. */
  reviewsToday(dayStart: Date): Promise<number>;
  /**
   * Take ownership of one (day, slot). A cross-process implementation uses a Postgres
   * advisory lock or a unique row; the claim is released when the day ends, so no global
   * single-flight is involved.
   */
  claimReview(input: { dayStart: Date; slot: number }): Promise<boolean>;
  /** Candidates awaiting review, most useful first. Fewer than limit is fine. */
  loadCandidates(limit: number): Promise<readonly LearningReviewCandidateEntry[]>;
  propose(input: {
    candidate: LearningReviewCandidateEntry;
    judgement: LearningReviewJudgement;
    reason: string;
  }): Promise<void>;
  promote(input: {
    candidate: LearningReviewCandidateEntry;
    judgement: LearningReviewJudgement;
  }): Promise<void>;
  drop(input: {
    candidate: LearningReviewCandidateEntry;
    judgement: LearningReviewJudgement;
    reason: string;
  }): Promise<void>;
  /** Persist the review and its per-candidate outcomes; this is what increments the day's count. */
  recordReview(record: LearningReviewRecord): Promise<void>;
  /** One model call. Retries, the deadline and the token budget are applied here. */
  complete: LearningReviewComplete;
};

export type LearningReviewRunner = {
  /** Run the review due at now, or report why none ran. Safe to call from several instances. */
  runOnce(now?: Date): Promise<LearningReviewRun>;
};

/** Matches the proactive judge; a slower reviewer is a stalled review. */
const DEFAULT_REVIEW_TIMEOUT_MS = 15_000;

export function createScheduledLearningReview(
  ports: LearningReviewPorts,
  options: { now?: () => Date; timeoutMs?: number } = {},
): LearningReviewRunner {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

  return {
    async runOnce(at?: Date): Promise<LearningReviewRun> {
      const current = at ?? now();
      const { policy, ownerDecision } = await ports.readPolicy();
      const resolved = resolveLearningMode({ policy, ownerDecision });
      if (resolved.mode === "off") return { ran: false, reason: "mode-off" };

      const dayStart = learningReviewDayStart(current);
      const reviewsToday = await ports.reviewsToday(dayStart);
      // Plan against the whole allowance first: the due slot and the caps must hold before
      // any candidate is loaded, and loading costs the stores a query.
      const plan = planLearningReview({
        policy,
        now: current,
        reviewsToday,
        candidatesAvailable: policy.maxCandidatesPerReview,
      });
      if (!plan.run) return { ran: false, reason: plan.reason };

      const claimed = await ports.claimReview({ dayStart, slot: plan.slot });
      if (!claimed) return { ran: false, reason: "slot-claimed" };

      const loaded = await ports.loadCandidates(plan.candidateLimit);
      const batch = loaded.slice(0, plan.candidateLimit);
      if (batch.length === 0) return { ran: false, reason: "no-candidates" };

      const usage: LearningReviewUsage = {};
      const records: LearningCandidateRecord[] = [];
      let promoted = 0;
      let proposed = 0;
      let dropped = 0;
      let stoppedBecause: LearningReviewStop = "all-candidates";

      for (const candidate of batch) {
        if (learningReviewTokensSpent(usage) >= plan.tokenBudget) {
          stoppedBecause = "tokens";
          break;
        }
        if (Date.now() > plan.deadline) {
          stoppedBecause = "deadline";
          break;
        }
        const judgement = await judgeLearningCandidate(
          ports.complete,
          { candidate },
          {
            maxRetries: policy.maxRetries,
            timeoutMs,
            deadline: plan.deadline,
          },
        );
        usage.inputTokens = addTokens(usage.inputTokens, judgement.usage.inputTokens);
        usage.outputTokens = addTokens(usage.outputTokens, judgement.usage.outputTokens);
        if (typeof judgement.usage.costUsd === "number") {
          usage.costUsd = (usage.costUsd ?? 0) + judgement.usage.costUsd;
        }
        const outcome = resolveLearningCandidateOutcome({
          mode: resolved.mode,
          judgement,
          candidate,
          state: candidate.state,
        });
        if (outcome.action === "promote") {
          await ports.promote({ candidate, judgement });
          promoted += 1;
        } else if (outcome.action === "propose") {
          await ports.propose({ candidate, judgement, reason: outcome.reason });
          proposed += 1;
        } else {
          await ports.drop({ candidate, judgement, reason: outcome.reason });
          dropped += 1;
        }
        records.push({
          id: candidate.id,
          artifactKind: candidate.artifactKind,
          outcome: outcome.action,
          ...(outcome.action === "promote" ? {} : { reason: outcome.reason }),
          verdict: judgement.verdict,
        });
      }

      const tokensSpent = learningReviewTokensSpent(usage);
      await ports.recordReview({
        dayStart,
        slot: plan.slot,
        mode: resolved.mode,
        rubricVersion: LEARNING_REVIEW_RUBRIC_VERSION,
        examined: records.length,
        promoted,
        proposed,
        dropped,
        tokensSpent,
        ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
        stoppedBecause,
        candidates: records,
      });

      return {
        ran: true,
        dayStart,
        slot: plan.slot,
        mode: resolved.mode,
        examined: records.length,
        promoted,
        proposed,
        dropped,
        tokensSpent,
        stoppedBecause,
      };
    },
  };
}

function addTokens(
  left: number | null | undefined,
  right: number | null | undefined,
): number | undefined {
  if (typeof right !== "number" || !Number.isFinite(right)) return left ?? undefined;
  return (left ?? 0) + right;
}

/**
 * When the next review should be offered. A review whose slot has already passed is due now,
 * so the caller wakes immediately rather than waiting for tomorrow.
 */
export function nextLearningReviewAt(input: {
  policy: LearningReviewPolicy;
  now: Date;
  reviewsToday: number;
}): Date | null {
  const slots = learningReviewSlots(
    learningReviewDayStart(input.now),
    input.policy.maxReviewsPerDay,
  );
  if (slots.length === 0) return null;
  const counted = Number.isFinite(input.reviewsToday)
    ? Math.max(Math.trunc(input.reviewsToday), 0)
    : 0;
  if (counted < slots.length) {
    const slot = slots[counted] as number;
    return new Date(Math.max(slot, input.now.getTime()));
  }
  const tomorrow = new Date(learningReviewDayStart(input.now).getTime() + 24 * 60 * 60 * 1_000);
  const next = learningReviewSlots(tomorrow, input.policy.maxReviewsPerDay)[0];
  return next === undefined ? null : new Date(next);
}
