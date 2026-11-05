import { ORPCError } from "@orpc/server";
import { CreateRoutineInput, SetupPlanDraftSchema, setupRoutinePrompt } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { discoverMonitorTools } from "../monitor-tool-discovery.js";
import { nextRoutineDate, routineNextRunAt, routineRowData } from "../routines.js";
import type { RouterContext } from "./context.js";

async function lockSetupReferences(
  tx: Prisma.TransactionClient,
  scope: { spaceId: string; userId: string },
  botId: string,
  source: { serverId: string; revision: number },
) {
  const bots = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM bots WHERE id = ${botId}
      AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId}
      AND "archivedAt" IS NULL FOR SHARE`;
  const servers = await tx.$queryRaw<
    Array<{
      id: string;
      name: string;
      slug: string;
      spaceId: string;
      allSpaces: boolean;
      allBots: boolean;
      revision: number;
      transport: string;
    }>
  >`
    SELECT id, name, slug, "spaceId", "allSpaces", "allBots", revision, transport FROM mcp_servers
    WHERE id = ${source.serverId} AND "userId" = ${scope.userId}
      AND enabled = true FOR SHARE`;
  const server = servers[0];
  if (!bots.length || !server)
    throw new ORPCError("NOT_FOUND", { message: "Bot or integration is unavailable." });
  if (server.spaceId !== scope.spaceId && !server.allSpaces) {
    const availability = await tx.$queryRaw<Array<{ serverId: string }>>`
      SELECT "serverId" FROM mcp_server_spaces WHERE "serverId" = ${server.id}
        AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR SHARE`;
    if (!availability.length)
      throw new ORPCError("NOT_FOUND", { message: "Bot or integration is unavailable." });
  }
  if (server.revision !== source.revision)
    throw new ORPCError("CONFLICT", { message: "Integration changed; review it again." });
  return server;
}

export { setupRoutinePrompt } from "@rakazo/contracts";

function dto(row: {
  id: string;
  revision: number;
  status: string;
  draft: unknown;
  routineId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  if (row.status !== "draft" && row.status !== "proposed" && row.status !== "configured")
    throw new Error("Unsupported setup plan state");
  return {
    id: row.id,
    revision: row.revision,
    status: row.status as "draft" | "proposed" | "configured",
    routineId: row.routineId ?? null,
    sourceAccess: "not_verified" as const,
    botAssignment: "not_checked" as const,
    draft: SetupPlanDraftSchema.parse(row.draft),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function setupPlansRoutes({ deps, authed }: RouterContext) {
  return {
    setupPlans: {
      previewReads: authed.setupPlans.previewReads.handler(async ({ context, input }) => {
        const result = await discoverMonitorTools(deps, context.actor, {
          botId: input.botId,
          serverId: input.serverId,
          setupPreview: true,
          signal: context.signal,
        });
        if (context.stillAuthorized && !(await context.stillAuthorized()))
          throw new ORPCError("UNAUTHORIZED");
        return result;
      }),
      grantRead: authed.setupPlans.grantRead.handler(async ({ context, input }) => {
        const found = await discoverMonitorTools(deps, context.actor, {
          botId: input.botId,
          serverId: input.serverId,
          expectedRevision: input.revision,
          setupPreview: true,
          signal: context.signal,
        });
        if (context.stillAuthorized && !(await context.stillAuthorized()))
          throw new ORPCError("UNAUTHORIZED");
        if (found.status !== "ok" || !found.tools.some((tool) => tool.name === input.toolName))
          throw new ORPCError("CONFLICT", {
            message: "Read operation is unavailable; find operations again.",
          });
        const scope = { spaceId: context.actor.spaceId, userId: context.actor.userId };
        return deps.prisma.$transaction(async (tx) => {
          const server = await lockSetupReferences(tx, scope, input.botId, {
            serverId: input.serverId,
            revision: input.revision,
          });
          const assignment = await tx.botMcpServer.findFirst({
            where: { ...scope, botId: input.botId, serverId: input.serverId },
          });
          if (!assignment && !server.allBots) {
            try {
              await tx.botMcpServer.create({
                data: {
                  ...scope,
                  botId: input.botId,
                  serverId: input.serverId,
                  allowAllTools: false,
                  allowedTools: [input.toolName],
                },
              });
            } catch (error) {
              if (error && typeof error === "object" && "code" in error && error.code === "P2002")
                throw new ORPCError("CONFLICT", {
                  message: "Bot access changed; review and try again.",
                });
              throw error;
            }
          }
          if (assignment && !assignment.allowAllTools) {
            if (
              !Array.isArray(assignment.allowedTools) ||
              !assignment.allowedTools.every((tool) => typeof tool === "string")
            )
              throw new ORPCError("CONFLICT", {
                message: "Bot access needs review in integration settings.",
              });
            if (!assignment.allowedTools.includes(input.toolName)) {
              if (assignment.allowedTools.length >= 500)
                throw new ORPCError("CONFLICT", {
                  message: "The bot's operation limit was reached.",
                });
              const changed = await tx.botMcpServer.updateMany({
                where: {
                  ...scope,
                  id: assignment.id,
                  allowAllTools: false,
                  updatedAt: assignment.updatedAt,
                  allowedTools: { equals: assignment.allowedTools as Prisma.InputJsonValue },
                },
                data: { allowedTools: [...assignment.allowedTools, input.toolName] },
              });
              if (changed.count !== 1)
                throw new ORPCError("CONFLICT", {
                  message: "Bot access changed; review and try again.",
                });
            }
          }
          return { status: "allowed" as const };
        });
      }),
      create: authed.setupPlans.create.handler(async ({ context, input }) => {
        const scope = { spaceId: context.actor.spaceId, userId: context.actor.userId };
        const key = { ...scope, requestKey: input.requestKey };
        try {
          return dto(
            await deps.prisma.setupPlan.create({
              data: { ...key, draft: input.draft, requestPayload: input.draft },
            }),
          );
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "P2002"))
            throw error;
          const prior = await deps.prisma.setupPlan.findFirst({ where: key });
          if (!prior) throw error;
          if (
            JSON.stringify(SetupPlanDraftSchema.parse(prior.requestPayload)) !==
            JSON.stringify(input.draft)
          )
            throw new ORPCError("CONFLICT", {
              message: "Request key already used for a different proposal.",
            });
          return dto(prior);
        }
      }),
      get: authed.setupPlans.get.handler(async ({ context, input }) => {
        const row = await deps.prisma.setupPlan.findFirst({
          where: { id: input.id, spaceId: context.actor.spaceId, userId: context.actor.userId },
        });
        if (!row) throw new ORPCError("NOT_FOUND");
        return dto(row);
      }),
      prerequisites: authed.setupPlans.prerequisites.handler(async ({ context, input }) => {
        const scope = { spaceId: context.actor.spaceId, userId: context.actor.userId };
        return deps.prisma.$transaction(
          async (tx) => {
            const plan = await tx.setupPlan.findFirst({ where: { id: input.id, ...scope } });
            if (!plan) throw new ORPCError("NOT_FOUND");
            if (plan.revision !== input.expectedRevision)
              throw new ORPCError("CONFLICT", { message: "Setup plan changed; reload it." });
            const parsed = SetupPlanDraftSchema.safeParse(plan.draft);
            if (!parsed.success)
              throw new ORPCError("BAD_REQUEST", { message: "Fix the setup plan first." });
            const draft = parsed.data;
            const [bot, server] = await Promise.all([
              draft.botId
                ? tx.bot.findFirst({
                    where: { id: draft.botId, ...scope, archivedAt: null },
                    select: { id: true },
                  })
                : null,
              draft.source
                ? tx.mcpServer.findFirst({
                    where: { id: draft.source.serverId, ...availableInSpace(scope), enabled: true },
                    select: { id: true, revision: true, transport: true, allBots: true },
                  })
                : null,
            ]);
            const source = !draft.source
              ? "not_selected"
              : !server
                ? "unavailable"
                : server.revision !== draft.source.revision
                  ? "changed"
                  : "available";
            let assignment: "not_checked" | "configured" | "not_configured" = "not_checked";
            let selectedTool: "not_checked" | "allowed" | "blocked" = "not_checked";
            if (bot && server && source === "available") {
              const explicit = await tx.botMcpServer.findFirst({
                where: { ...scope, botId: bot.id, serverId: server.id },
                select: { allowAllTools: true, allowedTools: true },
              });
              assignment = server.allBots || explicit ? "configured" : "not_configured";
              if (explicit) {
                selectedTool =
                  explicit.allowAllTools ||
                  (Array.isArray(explicit.allowedTools) &&
                    explicit.allowedTools.includes(draft.source!.toolName))
                    ? "allowed"
                    : "blocked";
              } else if (server.allBots) selectedTool = "allowed";
            }
            return {
              planRevision: plan.revision,
              bot: !draft.botId
                ? ("not_selected" as const)
                : bot
                  ? ("available" as const)
                  : ("unavailable" as const),
              source,
              assignment,
              selectedTool,
              operation: "not_verified" as const,
              sourceAccess: "not_verified" as const,
            };
          },
          { isolationLevel: "RepeatableRead" },
        );
      }),
      discoverCandidates: authed.setupPlans.discoverCandidates.handler(
        async ({ context, input }) => {
          const scope = { spaceId: context.actor.spaceId, userId: context.actor.userId };
          const inspect = () =>
            deps.prisma.$transaction(
              async (tx) => {
                const plan = await tx.setupPlan.findFirst({ where: { id: input.id, ...scope } });
                if (!plan) throw new ORPCError("NOT_FOUND");
                if (plan.revision !== input.expectedRevision)
                  throw new ORPCError("CONFLICT", { message: "Setup plan changed; reload it." });
                const parsed = SetupPlanDraftSchema.safeParse(plan.draft);
                if (!parsed.success || !parsed.data.botId || !parsed.data.source)
                  throw new ORPCError("BAD_REQUEST", {
                    message: "Select a bot and integration first.",
                  });
                const { botId, source } = parsed.data;
                const [bot, server] = await Promise.all([
                  tx.bot.findFirst({
                    where: { id: botId, ...scope, archivedAt: null },
                    select: { id: true },
                  }),
                  tx.mcpServer.findFirst({
                    where: { id: source.serverId, ...availableInSpace(scope), enabled: true },
                    select: { id: true, revision: true, transport: true, allBots: true },
                  }),
                ]);
                if (!bot || !server)
                  throw new ORPCError("NOT_FOUND", {
                    message: "Bot or integration is unavailable.",
                  });
                if (server.revision !== source.revision)
                  throw new ORPCError("CONFLICT", {
                    message: "Integration changed; review it again.",
                  });
                const assigned =
                  server.allBots ||
                  (await tx.botMcpServer.findFirst({
                    where: { ...scope, botId, serverId: server.id },
                    select: { botId: true },
                  }));
                if (!assigned)
                  throw new ORPCError("CONFLICT", {
                    message: "Assign the integration to this bot first.",
                  });
                return { botId, source };
              },
              { isolationLevel: "RepeatableRead" },
            );
          const selected = await inspect();
          const found = await discoverMonitorTools(deps, context.actor, {
            serverId: selected.source.serverId,
            botId: selected.botId,
            expectedRevision: selected.source.revision,
            signal: context.signal,
          });
          if (context.stillAuthorized && !(await context.stillAuthorized()))
            throw new ORPCError("UNAUTHORIZED");
          await inspect();
          return {
            planRevision: input.expectedRevision,
            sourceRevision: found.revision,
            status: found.status,
            selectedOperation:
              found.status !== "ok"
                ? ("not_checked" as const)
                : found.tools.some((tool) => tool.name === selected.source.toolName)
                  ? ("declared_read" as const)
                  : ("not_found" as const),
            tools: found.tools,
            sourceAccess: "not_verified" as const,
            read: "not_performed" as const,
          };
        },
      ),
      list: authed.setupPlans.list.handler(async ({ context, input }) => {
        const rows = await deps.prisma.setupPlan.findMany({
          where: {
            spaceId: context.actor.spaceId,
            userId: context.actor.userId,
            ...(input.cursor ? { id: { lt: input.cursor } } : {}),
          },
          orderBy: { id: "desc" },
          take: input.limit + 1,
        });
        return {
          plans: rows.slice(0, input.limit).map(dto),
          nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
        };
      }),
      update: authed.setupPlans.update.handler(async ({ context, input }) => {
        const scope = {
          id: input.id,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        };
        return deps.prisma.$transaction(async (tx) => {
          // The encryption layer resolves row ownership separately. Lock only an owned row
          // first, so nonexistent or foreign IDs never reach that lookup and deletes cannot race it.
          const locked = await tx.$queryRaw<
            Array<{ id: string; revision: number; status: string }>
          >`
            SELECT id, revision, status FROM setup_plans WHERE id = ${scope.id}
              AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE`;
          if (!locked.length) throw new ORPCError("NOT_FOUND");
          if (locked[0]!.status === "configured")
            throw new ORPCError("CONFLICT", { message: "This plan already created a routine." });
          if (locked[0]!.revision !== input.expectedRevision)
            throw new ORPCError("CONFLICT", { message: "Setup plan changed; reload it." });
          const current = await tx.setupPlan.findFirstOrThrow({ where: scope });
          const previous = SetupPlanDraftSchema.safeParse(current.draft);
          if (!previous.success)
            throw new ORPCError("CONFLICT", {
              message: "The saved plan cannot be safely updated.",
            });
          const from = previous.data.source;
          const to = input.draft.source;
          if (
            input.draft.arguments !== undefined &&
            (from?.serverId !== to?.serverId ||
              from?.revision !== to?.revision ||
              from?.toolName !== to?.toolName)
          )
            throw new ORPCError("BAD_REQUEST", {
              message:
                "Clear operation arguments when changing the integration or operation, then review them again.",
            });
          if (locked[0]!.revision === 2_147_483_647 && input.expectedRevision === 2_147_483_647)
            throw new ORPCError("CONFLICT", { message: "Setup plan revision limit reached." });
          const changed = await tx.setupPlan.updateMany({
            where: { ...scope, revision: input.expectedRevision },
            data: { draft: input.draft, status: "draft", revision: { increment: 1 } },
          });
          if (changed.count !== 1) {
            const exists = await tx.setupPlan.findFirst({ where: scope, select: { id: true } });
            throw new ORPCError(exists ? "CONFLICT" : "NOT_FOUND", {
              message: exists ? "Setup plan changed; reload it." : "Setup plan not found.",
            });
          }
          return dto(await tx.setupPlan.findFirstOrThrow({ where: scope }));
        });
      }),
      configure: authed.setupPlans.configure.handler(async ({ context, input }) => {
        const scope = {
          id: input.id,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        };
        return deps.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM setup_plans WHERE id = ${scope.id}
              AND "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE`;
          if (!locked.length) throw new ORPCError("NOT_FOUND");
          const plan = await tx.setupPlan.findFirstOrThrow({ where: scope });
          if (plan.status === "configured") {
            if (
              plan.configureRequestKey === input.requestKey &&
              plan.configuredFromRevision === input.expectedRevision
            )
              return dto(plan);
            throw new ORPCError("CONFLICT", { message: "This plan already created a routine." });
          }
          if (plan.status !== "proposed" || plan.revision !== input.expectedRevision)
            throw new ORPCError("CONFLICT", { message: "Setup plan changed; review it again." });
          if (plan.revision === 2_147_483_647)
            throw new ORPCError("CONFLICT", { message: "Setup plan revision limit reached." });
          const parsed = SetupPlanDraftSchema.safeParse(plan.draft);
          if (!parsed.success || !parsed.data.botId || !parsed.data.source || !parsed.data.schedule)
            throw new ORPCError("BAD_REQUEST", { message: "Complete the setup plan first." });
          const {
            botId,
            source,
            schedule,
            purpose,
            notify,
            arguments: operationArguments,
          } = parsed.data;
          const integration = await lockSetupReferences(tx, scope, botId, source);
          const inputRoutine = CreateRoutineInput.parse({
            botId,
            name: "Source monitor",
            prompt: setupRoutinePrompt({
              purpose,
              integration,
              toolName: source.toolName,
              operationArguments,
            }),
            crons: [schedule.cron],
            timezone: schedule.timezone,
            active: false,
            notify,
          });
          const row = await tx.routine.create({
            data: {
              ...routineRowData(context.actor, inputRoutine, routineNextRunAt(inputRoutine)),
            },
            select: { id: true },
          });
          const changed = await tx.setupPlan.updateMany({
            where: { ...scope, revision: input.expectedRevision, status: "proposed" },
            data: {
              status: "configured",
              revision: { increment: 1 },
              routineId: row.id,
              configureRequestKey: input.requestKey,
              configuredFromRevision: input.expectedRevision,
              configuredPrompt: inputRoutine.prompt,
            },
          });
          if (changed.count !== 1)
            throw new ORPCError("CONFLICT", { message: "Setup plan changed; review it again." });
          return dto(await tx.setupPlan.findFirstOrThrow({ where: scope }));
        });
      }),
      propose: authed.setupPlans.propose.handler(async ({ context, input }) => {
        const scope = {
          id: input.id,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        };
        return deps.prisma.$transaction(async (tx) => {
          const row = await tx.setupPlan.findFirst({ where: scope });
          if (!row) throw new ORPCError("NOT_FOUND");
          if (row.revision !== input.expectedRevision || row.status !== "draft")
            throw new ORPCError("CONFLICT", { message: "Setup plan changed; reload it." });
          if (row.revision === 2_147_483_647)
            throw new ORPCError("CONFLICT", { message: "Setup plan revision limit reached." });
          const parsed = SetupPlanDraftSchema.safeParse(row.draft);
          if (!parsed.success)
            throw new ORPCError("BAD_REQUEST", {
              message: "Fix the setup plan before proposing it.",
            });
          const draft = parsed.data;
          if (!draft.botId || !draft.source || !draft.schedule)
            throw new ORPCError("BAD_REQUEST", {
              message: "Select a bot, source and schedule first.",
            });
          nextRoutineDate([draft.schedule.cron], draft.schedule.timezone);
          // A proposal does not verify assignment or provider access.
          await lockSetupReferences(tx, scope, draft.botId, draft.source);
          const changed = await tx.setupPlan.updateMany({
            where: { ...scope, revision: input.expectedRevision, status: "draft" },
            data: { status: "proposed", revision: { increment: 1 } },
          });
          if (changed.count !== 1)
            throw new ORPCError("CONFLICT", { message: "Setup plan changed; reload it." });
          return dto(await tx.setupPlan.findFirstOrThrow({ where: scope }));
        });
      }),
    },
  };
}
