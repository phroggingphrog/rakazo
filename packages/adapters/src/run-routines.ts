import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  routineJobKey,
  routineRetryJob,
  routineWakeupJob,
  runContinueJob,
  TransientModelError,
} from "@rakazo/adapter-kit";
import { SETUP_SOURCE_TEST_KIND } from "@rakazo/contracts";
import {
  displayName,
  expandSkillReferencesInPrompt,
  isOneShotRoutineCrons,
  nextRoutineRunDateAcross,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import { protectedComputerLifecycleRefusal } from "./desktop-command-guard.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { routineRunModelPin } from "./model-selection.js";
import { routineSourceEnabledForBot, routineSourceFromEnv } from "./proactive.js";
import { findPendingRoutineTick, routineTimerNonce } from "./routine-coalescing.js";
import { stableStringify, tickRoutineWatch, watchDefinitionFilter } from "./routine-watch.js";
import { isUniqueViolation } from "./run-messages.js";
import { notifyRun } from "./run-notifications.js";
import { resolveSetupSourceBinding, storeSetupSourceBinding } from "./setup-source-binding.js";
import { listAgentSkillRecords } from "./skill-tools.js";

/** A routine run stopped by a transient model error gets one more try this much later. */
const ROUTINE_RETRY_DELAY_MS = 12 * 60_000;

/** The retry is skipped when the routine's next occurrence is this close; that run covers it. */
const ROUTINE_RETRY_NEXT_RUN_WINDOW_MS = 30 * 60_000;

export async function deferFutureRoutine(
  jobs: JobPublisher,
  routineId: string,
  scheduledAt: Date,
): Promise<boolean> {
  if (scheduledAt.getTime() <= Date.now()) return false;
  await jobs.enqueue(routineWakeupJob(routineId, scheduledAt));
  return true;
}

function routineNextRunIsNear(nextRunAt: Date | null, retryAt: number): boolean {
  return Boolean(nextRunAt && nextRunAt.getTime() - retryAt <= ROUTINE_RETRY_NEXT_RUN_WINDOW_MS);
}

/**
 * Queue one later retry of a routine run that a transient model error stopped before it posted
 * a message or called a tool. Effects are keyed to their run, so a retry after either could
 * repeat them. Returns whether a retry was queued.
 */
export async function scheduleRoutineRetry(
  deps: ExecutorDeps,
  run: {
    id: string;
    threadId: string;
    trigger: string;
    routineId: string | null;
    retryOfRunId: string | null;
  },
  error: unknown,
): Promise<boolean> {
  if (
    run.trigger !== "routine" ||
    !run.routineId ||
    run.retryOfRunId ||
    !(error instanceof TransientModelError)
  ) {
    return false;
  }
  try {
    const retryAt = Date.now() + ROUTINE_RETRY_DELAY_MS;
    const [routine, toolCalls, botMessages, sourceTest] = await Promise.all([
      deps.prisma.routine.findUnique({
        where: { id: run.routineId },
        select: { nextRunAt: true },
      }),
      deps.prisma.event.count({ where: { runId: run.id, type: "agent.tool.called" } }),
      deps.prisma.message.count({
        where: { threadId: run.threadId, runId: run.id, role: "bot" },
      }),
      deps.prisma.externalEffect.findFirst({
        where: { runId: run.id, kind: SETUP_SOURCE_TEST_KIND },
        select: { id: true },
      }),
    ]);
    if (!routine || toolCalls > 0 || botMessages > 0 || sourceTest) return false;
    if (routineNextRunIsNear(routine.nextRunAt, retryAt)) return false;
    await deps.jobs.enqueue(routineRetryJob(run.id, new Date(retryAt)));
    return true;
  } catch (scheduleError) {
    getLogger().error("routine retry schedule", scheduleError);
    return false;
  }
}

async function notifyFailedRoutineRun(
  deps: ExecutorDeps,
  failed: Parameters<typeof notifyRun>[1] & { error: string | null },
  options: { retryOnFailure?: boolean } = {},
) {
  const bot = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: failed.botId },
    select: { name: true },
  });
  await notifyRun(
    deps,
    failed,
    {
      kind: "failure",
      title: `${displayName(bot.name, "Bot")} failed`,
      body: failed.error ?? "",
      botId: failed.botId,
      threadId: failed.threadId,
    },
    options,
  );
}

/** Whether scheduled routines reach the bot through the proactive pipeline. */
function routineSourceEnabled(): boolean {
  return routineSourceFromEnv(process.env);
}

