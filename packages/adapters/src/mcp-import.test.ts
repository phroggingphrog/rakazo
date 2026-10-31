import { describe, expect, it } from "vitest";
import {
  deduplicateImportedMcpServers,
  importClaudeMcpConfig,
  importCodexMcpConfig,
  importCursorMcpConfig,
  importDshMcpConfig,
  importOpenCodeMcpConfig,
  importPiMcpConfig,
  redactMcpImportPreview,
} from "./mcp-import.js";

const simple = JSON.stringify({
  mcpServers: {
    local: { command: "node", args: ["server.js"], env: { API_TOKEN: "do-not-leak" } },
    remote: { type: "sse", url: "https://mcp.example.test/sse", enabled: false },
    incomplete: { type: "http" },
  },
});

describe("harness MCP import", () => {
  it.each([
    ["Pi", importPiMcpConfig],
    ["Cursor", importCursorMcpConfig],
    ["Claude Code", importClaudeMcpConfig],
    ["DSH", importDshMcpConfig],
  ])("imports JSON configuration for %s without exposing credentials", (_name, importer) => {
    const result = importer(simple);
    expect(result.servers).toHaveLength(3);
    expect(result.servers[0]).toMatchObject({
      transport: "stdio",
      command: "node",
      auth: "static_credential",
      status: "ready",
    });
    expect(result.servers[1]).toMatchObject({
      transport: "sse",
      enabled: false,
      status: "disabled",
    });
    expect(result.servers[2]).toMatchObject({
      status: "unsupported",
      unsupported: ["Remote transport has no URL"],
    });
    expect(redactMcpImportPreview(result)).not.toContain("do-not-leak");
  });

  it("deduplicates endpoints across harnesses but preserves different identities", () => {
    const one = importPiMcpConfig(
      JSON.stringify({
        mcpServers: { wiki: { type: "http", url: "https://mcp.example.test/mcp" } },
      }),
    ).servers[0]!;
    const same = {
      ...one,
      provenance: { harness: "Claude Code", location: "claude:.claude.json" },
    };
    const other = {
      ...same,
      name: "wiki-personal",
      endpoint: "https://mcp.example.test/personal",
      endpointIdentity: "https://mcp.example.test/personal",
    };
    expect(deduplicateImportedMcpServers([one, same, other])).toHaveLength(2);
  });

  it("classifies a remote Google OAuth provider as Google OAuth", () => {
    const result = importPiMcpConfig(
      JSON.stringify({
        mcpServers: {
          google: { type: "http", url: "https://accounts.google.com/mcp", oauth: {} },
        },
      }),
    );
    expect(result.servers[0]).toMatchObject({
      auth: "oauth_google",
      transport: "streamable_http",
      endpoint: "https://accounts.google.com/mcp",
    });
  });

  it("imports Codex TOML and retains server enablement and approval policy", () => {
    const result = importCodexMcpConfig(
      '[mcp_servers.sample]\nurl = "https://mcp.example.test/mcp"\nenabled = false\n[mcp_servers.sample.tools.write]\napproval_mode = "approve"',
    );
    expect(result.servers[0]).toMatchObject({
      transport: "streamable_http",
      enabled: false,
      toolPolicy: { approval: "approve" },
      status: "disabled",
    });
  });

  it("imports OpenCode remote and local server forms", () => {
    const result = importOpenCodeMcpConfig(
      JSON.stringify({
        mcp: {
          servers: {
            remote: { type: "remote", url: "https://mcp.example.test" },
            local: { type: "local", command: ["node", "server.js"], enabled: false },
          },
        },
      }),
    );
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]).toMatchObject({ transport: "streamable_http", status: "ready" });
    expect(result.servers[1]).toMatchObject({
      transport: "stdio",
      status: "disabled",
      command: "node",
    });
  });

  it("reports malformed configuration without throwing or returning source data", () => {
    expect(importPiMcpConfig('{"mcpServers": ["secret-value"]}')).toMatchObject({
      servers: [],
      errors: [expect.any(String)],
    });
    expect(importCodexMcpConfig("invalid = [")).toMatchObject({
      servers: [],
      errors: [expect.any(String)],
    });
  });

  it("deduplicates only matching identity and credential fingerprints", () => {
    const servers = importPiMcpConfig(simple).servers;
    const duplicate = { ...servers[0]!, provenance: { harness: "DSH", location: "dsh:mcp.json" } };
    const otherCredential = {
      ...duplicate,
      credentialFields: ["OTHER_TOKEN"],
      provenance: { harness: "Pi", location: "other:mcp.json" },
    };
    const result = deduplicateImportedMcpServers([servers[0]!, duplicate, otherCredential]);
    expect(result).toHaveLength(3);
    expect(result[0]?.provenance.location).toContain("mcp.json");
  });

  it("redacts credential-bearing header and query values from every result", () => {
    const result = importPiMcpConfig(
      JSON.stringify({
        mcpServers: {
          server: {
            type: "http",
            url: "https://mcp.example.test/mcp?access_token=hidden-query",
            headers: { Authorization: "Bearer hidden-header" },
          },
        },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("hidden-query");
    expect(JSON.stringify(result)).not.toContain("hidden-header");
    expect(result.servers[0]).toMatchObject({ auth: "static_credential", status: "unsupported" });
  });

  it("rejects credential-bearing URLs and keeps import records non-executable", () => {
    const result = importCursorMcpConfig(
      JSON.stringify({ mcpServers: { bad: { url: "https://user:pass@example.test/mcp" } } }),
    );
    expect(result.servers[0]?.status).toBe("unsupported");
    expect(result.servers[0]?.unsupported).toContain(
      "URL must use HTTP(S) and contain no credentials or fragment",
    );
    expect(JSON.stringify(result)).not.toContain("user:pass");
  });
});
