import { createHash } from "node:crypto";
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
  envReferences: z.record(z.string(), z.string().max(4096)).default({}),
  auth: z.enum(["none", "environment_reference", "static_credential", "oauth"]),
  enabled: z.boolean(),
  toolPolicy: z.object({ allowedTools: z.array(z.string()).optional(), approval: z.string().optional() }).default({}),
  provenance: z.object({ harness: z.string(), location: z.string(), namespace: z.string().optional() }),
  credentialFingerprint: z.string().optional(),
  status: z.enum(["ready", "disabled", "unsupported"]),
  unsupported: z.array(z.string()).default([]),
});
export type ImportedHarnessMcpServer = z.infer<typeof ImportedHarnessMcpServerSchema>;
export type McpImportPreview = { servers: ImportedHarnessMcpServer[]; errors: string[] };

type RawServer = Record<string, unknown>;

const sensitiveKey = /token|secret|password|credential|api[-_]?key|authorization|cookie/i;
function secretFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function scrubEnv(env: unknown): { env: Record<string, string>; auth: McpImportAuth; fingerprints: string[] } {
  const safe: Record<string, string> = {};
  const fingerprints: string[] = [];
  if (!env || typeof env !== "object" || Array.isArray(env)) return { env: safe, auth: "none", fingerprints };
  for (const [key, val] of Object.entries(env)) {
    if (typeof val !== "string") continue;
    if (sensitiveKey.test(key) && !/^\$\{[^}]+\}$/.test(val)) {
      fingerprints.push(secretFingerprint(val));
      safe[key] = "[redacted:static-credential]";
    } else {
      safe[key] = val;
    }
  }
  const references = Object.values(safe).some((val) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(val));
  return { env: safe, auth: fingerprints.length ? "static_credential" : references ? "environment_reference" : "none", fingerprints };
}
function serverEntries(root: unknown): Record<string, RawServer> {
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Configuration root must be an object");
  const input = root as Record<string, unknown>;
  const servers = input.mcpServers ?? input.mcp_servers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP server list must be an object");
  return servers as Record<string, RawServer>;
}

function normalize(harness: string, location: string, entries: Record<string, RawServer>): McpImportPreview {
  const servers: ImportedHarnessMcpServer[] = [];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${name}: server entry must be an object`);
      continue;
    }
    const ns = typeof raw.namespace === "string" ? raw.namespace : undefined;
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const endpoint = typeof raw.url === "string" ? raw.url : typeof raw.endpoint === "string" ? raw.endpoint : undefined;
    const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
    const unsupported: string[] = [];
    let transport: McpImportTransport = command ? "stdio" : type === "sse" ? "sse" : "streamable_http";
    if (type && !["stdio", "http", "streamable_http", "sse"].includes(type)) unsupported.push(`Unsupported transport type: ${type}`);
    if (type === "stdio" && !command) unsupported.push("stdio transport has no command");
    if (!command && !endpoint) unsupported.push("Remote transport has no URL");
    if (command && type && type !== "stdio") unsupported.push("Remote transport type cannot use a local command");
    if (!command && type === "stdio") unsupported.push("stdio transport has no command");
    let safeEndpoint = endpoint;
    if (endpoint) {
      try {
        const url = new URL(endpoint);
        if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.hash) unsupported.push("URL must use HTTP(S) and contain no credentials or fragment");
        if (url.username || url.password) safeEndpoint = `${url.protocol}//${url.host}${url.pathname}${url.search}`;
      } catch { unsupported.push("URL is not valid"); }
    }
    const scrubbed = scrubEnv(raw.env ?? raw.env_vars);
    let auth: McpImportAuth = scrubbed.auth;
    if (raw.headers && typeof raw.headers === "object") {
      for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof value === "string" && (sensitiveKey.test(key) || value.length)) {
          scrubbed.fingerprints.push(secretFingerprint(value));
          auth = "static_credential";
        }
      }
    }
    if (raw.oauth || raw.oauth_config) auth = "oauth";
    if (type === "http" || type === "streamable_http") transport = "streamable_http";
    const enabled = raw.enabled !== false;
    const parsed = ImportedHarnessMcpServerSchema.safeParse({
      name, namespace: ns, transport, command, args: Array.isArray(raw.args) ? raw.args.filter((item): item is string => typeof item === "string") : [],
      endpoint: safeEndpoint, envReferences: scrubbed.env, auth, enabled,
      toolPolicy: { allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools.filter((x): x is string => typeof x === "string") : undefined,
        approval: raw.approval_mode === "approve" ? "approve" : undefined },
      provenance: { harness, location, namespace: ns }, credentialFingerprint: scrubbed.fingerprints.length ? secretFingerprint(scrubbed.fingerprints.sort().join("|")) : undefined,
      status: unsupported.length ? "unsupported" : enabled ? "ready" : "disabled", unsupported,
    });
    if (parsed.success) servers.push(parsed.data);
    else errors.push(`${name}: invalid configuration (${parsed.error.issues.map((issue) => issue.path.join(".") || "entry").join(", ")})`);
  }
  return { servers, errors };
}