/**
 * Hands a due routine to the proactive pipeline and reports whether it took it. Every
 * reason to decline — flag off, bot not on the proactive path, routine no longer due, the
 * event could not be stored — returns false so the caller starts the run the usual way.
 * A routine is never dropped here.
 */
async function routeRoutineThroughProactive(
  deps: ExecutorDeps,
  routineId: string,
  scheduledAt: Date,
): Promise<boolean> {
  const proactive = deps.proactive;
  if (!proactive?.routineSource || !routineSourceEnabled()) return false;
  try {
    const routine = await deps.prisma.routine.findUnique({
      where: { id: routineId },
      select: { id: true, botId: true, active: true, nextRunAt: true, prompt: true },
    });
    if (!routine?.active || routine.nextRunAt?.getTime() !== scheduledAt.getTime()) return true;
    if (!routineSourceEnabledForBot(process.env, routine.botId)) return false;
    if (!proactive.enabledFor(routine.botId)) return false;
    await proactive.receiveRoutine({
      botId: routine.botId,
      routineId: routine.id,
      scheduledFor: scheduledAt.getTime(),
      text: routine.prompt,
    });
    return true;
  } catch (error) {
    getLogger().error("routine proactive route", error);
    return false;
  }
}

export async function wakeRoutine(deps: ExecutorDeps, routineId: string, scheduledFor: string) {
  const scheduledAt = new Date(scheduledFor);
  if (!Number.isFinite(scheduledAt.getTime())) return;
  if (await routeRoutineThroughProactive(deps, routineId, scheduledAt)) return;
  await startRoutineRun(deps, routineId, scheduledFor);
}

