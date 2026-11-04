import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { availableInSpace, IsolationError } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

/** Discover declared candidate reads through the same authorization path as bot tools. */
export async function discoverMonitorTools(
  deps: RouterDeps,
  actor: Actor,
  input: { serverId: string; botId: string; expectedRevision?: number; signal?: AbortSignal },
) {
  const [server, bot] = await Promise.all([
    deps.prisma.mcpServer.findFirst({
      where: { id: input.serverId, ...availableInSpace(actor), enabled: true },
    }),
    deps.prisma.bot.findFirst({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
      select: { id: true },
    }),
  ]);
  if (!server || !bot) throw new IsolationError();
  if (input.expectedRevision !== undefined && server.revision !== input.expectedRevision)
    throw new ORPCError("CONFLICT", { message: "Integration changed; review it again" });
  if (!deps.mcp?.discoverMonitorTools)
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Monitor discovery is unavailable" });
  const found = await deps.mcp.discoverMonitorTools(
    {
      operationId: "monitor-tools",
      traceId: "monitor-tools",
      ...actor,
      botId: bot.id,
      signal: input.signal ?? AbortSignal.timeout(30000),
    },
    server.id,
  );
  const current = await deps.prisma.mcpServer.findFirst({
    where: { id: server.id, ...availableInSpace(actor), enabled: true },
    select: { revision: true },
  });
  if (!current || current.revision !== server.revision)
    throw new ORPCError("CONFLICT", { message: "Integration changed during discovery" });
  return {
    status: found.status,
    revision: server.revision,
    tools: (found.status === "ok" ? found.tools : [])
      .filter(
        (tool) =>
          tool.readOnly === true &&
          !tool.batch &&
          tool.route?.connectorId === "mcp" &&
          tool.route.resourceId === server.id &&
          tool.route.resourceRevision === server.revision &&
          !tool.route.toolName.startsWith("__rakazo_"),
      )
      .map((tool) => ({
        name: tool.route!.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
  };
}
