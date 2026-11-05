import {
  SETUP_SOURCE_TEST_KIND,
  SETUP_SOURCE_UNBOUND_KIND,
  SetupPlanDraftSchema,
  setupSourceForRoutine,
  setupSourceTestKey,
  setupSourceUnboundKey,
} from "@rakazo/contracts";
import { availableInSpace, type Prisma } from "@rakazo/db";

type SourceBinding =
  | { kind: typeof SETUP_SOURCE_TEST_KIND; status: "intended"; request: Prisma.InputJsonValue }
  | { kind: typeof SETUP_SOURCE_UNBOUND_KIND; status: "completed"; request: Prisma.InputJsonValue };

/** Uses the owner-scoped configured plan; an edited prompt never forces the old source. */
export async function resolveSetupSourceBinding(
  tx: Prisma.TransactionClient,
  scope: {
    routineId: string;
    spaceId: string;
    userId: string;
    botId: string;
    prompt: string;
  },
): Promise<SourceBinding | undefined> {
  const setup = await tx.setupPlan.findFirst({
    where: {
      routineId: scope.routineId,
      spaceId: scope.spaceId,
      userId: scope.userId,
      status: "configured",
    },
    select: { id: true, draft: true, configuredPrompt: true },
  });
  if (!setup) return;
  const parsed = SetupPlanDraftSchema.safeParse(setup.draft);
  const source = parsed.success ? parsed.data.source : null;
  const legacyIntegration =
    setup.configuredPrompt === null && source
      ? await tx.mcpServer.findFirst({
          where: { id: source.serverId, ...availableInSpace(scope) },
          select: { id: true, name: true, slug: true },
        })
      : null;
  const draft = setupSourceForRoutine(
    scope.prompt,
    setup.draft,
    scope.botId,
    setup.configuredPrompt,
    legacyIntegration,
  );
  if (!draft) return { kind: SETUP_SOURCE_UNBOUND_KIND, status: "completed", request: {} };
  if (setup.configuredPrompt === null) {
    const updated = await tx.setupPlan.updateMany({
      where: {
        id: setup.id,
        spaceId: scope.spaceId,
        userId: scope.userId,
        status: "configured",
        configuredPrompt: null,
      },
      data: { configuredPrompt: scope.prompt },
    });
    if (updated.count !== 1)
      return { kind: SETUP_SOURCE_UNBOUND_KIND, status: "completed", request: {} };
  }
  return {
    kind: SETUP_SOURCE_TEST_KIND,
    status: "intended",
    request: draft as Prisma.InputJsonValue,
  };
}

export async function storeSetupSourceBinding(
  tx: Prisma.TransactionClient,
  spaceId: string,
  runId: string,
  binding: SourceBinding | undefined,
) {
  if (!binding) return;
  await tx.externalEffect.create({
    data: {
      runId,
      spaceId,
      kind: binding.kind,
      status: binding.status,
      request: binding.request,
      idempotencyKey:
        binding.kind === SETUP_SOURCE_TEST_KIND
          ? setupSourceTestKey(runId)
          : setupSourceUnboundKey(runId),
      ...(binding.kind === SETUP_SOURCE_UNBOUND_KIND ? { result: { state: "unbound" } } : {}),
    },
  });
}
