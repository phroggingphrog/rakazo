import { describe, expect, it, vi } from "vitest";
import { createProtectedTaskDraft, PROTECTED_TASK_PLACEHOLDER } from "./protected-task.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const owner = { spaceId: "space-a", userId: "user-a" };
const input = { botId: "bot-a", threadId: "thread-a", prompt: "synthetic private objective" };
function fixture() {
  const state = { encrypted: true, bot: true, thread: true };
  const task = { create: vi.fn(async () => ({ id: "task-a" })) };
  const tx = {
    bot: { findFirst: vi.fn(async () => (state.bot ? { id: input.botId } : null)) },
    thread: { findFirst: vi.fn(async () => (state.thread ? { id: input.threadId } : null)) },
    protectedExecutionContent: { create: vi.fn(async () => ({ id: "content-a" })) },
    task,
  };
  const prisma = {
    $contentEncryption: () => ({ ring: { encryptWrites: state.encrypted } }),
    $transaction: async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { state, tx, task, prisma };
}
describe("protected task draft", () => {
  it("requires the actual tenant context and content encryption", async () => {
    const f = fixture();
    await expect(createProtectedTaskDraft(f.prisma as never, owner, input)).rejects.toThrow();
    await expect(
      runAsSystem("synthetic test", () =>
        createProtectedTaskDraft(f.prisma as never, owner, input),
      ),
    ).rejects.toThrow();
    await expect(
      runAsTenant({ ...owner, userId: "user-b" }, () =>
        createProtectedTaskDraft(f.prisma as never, owner, input),
      ),
    ).rejects.toThrow();
    f.state.encrypted = false;
    await expect(
      runAsTenant(owner, () => createProtectedTaskDraft(f.prisma as never, owner, input)),
    ).rejects.toThrow("Content encryption");
    expect(f.task.create).not.toHaveBeenCalled();
  });
  it("validates owner-scoped bot and thread and stores the private prompt only in the protected field", async () => {
    const f = fixture();
    await expect(
      runAsTenant(owner, () => createProtectedTaskDraft(f.prisma as never, owner, input)),
    ).resolves.toEqual({ id: "task-a" });
    expect(f.tx.bot.findFirst).toHaveBeenCalledWith({
      where: { id: input.botId, ...owner, archivedAt: null },
      select: { id: true },
    });
    expect(f.tx.thread.findFirst).toHaveBeenCalledWith({
      where: { id: input.threadId, ...owner, botId: input.botId },
      select: { id: true },
    });
    expect(f.task.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        ...owner,
        botId: input.botId,
        threadId: input.threadId,
        prompt: PROTECTED_TASK_PLACEHOLDER,
        protected: true,
        status: "draft",
      },
      select: { id: true },
    });
    expect(f.tx.protectedExecutionContent.create).toHaveBeenCalledExactlyOnceWith({
      data: { ...owner, taskId: "task-a", text: input.prompt },
    });
  });
  it("does not write when the bot, thread or prompt is invalid", async () => {
    const f = fixture();
    await expect(
      runAsTenant(owner, () =>
        createProtectedTaskDraft(f.prisma as never, owner, { ...input, prompt: "   " }),
      ),
    ).rejects.toThrow();
    f.state.bot = false;
    await expect(
      runAsTenant(owner, () => createProtectedTaskDraft(f.prisma as never, owner, input)),
    ).rejects.toThrow();
    f.state.bot = true;
    f.state.thread = false;
    await expect(
      runAsTenant(owner, () => createProtectedTaskDraft(f.prisma as never, owner, input)),
    ).rejects.toThrow();
    expect(f.task.create).not.toHaveBeenCalled();
  });
});
