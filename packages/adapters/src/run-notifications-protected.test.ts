import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { notifyRun, runSendsFinishNotification } from "./run-notifications.js";

describe("protected setup notifications", () => {
  it("does not send or look up notification settings for protected setup", async () => {
    const send = vi.fn();
    const findFirst = vi.fn().mockResolvedValue({
      bot: { notifyOnFinish: true },
      thread: { groupId: null },
    });
    const deps = {
      notifications: { send },
      prisma: { run: { findFirst } },
    } as unknown as ExecutorDeps;
    const run = {
      spaceId: "space",
      userId: "owner",
      botId: "bot",
      threadId: "thread",
      trigger: "protected_setup_v2",
    };
    for (const kind of ["completion", "failure", "help", "takeover"] as const) {
      await notifyRun(deps, run, {
        kind,
        title: "Synthetic title",
        body: "Synthetic body",
        botId: run.botId,
        threadId: run.threadId,
      });
    }
    expect(send).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(runSendsFinishNotification(run.trigger)).toBe(false);
    expect(runSendsFinishNotification("routine")).toBe(true);
    expect(runSendsFinishNotification("user")).toBe(true);
  });
});
