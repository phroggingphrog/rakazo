import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";

const BATCH_SIZE = 100;
const MAX_PAGES = 10;

type Intent = {
  routineId: string;
  generation: bigint;
  active: boolean;
  nextRunAt: Date | null;
  operation: string;
  uncertain: boolean;
};

/** Rebuild a volatile queue from the latest durable intents in each process. */
export function createMemoryRoutineScheduleReconciler(
  prisma: PrismaClient,
  jobs: JobPublisher & { hasPendingOrActive(key: string): boolean },
) {
  const published = new Map<string, bigint>();
  let cursor = "";
  let running: Promise<void> | undefined;

  const reconcilePage = async (): Promise<boolean> => {
    const page = await runAsSystem("reconcile in-memory routine schedules", () =>
      prisma.$transaction(async (tx) => {
        const gate = await tx.$queryRaw<Array<{ enabled: boolean }>>`
          SELECT enabled FROM routine_schedule_gate WHERE id FOR SHARE`;
        if (!gate[0]) throw new Error("Routine scheduling gate is unavailable");
        if (!gate[0].enabled) return null;
        return tx.$queryRaw<Intent[]>`
          SELECT intent."routineId", intent.generation, intent.active,
                 intent."nextRunAt" AT TIME ZONE 'UTC' AS "nextRunAt", intent.operation,
                 EXISTS (SELECT 1 FROM routine_watch_attempts AS attempt
                   WHERE attempt."routineId" = intent."routineId"
                     AND attempt.generation = intent.generation
                     AND attempt.state = 'uncertain') AS uncertain
          FROM routine_schedule_outbox AS intent WHERE intent."routineId" > ${cursor}
          ORDER BY intent."routineId" LIMIT ${BATCH_SIZE}`;
      }),
    );

    if (!page) {
      for (const id of published.keys()) await jobs.cancel(`routine:v2:${id}`);
      published.clear();
      cursor = "";
      return false;
    }

    for (const intent of page) {
      const prior = published.get(intent.routineId);
      if (prior !== undefined && intent.generation < prior) {
        cursor = intent.routineId;
        continue;
      }
      const key = `routine:v2:${intent.routineId}`;
      const due =
        !intent.uncertain && intent.operation === "upsert" && intent.active && intent.nextRunAt;
      if (!due) {
        if (prior !== undefined) await jobs.cancel(key);
        published.delete(intent.routineId);
      } else if (prior !== intent.generation || !jobs.hasPendingOrActive(key)) {
        await jobs.enqueue({
          name: "routine.wakeup",
          payload: {
            routineId: intent.routineId,
            generation: intent.generation.toString(),
            scheduledFor: due.toISOString(),
          },
          availableAt: due,
          replaceKey: key,
        });
        published.set(intent.routineId, intent.generation);
      }
      cursor = intent.routineId;
    }
    if (page.length < BATCH_SIZE) cursor = "";
    return page.length === BATCH_SIZE;
  };

  return () => {
    if (running) return running;
    running = (async () => {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        if (!(await reconcilePage())) break;
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}