/** Claims a due routine and starts its run. The pipeline calls this for a routine it woke for. */
export async function startRoutineRun(deps: ExecutorDeps, routineId: string, scheduledFor: string) {
  const scheduledAt = new Date(scheduledFor);
  if (!Number.isFinite(scheduledAt.getTime())) return;
  const routine = await deps.prisma.routine.findUnique({
    where: { id: routineId },
  });
  if (!routine?.active || routine.nextRunAt?.getTime() !== scheduledAt.getTime()) return;
  if (await deferFutureRoutine(deps.jobs, routineId, scheduledAt)) return;
  const bot = await deps.prisma.bot.findUnique({
    where: { id: routine.botId },
    include: { thread: true },
  });
  if (bot?.archivedAt) {
    // Archiving pauses a bot's routines; re-pause one that slipped back to active.
    await deps.prisma.routine.updateMany({
      where: { id: routine.id, active: true },
      data: { active: false, nextRunAt: null },
    });
    return;
  }
  if (!bot?.thread) return;
  const targetThread = routine.threadId
    ? await deps.prisma.thread.findFirst({
        where: {
          id: routine.threadId,
          spaceId: routine.spaceId,
          OR: [
            { botId: bot.id },
            {
              group: {
                archivedAt: null,
                members: { some: { botId: bot.id } },
              },
            },
          ],
        },
        select: { id: true },
      })
    : null;
  const thread = targetThread ?? bot.thread;
  // A change trigger checks first, without a model; only news becomes a run.
  const watchTick =
    routine.watch == null
      ? null
      : await tickRoutineWatch(
          { ...deps, commandRefusal: protectedComputerLifecycleRefusal },
          routine,
          { threadId: thread.id, botId: bot.id },
          scheduledAt,
        );
  if (watchTick && !watchTick.run) return;
  // A schedule with no valid parseable cron among its crons (e.g. a
  // legacy row accepted before cron validation was added) fires the
  // already-due run once, then nextRunAt stays null and the routine
  // pauses rather than crash-looping the wakeup job.
  const nextRunAt = watchTick?.run
    ? watchTick.nextRunAt
    : isOneShotRoutineCrons(routine.crons)
      ? null
      : nextRoutineRunDateAcross(
          routine.crons,
          scheduledAt,
          new Date(Date.now()),
          routine.timezone,
        );
  const skillRecords = await listAgentSkillRecords(deps.prisma, {
    spaceId: routine.spaceId,
    userId: routine.userId,
  });
  const claimed = await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.routine.updateMany({
      where: {
        id: routine.id,
        active: true,
        nextRunAt: scheduledAt,
        crons: { equals: routine.crons },
        timezone: routine.timezone,
        watch: watchDefinitionFilter(routine.watch),
        bot: { archivedAt: null },
      },
      data: {
        lastRunAt: new Date(),
        nextRunAt,
        ...(nextRunAt ? {} : { active: false }),
        ...(watchTick?.run ? { watchState: watchTick.state } : {}),
      },
    });
    if (updated.count !== 1) return null;
    // The claim locks the row, so this is the model that was committed when it fired.
    const currentModel = await tx.routine.findUnique({
      where: { id: routine.id },
      select: { modelProvider: true, modelId: true, thinkingLevel: true, prompt: true },
    });
    if (!currentModel) return null;
    const currentPrompt = currentModel.prompt ?? routine.prompt;
    const routinePrompt =
      expandSkillReferencesInPrompt(currentPrompt, skillRecords) +
      (watchTick?.run ? watchTick.note : "");
    const sourceBinding = await resolveSetupSourceBinding(tx, {
      routineId: routine.id,
      spaceId: routine.spaceId,
      userId: routine.userId,
      botId: bot.id,
      prompt: currentPrompt,
    });
    const timerTick = routine.watch == null && !isOneShotRoutineCrons(routine.crons);
    const timerNonce = timerTick ? routineTimerNonce(routine.id, scheduledFor) : undefined;
    if (timerNonce) {
      const pending = await findPendingRoutineTick(tx, {
        routineId: routine.id,
        spaceId: routine.spaceId,
        botId: bot.id,
        userId: routine.userId,
        threadId: thread.id,
        prompt: routinePrompt,
        ...(sourceBinding ? { sourceBinding } : {}),
        ...routineRunModelPin(currentModel),
      });
      if (pending) return { ...pending, coalesced: true };
      // An edit racing an earlier tick can rewind the schedule onto an occurrence that already ran.
      const fired = await tx.run.findUnique({
        where: { spaceId_clientNonce: { spaceId: routine.spaceId, clientNonce: timerNonce } },
        select: { id: true },
      });
      if (fired) return "fired" as const;
    }
    const task = await tx.task.create({
      data: {
        spaceId: routine.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: routine.userId,
        prompt: routinePrompt,
        status: "queued",
      },
    });
    const run = await tx.run.create({
      data: {
        spaceId: routine.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: routine.userId,
        status: "queued",
        trigger: "routine",
        routineId: routine.id,
        clientNonce: timerNonce,
        ...routineRunModelPin(currentModel),
      },
    });
    await storeSetupSourceBinding(tx, routine.spaceId, run.id, sourceBinding);
    return { ...run, coalesced: false };
  });
  if (!claimed) {
    const current = await deps.prisma.routine.findUnique({ where: { id: routineId } });
    if (
      current?.active &&
      current.nextRunAt?.getTime() === scheduledAt.getTime() &&
      (current.timezone !== routine.timezone ||
        JSON.stringify(current.crons) !== JSON.stringify(routine.crons) ||
        stableStringify(current.watch) !== stableStringify(routine.watch))
    ) {
      await deps.jobs.enqueue(routineWakeupJob(routine.id, scheduledAt));
    }
    return;
  }
  if (claimed === "fired") {
    if (nextRunAt) await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
    return;
  }
  if ("cancelledEvents" in claimed && claimed.cancelledEvents) {
    for (const event of claimed.cancelledEvents) {
      await deps.events.notify(event.threadId, event.seq).catch(() => undefined);
    }
  }
  // Enqueue continuation first so a thread-signal failure cannot strand the run.
  try {
    await deps.jobs.enqueue({
      ...runContinueJob(claimed.id),
      ...(claimed.coalesced ? { keepExisting: true } : {}),
    });
  } catch (error) {
    // The committed run and advanced schedule are the durable source of
    // truth. Another tick or dispatcher may already own them; recovery scans
    // repair missed notifications without rolling back committed work.
    getLogger().warn("routine.run_wakeup_failed", {
      "routine.id": routine.id,
      "run.id": claimed.id,
      error: sanitizedError(error),
    });
  }
  if (claimed.coalesced) {
    getLogger().info("routine.coalesced", {
      "routine.id": routine.id,
      "run.id": claimed.id,
    });
  }
  try {
    if (!claimed.coalesced)
      await deps.events.append({
        spaceId: routine.spaceId,
        threadId: thread.id,
        botId: bot.id,
        type: "routine.fired",
        runId: claimed.id,
        payload: { routineId: routine.id, scheduledFor },
      });
  } catch {
    // Best effort: the run is already queued.
  }
  if (isOneShotRoutineCrons(routine.crons)) {
    try {
      await deps.jobs.cancel(routineJobKey(routine.id));
    } catch {
      // Best effort: the run is already queued for continuation.
    }
  } else if (nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  }
}

