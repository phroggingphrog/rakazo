import type { PrismaClient } from "@rakazo/db";
import {
  type LearningCandidateRow,
  memoryCandidateFromCorrection,
  skillCandidateFromTaughtSession,
} from "./learning-candidates.js";

/**
 * The collector writes rows, so it stays off until the owner turns it on. Unset means off: a
 * deployment that upgrades without reading this flag collects nothing and reviews nothing.
 */
export const LEARNING_COLLECTOR_FLAG = "RAKAZO_LEARNING_CANDIDATES";
/** How far back one collection looks. Long enough for a nightly pass, short enough to bound it. */
export const LEARNING_COLLECTOR_WINDOW_MINUTES = 24 * 60;
/** One pass never stores more than this many candidates, so a burst cannot flood a review. */
export const LEARNING_COLLECTOR_MAX_CANDIDATES = 25;

export function learningCollectorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LEARNING_COLLECTOR_FLAG]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export type LearningCollectorDeps = {
  prisma: PrismaClient;
  now?: Date;
  windowMinutes?: number;
  maxCandidates?: number;
  env?: NodeJS.ProcessEnv;
};

export type LearningCollectorResult = {
  enabled: boolean;
  /** Correction facts and finished teachings the pass looked at. */
  examined: number;
  /** Rows the database accepted; a duplicate key is an existing candidate, not an error. */
  created: number;
  /** Why the pass did not look, when it did not. */
  skipped?: "disabled";
};

/**
 * Turns recent evidence into pending candidates. The evidence is the bot's own stores — facts it
 * corrected in a run, and teaching sessions the owner finished — so this adds no second memory.
 * Nothing is promoted here: a candidate is only a question for the next review.
 */
export async function collectLearningCandidates(
  deps: LearningCollectorDeps,
): Promise<LearningCollectorResult> {
  if (!learningCollectorEnabled(deps.env ?? process.env)) {
    return { enabled: false, examined: 0, created: 0, skipped: "disabled" };
  }
  const now = deps.now ?? new Date();
  const since = new Date(
    now.getTime() - (deps.windowMinutes ?? LEARNING_COLLECTOR_WINDOW_MINUTES) * 60_000,
  );
  const budget = deps.maxCandidates ?? LEARNING_COLLECTOR_MAX_CANDIDATES;
  const { prisma } = deps;

  const corrections = await prisma.memoryFact.findMany({
    where: { createdAt: { gte: since }, supersedesFactId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: budget,
    select: {
      id: true,
      text: true,
      supersedesFactId: true,
      sourceRunId: true,
      sourceThreadId: true,
      document: { select: { spaceId: true, botId: true, path: true, scope: true } },
    },
  });
  const replacedIds = corrections
    .map((fact) => fact.supersedesFactId)
    .filter((id): id is string => typeof id === "string");
  const replaced =
    replacedIds.length === 0
      ? []
      : await prisma.memoryFact.findMany({
          where: { id: { in: replacedIds } },
          select: { id: true, text: true },
        });
  const replacedText = new Map(replaced.map((fact) => [fact.id, fact.text]));

  const teachings = await prisma.taughtSkill.findMany({
    where: { status: "completed", updatedAt: { gte: since } },
    orderBy: { updatedAt: "desc" },
    take: budget,
    select: { id: true, spaceId: true, botId: true, name: true, goal: true },
  });

  const drafts: LearningCandidateRow[] = [];
  for (const fact of corrections) {
    // A space-scoped document belongs to no bot, so there is no bot to review it for.
    const botId = fact.document.botId;
    if (!botId) continue;
    const candidate = memoryCandidateFromCorrection({
      spaceId: fact.document.spaceId,
      botId,
      documentPath: fact.document.path,
      scope: fact.document.scope,
      text: fact.text,
      earlierText: fact.supersedesFactId ? (replacedText.get(fact.supersedesFactId) ?? null) : null,
      sourceRunId: fact.sourceRunId,
      sourceThreadId: fact.sourceThreadId,
    });
    if (candidate) drafts.push(candidate);
  }
  for (const taught of teachings) {
    const candidate = skillCandidateFromTaughtSession({
      spaceId: taught.spaceId,
      botId: taught.botId,
      name: taught.name,
      goal: taught.goal,
    });
    if (candidate) drafts.push(candidate);
  }

  const seen = new Set<string>();
  const unique = drafts.filter((row) => {
    const key = `${row.botId}:${row.dedupeKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0)
    return { enabled: true, examined: corrections.length + teachings.length, created: 0 };
  const written = await prisma.learningCandidate.createMany({
    data: unique.slice(0, budget).map((row) => ({
      spaceId: row.spaceId,
      botId: row.botId,
      kind: row.kind,
      dedupeKey: row.dedupeKey,
      sourceRunId: row.sourceRunId ?? null,
      sourceThreadId: row.sourceThreadId ?? null,
      payload: { title: row.title, body: row.body, evidence: row.evidence },
    })),
    skipDuplicates: true,
  });
  return { enabled: true, examined: corrections.length + teachings.length, created: written.count };
}
