import type { AccountExportRecord } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type SetupPlanRecord = Extract<AccountExportRecord, { type: "setup_plan" }>;

/** Archive records never activate a plan or reuse source-install identities. */
export async function importSetupPlan(
  prisma: PrismaClient,
  scope: { userId: string; spaceId: string },
  id: string,
  record: SetupPlanRecord,
) {
  return prisma.setupPlan.create({
    data: {
      ...scope,
      id,
      requestKey: id,
      requestPayload: record.draft,
      draft: record.draft,
      status: "draft",
      revision: 1,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    },
  });
}