export function importPiMcpConfig(source: string, location = "pi:mcp.json"): McpImportPreview {
  try { return normalize("Pi", location, serverEntries(JSON.parse(source))); }
  catch { return { servers: [], errors: ["Pi MCP configuration is invalid JSON or has an unsupported structure"] }; }
}
export function importCursorMcpConfig(source: string, location = "cursor:mcp.json"): McpImportPreview {
  try { return normalize("Cursor", location, serverEntries(JSON.parse(source))); }
  catch { return { servers: [], errors: ["Cursor MCP configuration is invalid JSON or has an unsupported structure"] }; }
}
export function importClaudeMcpConfig(source: string, location = "claude:settings.json"): McpImportPreview {
  try {
    const data = JSON.parse(source) as Record<string, unknown>;
    const servers = serverEntries(data);
    return normalize("Claude Code", location, servers);
  } catch { return { servers: [], errors: ["Claude Code MCP configuration is invalid JSON or has an unsupported structure"] }; }
}
export function importDshMcpConfig(source: string, location = "dsh:mcp.json"): McpImportPreview {
  try { return normalize("DSH", location, serverEntries(JSON.parse(source))); }
  catch { return { servers: [], errors: ["DSH MCP configuration is invalid JSON or has an unsupported structure"] }; }
}
function parseCodexToml(source: string): Record<string, RawServer> {
  const servers: Record<string, RawServer> = {};
  let current: RawServer | undefined;
  if (/^\s*[^\n=]+\s*=/.test(source) && !/^\s*\[mcp_servers\./m.test(source)) throw new Error("TOML has assignments outside MCP server tables");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.(.+))?\]$/.exec(line);
    if (section) {
      current = servers[section[1]!] ??= {};
      continue;
    }
    if (line.startsWith("[")) { current = undefined; continue; }
    if (!current) continue;
    const field = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/.exec(line);
    if (!field) throw new Error("Invalid TOML assignment");
    const key = field[1]!;
    const value = field[2]!.trim();
    if (value === "true" || value === "false") current[key] = value === "true";
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) current[key] = Number(value);
    else if (value.startsWith('"') && value.endsWith('"')) current[key] = JSON.parse(value);
    else if (value.startsWith("[") && value.endsWith("]")) {
      const items = [...value.matchAll(/\"((?:\\\\.|[^\"\\\\])*)\"/g)].map((item) => JSON.parse(`\"${item[1]}\"`));
      current[key] = items;
    } else throw new Error("Unsupported Codex TOML value");
  }
  return servers;
}
export function importCodexMcpConfig(source: string, location = "codex:config.toml"): McpImportPreview {
  try { return normalize("Codex", location, parseCodexToml(source)); }
  catch { return { servers: [], errors: ["Codex MCP configuration is invalid TOML or has an unsupported structure"] }; }
}

export function deduplicateImportedMcpServers(input: ImportedHarnessMcpServer[]): ImportedHarnessMcpServer[] {
  const keyed = new Map<string, ImportedHarnessMcpServer>();
  for (const server of input) {
    const identity = [server.name.toLowerCase(), server.namespace ?? "", server.transport, server.command ?? server.endpoint ?? "", server.credentialFingerprint ?? ""].join("\0");
    const existing = keyed.get(identity);
    if (!existing) keyed.set(identity, server);
    else keyed.set(identity, { ...existing, provenance: { ...existing.provenance, location: `${existing.provenance.location}; ${server.provenance.location}` }, enabled: existing.enabled || server.enabled });
  }
  return [...keyed.values()];
}

export function redactMcpImportPreview(value: unknown): string {
  return JSON.stringify(value, (key, item) => sensitiveKey.test(key) && typeof item === "string" ? "[redacted]" : item);
}
