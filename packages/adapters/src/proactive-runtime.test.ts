import { describe, expect, it, vi } from "vitest";

vi.mock("@rakazo/db", () => ({
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
  runAsTenant: (_owner: unknown, fn: () => unknown) => fn(),
}));

import { createProactiveRuntime, RakazoWakeTarget } from "./proactive.js";

function fixture() {
  const prisma = {
    bot: { findFirst: vi.fn().mockResolvedValue(null) },
    run: {
      findFirst: vi.fn().mockResolvedValue({ id: "run" }),
      findUnique: vi.fn().mockResolvedValue({ botId: "one" }),
    },
    message: { findMany: vi.fn().mockResolvedValue([{ id: "message", createdAt: new Date(100) }]) },
  };
  const jobs = { enqueue: vi.fn(), cancel: vi.fn() };
  const events = { sendUserMessage: vi.fn() };
  const deps = {
    prisma,
    jobs,
    events,
    enabledBots: "one",
    judge: { version: "test", judge: vi.fn() },
  } as unknown as Parameters<typeof createProactiveRuntime>[0];
  return { prisma, runtime: createProactiveRuntime(deps), deps };
}
describe("proactive runtime trusted identity", () => {
  it("rejects controls and owner configuration outside authenticated ownership", async () => {
    const { runtime, prisma } = fixture();
    const identity = { botId: "one", spaceId: "space", userId: "owner" };
    await expect(
      runtime.control({ ...identity, action: "wake", dueAt: Date.now() + 600000 }),
    ).rejects.toThrow("owner scope");
    await expect(runtime.configure({ ...identity, config: {} })).rejects.toThrow("owner scope");
    expect(prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "one", spaceId: "space", userId: "owner", archivedAt: null },
      }),
    );
  });
  it("rejects disabled bots and too-early wakes before persistence", async () => {
    const { runtime, prisma } = fixture();
    prisma.bot.findFirst.mockResolvedValue({ id: "two" } as never);
    await expect(
      runtime.control({ botId: "two", spaceId: "space", userId: "owner", action: "get" }),
    ).rejects.toThrow("not enabled");
    prisma.bot.findFirst.mockResolvedValue({ id: "one" } as never);
    await expect(
      runtime.control({
        botId: "one",
        spaceId: "space",
        userId: "owner",
        action: "wake",
        dueAt: Date.now(),
      }),
    ).rejects.toThrow("five minutes");
  });
  it("uses queued/running state and records sent feedback with stable IDs", async () => {
    const { runtime, deps, prisma } = fixture();
    const target = new RakazoWakeTarget(deps);
    expect(await target.isWorking("bot:one")).toBe(true);
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: "one", status: { in: ["queued", "running"] } } }),
    );
    const receive = vi
      .spyOn(runtime.engine, "receive")
      .mockResolvedValue({ duplicate: false } as never);
    await runtime.recordSent("run");
    await runtime.recordSent("run");
    expect(receive).toHaveBeenNthCalledWith(1, {
      source: "sent:one",
      id: "sent:message",
      kind: "sent",
      at: 100,
      scope: "bot:one",
    });
    expect(receive.mock.calls[0]).toEqual(receive.mock.calls[1]);
  });
});
