import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  McpOAuthBroker,
  McpOAuthSummary,
  McpStdioPolicy,
  UserDeviceGateway,
} from "@rakazo/adapters";
import {
  assertNoMcpEndpointCredential,
  assertSafeRemoteUrl,
  buildMcpCredentialBlob,
  deriveMcpSlug,
  importClaudeMcpConfig,
  importCodexMcpConfig,
  importOpenCodeMcpConfig,
  importPiMcpConfig,
  mcpServerHealthDto,
  mcpStdioRefusal,
  recordMcpServerHealth,
} from "@rakazo/adapters";
import type { Actor, McpServer, McpServerConfigInput } from "@rakazo/contracts";
import { mcpOAuthEnvReferences } from "@rakazo/contracts";
import type { McpServer as McpServerRow, Prisma } from "@rakazo/db";
import { itemSecretIn, spaceAvailability } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isAdmin } from "./admins.js";
import { assertNameFreeWhereAvailable, userAddedAvailability } from "./availability.js";
import { dismissMcpServerApprovals } from "./mcp-approval.js";
import type { McpSecretMaterial } from "./mcp-material.js";
import { legacyMcpArgs } from "./mcp-material.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

export function mcpServerDto(
  row: {
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    hasArgs: boolean;
    env: unknown;
    files: unknown;
    headers: unknown;
    secretId: string | null;
    installId?: string | null;
    allSpaces?: boolean;
    availableIn?: Array<{ spaceId: string }>;
    enabled: boolean;
    revision: number;
    healthStatus: string;
    healthMessage: string | null;
    healthToolCount: number | null;
    healthCheckedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  oauth: McpOAuthSummary = { status: "none", clientId: null },
): McpServer {
  const keysOf = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const envKeys = keysOf(row.env);
  const headerKeys = keysOf(row.headers);
  return {
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    hasArgs: row.hasArgs || legacyMcpArgs(row.args).length > 0,
    envKeys,
    fileKeys: keysOf(row.files),
    headerKeys,
    installId: row.installId ?? null,
    hasSecret: row.secretId !== null,
    oauthStatus: oauth.status,
    oauthClientId: oauth.clientId,
    enabled: row.enabled,
    revision: row.revision,
    health: mcpServerHealthDto(row),
    availability: spaceAvailability({ ...row, allSpaces: row.allSpaces ?? false }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const MCP_OAUTH_PENDING_MESSAGE = "Connect this server's account to check it.";

/** Private server endpoints require explicit operator configuration. */
export function mayUsePrivateEndpoint(deps: Pick<RouterDeps, "env">): boolean {
  return deps.env.mcpAllowPrivateEndpoint === true;
}

export function mcpStdioPolicy(deps: Pick<RouterDeps, "env">): McpStdioPolicy {
  return {
    stdioEnabled: deps.env.mcpStdioEnabled,
    allowedCommands: deps.env.mcpStdioAllowedCommands,
  };
}

/** A stdio server runs with the API's and worker's own access, so only admins add or change one. */
export async function assertMcpStdioAdmin(
  actor: Actor,
  deps: Pick<RouterDeps, "env" | "prisma">,
): Promise<void> {
  if (!(await isAdmin(deps, actor.userId)))
    throw new ORPCError("FORBIDDEN", { message: "Only admins can add local MCP servers" });
}

/** Refuse a stdio server this deployment would never run, or one a non-admin adds. */
export async function assertMcpStdioCommand(
  command: string,
  actor: Actor,
  deps: Pick<RouterDeps, "env" | "prisma">,
): Promise<void> {
  const refusal = mcpStdioRefusal(command, mcpStdioPolicy(deps));
  if (refusal) throw new ORPCError("BAD_REQUEST", { message: refusal });
  await assertMcpStdioAdmin(actor, deps);
}

export async function assertMcpRemoteEndpoint(
  endpoint: string | null | undefined,
  deps: Pick<RouterDeps, "remoteConnectors" | "env">,
): Promise<void> {
  if (!endpoint) return;
  try {
    await assertSafeRemoteUrl(endpoint, deps.remoteConnectors?.resolveHostname, {
      allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
    });
    assertNoMcpEndpointCredential(endpoint);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "MCP endpoint is invalid",
    });
  }
}

/** A stdio server gets its OAuth grant through `{{oauth.*}}` references in env
 * values and credential file templates, so they must name real fields and the
 * server must have a client to run the flow. A key is either a value or a file path. */
export function assertMcpOAuthTemplates(
  env: Record<string, string>,
  files: Record<string, string>,
  hasOAuthClient: boolean,
): void {
  for (const key of Object.keys(files)) {
    if (key in env) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${key} is set as both an environment variable and a credential file`,
      });
    }
  }
  const sources = [
    ...Object.entries(env).map(([key, value]) => ({ label: `Environment variable ${key}`, value })),
    ...Object.entries(files).map(([key, value]) => ({ label: `Credential file ${key}`, value })),
  ];
  for (const { label, value } of sources) {
    const { fields, unknown } = mcpOAuthEnvReferences(value);
    if (unknown[0] !== undefined) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${label} references unknown OAuth field {{oauth.${unknown[0]}}}`,
      });
    }
    if (fields[0] !== undefined && !hasOAuthClient) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${label} uses {{oauth.${fields[0]}}}, which needs an OAuth client`,
      });
    }
  }
}

export function mcpAssignmentDto(row: {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    serverId: row.serverId,
    allowAllTools: row.allowAllTools,
    allowedTools: Array.isArray(row.allowedTools)
      ? row.allowedTools.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mcpCredentialRecords(
  material: unknown,
): { headers: Record<string, string>; env: Record<string, string> } | null {
  const record = (value: unknown): Record<string, string> | null => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    return entries.every(([, item]) => typeof item === "string")
      ? (Object.fromEntries(entries) as Record<string, string>)
      : null;
  };
  if (!material || typeof material !== "object" || Array.isArray(material)) return null;
  const { headers, env } = material as { headers?: unknown; env?: unknown };
  const parsed = { headers: record(headers), env: record(env) };
  return parsed.headers && parsed.env ? { headers: parsed.headers, env: parsed.env } : null;
}

export function createMcpServers(
  deps: RouterDeps,
  onboardingDeps: Parameters<typeof dismissMcpServerApprovals>[0],
  mcpOAuth: McpOAuthBroker,
  userDevices?: UserDeviceGateway,
) {
  const mcpAwaitsOAuth = async (server: McpServerRow, actor: Actor, oauth: McpOAuthSummary) => {
    if (oauth.status === "connected") return false;
    const secret = server.secretId
      ? await deps.prisma.secret.findFirst({
          where: { id: server.secretId, ...itemSecretIn(actor) },
        })
      : null;
    const material: McpSecretMaterial = secret
      ? JSON.parse(await deps.secrets.load(secret.ciphertext, { recordId: secret.id }))
      : {};
    const needsGrant = [
      ...Object.values(material.env ?? {}),
      ...Object.values(material.files ?? {}),
    ].some((value) => mcpOAuthEnvReferences(value).fields.length > 0);
    return (
      needsGrant ||
      (oauth.clientId !== null &&
        !material.secret &&
        Object.keys(material.headers ?? {}).length === 0)
    );
  };
  const probeMcpServer = async (server: McpServerRow, actor: Actor): Promise<void> => {
    if (!deps.mcp) return;
    try {
      // The connector records the outcome itself.
      await deps.mcp.probe(server, { spaceId: actor.spaceId, userId: actor.userId });
    } catch {
      getLogger().error("mcp server probe failed", { "mcp.server.id": server.id });
      await recordMcpServerHealth(deps.prisma, server.id, {
        status: "error",
        message: "Could not check this MCP server",
      });
    }
  };
  /**
   * Shows `installing` (stdio may have to download a package) and probes in the background.
   * Never throws; a probe problem must not fail the save.
   */
  const beginMcpProbe = async (
    row: McpServerRow,
    actor: Actor,
    oauth: McpOAuthSummary,
  ): Promise<McpServerRow> => {
    if (!deps.mcp || !row.enabled) return row;
    const shown = async (
      status: "unknown" | "installing",
      message: string | null,
    ): Promise<McpServerRow> => {
      await recordMcpServerHealth(deps.prisma, row.id, { status, message });
      return {
        ...row,
        healthStatus: status,
        healthMessage: message,
        healthToolCount: null,
        healthCheckedAt: new Date(),
      };
    };
    if (await mcpAwaitsOAuth(row, actor, oauth)) return shown("unknown", MCP_OAUTH_PENDING_MESSAGE);
    const display = row.transport === "stdio" ? await shown("installing", null) : row;
    void probeMcpServer(row, actor);
    return display;
  };
  const removeMcpServerInTransaction = async (
    tx: Prisma.TransactionClient,
    actor: Actor,
    server: { id: string; secretId: string | null },
  ) => {
    const painted = await dismissMcpServerApprovals(onboardingDeps, actor, server.id, tx);
    await tx.mcpServer.delete({ where: { id: server.id } });
    if (server.secretId) {
      await tx.secret.deleteMany({ where: { id: server.secretId, ...itemSecretIn(actor) } });
    }
    return painted;
  };
  const prepareMcpServer = async (actor: Actor, input: McpServerConfigInput) => {
    await assertMcpRemoteEndpoint("endpoint" in input ? input.endpoint : null, deps);
    if (input.transport === "stdio") {
      await assertMcpStdioCommand(input.command, actor, deps);
      assertMcpOAuthTemplates(input.env, input.files ?? {}, Boolean(input.oauthClient));
      await assertMcpRemoteEndpoint(input.oauthClient?.authorizationServer, deps);
    }
    const secretPayload = buildMcpCredentialBlob(input);
    return secretPayload
      ? await deps.secrets.put(secretPayload, computerContext(actor, "mcp", "mcp.create"))
      : null;
  };
  const insertMcpServer = async (
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: McpServerConfigInput,
    stored: Awaited<ReturnType<typeof prepareMcpServer>>,
    // What the user adds reaches all their spaces; an import stays in its space.
    options: { everywhere?: boolean } = {},
  ) => {
    if (options.everywhere)
      await assertNameFreeWhereAvailable(
        tx,
        "mcpServer",
        actor,
        input.slug,
        userAddedAvailability(actor),
      );
    if (stored) {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: options.everywhere ? null : actor.spaceId,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
    }
    return tx.mcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        allSpaces: options.everywhere ?? false,
        slug: input.slug,
        name: input.name,
        description: input.description,
        transport: input.transport,
        endpoint: "endpoint" in input ? input.endpoint : null,
        command: "command" in input ? input.command : null,
        hasArgs: "args" in input && input.args.length > 0,
        env: ("env" in input
          ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
          : {}) as Prisma.InputJsonValue,
        files: Object.fromEntries(
          Object.keys("files" in input ? (input.files ?? {}) : {}).map((key) => [key, true]),
        ) as Prisma.InputJsonValue,
        headers: ("headers" in input
          ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
          : {}) as Prisma.InputJsonValue,
        secretId: stored?.id,
        enabled: input.enabled,
      },
    });
  };
  const announceMcpServer = async (row: McpServerRow, actor: Actor) => {
    const oauth = await mcpOAuth.summaryFor(row, actor);
    return mcpServerDto(await beginMcpProbe(row, actor, oauth), oauth);
  };
  return {
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    importHarnessMcpInventory: async (actor: Actor) => {
      if (!userDevices)
        throw new ORPCError("BAD_REQUEST", { message: "Secure host import is unavailable" });
      const device = await userDevices.connected(actor.userId);
      if (!device)
        throw new ORPCError("BAD_REQUEST", { message: "Connect a paired Rakazo computer first" });
      const imported: string[] = [];
      const skipped: string[] = [];
      const candidates = new Map<
        string,
        { server: import("@rakazo/adapters").ImportedHarnessMcpServer; id: string; harness: string }
      >();
      for (const harness of ["pi", "claude", "codex", "dsh", "omp", "opencode"] as const) {
        const locs: Record<typeof harness, string[]> = {
          pi: [".pi/agent/mcp.json"],
          claude: [".claude.json"],
          codex: [".codex/config.toml"],
          dsh: [".dsh/mcp.json"],
          omp: [".config/omp/mcp.json"],
          opencode: [".config/opencode/opencode.json"],
        };
        for (const relative of locs[harness]) {
          const full = relative;
          try {
            let file: { content: string } | null = null;
            for await (const frame of userDevices.request(
              actor.userId,
              { method: "mcpInventory", botId: `mcp-import-${actor.userId}`, path: full },
              AbortSignal.timeout(15000),
              device.deviceId,
            ))
              if (
                frame &&
                typeof frame === "object" &&
                "content" in frame &&
                typeof frame.content === "string"
              )
                file = frame as { content: string };
            if (!file) continue;
            const parsed =
              harness === "codex"
                ? importCodexMcpConfig(file.content, `${harness}:${relative}`)
                : harness === "opencode"
                  ? importOpenCodeMcpConfig(file.content, `${harness}:${relative}`)
                  : harness === "claude"
                    ? importClaudeMcpConfig(file.content, `${harness}:${relative}`)
                    : importPiMcpConfig(file.content, `${harness}:${relative}`);
            for (const server of parsed.servers) {
              const id = `${harness}:${relative}:${server.name}`;
              const identity = [
                server.name.toLowerCase(),
                server.namespace ?? "",
                server.transport,
                server.command ?? server.endpointIdentity ?? server.endpoint ?? "",
                server.credentialFields.join(","),
              ].join("\0");
              if (server.auth === "oauth") {
                skipped.push(`${id} (OAuth authorization needs renewal)`);
                continue;
              }
              if (server.auth === "static_credential" && server.environmentFields.length > 0) {
                skipped.push(`${id} (environment credentials need protected reconnection)`);
                continue;
              }
              if (server.endpointHasCredentialPlaceholder) {
                skipped.push(`${id} (URL credential needs protected reconnection)`);
                continue;
              }
              if (candidates.has(identity)) {
                skipped.push(`${id} (duplicate of existing connection)`);
                continue;
              }
              if (server.transport === "stdio" && server.credentialFields.length) {
                skipped.push(`${id} (stdio credentials need protected reconnect)`);
                continue;
              }
              candidates.set(identity, { server, id, harness });
            }
          } catch {
            /* Missing host path or unavailable shell. */
          }
        }
      }
      for (const { server, id, harness } of candidates.values()) {
        const slug = deriveMcpSlug(
          `${server.name.toLowerCase()}-${createHash("sha256")
            .update(
              `${server.endpointIdentity ?? server.command ?? ""}:${server.credentialFields.join(",")}`,
            )
            .digest("hex")
            .slice(0, 8)}`,
        );
        if (server.transport === "stdio") {
          const stdioSlug = deriveMcpSlug(`${harness}-${server.name}`);
          const stdioConfig = {
            transport: "stdio" as const,
            slug: stdioSlug,
            name: server.name,
            description: `Imported from ${harness}; disabled pending command review`,
            enabled: false,
            command: server.command ?? "",
            args: server.args,
            env: {},
            secret: undefined,
          };
          try {
            await deps.prisma.$transaction(async (tx) => {
              const existing = await tx.mcpServer.findFirst({
                where: {
                  userId: actor.userId,
                  transport: "stdio",
                  command: stdioConfig.command,
                  allSpaces: true,
                },
              });
              if (
                !existing &&
                deps.env.mcpStdioEnabled &&
                mcpStdioRefusal(stdioConfig.command, mcpStdioPolicy(deps)) === null
              ) {
                await assertMcpStdioCommand(stdioConfig.command, actor, deps);
                return insertMcpServer(tx, actor, stdioConfig, null, { everywhere: true });
              }
              return existing;
            });
            const commandAllowed = Boolean(
              deps.env.mcpStdioEnabled &&
                mcpStdioRefusal(stdioConfig.command, mcpStdioPolicy(deps)) === null,
            );
            imported.push(
              commandAllowed
                ? `${id} (disabled pending explicit enable)`
                : `${id} (disabled; deployment command allowlist required)`,
            );
          } catch {
            skipped.push(`${id} (unavailable; command needs deployment allowlist)`);
          }
          continue;
        }
        if (server.endpointHasCredentialPlaceholder) {
          skipped.push(`${id} (credential needs protected reconnection)`);
          continue;
        }
        if (server.status === "unsupported") {
          skipped.push(`${id} (unsupported: ${server.unsupported.join("; ")})`);
          continue;
        }
        if (server.auth === "oauth") {
          skipped.push(`${id} (OAuth authorization needs renewal in the protected UI)`);
          continue;
        }
        if (
          server.auth === "static_credential" &&
          server.credentialHeaders.length === 0 &&
          server.environmentFields.length === 0
        ) {
          skipped.push(`${id} (credential requires protected reconnection)`);
          continue;
        }
        const protectedEnv = Object.fromEntries(
          Object.entries(server.environmentValues).filter(([key]) =>
            server.environmentFields.includes(key),
          ),
        );
        const protectedHeaders = Object.fromEntries(
          Object.entries(server.headerValues).filter(([key]) =>
            server.credentialHeaders.includes(key),
          ),
        );
        const secret =
          Object.keys(protectedEnv).length || Object.keys(protectedHeaders).length
            ? JSON.stringify({ env: protectedEnv, headers: protectedHeaders })
            : undefined;
        const config = {
          transport: server.transport,
          slug,
          name: server.name,
          description: `Imported from ${harness}`,
          enabled: server.enabled && server.status === "ready",
          endpoint: server.endpoint ?? "https://invalid.invalid",
          headers: {},
          secret,
          oauthClient: null,
        };
        try {
          const existing = await deps.prisma.mcpServer.findFirst({
            where: {
              userId: actor.userId,
              transport: server.transport,
              endpoint: server.endpoint ?? null,
              command: server.command ?? null,
              allSpaces: true,
            },
          });
          if (existing) {
            skipped.push(`${id} (already in catalog)`);
            continue;
          }
          const stored = await prepareMcpServer(actor, config);
          const row = await deps.prisma.$transaction((tx) =>
            insertMcpServer(tx, actor, config, stored, { everywhere: true }),
          );
          if (stored?.id && secret) {
            const secretRow = await deps.prisma.secret.findFirst({
              where: { id: stored.id, ...itemSecretIn(actor) },
            });
            if (secretRow) {
              const material = JSON.parse(
                await deps.secrets.load(secretRow.ciphertext, secretRow.id),
              ) as Record<string, unknown>;
              const mergedEnv = {
                ...((material.env as Record<string, string>) ?? {}),
                ...protectedEnv,
              };
              const protectedHeaders = server.headerValues;
              const encrypted = await deps.secrets.put(
                JSON.stringify({
                  ...material,
                  env: mergedEnv,
                  headers: {
                    ...((material.headers as Record<string, string>) ?? {}),
                    ...protectedHeaders,
                  },
                }),
                computerContext(actor, "mcp", "mcp.import.credentials"),
                { recordId: secretRow.id },
              );
              await deps.prisma.secret.update({
                where: { id: secretRow.id },
                data: { ciphertext: encrypted.ciphertext },
              });
            }
          }
          imported.push(id);
          if (server.enabled) void probeMcpServer(row, actor);
        } catch {
          skipped.push(`${id} (unavailable)`);
        }
      }
      return { discovered: imported, unavailable: skipped };
    },
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
  };
}
