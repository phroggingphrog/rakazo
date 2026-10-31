import { describe, expect, it } from "vitest";
import {
  deduplicateImportedMcpServers,
  importClaudeMcpConfig,
  importCodexMcpConfig,
  importCursorMcpConfig,
  importDshMcpConfig,
  importPiMcpConfig,
  redactMcpImportPreview,
} from "./mcp-import.js";

const simple = JSON.stringify({ mcpServers: {
  local: { command: "node", args: ["server.js"], env: { API_TOKEN: "do-not-leak" } },
  remote: { type: "sse", url: "https://mcp.example.test/sse", enabled: false },
  incomplete: { type: "http" },
} });

describe("harness MCP import", () => {
  it.each([
    ["Pi", importPiMcpConfig],
    ["Cursor", importCursorMcpConfig],
    ["Claude Code", importClaudeMcpConfig],
    ["DSH", importDshMcpConfig],
  ])("imports JSON configuration for %s without exposing credentials", (_name, importer) => {
    const result = importer(simple);
    expect(result.servers).toHaveLength(3);
    expect(result.servers[0]).toMatchObject({ transport: "stdio", command: "node", auth: "static_credential", status: "ready" });
    expect(result.servers[1]).toMatchObject({ transport: "sse", enabled: false, status: "disabled" });
    expect(result.servers[2]).toMatchObject({ status: "unsupported", unsupported: ["Remote transport has no URL"] });
    expect(redactMcpImportPreview(result)).not.toContain("do-not-leak");
  });

  it("imports Codex TOML and retains server enablement and approval policy", () => {
    const result = importCodexMcpConfig('[mcp_servers.sample]\nurl = "https://mcp.example.test/mcp"\nenabled = false\n[mcp_servers.sample.tools.write]\napproval_mode = "approve"');
    expect(result.servers[0]).toMatchObject({ transport: "streamable_http", enabled: false, toolPolicy: { approval: "approve" }, status: "disabled" });
  });

  it("reports malformed configuration without throwing or returning source data", () => {
    expect(importPiMcpConfig('{"mcpServers": ["secret-value"]}')).toMatchObject({ servers: [], errors: [expect.any(String)] });
    expect(importCodexMcpConfig("invalid = [")).toMatchObject({ servers: [], errors: [expect.any(String)] });
  });

  it("deduplicates only matching identity and credential fingerprints", () => {
    const servers = importPiMcpConfig(simple).servers;
    const duplicate = { ...servers[0]!, provenance: { harness: "DSH", location: "dsh:mcp.json" } };
    const otherCredential = { ...duplicate, credentialFingerprint: "different" };
    const result = deduplicateImportedMcpServers([servers[0]!, duplicate, otherCredential]);
    expect(result).toHaveLength(2);
    expect(result[0]?.provenance.location).toContain("dsh:mcp.json");
  });

  it("rejects credential-bearing URLs and keeps import records non-executable", () => {
    const result = importCursorMcpConfig(JSON.stringify({ mcpServers: { bad: { url: "https://user:pass@example.test/mcp" } } }));
    expect(result.servers[0]?.status).toBe("unsupported");
    expect(result.servers[0]?.unsupported).toContain("URL must use HTTP(S) and contain no credentials or fragment");
    expect(JSON.stringify(result)).not.toContain("user:pass");
  });
});
