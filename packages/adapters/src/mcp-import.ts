import * as z from "zod";

export type McpImportTransport = "stdio" | "streamable_http" | "sse";
export type McpImportAuth = "none" | "environment_reference" | "static_credential" | "oauth";

export const ImportedHarnessMcpServerSchema = z.object({
  name: z.string().min(1).max(120),
  namespace: z.string().max(120).optional(),
  transport: z.enum(["stdio", "streamable_http", "sse"]),
  command: z.string().max(512).optional(),
  args: z.array(z.string().max(2048)).max(64).default([]),
  endpoint: z.string().max(2048).optional(),
  endpointIdentity: z.string().optional(),
  endpointHasCredentialPlaceholder: z.boolean().default(false),
  envReferences: z.record(z.string(), z.string().max(4096)).default({}),
  auth: z.enum(["none", "environment_reference", "static_credential", "oauth"]),
  enabled: z.boolean(),
  toolPolicy: z
    .object({ allowedTools: z.array(z.string()).optional(), approval: z.string().optional() })
    .default({}),
  provenance: z.object({
    harness: z.string(),
    location: z.string(),
    namespace: z.string().optional(),
  }),
  credentialFields: z.array(z.string()).default([]),
  environmentFields: z.array(z.string()).default([]),
  credentialHeaders: z.array(z.string()).default([]),
  headerValues: z.record(z.string(), z.string()).default({}),
  environmentValues: z.record(z.string(), z.string()).default({}),
  status: z.enum(["ready", "disabled", "unsupported"]),
  unsupported: z.array(z.string()).default([]),
});
export type ImportedHarnessMcpServer = z.infer<typeof ImportedHarnessMcpServerSchema>;
export type McpImportPreview = { servers: ImportedHarnessMcpServer[]; errors: string[] };

