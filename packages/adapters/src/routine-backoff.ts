import type { JobPublisher } from "@rakazo/adapter-kit";
import { ModelAccountError, routineWakeupJob } from "@rakazo/adapter-kit";
import type { RunErrorKind } from "@rakazo/contracts";
import { nextCronDateAcross, nextRoutineRunDateAcross, normalizeRunError } from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { routineSchedulerMode } from "./routine-scheduler-mode.js";

/** The first account-error failure holds the routine this long; each further one doubles it. */
const ROUTINE_ACCOUNT_BACKOFF_BASE_MS = 5 * 60_000;
const ROUTINE_ACCOUNT_BACKOFF_MAX_MS = 24 * 60 * 60_000;

interface RoutineBackoffDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
}

type RoutineSchedule = {
  active: boolean;
  crons: string[];
  timezone: string;
  watch: unknown;
  nextRunAt: Date | null;
  accountFailures: number;
};

/**
 * A rejected key, a model the account may not use or no longer has, or a balance or plan that
 * has run out.
 */
const ACCOUNT_REFUSAL_KINDS = new Set<RunErrorKind>([
  "auth",
  "access",
  "key",
  "credit",
  "spending",
  "model",
]);

/**
 * Whether the provider refused the account in a way that stays refused until the user acts or
 * until the reset it named, with that reset. Rate limits, timeouts, unusable output and periodic
 * limits without a reset time do not count.
 */
export function modelAccountRefusal(error: unknown): { resetAt?: Date } | undefined {
  if (!(error instanceof ModelAccountError)) return undefined;
  const { kind, period, resetAt } = normalizeRunError(error.message);
  if (kind === undefined || !ACCOUNT_REFUSAL_KINDS.has(kind)) return undefined;
  if (resetAt !== undefined) return { resetAt: new Date(resetAt) };
  return period === undefined || period === "none" ? {} : undefined;
}

export function routineAccountBackoffMs(failures: number): number {
  return Math.min(
    ROUTINE_ACCOUNT_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    ROUTINE_ACCOUNT_BACKOFF_MAX_MS,
  );
}

/**
 * A missing or refused model connection of the user's own fails every run the same way until
 * the user fixes it, so a frequent routine would keep firing against it. Push
 * its next run out by a gap that doubles with each such failure in a row, or to the reset the
 * provider named, at most a day away.
 */
export async function backOffRoutineAfterAccountError(
  deps: RoutineBackoffDeps,
  routineId: string,
  now = new Date(),
  resetAt?: Date,
): Promise<void> {
  await updateSchedule(deps, routineId, "routine.backoff", (routine) => {
    const accountFailures = routine.accountFailures + 1;
    if (!routine.active || !routine.nextRunAt) return { accountFailures };
    const resumeAt = new Date(
      resetAt
        ? Math.min(resetAt.getTime(), now.getTime() + ROUTINE_ACCOUNT_BACKOFF_MAX_MS)
        : now.getTime() + routineAccountBackoffMs(accountFailures),
    );
    if (routine.nextRunAt >= resumeAt) return { accountFailures };
    // A timer routine keeps its cadence after the gap; a change trigger just checks again then.
    const nextRunAt =
      (routine.watch == null
        ? nextRoutineRunDateAcross(routine.crons, routine.nextRunAt, resumeAt, routine.timezone)
        : null) ?? resumeAt;
    return { accountFailures, nextRunAt };
  });
}

/**
 * A run of the routine got through, so its schedule returns to normal: a held timer routine
 * takes its next occurrence the way turning it back on would.
 */
export async function clearRoutineBackoff(
  deps: RoutineBackoffDeps,
  routineId: string,
  now = new Date(),
): Promise<void> {
  const owner = routineTenant();
  // Most completions have nothing to clear; skip the locked write for them.
  const held = await deps.prisma.routine
    .count({ where: { id: routineId, ...owner, accountFailures: { gt: 0 } } })
    .catch((error: unknown) => {
      getLogger().error("routine.backoff_clear", error);
      return 0;
    });
  if (held === 0) return;
  await updateSchedule(deps, routineId, "routine.backoff_clear", (routine) => {
    if (routine.accountFailures === 0) return null;
    if (!routine.active || !routine.nextRunAt || routine.watch != null) {
      return { accountFailures: 0 };
    }
    const nextRunAt = nextCronDateAcross(routine.crons, now, routine.timezone);
    return nextRunAt && nextRunAt < routine.nextRunAt
      ? { accountFailures: 0, nextRunAt }
      : { accountFailures: 0 };
  });
}

function routineTenant() {
  const context = currentDbContext();
  return context?.kind === "tenant" ? { spaceId: context.spaceId, userId: context.userId } : {};
}

/**
 * Reads and writes the routine under its row lock, so a success and a failure of overlapping
 * runs cannot interleave and undo each other's schedule.
 */
async function updateSchedule(
  deps: RoutineBackoffDeps,
  routineId: string,
  logMessage: string,
  change: (routine: RoutineSchedule) => { accountFailures: number; nextRunAt?: Date } | null,
): Promise<void> {
  try {
    const owner = routineTenant();
    const result = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const versioned = await routineSchedulerMode(tx);
      if (owner.userId) {
        await tx.$queryRaw`SELECT id FROM routines WHERE id = ${routineId}
          AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId} FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM routines WHERE id = ${routineId} FOR UPDATE`;
      }
      const routine = await tx.routine.findFirst({
        where: { id: routineId, ...owner },
        select: {
          active: true,
          crons: true,
          timezone: true,
          watch: true,
          nextRunAt: true,
          accountFailures: true,
        },
      });
      const data = routine ? change(routine) : null;
      if (!data) return null;
      if (versioned && routine?.watch != null && data.nextRunAt) {
        throw new Error("Versioned routine watch execution is unavailable");
      }
      await tx.routine.update({ where: { id: routineId, ...owner }, data });
      return { nextRunAt: data.nextRunAt ?? null, versioned };
    });
    if (result?.nextRunAt && !result.versioned) {
      await deps.jobs.enqueue(routineWakeupJob(routineId, result.nextRunAt));
    }
  } catch (error) {
    getLogger().error(logMessage, error);
  }
}
