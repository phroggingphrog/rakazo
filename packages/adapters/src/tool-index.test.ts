import type { ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { ToolIndexWindows } from "./tool-index.js";
import {
  DEFAULT_TOOL_INDEX_WINDOWS,
  EMPTY_TOOL_INDEX_REVISION,
  ToolIndex,
  toolSource,
} from "./tool-index.js";

const windows: ToolIndexWindows = { graceMs: 1_000, freshnessMs: 10_000 };
const scope = { spaceId: "space-a", botId: "bot-a" };

function mcpTool(name: string, description = "an mcp tool", serverId = "server-1"): ConnectorTool {
  return {
    name,
    description,
    inputSchema: { type: "object" },
    route: { connectorId: "mcp", toolName: name, resourceId: serverId },
  };
}

function installedTool(name: string, installId = "install-1"): ConnectorTool {
  return {
    name,
    description: "an installed capability tool",
    inputSchema: { type: "object" },
    route: { connectorId: "installed", toolName: name, resourceId: installId },
  };
}

function providerTool(name: string, connectorId = "composio"): ConnectorTool {
  return {
    name,
    description: "a provider tool",
    inputSchema: { type: "object" },
    route: { connectorId, toolName: name },
  };
}

const names = (entries: readonly { name: string }[]) => entries.map((entry) => entry.name);

describe("derived tool index", () => {
  it("projects provenance from the route the offering connector set", () => {
    expect(toolSource(mcpTool("mcp__github__create_issue", "x", "server-9"))).toEqual({
      kind: "mcp",
      id: "server-9",
    });
    expect(toolSource(installedTool("linear_create_issue", "install-7"))).toEqual({
      kind: "installed",
      id: "install-7",
    });
    expect(toolSource(providerTool("gmail_send_email"))).toEqual({
      kind: "connector",
      id: "composio",
    });
    // A provider library tool with no resource id still resolves to its connector id.
    expect(toolSource(providerTool("slack_post_message", "pipedream"))).toEqual({
      kind: "connector",
      id: "pipedream",
    });
  });

  it("records source, scope, description digest and confirmation time", () => {
    const index = new ToolIndex({ windows });
    const snapshot = index.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue", "opens a GitHub issue")],
      now: 1_000,
    });
    expect(snapshot.entries).toHaveLength(1);
    const entry = snapshot.entries[0]!;
    expect(entry).toMatchObject({
      name: "mcp__github__create_issue",
      spaceId: "space-a",
      botId: "bot-a",
      firstSeenAt: 1_000,
      lastConfirmedAt: 1_000,
      absentSince: null,
      source: { kind: "mcp", id: "server-1" },
    });
    // The digest stands in for the description, which is never stored.
    expect(entry.descriptionDigest).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(entry)).not.toContain("opens a GitHub issue");
  });

  it("withholds a tool the source answered without", () => {
    const index = new ToolIndex({ windows });
    index.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue"), mcpTool("mcp__github__delete_repo")],
      now: 1_000,
    });
    // The server answered and no longer lists delete_repo: offering it would fail at call time.
    const snapshot = index.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue")],
      now: 2_000,
    });
    expect(names(snapshot.entries)).toEqual(["mcp__github__create_issue"]);
    expect(snapshot.withheld).toEqual([{ name: "mcp__github__delete_repo", reason: "dropped" }]);
  });

  it("keeps a silent source through the grace window, then withholds it", () => {
    const index = new ToolIndex({ windows });
    index.observe({ scope, tools: [mcpTool("mcp__github__create_issue")], now: 1_000 });
    // The source reported nothing at all: it may be a live-only provider outage.
    const duringGrace = index.observe({ scope, tools: [], now: 1_500 });
    expect(names(duringGrace.entries)).toEqual(["mcp__github__create_issue"]);
    expect(duringGrace.withheld).toEqual([]);
    const afterGrace = index.snapshot(scope, 2_600);
    expect(afterGrace.entries).toEqual([]);
    expect(afterGrace.withheld).toEqual([
      { name: "mcp__github__create_issue", reason: "grace-expired" },
    ]);
  });

  it("does not touch a source that reported its own enumeration failure", () => {
    const index = new ToolIndex({ windows });
    index.observe({ scope, tools: [mcpTool("mcp__github__create_issue")], now: 1_000 });
    index.observe({
      scope,
      tools: [],
      now: 2_000,
      failedSources: [{ kind: "mcp", id: "server-1" }],
    });
    // Past the grace window a silent source is withheld; a source that said "I failed" is not.
    const snapshot = index.snapshot(scope, 2_500);
    expect(names(snapshot.entries)).toEqual(["mcp__github__create_issue"]);
    expect(snapshot.entries[0]!.absentSince).toBeNull();
    expect(snapshot.withheld).toEqual([]);
  });

  it("withholds an entry that was not confirmed inside the freshness window", () => {
    const index = new ToolIndex({ windows });
    index.observe({ scope, tools: [installedTool("linear_create_issue")], now: 1_000 });
    expect(names(index.snapshot(scope, 10_500).entries)).toEqual(["linear_create_issue"]);
    const stale = index.snapshot(scope, 11_500);
    expect(stale.entries).toEqual([]);
    expect(stale.withheld).toEqual([{ name: "linear_create_issue", reason: "stale" }]);
  });

  it("keeps a source alive again after a transient gap", () => {
    const index = new ToolIndex({ windows });
    index.observe({ scope, tools: [mcpTool("mcp__github__create_issue")], now: 1_000 });
    index.observe({ scope, tools: [], now: 1_500 });
    const snapshot = index.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue")],
      now: 4_000,
    });
    expect(names(snapshot.entries)).toEqual(["mcp__github__create_issue"]);
    expect(snapshot.entries[0]!.absentSince).toBeNull();
    expect(snapshot.withheld).toEqual([]);
  });

  it("gives an equal revision for equal content and a new one when a description changes", () => {
    const first = new ToolIndex({ windows });
    const second = new ToolIndex({ windows });
    first.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue", "opens an issue")],
      now: 1_000,
    });
    second.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue", "opens an issue")],
      now: 9_000,
    });
    const firstRevision = first.snapshot(scope, 1_000).revision;
    expect(second.snapshot(scope, 9_000).revision).toBe(firstRevision);
    expect(firstRevision).not.toBe(EMPTY_TOOL_INDEX_REVISION);
    const changed = first.observe({
      scope,
      tools: [mcpTool("mcp__github__create_issue", "opens an issue with labels")],
      now: 2_000,
    });
    expect(changed.revision).not.toBe(firstRevision);
  });

  it("never indexes one offered name twice", () => {
    const index = new ToolIndex({ windows });
    index.observe({ scope, tools: [providerTool("gmail_send_email")], now: 1_000 });
    const snapshot = index.observe({
      scope,
      tools: [providerTool("gmail_send_email"), providerTool("gmail_send_email")],
      now: 2_000,
    });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.firstSeenAt).toBe(1_000);
    expect(snapshot.entries[0]!.lastConfirmedAt).toBe(2_000);
  });

  it("keeps one scope bounded and evicts the least recently used scope", () => {
    const index = new ToolIndex({ windows, maxEntriesPerScope: 2, maxScopes: 1 });
    const snapshot = index.observe({
      scope,
      tools: [mcpTool("mcp__a__one"), mcpTool("mcp__a__two"), mcpTool("mcp__a__three")],
      now: 1_000,
    });
    expect(snapshot.entries).toHaveLength(2);
    expect(names(snapshot.entries)).toEqual(["mcp__a__three", "mcp__a__two"]);
    index.observe({
      scope: { spaceId: "space-b", botId: "bot-b" },
      tools: [mcpTool("mcp__b__one")],
      now: 1_000,
    });
    expect(index.size).toBe(1);
    expect(index.snapshot(scope, 1_000).revision).toBe(EMPTY_TOOL_INDEX_REVISION);
  });

  it("counts successful and failed uses per tool", () => {
    const index = new ToolIndex({ windows });
    index.recordToolOutcome(scope, "mcp__github__create_issue", true);
    index.recordToolOutcome(scope, "mcp__github__create_issue", true);
    index.recordToolOutcome(scope, "mcp__github__create_issue", false);
    expect(index.usageFor(scope).get("mcp__github__create_issue")).toEqual({
      successes: 2,
      failures: 1,
    });
    // Another bot in the same space has no history of its own.
    expect(index.usageFor({ spaceId: "space-a", botId: "bot-b" }).size).toBe(0);
  });

  it("documents the default windows against the existing re-probe cadence", () => {
    expect(DEFAULT_TOOL_INDEX_WINDOWS.graceMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(DEFAULT_TOOL_INDEX_WINDOWS.freshnessMs).toBeGreaterThan(
      DEFAULT_TOOL_INDEX_WINDOWS.graceMs,
    );
  });
});
