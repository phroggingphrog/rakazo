import { afterEach, describe, expect, it, vi } from "vitest";
import { durableDiscoveryRetryFromEnv, McpConnector } from "./mcp-connector.js";

const TEST_NETWORK = {
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};
const SERVER = {
  id: "server-1",
  slug: "demo",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/mcp",
  secretId: null,
  args: [],
  revision: 1,
};
const ASSIGNMENT = {
  botId: "bot-1",
  serverId: "server-1",
  spaceId: "w1",
  userId: "u1",
  allowAllTools: true,
  allowedTools: [],
  server: SERVER,
};
const context = () =>
  ({
    spaceId: "w1",
    userId: "u1",
    botId: "bot-1",
    runId: "run-1",
    signal: new AbortController().signal,
  }) as never;

function fakePrisma(queryRaw: ReturnType<typeof vi.fn>) {
  return {
    mcpServer: { findMany: async () => [], findFirst: async () => null, updateMany: vi.fn() },
    botMcpServer: { findMany: vi.fn().mockResolvedValue([ASSIGNMENT]) },
    run: { findUnique: vi.fn().mockResolvedValue({ threadId: "thread-1" }) },
    $queryRaw: queryRaw,
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("McpConnector durable discovery retry (TASK-484)", () => {
  it("reads the flag only when set to 1", () => {
    expect(durableDiscoveryRetryFromEnv({})).toBe(false);
    expect(durableDiscoveryRetryFromEnv({ RAKAZO_DURABLE_DISCOVERY_RETRY: "1" })).toBe(true);
    expect(durableDiscoveryRetryFromEnv({ RAKAZO_DURABLE_DISCOVERY_RETRY: "true" })).toBe(false);
  });

  it("never touches the ledger when the flag is off", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetch);
    const prisma = fakePrisma(vi.fn());
    const connector = new McpConnector(prisma as never, {} as never, { network: TEST_NETWORK });
    await connector.discoverTools(context());
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    await connector.close();
  });

  it("skips the server without contacting it when the ledger denies the claim", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("must not be called"));
    vi.stubGlobal("fetch", fetch);
    const prisma = fakePrisma(vi.fn().mockResolvedValue([]));
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      durableDiscoveryRetry: true,
    });
    const tools = await connector.discoverTools(context());
    expect(tools.map((tool) => tool.name)).toContain("mcp__demo__unavailable");
    expect(fetch).not.toHaveBeenCalled();
    await connector.close();
  });

  it("records a transient failure against the claim", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const prisma = fakePrisma(vi.fn().mockResolvedValue([{ claimToken: "t" }]));
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      durableDiscoveryRetry: true,
    });
    await connector.discoverTools(context());
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    await connector.close();
  });

  it("falls back to discovery when the ledger itself fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetch);
    const prisma = fakePrisma(vi.fn().mockRejectedValue(new Error("relation missing")));
    const connector = new McpConnector(prisma as never, {} as never, {
      network: TEST_NETWORK,
      durableDiscoveryRetry: true,
    });
    await connector.discoverTools(context());
    expect(fetch).toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    await connector.close();
  });
});
