import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { inspectPreparedSetup } from "./protected-setup-validation.js";

const owner = { spaceId: "space", userId: "owner" };
const now = new Date("2026-11-04T00:00:00.000Z");
function fixture() {
  const source = { serverId: "server", revision: 1, toolName: "read" };
  const schedule = { cron: "0 9 * * *", timezone: "UTC" };
  const snapshot = {
    version: 1,
    planRevision: 3,
    routineId: "routine",
    routineUpdatedAt: now.toISOString(),
    routineContentId: "content",
    routineContentUpdatedAt: now.toISOString(),
    botId: "bot",
    serverId: "server",
    sourceRevision: 1,
    toolName: "read",
    ...schedule,
    notify: true,
    assignment: "not_checked",
    operation: "not_verified",
    sourceAccess: "not_verified",
  };
  const attempt = {
    id: "attempt",
    planId: "plan",
    planRevision: 3,
    taskId: "task",
    taskProtected: true,
    status: "prepared",
    snapshot,
  };
  const draft = {
    kind: "email_monitor",
    purpose: "private purpose",
    botId: "bot",
    source,
    schedule,
    notify: true,
  };
  const plan = { id: "plan", revision: 3, status: "configured", routineId: "routine", draft };
  const content = { ...owner, text: draft.purpose };
  const task = {
    id: "task",
    threadId: "thread",
    protected: true,
    status: "draft",
    protectedContent: content,
  };
  const routine = {
    protected: true,
    active: false,
    protectedContent: { ...content, id: "content", updatedAt: now },
    updatedAt: now,
    crons: [schedule.cron],
    timezone: schedule.timezone,
    notify: true,
    monitor: {
      kind: "email",
      mode: "report_only",
      source: { connectorId: "mcp", resourceId: "server", resourceRevision: 1, toolName: "read" },
    },
  };
  const server = { id: "server", revision: 1, transport: "http", allBots: true };
  const assignment = { allowAllTools: false, allowedTools: ["other"] };
  const tx = {
    setupTestAttempt: { findFirst: vi.fn(async () => attempt) },
    setupPlan: { findFirst: vi.fn(async () => plan) },
    bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
    task: { findFirst: vi.fn(async () => task) },
    routine: { findFirst: vi.fn(async () => routine) },
    mcpServer: { findFirst: vi.fn(async () => server) },
    thread: { findFirst: vi.fn(async () => ({ id: "thread" })) },
    run: { count: vi.fn(async () => 0) },
    botMcpServer: { findFirst: vi.fn(async () => assignment) },
  };
  const prisma = {
    $contentEncryption: () => ({ ring: { encryptWrites: true } }),
    $transaction: async (fn: (arg: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  const inspect = () => runAsTenant(owner, () => inspectPreparedSetup(prisma, owner, "attempt"));
  return { inspect, prisma, tx, snapshot, plan, task, routine, server, assignment };
}

describe("protected setup inspection", () => {
  it("detects changes to reviewed arguments after snapshot preparation", async () => {
    const f = fixture();
    Object.assign(f.plan.draft, { arguments: { query: "sample" } });
    expect((await f.inspect()).configuration).toBe("stale_or_unavailable");
    Object.assign(f.snapshot, { arguments: { query: "sample" } });
    expect((await f.inspect()).configuration).toBe("consistent");
    Object.assign(f.plan.draft, { arguments: { query: "changed" } });
    expect((await f.inspect()).configuration).toBe("stale_or_unavailable");
  });
  it("reports local assignment but never treats it as source access or execution", async () => {
    const f = fixture();
    const result = await f.inspect();
    expect(result).toEqual({
      configuration: "consistent",
      assignment: "blocked",
      execution: "not_started",
      sourceAccess: "not_verified",
      operation: "not_verified",
    });
    expect(JSON.stringify(result)).not.toContain("private purpose");
    f.assignment.allowedTools = ["read"];
    expect((await f.inspect()).assignment).toBe("allowed");
  });
  it("fails closed for drift, malformed snapshots, or already attached runs", async () => {
    const f = fixture();
    f.server.revision = 2;
    expect((await f.inspect()).configuration).toBe("stale_or_unavailable");
    f.server.revision = 1;
    f.snapshot.routineUpdatedAt = new Date(now.getTime() - 1000).toISOString();
    expect((await f.inspect()).configuration).toBe("stale_or_unavailable");
    f.snapshot.routineUpdatedAt = now.toISOString();
    f.tx.run.count.mockResolvedValue(1);
    expect((await f.inspect()).configuration).toBe("stale_or_unavailable");
    f.tx.run.count.mockResolvedValue(0);
    f.snapshot.version = 2;
    expect((await f.inspect()).configuration).toBe("stale_or_unavailable");
  });
  it("requires matching tenant context and an encrypting client before any database work", async () => {
    const f = fixture();
    await expect(inspectPreparedSetup(f.prisma, owner, "attempt")).rejects.toThrow();
    await expect(
      runAsTenant({ ...owner, userId: "other" }, () =>
        inspectPreparedSetup(f.prisma, owner, "attempt"),
      ),
    ).rejects.toThrow();
    const unencrypted = { ...f.prisma, $contentEncryption: () => undefined } as PrismaClient;
    await expect(
      runAsTenant(owner, () => inspectPreparedSetup(unencrypted, owner, "attempt")),
    ).rejects.toThrow(/encryption/i);
    expect(f.tx.setupTestAttempt.findFirst).not.toHaveBeenCalled();
  });
});
