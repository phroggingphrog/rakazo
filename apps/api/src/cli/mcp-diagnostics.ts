// Run this read-only command separately in the API and worker containers.
// node dist/cli/mcp-diagnostics.js <bot-id> <server-slug> [read-only-tool-name]
import { contentKeyProviderFromEnv, createSecretStore, McpConnector } from "@rakazo/adapters";
import { createDb, runAsSystem } from "@rakazo/db";
import { loadEnv } from "../env.js";

const report = (value: string) => {
  process.stdout.write(`${value}\n`);
};
const [botId, slug, toolName] = process.argv.slice(2);
if (!botId || !slug) throw new Error("Specify an existing bot ID and server slug");
const env = loadEnv();
const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
const secrets = createSecretStore(env.encryptionKey);
const connector = new McpConnector(prisma, secrets, {
  stdioEnabled: env.mcpStdioEnabled,
  allowedCommands: env.mcpStdioAllowedCommands,
  ...env.mcpStdio,
  allowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
});
try {
  await runAsSystem("owner-invoked read-only MCP execution-path diagnostic", async () => {
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    const assignment = await prisma.botMcpServer.findFirst({
      where: { botId, spaceId: bot.spaceId, userId: bot.userId, server: { slug, enabled: true } },
      include: { server: true },
    });
    if (!assignment) {
      report(
        JSON.stringify({
          code: "missing_assignment",
          recovery: "Ask the owner for this specific bot grant",
        }),
      );
      return;
    }
    const context = {
      operationId: "mcp-diagnostics",
      traceId: "mcp-diagnostics",
      spaceId: bot.spaceId,
      userId: bot.userId,
      botId,
      signal: AbortSignal.timeout(30000),
    };
    await connector.discoverTools(context);
    const unavailable = await connector.resolveCall(
      { tool: `mcp__${slug}__unavailable`, args: {}, executionId: "diagnostic-unavailable" },
      context,
    );
    if (unavailable) {
      report(
        JSON.stringify({
          code: "connection_unavailable",
          recovery:
            "Inspect the sanitized MCP health reason and run this diagnostic in both execution services",
          gitSha: env.gitSha,
        }),
      );
      return;
    }
    // Resolve only owner-selected tools. A read-only annotation is necessary but not
    // sufficient for automatic diagnostics: the CLI never invokes a tool by default.
    if (!toolName) {
      report(JSON.stringify({ code: "discovery_checked", gitSha: env.gitSha, assigned: true }));
      return;
    }
    const resolved = await connector.resolveCall(
      { tool: `mcp__${slug}__${toolName}`, args: {}, executionId: "diagnostic" },
      context,
    );
    if (resolved?.tool.readOnly !== true) {
      report(
        JSON.stringify({
          code: "read_only_tool_not_available",
          recovery: "Select an explicitly read-only assigned tool",
        }),
      );
      return;
    }
    let result = false;
    let error = false;
    for await (const event of connector.execute(resolved.call, context)) {
      if (event.type === "result") result = true;
      if (event.type === "error") error = true;
    }
    report(
      JSON.stringify({
        code: error ? "execution_failed" : "read_only_execution_checked",
        result,
        gitSha: env.gitSha,
      }),
    );
  });
} catch (error) {
  report(
    JSON.stringify({
      code: "diagnostic_failed",
      errorClass: error instanceof Error ? error.name : "Error",
      recovery: "Check assignment, authentication and network from both containers",
    }),
  );
  process.exitCode = 1;
} finally {
  await connector.close();
  await secrets.close?.();
  await prisma.$disconnect();
  await pool.end();
}
