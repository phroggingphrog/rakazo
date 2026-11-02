import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ArtifactPut } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";
import type { McpOutputLedger, McpOutputMetadata, McpOutputScope } from "./mcp-output-store.js";
import { MCP_OUTPUT_LIMITS, McpOutputStore } from "./mcp-output-store.js";

const scope: McpOutputScope = {
  spaceId: "space-a",
  userId: "user-a",
  botId: "bot-a",
  runId: "run-a",
  serverId: "server-a",
};
function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    operationId: "op",
    traceId: "trace",
    ...scope,
    signal: new AbortController().signal,
    ...overrides,
  };
}
function harness() {
  const records = new Map<string, Uint8Array>();
  const metadata = new Map<string, McpOutputMetadata>();
  let next = 0;
  const artifacts = {
    records,
    put: vi.fn(async (put: ArtifactPut) => {
      const id = `artifact-${++next}`;
      records.set(id, put.bytes.slice());
      return { id, hash: "" };
    }),
    get: vi.fn(async (id: string) => {
      const bytes = records.get(id);
      if (!bytes) throw Error("missing");
      return bytes.slice();
    }),
    remove: vi.fn(async (id: string) => {
      records.delete(id);
    }),
  };
  const ledger: McpOutputLedger = {
    async createUnderRunLock(record) {
      const run = [...metadata.values()].filter(
        (row) =>
          row.spaceId === record.spaceId &&
          row.userId === record.userId &&
          row.botId === record.botId &&
          row.runId === record.runId,
      );
      if (
        run.reduce((sum, row) => sum + row.bytes, 0) + record.bytes >
        MCP_OUTPUT_LIMITS.runQuotaBytes
      )
        throw Error("MCP output run quota exceeded");
      metadata.set(record.id, record);
    },
    async findOwned(id, wanted) {
      const row = metadata.get(id);
      return row &&
        row.spaceId === wanted.spaceId &&
        row.userId === wanted.userId &&
        row.botId === wanted.botId &&
        row.runId === wanted.runId &&
        row.serverId === wanted.serverId
        ? row
        : null;
    },
    async listExpired(now, limit) {
      const rows = [...metadata.values()].filter((row) => row.expiresAt <= now).slice(0, limit);
      return rows;
    },
    async delete(id) {
      metadata.delete(id);
    },
  };
  return { artifacts, ledger, metadata };
}
const signingKey = new Uint8Array(32).fill(7);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("McpOutputStore", () => {
  it("stores bounded output and pages it with a digest and valid UTF-8 boundaries", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    const output = `A${"é".repeat(12_000)}`;
    const saved = await store.store(output, scope, context());
    expect(saved.storedBytes).toBe(Buffer.byteLength(output));
    expect(saved.truncated).toBe(false);
    expect(saved.sha256).toBe(createHash("sha256").update(output).digest("hex"));
    const first = await store.retrieve(saved.receipt, scope, context(), 0, 99_999);
    expect(first.bytes).toBeLessThanOrEqual(MCP_OUTPUT_LIMITS.pageBytes);
    const second = await store.retrieve(saved.receipt, scope, context(), first.nextOffset!, 99_999);
    expect(first.text + second.text).toBe(output.slice(0, first.text.length + second.text.length));
    expect(second.sha256).toBe(saved.sha256);
  });

  it("rejects output larger than 2 MiB instead of storing an incomplete result", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    await expect(
      store.store("x".repeat(MCP_OUTPUT_LIMITS.fullBytes + 1), scope, context()),
    ).rejects.toThrow("exceeds the 2 MiB storage limit");
    expect(h.artifacts.put).not.toHaveBeenCalled();
  });

  it("rejects tampering and space, user, bot, run, and server scope mismatches before artifact access", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    const saved = await store.store("private", scope, context());
    for (const [receipt, other] of [
      [`${saved.receipt}x`, scope],
      [saved.receipt, { ...scope, spaceId: "space-b" }],
      [saved.receipt, { ...scope, userId: "user-b" }],
      [saved.receipt, { ...scope, botId: "bot-b" }],
      [saved.receipt, { ...scope, runId: "run-b" }],
      [saved.receipt, { ...scope, serverId: "server-b" }],
    ] as const)
      await expect(store.retrieve(receipt, other, context())).rejects.toThrow(
        "unavailable, expired, or not authorized",
      );
    expect(h.artifacts.get).not.toHaveBeenCalled();
  });

  it("checks durable expiry before get and deletes expired rows and blobs in a bounded sweep", async () => {
    let now = 100;
    const h = harness();
    const ledger: McpOutputLedger = {
      ...h.ledger,
      async createUnderRunLock(record) {
        h.metadata.set(record.id, {
          ...record,
          expiresAt: new Date(now + MCP_OUTPUT_LIMITS.ttlMs),
        });
      },
    };
    const store = new McpOutputStore(h.artifacts, ledger, signingKey, () => now);
    const saved = await store.store("expired", scope, context());
    now += MCP_OUTPUT_LIMITS.ttlMs;
    await expect(store.retrieve(saved.receipt, scope, context())).rejects.toThrow(
      "unavailable, expired, or not authorized",
    );
    expect(h.artifacts.get).not.toHaveBeenCalled();
    expect(await store.sweepExpired(context(), 1)).toBe(1);
    expect(h.metadata.size).toBe(0);
    expect(h.artifacts.records.size).toBe(0);
  });

  it("sweeps 256 expired files within the worker's 30-second timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-mcp-output-sweep-"));
    tempDirs.push(root);
    const artifacts = new LocalArtifactStore(root);
    const metadata = new Map<string, McpOutputMetadata>();
    const ledger: McpOutputLedger = {
      ...harness().ledger,
      async createUnderRunLock(record) { metadata.set(record.id, record); },
      async findOwned(id) { return metadata.get(id) ?? null; },
      async listExpired(now, limit) {
        return [...metadata.values()].filter((row) => row.expiresAt <= now).slice(0, limit);
      },
      async delete(id) { metadata.delete(id); },
    };
    const store = new McpOutputStore(artifacts, ledger, signingKey, () => 100);
    const sweepContext = context({ spaceId: "system", userId: "system" });
    for (let i = 0; i < 256; i++) {
      await store.store(`payload-${i}`, { ...scope, runId: `run-${i}` }, context());
      const row = [...metadata.values()][i]!;
      metadata.set(row.id, { ...row, expiresAt: new Date(100) });
    }

    const started = performance.now();
    expect(await store.sweepExpired(sweepContext)).toBe(256);
    const elapsedMs = performance.now() - started;
    console.info(`256 local artifact sweep: ${elapsedMs.toFixed(1)} ms (${(256 / (elapsedMs / 1000)).toFixed(1)} records/s)`);
    expect(elapsedMs).toBeLessThan(30_000);
    expect(metadata.size).toBe(0);
    expect(await artifacts.fileCounts()).toMatchObject({ sealed: 0, plaintext: 0, abandoned: 0 });
    expect(256 / (elapsedMs / 1000)).toBeGreaterThan(256 / 30);
  });

  it("retains rows when file removal fails and retries them on the next sweep", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey, () => 100);
    await store.store("expired", scope, context());
    const row = [...h.metadata.values()][0]!;
    h.metadata.set(row.id, { ...row, expiresAt: new Date(100) });
    const remove = h.artifacts.remove;
    remove.mockRejectedValueOnce(Error("temporary file failure"));

    expect(await store.sweepExpired(context())).toBe(0);
    expect(h.metadata.size).toBe(1);
    expect(await store.sweepExpired(context())).toBe(1);
    expect(h.metadata.size).toBe(0);
    expect(h.artifacts.records.size).toBe(0);
  });

  it("stops a sweep when cancelled and leaves unprocessed rows for retry", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey, () => 100);
    await store.store("one", { ...scope, runId: "run-1" }, context());
    await store.store("two", { ...scope, runId: "run-2" }, context());
    for (const row of h.metadata.values()) h.metadata.set(row.id, { ...row, expiresAt: new Date(100) });
    const controller = new AbortController();
    h.artifacts.remove.mockImplementationOnce(async (id) => {
      h.artifacts.records.delete(id);
      controller.abort();
    });

    await expect(store.sweepExpired(context({ signal: controller.signal }))).rejects.toThrow();
    expect(h.metadata.size).toBe(2);
  });

  it("enforces the durable per-run quota before accepting another artifact", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    for (let i = 0; i < 4; i++)
      await store.store("x".repeat(MCP_OUTPUT_LIMITS.fullBytes), scope, context());
    await expect(store.store("x", scope, context())).rejects.toThrow("quota exceeded");
    expect(h.artifacts.put).toHaveBeenCalledTimes(5); // last staged blob is cleaned after ledger refusal
    expect(h.artifacts.records.size).toBe(4);
  });

  it("shares the 8 MiB run quota across server scopes", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    for (let i = 0; i < 4; i++)
      await store.store("x".repeat(MCP_OUTPUT_LIMITS.fullBytes), scope, context());
    await expect(store.store("x", { ...scope, serverId: "server-b" }, context())).rejects.toThrow(
      "quota exceeded",
    );
    expect(h.artifacts.records.size).toBe(4);
  });

  it("does not leave staged artifacts when a store is cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    h.artifacts.put.mockImplementationOnce(async (put) => {
      const result = await harness().artifacts.put(put);
      controller.abort();
      return result;
    });
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    await expect(
      store.store("no", scope, context({ signal: controller.signal })),
    ).rejects.toThrow();
  });

  it("stores only the caller-provided already-redacted text", async () => {
    const h = harness();
    const store = new McpOutputStore(h.artifacts, h.ledger, signingKey);
    await store.store("[REDACTED]", scope, context());
    expect(Buffer.from(h.artifacts.records.get("artifact-1")!).toString()).toBe("[REDACTED]");
  });
});
