import { isDeepStrictEqual } from "node:util";
import {
  SetupOperationArgumentsSchema,
  SetupPlanDraftSchema,
  WorkspaceMonitorSchema,
} from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  availableInSpace,
  contentEncryptionOf,
  currentDbContext,
  IsolationError,
} from "@rakazo/db";
import * as z from "zod";

const snapshotSchema = z
  .object({
    version: z.literal(1),
    planRevision: z.number().int().positive(),
    routineId: z.string().min(1),
    routineUpdatedAt: z.iso.datetime(),
    routineContentId: z.string().min(1),
    routineContentUpdatedAt: z.iso.datetime(),
    botId: z.string().min(1),
    serverId: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    toolName: z.string().min(1).max(200),
    arguments: SetupOperationArgumentsSchema.optional(),
    cron: z.string().min(1).max(200),
    timezone: z.string().min(1).max(200),
    notify: z.boolean(),
    assignment: z.literal("not_checked"),
    operation: z.literal("not_verified"),
    sourceAccess: z.literal("not_verified"),
  })
  .strict();

type Inspection = {
  configuration: "consistent" | "stale_or_unavailable";
  assignment: "allowed" | "blocked" | "not_checked";
  execution: "not_started";
  sourceAccess: "not_verified";
  operation: "not_verified";
};

/** Read-only diagnostic. This is not a claim, authorization, or durable execution fence. */
export async function inspectPreparedSetup(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string },
  attemptId: string,
): Promise<Inspection> {
  const context = currentDbContext();
  if (
    context?.kind !== "tenant" ||
    context.spaceId !== owner.spaceId ||
    context.userId !== owner.userId
  )
    throw new IsolationError();
  if (!contentEncryptionOf(prisma)?.ring.encryptWrites)
    throw new Error("Content encryption is required for protected setup inspection.");
  return prisma.$transaction((tx) => inspectPreparedSetupInTransaction(tx, owner, attemptId), {
    isolationLevel: "RepeatableRead",
  });
}

/** Internal diagnostic only; callers must provide matching tenant context. */
export async function inspectPreparedSetupInTransaction(
  tx: Prisma.TransactionClient,
  owner: { spaceId: string; userId: string },
  attemptId: string,
): Promise<Inspection> {
  const context = currentDbContext();
  if (
    context?.kind !== "tenant" ||
    context.spaceId !== owner.spaceId ||
    context.userId !== owner.userId
  )
    throw new IsolationError();
  const stale: Inspection = {
    configuration: "stale_or_unavailable",
    assignment: "not_checked",
    execution: "not_started",
    sourceAccess: "not_verified",
    operation: "not_verified",
  };
  const attempt = await tx.setupTestAttempt.findFirst({ where: { id: attemptId, ...owner } });
  if (attempt?.status !== "prepared" || !attempt.taskId || attempt.taskProtected !== true)
    return stale;
  const parsed = snapshotSchema.safeParse(attempt.snapshot);
  if (!parsed.success) return stale;
  const snapshot = parsed.data;
  const plan = await tx.setupPlan.findFirst({ where: { id: attempt.planId, ...owner } });
  if (
    plan?.status !== "configured" ||
    plan.revision !== attempt.planRevision ||
    plan.revision !== snapshot.planRevision ||
    plan.routineId !== snapshot.routineId
  )
    return stale;
  const draft = SetupPlanDraftSchema.safeParse(plan.draft);
  if (!draft.success) return stale;
  const input = draft.data;
  if (!input.source || !input.schedule) return stale;
  if (
    input.botId !== snapshot.botId ||
    input.source.serverId !== snapshot.serverId ||
    input.source.revision !== snapshot.sourceRevision ||
    input.source.toolName !== snapshot.toolName ||
    !isDeepStrictEqual(input.arguments, snapshot.arguments) ||
    input.schedule.cron !== snapshot.cron ||
    input.schedule.timezone !== snapshot.timezone ||
    input.notify !== snapshot.notify
  )
    return stale;
  const [bot, task, routine, server] = await Promise.all([
    tx.bot.findFirst({
      where: { id: snapshot.botId, ...owner, archivedAt: null },
      select: { id: true },
    }),
    tx.task.findFirst({
      where: { id: attempt.taskId, ...owner, botId: snapshot.botId },
      include: { protectedContent: true },
    }),
    tx.routine.findFirst({
      where: { id: snapshot.routineId, ...owner, botId: snapshot.botId },
      include: { protectedContent: true },
    }),
    tx.mcpServer.findFirst({
      where: { id: snapshot.serverId, ...availableInSpace(owner), enabled: true },
      select: { id: true, revision: true, transport: true, allBots: true },
    }),
  ]);
  if (
    !bot ||
    !task ||
    !routine ||
    !server ||
    !task.protected ||
    task.status !== "draft" ||
    !task.protectedContent ||
    task.protectedContent.userId !== owner.userId ||
    task.protectedContent.spaceId !== owner.spaceId ||
    task.protectedContent.text !== input.purpose ||
    !routine.protected ||
    routine.active ||
    !routine.protectedContent ||
    routine.protectedContent.userId !== owner.userId ||
    routine.protectedContent.spaceId !== owner.spaceId ||
    routine.protectedContent.id !== snapshot.routineContentId ||
    routine.protectedContent.text !== input.purpose ||
    routine.updatedAt.toISOString() !== snapshot.routineUpdatedAt ||
    routine.protectedContent.updatedAt.toISOString() !== snapshot.routineContentUpdatedAt ||
    routine.crons.length !== 1 ||
    routine.crons[0] !== snapshot.cron ||
    routine.timezone !== snapshot.timezone ||
    routine.notify !== snapshot.notify ||
    server.revision !== snapshot.sourceRevision ||
    server.transport === "stdio"
  )
    return stale;
  const policy = WorkspaceMonitorSchema.safeParse(routine.monitor);
  if (
    !policy.success ||
    policy.data.kind !== "email" ||
    policy.data.mode !== "report_only" ||
    policy.data.source?.connectorId !== "mcp" ||
    policy.data.source.resourceId !== snapshot.serverId ||
    policy.data.source.resourceRevision !== snapshot.sourceRevision ||
    policy.data.source.toolName !== snapshot.toolName
  )
    return stale;
  const [thread, runs, explicit] = await Promise.all([
    tx.thread.findFirst({
      where: { id: task.threadId, ...owner, botId: snapshot.botId },
      select: { id: true },
    }),
    tx.run.count({ where: { taskId: task.id } }),
    tx.botMcpServer.findFirst({
      where: { ...owner, botId: snapshot.botId, serverId: snapshot.serverId },
      select: { allowAllTools: true, allowedTools: true },
    }),
  ]);
  if (!thread || runs !== 0) return stale;
  const allowed = explicit
    ? explicit.allowAllTools ||
      (Array.isArray(explicit.allowedTools) && explicit.allowedTools.includes(snapshot.toolName))
    : server.allBots;
  return { ...stale, configuration: "consistent", assignment: allowed ? "allowed" : "blocked" };
}
