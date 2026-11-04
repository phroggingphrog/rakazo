import type { JobPublisher, NotificationProvider } from "@rakazo/adapter-kit";
import { reconcileRoutineNotificationIntents } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";

/** The durable worker must enable intent creation and its recovery together. */
export function workerRoutineNotifications(deps: {
  prisma: PrismaClient;
  notifications: NotificationProvider;
  jobs: JobPublisher;
  durable: boolean;
}) {
  return {
    executor: { routineNotificationOutbox: deps.durable },
    reconciler: deps.durable
      ? { reconcileRoutineNotifications: () => reconcileRoutineNotificationIntents(deps) }
      : {},
  };
}