type RawServer = Record<string, unknown>;
const sensitiveKey = /token|secret|password|credential|api[-_]?key|authorization|cookie/i;
function scrubEnv(env: unknown): {
  env: Record<string, string>;
  auth: McpImportAuth;
  fields: string[];
  values: Record<string, string>;
} {
  const safe: Record<string, string> = {};
  const values: Record<string, string> = {};
  const fields: string[] = [];
  if (!env || typeof env !== "object" || Array.isArray(env))
    return { env: safe, auth: "none", fields, values };
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (sensitiveKey.test(key) && !/^\$\{[^}]+\}$/.test(value)) {
      fields.push(key);
      values[key] = value;
      safe[key] = "[credential requires protected re-entry]";
    } else if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) safe[key] = value;
    else safe[key] = "[value not imported]";
  }
  const refs = Object.values(safe).some((v) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v));
  return {
    env: safe,
    auth: fields.length ? "static_credential" : refs ? "environment_reference" : "none",
    fields,
    values,
  };
}
function serverEntries(root: unknown): Record<string, RawServer> {
  if (!root || typeof root !== "object" || Array.isArray(root))
    throw new Error("Configuration root must be an object");
  const input = root as Record<string, unknown>;
  const servers = input.mcpServers ?? input.mcp_servers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw new Error("MCP server list must be an object");
  return servers as Record<string, RawServer>;
}
function normalize(
  harness: string,
  location: string,
  entries: Record<string, RawServer>,
): McpImportPreview {
  const servers: ImportedHarnessMcpServer[] = [];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${name}: server entry must be an object`);
      continue;
    }
    const ns = typeof raw.namespace === "string" ? raw.namespace : undefined;
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const endpoint =
      typeof raw.url === "string"
        ? raw.url
        : typeof raw.endpoint === "string"
          ? raw.endpoint
          : undefined;
    const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
    const unsupported: string[] = [];
    let transport: McpImportTransport = command
      ? "stdio"
      : type === "sse"
        ? "sse"
        : "streamable_http";
    if (type && !["stdio", "http", "streamable_http", "sse"].includes(type))
      unsupported.push(`Unsupported transport type: ${type}`);
    if (type === "stdio" && !command) unsupported.push("stdio transport has no command");
    if (!command && !endpoint) unsupported.push("Remote transport has no URL");
    if (command && type && type !== "stdio")
      unsupported.push("Remote transport type cannot use a local command");
    if (!command && type === "stdio") unsupported.push("stdio transport has no command");
    let safeEndpoint = endpoint;
    let endpointHasCredentials = false;
    if (endpoint)
      try {
        const url = new URL(endpoint);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
          unsupported.push("URL must use HTTP(S) and contain no credentials or fragment");
        const sensitive = [...url.searchParams.keys()].filter((k) => sensitiveKey.test(k));
        if (sensitive.length) {
          endpointHasCredentials = true;
          unsupported.push("URL query contains credentials; reconnect with a protected credential");
        }
        for (const key of sensitive)
          url.searchParams.set(key, "[credential requires protected re-entry]");
        if (url.username || url.password || sensitive.length)
          safeEndpoint = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
      } catch {
        unsupported.push("URL is not valid");
      }
    const scrubbed = scrubEnv(raw.env ?? raw.env_vars);
    let auth = scrubbed.auth;
    const credentialHeaders: string[] = [];
    if (raw.headers && typeof raw.headers === "object")
      for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>))
        if (typeof value === "string" && (sensitiveKey.test(key) || value.length)) {
          scrubbed.fields.push(key);
          credentialHeaders.push(key);
          auth = "static_credential";
        }
    if (endpointHasCredentials) auth = "static_credential";
    if (raw.oauth || raw.oauth_config) auth = "oauth";
    if (type === "http" || type === "streamable_http") transport = "streamable_http";
    const enabled = raw.enabled !== false;
    const parsed = ImportedHarnessMcpServerSchema.safeParse({
      name,
      namespace: ns,
      transport,
      command,
      args: Array.isArray(raw.args)
        ? raw.args.filter((x): x is string => typeof x === "string")
        : [],
      endpoint: safeEndpoint,
      endpointHasCredentialPlaceholder: endpointHasCredentials,
      endpointIdentity: endpoint
        ? new URL(endpoint).origin + new URL(endpoint).pathname
        : undefined,
      envReferences: scrubbed.env,
      auth,
      enabled,
      toolPolicy: {
        allowedTools: Array.isArray(raw.allowedTools)
          ? raw.allowedTools.filter((x): x is string => typeof x === "string")
          : undefined,
        approval: raw.approval_mode === "approve" ? "approve" : undefined,
      },
      provenance: { harness, location, namespace: ns },
      credentialFields: [...scrubbed.fields, ...(endpointHasCredentials ? ["URL"] : [])].sort(),
      environmentFields: scrubbed.fields
        .filter((field) => Object.hasOwn(scrubbed.env, field))
        .sort(),
      environmentValues: scrubbed.values,
      credentialHeaders,
      headerValues: Object.fromEntries(
        credentialHeaders.map((key) => [
          key,
          sensitiveKey.test(key)
            ? "[credential requires protected reconnection]"
            : "[non-credential header value not imported]",
        ]),
      ),
      status: unsupported.length ? "unsupported" : enabled ? "ready" : "disabled",
      unsupported,
    });
    if (parsed.success) servers.push(parsed.data);
    else
      errors.push(
        `${name}: invalid configuration (${parsed.error.issues.map((i) => i.path.join(".") || "entry").join(", ")})`,
      );
  }
  return { servers, errors };
}
function jsonImporter(
  harness: string,
  source: string,
  location: string,
  rootSelector?: (root: Record<string, unknown>) => unknown,
): McpImportPreview {
  try {
    const root = JSON.parse(source) as Record<string, unknown>;
    const entries = rootSelector ? rootSelector(root) : serverEntries(root);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error();
    return normalize(harness, location, entries as Record<string, RawServer>);
  } catch {
    return {
      servers: [],
      errors: [`${harness} MCP configuration is invalid JSON or has an unsupported structure`],
    };
  }
}
export function importPiMcpConfig(source: string, location = "pi:mcp.json"): McpImportPreview {
  return jsonImporter("Pi", source, location);
}
export function importCursorMcpConfig(
  source: string,
  location = "cursor:mcp.json",
): McpImportPreview {
  return jsonImporter("Cursor", source, location);
}
export function importClaudeMcpConfig(
  source: string,
  location = "claude:settings.json",
): McpImportPreview {
  return jsonImporter("Claude Code", source, location);
}
export function importDshMcpConfig(source: string, location = "dsh:mcp.json"): McpImportPreview {
  return jsonImporter("DSH", source, location);
}
export function importOpenCodeMcpConfig(
  source: string,
  location = "opencode:opencode.json",
): McpImportPreview {
  return jsonImporter("OpenCode", source, location, (root) => {
    const mcp = root.mcp as Record<string, unknown> | undefined;
    const raw = mcp?.servers;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const normalized: Record<string, RawServer> = {};
    for (const [name, item] of Object.entries(raw)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        normalized[name] = item as RawServer;
        continue;
      }
      const config = item as RawServer;
      const command = Array.isArray(config.command)
        ? config.command.filter((x): x is string => typeof x === "string")
        : [];
      normalized[name] = {
        ...config,
        type: config.type === "local" ? "stdio" : config.type === "remote" ? "http" : config.type,
        command: command[0],
        args: command.slice(1),
        url: config.url,
        enabled: config.enabled !== false,
      };
    }
    return normalized;
  });
}
function parseCodexToml(source: string): Record<string, RawServer> {
  const servers: Record<string, RawServer> = {};
  let current: RawServer | undefined;
  if (/^\s*[^\n=]+\s*=/.test(source) && !/^\s*\[mcp_servers\./m.test(source))
    throw new Error("TOML has assignments outside MCP server tables");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, " ").trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.(.+))?\]$/.exec(line);
    if (section) {
      current = servers[section[1]!] ??= {};
      continue;
    }
    if (line.startsWith("[")) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const field = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (!field) throw new Error("Invalid TOML assignment");
    const key = field[1]!;
    const value = field[2]!.trim();
    if (value === "true" || value === "false") current[key] = value === "true";
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) current[key] = Number(value);
    else if (value.startsWith('"') && value.endsWith('"')) current[key] = JSON.parse(value);
    else if (value.startsWith("[") && value.endsWith("]"))
      current[key] = [...value.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) =>
        JSON.parse(`"${m[1]}"`),
      );
    else throw new Error("Unsupported Codex TOML value");
  }
  return servers;
}
export function importCodexMcpConfig(
  source: string,
  location = "codex:config.toml",
): McpImportPreview {
  try {
    return normalize("Codex", location, parseCodexToml(source));
  } catch {
    return {
      servers: [],
      errors: ["Codex MCP configuration is invalid TOML or has an unsupported structure"],
    };
  }
}
export function deduplicateImportedMcpServers(
  input: ImportedHarnessMcpServer[],
): ImportedHarnessMcpServer[] {
  const keyed = new Map<string, ImportedHarnessMcpServer>();
  for (const server of input) {
    const identity = [
      server.name.toLowerCase(),
      server.namespace ?? "",
      server.transport,
      server.command ?? server.endpointIdentity ?? server.endpoint ?? "",
      server.credentialFields.join(","),
    ].join("\0");
    if (server.credentialFields.length) {
      keyed.set(`${identity}\0${server.provenance.harness}\0${server.provenance.location}`, {
        ...server,
        environmentValues: {},
        headerValues: {},
      });
      continue;
    }
    const matching = [...keyed.keys()].find(
      (key) => key === identity || key.startsWith(`${identity}\0`),
    );
    if (matching) {
      const prior = keyed.get(matching)!;
      keyed.set(identity, {
        ...prior,
        provenance: {
          ...prior.provenance,
          location: `${prior.provenance.location}; ${server.provenance.location}`,
        },
        enabled: prior.enabled || server.enabled,
      });
    } else keyed.set(identity, server);
  }
  return [...keyed.values()];
}
export function redactMcpImportPreview(value: unknown): string {
  return JSON.stringify(value, (key, item) =>
    key === "sourceContent" ||
    key === "environmentValues" ||
    key === "headerValues" ||
    (sensitiveKey.test(key) && typeof item === "string")
      ? "[redacted]"
      : item,
  );
}
