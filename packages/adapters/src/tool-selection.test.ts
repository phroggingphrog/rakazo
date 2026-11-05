import type { ConnectorTool } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { FIND_TOOL, partitionTools, USE_TOOL } from "./builtin-tool-bridge.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { ToolIndex } from "./tool-index.js";
import {
  resetToolSelectionMetrics,
  selectionIndexOf,
  selectToolsForRun,
  toolSelectionEnabled,
  toolSelectionMetrics,
} from "./tool-selection.js";

function builtinTool(name: string, description = "a built-in tool"): ConnectorTool {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

function connectorTool(name: string, description = "", connectorId = "composio"): ConnectorTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    route: { connectorId, toolName: name },
  };
}

function catalog(servable: readonly string[], revision = "rev-1") {
  return { revision, servable };
}

const toolNames = (tools: readonly ConnectorTool[]) => tools.map((tool) => tool.name);

const shell = builtinTool("shell");
const readFile = builtinTool("read_file");

beforeEach(() => {
  resetToolSelectionMetrics();
});

describe("bounded per-turn tool selection", () => {
  it("keeps the full set on an owner-started run", () => {
    const candidates = [connectorTool("gmail_send_email"), connectorTool("jira_search")];
    const result = selectToolsForRun({
      builtins: [shell, readFile],
      connectorCandidates: candidates,
      trigger: "user",
      request: "send an email",
      index: catalog(["gmail_send_email", "jira_search"]),
    });
    expect(result.record.mode).toBe("interactive-full-set");
    expect(toolNames(result.tools)).toEqual([
      "shell",
      "read_file",
      "gmail_send_email",
      "jira_search",
    ]);
    // Every candidate is offered, whatever its score.
    expect(result.record.selected).toBe(2);
  });

  it("honours the caller's owner-started verdict over the trigger alone", () => {
    // The executor already resolved ownerStartedRun, including follow_up-from-user, which the
    // trigger string alone cannot express.
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: [connectorTool("gmail_send_email"), connectorTool("jira_search")],
      trigger: "follow_up",
      interactive: true,
      request: "anything",
      index: catalog(["gmail_send_email"]),
    });
    expect(result.record.mode).toBe("interactive-full-set");
    expect(toolNames(result.tools)).toEqual(["shell", "gmail_send_email", "jira_search"]);
  });

  it("selects for a scheduled run and keeps the built-ins", () => {
    const result = selectToolsForRun({
      builtins: [shell, readFile],
      connectorCandidates: [connectorTool("gmail_send_email"), connectorTool("jira_search")],
      trigger: "routine",
      request: "send the weekly email",
      index: catalog(["gmail_send_email", "jira_search"]),
    });
    expect(result.record.mode).toBe("selected");
    expect(result.record.interactive).toBe(false);
    expect(toolNames(result.tools)).toContain("shell");
    expect(toolNames(result.tools)).toContain("read_file");
    expect(result.record.selected).toBe(2);
  });

  it("never re-admits a tool the policy filter removed, however relevant it looks", () => {
    // The caller already applied the allowlists and the disabled-tool set, so deploy_prod
    // and the unreachable calendar tool are not in the candidate set at all.
    const candidates = [connectorTool("jira_search")];
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "deploy_prod deploy prod deploy_prod deploy_prod",
      index: catalog(["deploy_prod", "jira_search", "calendar_delete_event"]),
    });
    expect(toolNames(result.tools)).not.toContain("deploy_prod");
    expect(toolNames(result.tools)).not.toContain("calendar_delete_event");
    expect(result.record.withheld.byPolicy).toEqual(["calendar_delete_event", "deploy_prod"]);
    // The only offered connector tool is the one the policy let through.
    expect(toolNames(result.tools).filter((name) => name !== "shell")).toEqual(["jira_search"]);
  });

  it("can only ever return names that were already offered", () => {
    const indexNames = ["alpha", "beta", "gamma", "deploy_prod"];
    const candidates = [connectorTool("alpha"), connectorTool("beta")];
    const offered = new Set(toolNames(candidates));
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "webhook",
      request: "gamma deploy_prod alpha beta",
      index: catalog(indexNames),
    });
    for (const tool of result.tools) {
      expect(offered.has(tool.name) || tool.name === "shell").toBe(true);
    }
  });

  it("is deterministic for a fixed index revision, whatever order the sources used", () => {
    const candidates = [
      connectorTool("jira_search", "search issues"),
      connectorTool("gmail_send_email", "send an email"),
      connectorTool("slack_post_message", "post to a channel"),
      connectorTool("calendar_create_event", "create a calendar event"),
    ];
    const index = catalog(toolNames(candidates));
    const once = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "send an email about the incident",
      index,
    });
    const twice = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "send an email about the incident",
      index,
    });
    expect(toolNames(once.tools)).toEqual(toolNames(twice.tools));
    expect(toolNames(once.tools)[1]).toBe("gmail_send_email");
    // Ties break on the offered name, not on iteration order.
    const reversed = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: [...candidates].reverse(),
      trigger: "routine",
      request: "send an email about the incident",
      index,
    });
    expect(toolNames(reversed.tools)).toEqual(toolNames(once.tools));
  });

  it("falls back to exactly today\u0027s list when the index cannot be read", () => {
    const candidates = [connectorTool("gmail_send_email"), connectorTool("jira_search")];
    const expected = [shell, readFile, ...candidates];
    for (const index of [null, undefined, catalog([])]) {
      const result = selectToolsForRun({
        builtins: [shell, readFile],
        connectorCandidates: candidates,
        trigger: "routine",
        request: "send an email",
        index,
      });
      expect(result.record.mode).toBe("fallback");
      expect(result.record.fallbackCause).toBe("index-unavailable");
      // Same order, same tool objects: the fallback is the pre-change assembly.
      expect(result.tools).toHaveLength(expected.length);
      expected.forEach((tool, position) => {
        expect(result.tools[position]).toBe(tool);
      });
    }
    expect(toolSelectionMetrics().fallbacks).toBe(3);
    expect(toolSelectionMetrics().fallbacksByCause["index-unavailable"]).toBe(3);
  });

  it("falls back when the catalog knows none of the offered tools", () => {
    const candidates = [connectorTool("gmail_send_email"), connectorTool("jira_search")];
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "send an email",
      index: catalog(["nothing_we_offer"]),
    });
    expect(result.record.mode).toBe("fallback");
    expect(result.record.fallbackCause).toBe("empty-result");
    expect(toolNames(result.tools)).toEqual(["shell", "gmail_send_email", "jira_search"]);
    expect(result.record.withheld.notInCatalog).toEqual(["gmail_send_email", "jira_search"]);
    expect(toolSelectionMetrics().fallbacksByCause["empty-result"]).toBe(1);
    // One reason per candidate, even though ranking had already started.
    expect(result.record.entries.filter((entry) => entry.name === "gmail_send_email")).toHaveLength(
      1,
    );
    expect(result.record.entries).toHaveLength(3);
  });

  it("drops a tool the catalog does not hold while keeping the rest", () => {
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: [connectorTool("gmail_send_email"), connectorTool("orphan_tool")],
      trigger: "routine",
      request: "send an email",
      index: catalog(["gmail_send_email"]),
    });
    expect(result.record.mode).toBe("selected");
    expect(toolNames(result.tools)).toEqual(["shell", "gmail_send_email"]);
    expect(result.record.withheld.notInCatalog).toEqual(["orphan_tool"]);
  });

  it("bounds the number of connector tools and explains every candidate", () => {
    const candidates = Array.from({ length: 40 }, (_, position) =>
      connectorTool(`tool_${String(position).padStart(2, "0")}`, "a connector tool"),
    );
    const result = selectToolsForRun({
      builtins: [shell, readFile],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "do the thing",
      budget: { maxTools: 5 },
      index: catalog(toolNames(candidates)),
    });
    expect(result.record.selected).toBe(5);
    expect(toolNames(result.tools)).toHaveLength(7);
    const kept = result.record.entries.filter((entry) => entry.kept);
    const dropped = result.record.entries.filter((entry) => !entry.kept);
    expect(kept).toHaveLength(7);
    expect(dropped).toHaveLength(35);
    // A per-entry reason, never a bare truncation.
    for (const entry of dropped) expect(entry.detail).toContain("over-budget:count");
    for (const entry of kept) expect(typeof entry.detail).toBe("string");
  });

  it("bounds the serialized size and falls back when nothing fits", () => {
    const candidates = [connectorTool("gmail_send_email", "send an email with a long description")];
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "send an email",
      budget: { maxTools: 10, maxDescriptionChars: 4 },
      index: catalog(["gmail_send_email"]),
    });
    expect(result.record.mode).toBe("fallback");
    expect(result.record.fallbackCause).toBe("empty-result");
    expect(toolNames(result.tools)).toEqual(["shell", "gmail_send_email"]);
  });

  it("has nothing to select when the trigger offered no connector tools", () => {
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: [],
      trigger: "created",
      index: catalog(["gmail_send_email"]),
    });
    expect(result.record.mode).toBe("nothing-to-select");
    expect(toolNames(result.tools)).toEqual(["shell"]);
    expect(toolSelectionMetrics().fallbacks).toBe(0);
  });

  it("ranks a tool the bot has used successfully above an equally matching one", () => {
    const candidates = [connectorTool("alpha_x"), connectorTool("alpha_y")];
    const shared = {
      builtins: [shell],
      connectorCandidates: candidates,
      trigger: "routine",
      request: "alpha",
      index: catalog(["alpha_x", "alpha_y"]),
    };
    // No history at all: the tie breaks on the name.
    expect(toolNames(selectToolsForRun(shared).tools)).toEqual(["shell", "alpha_x", "alpha_y"]);
    expect(toolNames(selectToolsForRun({ ...shared, usage: new Map() }).tools)).toEqual([
      "shell",
      "alpha_x",
      "alpha_y",
    ]);
    const used = new Map([["alpha_y", { successes: 3, failures: 0 }]]);
    expect(toolNames(selectToolsForRun({ ...shared, usage: used }).tools)).toEqual([
      "shell",
      "alpha_y",
      "alpha_x",
    ]);
    // A tool with a worse record than another one ranks below it.
    const mixed = new Map([
      ["alpha_x", { successes: 1, failures: 9 }],
      ["alpha_y", { successes: 4, failures: 0 }],
    ]);
    expect(toolNames(selectToolsForRun({ ...shared, usage: mixed }).tools)).toEqual([
      "shell",
      "alpha_y",
      "alpha_x",
    ]);
    // A record for a tool that is not a candidate changes nothing.
    const unrelated = new Map([["beta_z", { successes: 9, failures: 0 }]]);
    expect(toolNames(selectToolsForRun({ ...shared, usage: unrelated }).tools)).toEqual([
      "shell",
      "alpha_x",
      "alpha_y",
    ]);
  });

  it("keeps find_tool and use_tool reachable inside the selected set", () => {
    const builtins = selectBuiltinToolsForRun({
      graphicalToolsAllowed: false,
      groupId: null,
      trigger: "routine",
      semanticMemoryEnabled: false,
      historyRetrievalEnabled: true,
      messagingChannelRun: false,
      fleetManagement: true,
      followUpFromUser: false,
    });
    const candidates = [connectorTool("gmail_send_email")];
    const result = selectToolsForRun({
      builtins,
      connectorCandidates: candidates,
      trigger: "routine",
      request: "triage the board",
      index: catalog(["gmail_send_email"]),
    });
    expect(result.record.mode).toBe("selected");
    const partitioned = partitionTools(result.tools);
    const listed = toolNames(partitioned.listed);
    expect(listed).toContain(FIND_TOOL);
    expect(listed).toContain(USE_TOOL);
    // The bridge only exists because the deferred built-ins survived selection.
    expect(partitioned.deferred.length).toBeGreaterThan(0);
  });

  it("keeps the routed provenance of every tool it selects", () => {
    const mcp = connectorTool("mcp__github__create_issue", "opens an issue", "mcp");
    const result = selectToolsForRun({
      builtins: [shell],
      connectorCandidates: [mcp],
      trigger: "routine",
      request: "open an issue",
      index: catalog(["mcp__github__create_issue"]),
    });
    const selected = result.tools.find((tool) => tool.name === "mcp__github__create_issue");
    expect(selected).toBe(mcp);
    expect(selected?.route).toEqual({ connectorId: "mcp", toolName: "mcp__github__create_issue" });
  });

  it("projects a snapshot into a selection index", () => {
    const index = new ToolIndex({
      windows: { graceMs: 1_000, freshnessMs: 10_000 },
    });
    const scope = { spaceId: "space-a", botId: "bot-a" };
    index.observe({
      scope,
      tools: [connectorTool("gmail_send_email"), connectorTool("jira_search")],
      now: 1_000,
    });
    index.observe({
      scope,
      tools: [connectorTool("gmail_send_email")],
      now: 2_000,
    });
    const projected = selectionIndexOf(index.snapshot(scope, 2_000));
    expect(projected.servable).toEqual(["gmail_send_email"]);
    expect(projected.withheld).toEqual([{ name: "jira_search", reason: "dropped" }]);
    expect(projected.revision).toBe(index.snapshot(scope, 2_000).revision);
  });

  it("stays inert until a deployment turns it on", () => {
    // Off means the run receives the list the rules authorized, unchanged.
    expect(toolSelectionEnabled({})).toBe(false);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "" })).toBe(false);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "0" })).toBe(false);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "off" })).toBe(false);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "  yes " })).toBe(true);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "TRUE" })).toBe(true);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "on" })).toBe(true);
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "1" })).toBe(true);
  });
});