export async function notifyRoutineRetryAttemptsExhausted(deps: ExecutorDeps, runId: string) {
  const failed = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (
    !failed?.routineId ||
    failed.trigger !== "routine" ||
    failed.status !== "failed" ||
    failed.retryOfRunId
  ) {
    return;
  }
  const supersedingRun = await deps.prisma.run.findFirst({
    where: {
      OR: [
        { retryOfRunId: failed.id },
        { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
      ],
    },
    select: { id: true },
  });
  if (supersedingRun) return;
  await notifyFailedRoutineRun(deps, failed, { retryOnFailure: true });
}

export async function retryRoutineRun(deps: ExecutorDeps, runId: string) {
  const failed = await deps.prisma.run.findUnique({ where: { id: runId } });
  if (
    !failed?.routineId ||
    failed.trigger !== "routine" ||
    failed.status !== "failed" ||
    failed.retryOfRunId
  ) {
    return;
  }
  const routine = await deps.prisma.routine.findUnique({
    where: { id: failed.routineId },
    select: {
      active: true,
      crons: true,
      nextRunAt: true,
      bot: { select: { archivedAt: true } },
    },
  });
  const laterRun = await deps.prisma.run.findFirst({
    where: { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
    select: { id: true },
  });
  if (laterRun) return;
  const notifyAbandonedRetry = () => notifyFailedRoutineRun(deps, failed, { retryOnFailure: true });
  if (routine && routineNextRunIsNear(routine.nextRunAt, Date.now())) {
    await notifyAbandonedRetry();
    return;
  }
  // A one-time routine turns itself off when it fires, so only a recurring one counts as paused.
  if (
    !routine ||
    (!routine.active && !isOneShotRoutineCrons(routine.crons)) ||
    routine.bot.archivedAt
  ) {
    await notifyAbandonedRetry();
    return;
  }
  const task = await deps.prisma.task.findUnique({
    where: { id: failed.taskId },
    select: { prompt: true },
  });
  if (!task) {
    await notifyAbandonedRetry();
    return;
  }
  let retry: { id: string; taskId: string } | null;
  try {
    retry = await deps.prisma.$transaction(async (tx) => {
      // Claim the still-eligible routine without changing its state. One-shot routines
      // may already be inactive; match their crons so an edit cannot revive a paused routine.
      const claimed = await tx.routine.updateMany({
        where: {
          id: failed.routineId!,
          active: routine.active,
          ...(!routine.active ? { crons: { equals: routine.crons } } : {}),
          bot: { archivedAt: null },
        },
        data: { active: routine.active },
      });
      if (claimed.count !== 1) return null;
      const laterRun = await tx.run.findFirst({
        where: { routineId: failed.routineId!, createdAt: { gt: failed.createdAt } },
        select: { id: true },
      });
      if (laterRun) return null;
      const targetThread = await tx.thread.findFirst({
        where: {
          id: failed.threadId,
          spaceId: failed.spaceId,
          OR: [
            { botId: failed.botId },
            {
              group: {
                archivedAt: null,
                members: { some: { botId: failed.botId } },
              },
            },
          ],
        },
        select: { id: true },
      });
      if (!targetThread) return null;
      const retryTask = await tx.task.create({
        data: {
          spaceId: failed.spaceId,
          botId: failed.botId,
          threadId: failed.threadId,
          userId: failed.userId,
          prompt: task.prompt,
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          spaceId: failed.spaceId,
          botId: failed.botId,
          threadId: failed.threadId,
          taskId: retryTask.id,
          userId: failed.userId,
          status: "queued",
          trigger: "routine",
          routineId: failed.routineId,
          retryOfRunId: failed.id,
          ...(failed.modelPinned
            ? {
                modelProvider: failed.modelProvider,
                modelId: failed.modelId,
                thinkingLevel: failed.thinkingLevel,
                modelPinned: true,
              }
            : {}),
        },
      });
    });
  } catch (error) {
    // retryOfRunId is unique: another delivery of this job already queued the retry.
    if (isUniqueViolation(error)) return;
    throw error;
  }
  if (!retry) {
    const laterRun = await deps.prisma.run.findFirst({
      where: { routineId: failed.routineId, createdAt: { gt: failed.createdAt } },
      select: { id: true },
    });
    if (laterRun) return;
    await notifyAbandonedRetry();
    return;
  }
  try {
    await deps.jobs.enqueue(runContinueJob(retry.id));
  } catch (error) {
    // Remove the retry so the job queue's own retry of this job can queue it again.
    const queuedRetry = retry;
    await deps.prisma.$transaction(async (tx) => {
      const removed = await tx.run.deleteMany({
        where: { id: queuedRetry.id, status: "queued" },
      });
      if (removed.count === 1) {
        await tx.task.deleteMany({ where: { id: queuedRetry.taskId, status: "queued" } });
      }
    });
    throw error;
  }
}
