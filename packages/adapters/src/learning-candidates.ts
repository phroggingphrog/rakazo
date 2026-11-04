import { createHash } from "node:crypto";

/** The three kinds of lesson a bot may collect. Persona candidates are only ever proposed. */
export type LearningCandidateKind = "memory" | "skill" | "persona";

export type LearningCandidateDraft = {
  kind: LearningCandidateKind;
  title: string;
  body: string;
  evidence: string;
  sourceRunId?: string | null;
  sourceThreadId?: string | null;
};

export type LearningCandidateRow = LearningCandidateDraft & {
  spaceId: string;
  botId: string;
  dedupeKey: string;
};

/** Shorter than this teaches nothing: "ok" and "done" are not lessons. */
export const MIN_LEARNING_CANDIDATE_BODY = 16;
/** Longer than this is a transcript, not a lesson, and would not fit a review prompt. */
export const MAX_LEARNING_CANDIDATE_BODY = 2_000;
/** Evidence is quoted into the prompt, so it is bounded the same way. */
export const MAX_LEARNING_CANDIDATE_EVIDENCE = 1_000;

function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function clip(text: string, max: number): string {
  const clean = collapse(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * The same lesson collected twice must not be judged twice, so the key is a digest of what the
 * candidate says, not of when it was found. A bot's own later wording is a new candidate.
 */
export function learningCandidateKey(input: {
  kind: LearningCandidateKind;
  title: string;
  body: string;
}): string {
  return createHash("sha256")
    .update([input.kind, collapse(input.title), collapse(input.body)].join("\n"))
    .digest("hex");
}

/** Trims and bounds one draft; returns null when there is nothing worth reviewing. */
export function buildLearningCandidate(
  draft: LearningCandidateDraft & { spaceId: string; botId: string },
): LearningCandidateRow | null {
  const title = clip(draft.title, 200);
  const body = clip(draft.body, MAX_LEARNING_CANDIDATE_BODY);
  const evidence = clip(draft.evidence, MAX_LEARNING_CANDIDATE_EVIDENCE);
  if (title.length === 0 || body.length < MIN_LEARNING_CANDIDATE_BODY) return null;
  return {
    spaceId: draft.spaceId,
    botId: draft.botId,
    kind: draft.kind,
    title,
    body,
    evidence,
    sourceRunId: draft.sourceRunId ?? null,
    sourceThreadId: draft.sourceThreadId ?? null,
    dedupeKey: learningCandidateKey({ kind: draft.kind, title, body }),
  };
}

/**
 * A memory correction: the bot replaced what it had recorded with something newer. The new text
 * is the lesson; the replaced text is the evidence that this was a correction, not a first note.
 */
export function memoryCandidateFromCorrection(input: {
  spaceId: string;
  botId: string;
  documentPath: string;
  scope: string;
  text: string;
  earlierText?: string | null;
  sourceRunId?: string | null;
  sourceThreadId?: string | null;
}): LearningCandidateRow | null {
  const earlier = collapse(input.earlierText ?? "");
  return buildLearningCandidate({
    spaceId: input.spaceId,
    botId: input.botId,
    kind: "memory",
    title: `Memory correction in ${collapse(input.documentPath) || input.scope}`,
    body: input.text,
    evidence: earlier
      ? `Replaced an earlier fact: ${earlier}`
      : `Recorded in ${input.scope}/${input.documentPath}`,
    sourceRunId: input.sourceRunId,
    sourceThreadId: input.sourceThreadId,
  });
}

/**
 * A teaching session the owner finished: the goal and playbook are the lesson, and the session
 * itself is what makes it worth reviewing.
 */
export function skillCandidateFromTaughtSession(input: {
  spaceId: string;
  botId: string;
  name: string;
  goal: string;
  sourceThreadId?: string | null;
}): LearningCandidateRow | null {
  const name = collapse(input.name);
  return buildLearningCandidate({
    spaceId: input.spaceId,
    botId: input.botId,
    kind: "skill",
    title: `Taught skill: ${name || collapse(input.goal).slice(0, 80)}`,
    body: input.goal,
    evidence: `The owner recorded a teaching session${name ? ` named "${name}"` : ""}.`,
    sourceThreadId: input.sourceThreadId,
  });
}
