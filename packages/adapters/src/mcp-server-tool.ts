import { createHash } from "node:crypto";
import type { McpTransport, MessageBlock } from "@rakazo/contracts";
import { McpRemoteEndpointSchema, McpTransportSchema } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import type { McpServer } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { toStringRecord } from "./memory-provider-factory.js";
import { assertNoMcpEndpointCredential, assertSafeRemoteUrl } from "./remote-mcp.js";
import { isUniqueViolation, persistMessageInTransaction, runLeaseFor } from "./run-messages.js";

export { deriveMcpSlug } from "@rakazo/core";

const MAX_HEADERS = 32;

function cardEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** List or request an existing owner integration without changing its grants or credentials. */
export async function connectExistingMcpFromTool(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  args: Record<string, unknown>,
  effectKey: string,
) {
  const scope = { userId: run.userId, spaceId: run.spaceId };
  const serverId = typeof args.server_id === "string" ? args.server_id.trim() : "";
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 120) : "";
  const bot = await deps.prisma.bot.findFirst({
    where: { id: run.botId, ...scope, archivedAt: null },
    select: { id: true },
  });
  if (!bot) return { error: "This bot is unavailable." };
  if (!serverId) {
    const servers = await deps.prisma.mcpServer.findMany({
      where: {
        ...availableInSpace(scope),
        enabled: true,
        ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      },
      select: { id: true, name: true, transport: true, allBots: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 51,
    });
    const visible = servers.slice(0, 50);
    const assignments = await deps.prisma.botMcpServer.findMany({
      where: { ...scope, botId: bot.id, serverId: { in: visible.map((server) => server.id) } },
      select: { serverId: true, allowAllTools: true },
    });
    return {
      integrations: visible.map((server) => {
        const assignment = assignments.find((row) => row.serverId === server.id);
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          access: assignment
            ? assignment.allowAllTools
              ? "assigned"
              : "restricted"
            : server.allBots
              ? "shared"
              : "not_assigned",
        };
      }),
      more: servers.length > 50,
    };
  }
  const nonce = `mcp-existing:${createHash("sha256").update(effectKey).digest("hex")}`;
  const result = await deps.prisma.$transaction(async (tx) => {
    const [currentBot, server, assignment] = await Promise.all([
      tx.bot.findFirst({ where: { id: bot.id, ...scope, archivedAt: null }, select: { id: true } }),
      tx.mcpServer.findFirst({
        where: { id: serverId, ...availableInSpace(scope), enabled: true },
        select: { id: true, name: true, transport: true, endpoint: true, allBots: true },
      }),
      tx.botMcpServer.findFirst({
        where: { ...scope, botId: bot.id, serverId },
        select: { allowAllTools: true },
      }),
    ]);
    if (!currentBot || !server)
      return { error: "This integration is unavailable in this space." } as const;
    if (assignment)
      return {
        ok: true as const,
        access: assignment.allowAllTools ? "assigned" : "restricted",
        note: "The existing assignment was kept unchanged. Provider sign-in and tool readiness were not checked.",
      };
    if (server.allBots)
      return {
        ok: true as const,
        access: "shared",
        note: "This integration is already shared with this bot. Provider sign-in and tool readiness were not checked.",
      };
    const threads = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM threads WHERE id = ${run.threadId} AND "userId" = ${run.userId}
        AND "spaceId" = ${run.spaceId} FOR UPDATE`;
    if (!threads.length) return { error: "This conversation is unavailable." } as const;
    const thread = await tx.thread.findFirst({
      where: {
        id: run.threadId,
        ...scope,
        OR: [{ botId: bot.id }, { group: { members: { some: { botId: bot.id } } } }],
      },
      select: { id: true },
    });
    if (!thread) return { error: "This bot is not part of the conversation." } as const;
    const previous = await tx.message.findUnique({
      where: { threadId_clientNonce: { threadId: run.threadId, clientNonce: nonce } },
      select: { runId: true, botId: true, blocks: true },
    });
    if (previous) {
      const card = Array.isArray(previous.blocks)
        ? previous.blocks.find(
            (block) =>
              block &&
              typeof block === "object" &&
              !Array.isArray(block) &&
              block.kind === "mcp_approval" &&
              block.serverId === server.id,
          )
        : undefined;
      if (
        previous.runId !== run.id ||
        previous.botId !== run.botId ||
        !card ||
        typeof card !== "object" ||
        Array.isArray(card)
      )
        return { error: "Could not recover the connection request." } as const;
      return {
        ok: true as const,
        access:
          card.status === "dismissed"
            ? "dismissed"
            : card.status === "connected"
              ? "connection_changed"
              : "pending",
        note: "Review the existing connection card in the chat.",
      };
    }
    const blocks: MessageBlock[] = [
      {
        kind: "mcp_approval",
        name: server.name,
        serverId: server.id,
        transport: server.transport as McpTransport,
        endpoint: cardEndpoint(server.endpoint),
        needsOAuth: false,
        assignmentOnly: true,
        status: "pending",
      },
    ];
    const committed = await persistMessageInTransaction(
      tx,
      run,
      "bot",
      blocks,
      undefined,
      nonce,
      false,
      runLeaseFor(deps, run.id),
    );
    return {
      ok: true as const,
      access: "pending",
      note: "Approve the connection card in chat. This grants assignment only; provider sign-in and tool readiness are not verified. Use integration settings if sign-in is needed.",
      seq: committed.eventSeq,
      responseRunId: committed.firstResponseRunId,
    };
  });
  if ("seq" in result && result.seq !== undefined)
    await deps.events
      .notify(run.threadId, result.seq, result.responseRunId)
      .catch((error) => getLogger().error("MCP approval realtime notification", error));
  return result;
}

export type ParsedMcpServerArgs = {
  slug: string;
  name: string;
  description: string;
  transport: Exclude<McpTransport, "stdio">;
  endpoint: string;
  headers: Record<string, string>;
  secret?: string;
  assignToSelf: boolean;
};

/** Returns undefined for anything that would fail server-side validation,
 * so the model gets a single actionable error instead of a partial create. */
export function parseMcpServerToolArgs(
  args: Record<string, unknown>,
): ParsedMcpServerArgs | undefined {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 120) : "";
  if (!name) return undefined;
  const parsedTransport = McpTransportSchema.safeParse(args.transport);
  if (!parsedTransport.success || parsedTransport.data === "stdio") return undefined;
  const transport = parsedTransport.data;

  const endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
  if (!McpRemoteEndpointSchema.safeParse(endpoint).success) return undefined;

  const headers = toStringRecord(args.headers);
  if (Object.keys(headers).length > MAX_HEADERS) return undefined;

  return {
    slug: deriveMcpSlug(name),
    name,
    description: typeof args.description === "string" ? args.description.slice(0, 2000) : "",
    transport,
    endpoint,
    headers,
    secret:
      typeof args.secret === "string" && args.secret ? args.secret.slice(0, 16384) : undefined,
    assignToSelf: args.assign_to_self !== false,
  };
}

/** Serialized credential blob for the encrypted secret store; null when the
 * server has no static credential material. */
export function buildMcpCredentialBlob(parsed: {
  secret?: string;
  /** Stdio launch arguments, which may carry tokens. */
  args?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
    scope?: string;
    authorizationServer?: string;
    authorizationParams?: string;
  } | null;
}): string | null {
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  const files = parsed.files ?? {};
  const args = parsed.args ?? [];
  const client = parsed.oauthClient;
  if (
    !parsed.secret &&
    args.length === 0 &&
    !client &&
    Object.keys(env).length === 0 &&
    Object.keys(headers).length === 0 &&
    Object.keys(files).length === 0
  ) {
    return null;
  }
  return JSON.stringify({
    secret: parsed.secret,
    env,
    headers,
    ...(Object.keys(files).length > 0 ? { files } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(client
      ? {
          oauthClient: {
            client_id: client.clientId,
            ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
            ...(client.scope ? { scope: client.scope } : {}),
            ...(client.authorizationParams
              ? { authorization_params: client.authorizationParams }
              : {}),
            ...(client.authorizationServer
              ? { authorization_server: new URL(client.authorizationServer).href }
              : {}),
          },
        }
      : {}),
  });
}

/** Heuristic for whether the approval card should lead with OAuth: remote
 * servers without a static credential usually need browser authorization. */
export function needsOAuthProbe(parsed: {
  transport: string;
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): boolean {
  if (parsed.transport === "stdio") return false;
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  return !parsed.secret && Object.keys(env).length === 0 && Object.keys(headers).length === 0;
}

/** add_mcp_server: registers the server and, when asked, posts its approval card. */
export async function addMcpServerFromTool(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  botId: string,
  args: Record<string, unknown>,
  executionId: string,
) {
  // A local server runs on the deployment's own hosts, so only an admin adds one.
  if (args.transport === "stdio") {
    return {
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    };
  }
  const parsed = parseMcpServerToolArgs(args);
  if (!parsed) {
    return {
      error:
        "Invalid MCP server details. Required: name, transport (streamable_http|sse), and an endpoint URL.",
    };
  }
  try {
    await assertSafeRemoteUrl(parsed.endpoint, deps.secretHttp?.resolveHostname, {
      allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint === true,
    });
    assertNoMcpEndpointCredential(parsed.endpoint);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid MCP endpoint",
    };
  }
  if (!deps.secretStore) {
    return {
      error: "Secret storage is not available in this deployment.",
    };
  }
  const credentialBlob = buildMcpCredentialBlob(parsed);
  let storedCredential: { id: string; ciphertext: string } | null = null;
  if (credentialBlob) {
    storedCredential = await deps.secretStore.put(credentialBlob, {
      operationId: executionId,
      traceId: executionId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId,
      signal: new AbortController().signal,
    });
  }
  const oauthLikely = needsOAuthProbe(parsed);
  let serverRow: McpServer;
  let approvalEventSeq: number | undefined;
  let approvalResponseRunId: string | undefined;
  try {
    const created = await deps.prisma.$transaction(async (tx) => {
      if (storedCredential) {
        await tx.secret.create({
          data: {
            id: storedCredential.id,
            userId: run.userId,
            spaceId: run.spaceId,
            kind: "mcp",
            ciphertext: storedCredential.ciphertext,
          },
        });
      }
      const server = await tx.mcpServer.create({
        data: {
          spaceId: run.spaceId,
          userId: run.userId,
          slug: parsed.slug,
          name: parsed.name,
          description: parsed.description,
          transport: parsed.transport,
          endpoint: parsed.endpoint,
          headers: Object.fromEntries(Object.keys(parsed.headers).map((key) => [key, true])),
          secretId: storedCredential?.id,
          enabled: true,
        },
      });
      if (!parsed.assignToSelf) return { server };
      const blocks: MessageBlock[] = [
        {
          kind: "mcp_approval",
          name: server.name,
          serverId: server.id,
          transport: parsed.transport,
          endpoint: parsed.endpoint,
          needsOAuth: oauthLikely,
          status: "pending",
        },
      ];
      const committed = await persistMessageInTransaction(
        tx,
        run,
        "bot",
        blocks,
        undefined,
        undefined,
        false,
        runLeaseFor(deps, run.id),
      );
      return {
        server,
        eventSeq: committed.eventSeq,
        firstResponseRunId: committed.firstResponseRunId,
      };
    });
    serverRow = created.server;
    approvalEventSeq = created.eventSeq;
    approvalResponseRunId = created.firstResponseRunId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        error: `An MCP server named "${parsed.name}" already exists. Use connect_existing_mcp to inspect available integrations, or choose another name if this is a different server.`,
      };
    }
    throw error;
  }
  if (approvalEventSeq !== undefined) {
    await deps.events
      .notify(run.threadId, approvalEventSeq, approvalResponseRunId)
      .catch((error) => {
        getLogger().error("MCP approval realtime notification", error);
      });
  }
  return {
    ok: true,
    server_id: serverRow.id,
    next_step: parsed.assignToSelf
      ? `An approval card is in the chat. End your turn with one short sentence asking the user to ${oauthLikely ? "authorize" : "approve"} it there; the card already shows the server's details. You will be told when they connect it.`
      : "The server was registered without assigning it to this bot.",
  };
}
