import type { McpOAuthBroker } from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reprobeUnknownMcpServers, startMcpReprobe } from "./mcp-servers.js";

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  secretId: string | null;
  enabled: boolean;
  revision: number;
  createdAt: Date;
  healthStatus: string;
  healthMessage: string | null;
  healthToolCount: number | null;
  healthCheckedAt: Date | null;
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function server(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    spaceId: "space-1",
    userId: "user-1",
    secretId: null,
    enabled: true,
    revision: 1,
    createdAt: new Date(Number(id.replace(/\D/g, "")) * 1000),
    healthStatus: "unknown",
    healthMessage: null,
    healthToolCount: null,
    healthCheckedAt: null,
    ...overrides,
  };
}

/** Evaluates only the `where` shape the sweep sends, so a changed query fails here. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  const { OR, ...rest } = where as { OR?: Array<Record<string, unknown>> };
  const field = (key: string, wanted: unknown) => {
    const value = row[key as keyof Row];
    if (wanted && typeof wanted === "object" && "lt" in wanted) {
      return value instanceof Date && value < (wanted as { lt: Date }).lt;
    }
    return value === wanted;
  };
  return (
    Object.entries(rest).every(([key, wanted]) => field(key, wanted)) &&
    (!OR || OR.some((clause) => matches(row, clause)))
  );
}

function fixture(
  rows: Row[],
  probe: (row: Row) => Promise<void> = async (row) => {
    row.healthStatus = "ok";
    row.healthCheckedAt = new Date();
  },
) {
  const probeCalls: string[] = [];
  const deps = {
    prisma: {
      mcpServer: {
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((row) => matches(row, where)).sort((a, b) => +a.createdAt - +b.createdAt),
        ),
        updateMany: vi.fn(
          async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
            const hit = rows.filter((row) => matches(row, where));
            for (const row of hit) Object.assign(row, data);
            return { count: hit.length };
          },
        ),
      },
      secret: { findFirst: vi.fn(async () => null) },
    },
    secrets: { load: vi.fn() },
    mcp: {
      probe: vi.fn(async (target: Row) => {
        probeCalls.push(target.id);
        await probe(rows.find((row) => row.id === target.id) as Row);
        return { status: "ok" as const };
      }),
    },
  };
  const oauthPending = new Set<string>();
  const mcpOAuth = {
    summaryFor: vi.fn(async (target: Row) => ({
      status: "none" as const,
      clientId: oauthPending.has(target.id) ? "client-1" : null,
    })),
  } as unknown as McpOAuthBroker;
  return { deps: deps as never, rawDeps: deps, mcpOAuth, probeCalls, oauthPending };
}

afterEach(() => vi.useRealTimers());

describe("reprobeUnknownMcpServers", () => {
  it("probes servers left unknown or never checked", async () => {
    const rows = [
      server("s1", { healthCheckedAt: minutesAgo(30) }),
      server("s2", { healthStatus: "ok", healthCheckedAt: null }),
      server("s3", { healthStatus: "ok", healthCheckedAt: minutesAgo(30) }),
      server("s4", { enabled: false }),
    ];
    const { deps, mcpOAuth, probeCalls } = fixture(rows);
    await reprobeUnknownMcpServers(deps, mcpOAuth);
    expect(probeCalls.sort()).toEqual(["s1", "s2"]);
    expect(rows.map((row) => row.healthStatus)).toEqual(["ok", "ok", "ok", "unknown"]);
  });

  it("leaves a server that waits for an OAuth grant unknown", async () => {
    const rows = [server("s1"), server("s2")];
    const { deps, mcpOAuth, probeCalls, oauthPending } = fixture(rows);
    oauthPending.add("s1");
    await reprobeUnknownMcpServers(deps, mcpOAuth);
    expect(probeCalls).toEqual(["s2"]);
    expect(rows[0]?.healthStatus).toBe("unknown");
    expect(rows[0]?.healthCheckedAt).toBeNull();
  });

  it("keeps sweeping when a probe throws", async () => {
    const rows = [server("s1"), server("s2"), server("s3"), server("s4")];
    const { deps, mcpOAuth, probeCalls } = fixture(rows, async (row) => {
      if (row.id === "s1") throw new Error("connector down");
      row.healthStatus = "ok";
    });
    await expect(reprobeUnknownMcpServers(deps, mcpOAuth)).resolves.toBeUndefined();
    expect(probeCalls.sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect(rows.map((row) => row.healthStatus)).toEqual(["error", "ok", "ok", "ok"]);
  });

  it("does not throw when the database fails", async () => {
    const { deps, rawDeps, mcpOAuth } = fixture([]);
    rawDeps.prisma.mcpServer.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(reprobeUnknownMcpServers(deps, mcpOAuth)).resolves.toBeUndefined();
  });

  it("skips a server checked in the last minute", async () => {
    const rows = [server("s1", { healthCheckedAt: new Date(Date.now() - 20_000) })];
    const { deps, mcpOAuth, probeCalls } = fixture(rows);
    await reprobeUnknownMcpServers(deps, mcpOAuth);
    expect(probeCalls).toEqual([]);
  });

  it("probes a server once when two instances sweep together", async () => {
    const rows = [server("s1"), server("s2", { healthCheckedAt: minutesAgo(5) })];
    const { deps, mcpOAuth, probeCalls } = fixture(rows);
    await Promise.all([
      reprobeUnknownMcpServers(deps, mcpOAuth),
      reprobeUnknownMcpServers(deps, mcpOAuth),
    ]);
    expect(probeCalls.sort()).toEqual(["s1", "s2"]);
  });

  it("probes at most three servers at once", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => server(`s${index + 1}`));
    let active = 0;
    let peak = 0;
    const { deps, mcpOAuth, probeCalls } = fixture(rows, async (row) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      row.healthStatus = "ok";
    });
    await reprobeUnknownMcpServers(deps, mcpOAuth);
    expect(probeCalls).toHaveLength(8);
    expect(peak).toBe(3);
  });
});

describe("startMcpReprobe", () => {
  it("sweeps at start and every ten minutes until stopped", async () => {
    vi.useFakeTimers();
    const rows = [server("s1")];
    const { deps, mcpOAuth, probeCalls } = fixture(rows, async (row) => {
      row.healthStatus = "unknown";
    });
    const stop = startMcpReprobe(deps, mcpOAuth);
    await vi.advanceTimersByTimeAsync(0);
    expect(probeCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probeCalls).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(probeCalls).toHaveLength(2);
  });
});
