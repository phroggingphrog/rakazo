import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { prepareRunTaskForExecution, resolveRunTaskPrompt } from "./protected-run-prompt.js";

const owner = { spaceId: "space", userId: "owner" };
const run = { ...owner, id: "run", taskId: "task", botId: "bot", threadId: "thread" };
const protectedTask = {
  id: "task",
  protected: true,
  prompt: "Protected task; execution is unavailable.",
};
function fixture(bound: boolean, text: string | null = "private purpose") {
  const findFirst = vi.fn(async () => (text === null ? null : { text }));
  const query = vi.fn(async () => (bound ? [{ attemptId: "attempt" }] : []));
  const tx = { $queryRaw: query, protectedExecutionContent: { findFirst } };
  const prisma = {
    $contentEncryption: () => ({ ring: { encryptWrites: true } }),
    $transaction: async (fn: (arg: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, query, findFirst };
}

describe("run prompt resolution", () => {
  it("stops protected content at the executor boundary without mutating its legacy task", async () => {
    const f = fixture(true, "private purpose");
    const task = { ...protectedTask };
    const result = await runAsTenant(owner, () =>
      prepareRunTaskForExecution(f.prisma, run, task, "worker", 1).catch((error: Error) => error),
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain("private purpose");
    expect(task).toEqual(protectedTask);
    expect(task.prompt).not.toContain("private purpose");
    expect(f.query).not.toHaveBeenCalled();
    expect(f.findFirst).not.toHaveBeenCalled();
  });
  it("preserves ordinary task prompts without a database read", async () => {
    const f = fixture(false);
    const task = { id: "task", protected: false, prompt: "ordinary" };
    expect(await prepareRunTaskForExecution(f.prisma, run, task, "worker", 1)).toBe(task);
    expect(await resolveRunTaskPrompt(f.prisma, run, task, "worker", 1)).toBe("ordinary");
    expect(f.query).not.toHaveBeenCalled();
  });
  it("requires the matching owner, encrypted client, and exact task identity", async () => {
    const f = fixture(true);
    await expect(
      runAsTenant({ ...owner, userId: "other" }, () =>
        resolveRunTaskPrompt(f.prisma, run, protectedTask, "worker", 1),
      ),
    ).rejects.toThrow();
    await expect(
      runAsTenant(owner, () =>
        resolveRunTaskPrompt(f.prisma, run, { ...protectedTask, id: "other" }, "worker", 1),
      ),
    ).rejects.toThrow(/unavailable/);
    const plain = { ...f.prisma, $contentEncryption: () => undefined } as PrismaClient;
    await expect(
      runAsTenant(owner, () => resolveRunTaskPrompt(plain, run, protectedTask, "worker", 1)),
    ).rejects.toThrow(/unavailable/);
    expect(f.query).not.toHaveBeenCalled();
  });
  it("fails closed when the v2 binding or live lease is absent", async () => {
    const f = fixture(false);
    await expect(
      runAsTenant(owner, () => resolveRunTaskPrompt(f.prisma, run, protectedTask, "worker", 1)),
    ).rejects.toThrow(/unavailable/);
    expect(f.findFirst).not.toHaveBeenCalled();
  });
  it("returns only the owner-scoped protected text after the bound lease check", async () => {
    const f = fixture(true);
    expect(
      await runAsTenant(owner, () =>
        resolveRunTaskPrompt(f.prisma, run, protectedTask, "worker", 4),
      ),
    ).toBe("private purpose");
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { taskId: "task", ...owner, protected: true },
      select: { text: true },
    });
    const missing = fixture(true, null);
    await expect(
      runAsTenant(owner, () =>
        resolveRunTaskPrompt(missing.prisma, run, protectedTask, "worker", 4),
      ),
    ).rejects.toThrow(/unavailable/);
  });
});
