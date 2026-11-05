import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  collectLearningCandidates,
  learningCollectorEnabled,
} from "./learning-candidate-collector.js";

const now = new Date("2026-11-04T12:00:00.000Z");

function harness(input: {
  corrections?: Record<string, unknown>[];
  replaced?: { id: string; text: string }[];
  teachings?: Record<string, unknown>[];
  createdCount?: number;
}) {
  const findMany = vi
    .fn()
    .mockResolvedValueOnce(input.corrections ?? [])
    .mockResolvedValueOnce(input.replaced ?? []);
  const createMany = vi.fn().mockResolvedValue({ count: input.createdCount ?? 1 });
  const prisma = {
    memoryFact: { findMany },
    taughtSkill: { findMany: vi.fn().mockResolvedValue(input.teachings ?? []) },
    learningCandidate: { createMany },
  } as unknown as PrismaClient;
  return { prisma, createMany, findMany };
}

const correction = {
  id: "fact-2",
  text: "The owner prefers the train over driving to the city.",
  supersedesFactId: "fact-1",
  sourceRunId: "run-1",
  sourceThreadId: "thread-1",
  document: { spaceId: "space-1", botId: "bot-1", path: "preferences.md", scope: "private" },
};

describe("learning candidate collector", () => {
  it("collects nothing when its flag and the per-bot switch are off", async () => {
    const { prisma, createMany } = harness({ corrections: [correction] });

    const result = await collectLearningCandidates({
      prisma,
      now,
      env: { RAKAZO_SELF_CONFIG_BOTS: "none" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({ enabled: false, examined: 0, created: 0, skipped: "disabled" });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("accepts the documented flag spellings only", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(
        learningCollectorEnabled({ RAKAZO_LEARNING_CANDIDATES: raw } as NodeJS.ProcessEnv),
      ).toBe(true);
    }
    for (const raw of ["", "0", "false", "off", "enabled"]) {
      expect(
        learningCollectorEnabled({
          RAKAZO_LEARNING_CANDIDATES: raw,
          RAKAZO_SELF_CONFIG_BOTS: "none",
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
    // Unset everything: the per-bot switch defaults to every bot.
    expect(learningCollectorEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });

  it("turns a correction into a memory candidate carrying the replaced fact as evidence", async () => {
    const { prisma, createMany } = harness({
      corrections: [correction],
      replaced: [{ id: "fact-1", text: "The owner drives to the city." }],
    });

    const result = await collectLearningCandidates({
      prisma,
      now,
      env: { RAKAZO_LEARNING_CANDIDATES: "1" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({ enabled: true, examined: 1, created: 1 });
    const rows = createMany.mock.calls[0]?.[0]?.data as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      spaceId: "space-1",
      botId: "bot-1",
      kind: "memory",
      sourceRunId: "run-1",
      sourceThreadId: "thread-1",
      payload: {
        title: "Memory correction in preferences.md",
        body: "The owner prefers the train over driving to the city.",
        evidence: "Replaced an earlier fact: The owner drives to the city.",
      },
    });
    expect(String(rows[0]?.dedupeKey)).toHaveLength(64);
    expect(createMany.mock.calls[0]?.[0]?.skipDuplicates).toBe(true);
  });

  it("skips a space-scoped document, which belongs to no bot", async () => {
    const { prisma, createMany } = harness({
      corrections: [{ ...correction, document: { ...correction.document, botId: null } }],
    });

    const result = await collectLearningCandidates({
      prisma,
      now,
      env: { RAKAZO_LEARNING_CANDIDATES: "1" } as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({ enabled: true, examined: 1, created: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("collects a finished teaching session as a skill candidate", async () => {
    const { prisma, createMany } = harness({
      teachings: [
        {
          id: "taught-1",
          spaceId: "space-1",
          botId: "bot-1",
          name: "Invoice chase",
          goal: "Chase overdue invoices politely, one reminder per invoice.",
        },
      ],
    });

    await collectLearningCandidates({
      prisma,
      now,
      env: { RAKAZO_LEARNING_CANDIDATES: "1" } as NodeJS.ProcessEnv,
    });

    const rows = createMany.mock.calls[0]?.[0]?.data as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      kind: "skill",
      payload: { title: "Taught skill: Invoice chase" },
    });
    const payload = rows[0]?.payload as Record<string, unknown> | undefined;
    expect(String(payload?.body)).toContain("overdue invoices");
  });

  it("stores the same lesson once even when two sources report it", async () => {
    const { prisma, createMany } = harness({
      corrections: [correction, { ...correction, id: "fact-3" }],
      replaced: [{ id: "fact-1", text: "The owner drives to the city." }],
    });

    await collectLearningCandidates({
      prisma,
      now,
      env: { RAKAZO_LEARNING_CANDIDATES: "1" } as NodeJS.ProcessEnv,
    });

    const rows = createMany.mock.calls[0]?.[0]?.data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });
});
