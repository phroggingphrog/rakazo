import type { Actor, CreateRoutineInput } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRoutineAnnouncer, createRoutineScheduled } from "./routines.js";

const actor: Actor = {
  userId: "owner-1",
  spaceId: "space-1",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
const input: CreateRoutineInput = {
  botId: "bot-1",
  name: "Check",
  prompt: "Synthetic",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: true,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
};

function fixture(enabled: boolean) {
  const calls: string[] = [];
  const create = vi.fn(async ({ data }: { data: unknown }) => ({
    id: "routine-1",
    ...(data as object),
  }));
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      calls.push(sql);
      if (sql.includes("current_setting('app.rls_bypass'")) return [{ bypass: "off" }];
      if (sql.includes("FROM routine_schedule_gate")) return [{ enabled }];
      return [];
    }),
    routine: { create },
  };
  const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) };
  return { prisma, tx, calls, create };
}

describe("owner routine creation scheduling protocol", () => {
  it.each([false, true])("records gate=%s in the creation transaction", async (enabled) => {
    const f = fixture(enabled);
    const result = await createRoutineScheduled(f.prisma as never, actor, input);
    expect(result.versioned).toBe(enabled);
    expect(
      f.calls.some(
        (sql) => sql.includes("FROM routine_schedule_gate") && sql.includes("FOR SHARE"),
      ),
    ).toBe(true);
    expect(f.calls.some((sql) => sql.includes("app.scheduler_protocol"))).toBe(true);
    expect(f.create).toHaveBeenCalledOnce();
  });

  it("does not create a versioned watch while fenced watch execution is unavailable", async () => {
    const f = fixture(true);
    const watch: NonNullable<CreateRoutineInput["watch"]> = {
      kind: "files",
      paths: ["inbox"],
      everyMinutes: 5,
      loud: false,
    };
    await expect(
      createRoutineScheduled(f.prisma as never, actor, { ...input, crons: [], watch }),
    ).rejects.toThrow("Versioned routine watch execution is unavailable");
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("publishes the legacy wake only when gate=%s", async (enabled) => {
    const f = fixture(enabled);
    const { row, versioned } = await createRoutineScheduled(f.prisma as never, actor, input);
    const enqueue = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const announce = createRoutineAnnouncer({ jobs: { enqueue }, events: { append } } as never);
    await announce(actor, { id: input.botId, thread: { id: "thread-1" } }, row as never, {
      versioned,
    });
    expect(append).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledTimes(enabled ? 0 : 1);
  });
});
