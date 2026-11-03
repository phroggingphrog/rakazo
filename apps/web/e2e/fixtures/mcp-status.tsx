import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { McpServersOverlay } from "../../src/pages/McpServersOverlay";
import "../../src/styles.css";

const base = {
  description: "",
  transport: "streamable_http",
  enabled: true,
  hasSecret: false,
  hasArgs: false,
  envKeys: [],
  fileKeys: [],
  headerNames: [],
  oauthStatus: "reconnect",
  oauthClientId: null,
  hasOauthClientSecret: false,
  oauthScope: null,
  oauthAuthorizationParams: "",
  availability: { mode: "owner" },
  health: { status: "ok", message: null, checkedAt: new Date().toISOString(), toolCount: 23 },
};
const servers = [
  {
    ...base,
    id: "gmail",
    slug: "gmail",
    name: "Gmail",
    endpoint: "https://gmail.example.test/mcp",
  },
  {
    ...base,
    id: "archive",
    slug: "archive",
    name: "Archive MCP",
    endpoint: "https://archive.example.test/mcp",
    health: {
      ...base.health,
      status: "error",
      toolCount: null,
      message: "MCP authorization expired. Reconnect this server in MCP settings.",
    },
  },
  {
    ...base,
    id: "local",
    slug: "local",
    name: "Local MCP",
    transport: "stdio",
    endpoint: null,
    command: "npx",
    oauthStatus: "none",
    health: {
      ...base.health,
      status: "error",
      toolCount: null,
      message: "Command is not allowed by this deployment",
    },
  },
];
const original = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : String(input), location.href)
    .pathname;
  if (path.startsWith("/rpc/")) {
    let data: unknown = [];
    if (path.endsWith("/mcp/servers/list")) data = servers;
    else if (path.endsWith("/bots/list"))
      data = [{ id: "bot-1", name: "Example bot", archivedAt: null }];
    return Response.json({ json: data });
  }
  return original(input, init);
};
await bootstrapI18n();
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <McpServersOverlay onClose={() => {}} />
    </QueryClientProvider>
  </I18nProvider>,
);
