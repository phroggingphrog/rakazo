import { WorkspaceMonitorSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { SubscriptionDeadline } from "./workspace-monitoring.js";
import {
  calendarConflicts,
  upcomingSubscriptionDeadlines,
  workspaceMonitorPrompt,
  workspaceMonitorToolDecision,
} from "./workspace-monitoring.js";

const record = (
  id: string,
  date: string | null,
  confidence: SubscriptionDeadline["confidence"],
): SubscriptionDeadline => ({
  id,
  date,
  confidence,
  sourceId: "source-1",
  observedAt: "2026-11-04T00:00:00Z",
});

describe("monitor capability policy", () => {
  it("denies source reads for an unbound monitor while permitting catalog metadata", () => {
    const monitor = { kind: "email" };
    const tool = {
      name: "mail_read",
      connector: true,
      readOnly: true,
      route: {
        connectorId: "mcp",
        resourceId: "mail-server",
        resourceRevision: 1,
        toolName: "read_mail",
      },
    };
    expect(workspaceMonitorToolDecision(monitor, tool)).toBe("deny");
    expect(workspaceMonitorToolDecision(monitor, { ...tool, route: undefined })).toBe("deny");
    for (const toolName of ["__catalog_search", "__catalog_load"]) {
      expect(
        workspaceMonitorToolDecision(monitor, {
          ...tool,
          route: { connectorId: "mcp", toolName },
        }),
      ).toBe("allow");
      expect(
        workspaceMonitorToolDecision(monitor, {
          ...tool,
          readOnly: undefined,
          route: { connectorId: "mcp", toolName },
        }),
      ).toBe("deny");
      expect(
        workspaceMonitorToolDecision(monitor, {
          ...tool,
          batch: true,
          route: { connectorId: "mcp", toolName },
        }),
      ).toBe("deny");
      expect(
        workspaceMonitorToolDecision(monitor, {
          ...tool,
          route: { connectorId: "mcp", resourceId: "other-server", toolName },
        }),
      ).toBe("deny");
    }
    expect(
      workspaceMonitorToolDecision(monitor, {
        ...tool,
        route: { connectorId: "mcp", toolName: "__catalog_execute" },
      }),
    ).toBe("deny");
  });
  it("defaults to report-only and rejects unknown configuration", () => {
    expect(WorkspaceMonitorSchema.parse({ kind: "email" }).mode).toBe("report_only");
    expect(WorkspaceMonitorSchema.safeParse({ kind: "email", bypass: true }).success).toBe(false);
    expect(
      workspaceMonitorToolDecision({}, { name: "read", connector: true, readOnly: true }),
    ).toBe("deny");
  });
  it("allows only declared complete connector reads", () => {
    const route = {
      connectorId: "mcp",
      resourceId: "calendar-server",
      resourceRevision: 1,
      toolName: "read",
    };
    const monitor = { kind: "calendar", source: route };
    expect(
      workspaceMonitorToolDecision(monitor, {
        name: "read",
        connector: true,
        readOnly: true,
        route,
      }),
    ).toBe("allow");
    for (const readOnly of [false, undefined])
      expect(
        workspaceMonitorToolDecision(monitor, {
          name: "action",
          connector: true,
          readOnly,
        }),
      ).toBe("deny");
    expect(
      workspaceMonitorToolDecision(monitor, {
        name: "batch",
        connector: true,
        readOnly: true,
        batchComplete: false,
      }),
    ).toBe("deny");
  });
  it("limits a configured source to the reviewed MCP operation", () => {
    const source = {
      connectorId: "mcp",
      resourceId: "mail-server",
      resourceRevision: 3,
      toolName: "read_mail",
    };
    const monitor = { kind: "email", source };
    const tool = { name: "mail", connector: true, readOnly: true, route: source };
    expect(workspaceMonitorToolDecision(monitor, tool)).toBe("allow");
    for (const route of [
      { ...source, resourceId: "other-server" },
      { ...source, resourceRevision: 4 },
      { ...source, resourceRevision: undefined },
      { ...source, toolName: "read_other" },
      { ...source, connectorId: "other" },
    ])
      expect(workspaceMonitorToolDecision(monitor, { ...tool, route })).toBe("deny");
    expect(workspaceMonitorToolDecision(monitor, { ...tool, route: undefined })).toBe("deny");
    expect(workspaceMonitorToolDecision(monitor, { ...tool, batch: true })).toBe("deny");
    for (const toolName of ["__catalog_search", "__catalog_load"]) {
      expect(
        workspaceMonitorToolDecision(monitor, {
          ...tool,
          route: { connectorId: "mcp", toolName },
        }),
      ).toBe("allow");
      expect(
        workspaceMonitorToolDecision(monitor, {
          ...tool,
          route: { connectorId: "mcp", resourceId: "other-server", toolName },
        }),
      ).toBe("deny");
    }
    expect(
      workspaceMonitorToolDecision(monitor, {
        ...tool,
        route: { connectorId: "mcp", toolName: "__catalog_execute" },
      }),
    ).toBe("deny");
    expect(
      workspaceMonitorToolDecision(monitor, {
        ...tool,
        route: { ...source, toolName: "__rakazo_read_output" },
      }),
    ).toBe("deny");
    const receiptSource = { ...source, toolName: "__rakazo_read_output" };
    expect(
      workspaceMonitorToolDecision(
        { kind: "email", source: receiptSource },
        { ...tool, route: receiptSource },
      ),
    ).toBe("deny");
  });
  it("denies unsupported mutations even in approval-required mode", () => {
    for (const kind of ["calendar", "subscriptions"]) {
      for (const readOnly of [false, undefined])
        expect(
          workspaceMonitorToolDecision(
            { kind, mode: "approval_required" },
            { name: "action", connector: true, readOnly },
          ),
        ).toBe("deny");
    }
    expect(
      workspaceMonitorToolDecision(
        { kind: "email", mode: "approval_required" },
        { name: "action", connector: true, readOnly: false },
      ),
    ).toBe("deny");
  });
  it("blocks bypass capabilities even with approval enabled", () => {
    for (const name of ["shell", "web_fetch", "browser", "delegate", "schedule_create"])
      expect(
        workspaceMonitorToolDecision(
          { kind: "calendar", mode: "approval_required" },
          { name, connector: false, readOnly: true },
        ),
      ).toBe("deny");
  });
});

describe("calendar interval evidence", () => {
  it("compares absolute instants and excludes touching boundaries", () => {
    expect(
      calendarConflicts([
        {
          id: "a",
          start: "2026-11-04T10:00:00+11:00",
          end: "2026-11-04T11:00:00+11:00",
          revision: "1",
        },
        {
          id: "b",
          start: "2026-11-03T23:30:00Z",
          end: "2026-11-04T00:30:00Z",
          revision: "1",
        },
        {
          id: "c",
          start: "2026-11-04T00:30:00Z",
          end: "2026-11-04T01:00:00Z",
          revision: "1",
        },
      ]),
    ).toEqual([["a", "b"]]);
  });
  it("refuses timezone guesses", () => {
    expect(() =>
      calendarConflicts([
        {
          id: "a",
          start: "2026-11-04T10:00:00",
          end: "2026-11-04T11:00:00",
          revision: "1",
        },
      ]),
    ).toThrow("Event timezone required");
  });
});

describe("subscription evidence deadlines", () => {
  it("preserves estimates as estimates, excludes unknown and past dates, sorts upcoming dates", () => {
    const estimate = record("estimate", "2026-11-06", "estimate");
    const verified = record("verified", "2026-11-04", "verified");
    expect(
      upcomingSubscriptionDeadlines(
        [
          estimate,
          record("unknown", null, "unknown"),
          record("past", "2026-11-03", "verified"),
          verified,
        ],
        "2026-11-04",
        2,
      ),
    ).toEqual([verified, estimate]);
  });
  it("rejects impossible dates rather than silently rolling them forward", () => {
    expect(() =>
      upcomingSubscriptionDeadlines([record("bad", "2026-02-30", "verified")], "2026-02-01", 30),
    ).toThrow("Invalid calendar date");
    expect(() => upcomingSubscriptionDeadlines([], "2026-11-04", -1)).toThrow(
      "Invalid deadline horizon",
    );
  });
});

describe("conservative routine templates", () => {
  it.each(["email", "calendar", "subscriptions"] as const)(
    "requires evidence and intervention for %s",
    (kind) => {
      const prompt = workspaceMonitorPrompt(kind);
      expect(prompt).toContain("read-back evidence");
      expect(prompt).toContain("required user intervention");
      expect(prompt).toContain("Never permanently delete messages");
    },
  );
});
