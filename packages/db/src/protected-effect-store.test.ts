import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { ensureProtectedEffectScope, stageProtectedEffect } from "./protected-effect-store.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const owner = { spaceId: "space-1", userId: "owner-1" };
const lease = { runId: "run-1", workerId: "worker-1", fence: 1 };

describe("protected effect storage admission", () => {
  it("requires the matching tenant before any database or key access", async () => {
    const query = vi.fn();
    const prisma = { $queryRaw: query } as unknown as PrismaClient;
    await expect(ensureProtectedEffectScope(prisma, owner, lease)).rejects.toThrow();
    await expect(
      runAsTenant({ ...owner, userId: "other" }, () =>
        ensureProtectedEffectScope(prisma, owner, lease),
      ),
    ).rejects.toThrow();
    await expect(
      runAsSystem("test", () => ensureProtectedEffectScope(prisma, owner, lease)),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects invalid leases before checking storage", async () => {
    const query = vi.fn();
    const prisma = { $queryRaw: query } as unknown as PrismaClient;
    for (const invalid of [
      { ...lease, fence: 0 },
      { ...lease, workerId: "" },
      { ...lease, runId: "" },
    ])
      await expect(
        runAsTenant(owner, () => ensureProtectedEffectScope(prisma, owner, invalid)),
      ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not initialize keys or write when the protected gate or lease is unavailable", async () => {
    const content = vi.fn();
    const transaction = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $contentEncryption: content,
      $transaction: transaction,
    } as unknown as PrismaClient;
    await expect(
      runAsTenant(owner, () => ensureProtectedEffectScope(prisma, owner, lease)),
    ).rejects.toThrow("unavailable");
    await expect(
      runAsTenant(owner, () =>
        stageProtectedEffect(prisma, owner, lease, {
          scopeId: "scope-1",
          route: {},
          args: {},
          occurrence: 0,
        }),
      ),
    ).rejects.toThrow("unavailable");
    expect(content).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not write when encryption is disabled", async () => {
    const transaction = vi.fn();
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ scopeId: null, keyCiphertext: null }]),
      $contentEncryption: () => ({ ring: { encryptWrites: false } }),
      $transaction: transaction,
    } as unknown as PrismaClient;
    await expect(
      runAsTenant(owner, () => ensureProtectedEffectScope(prisma, owner, lease)),
    ).rejects.toThrow("encryption");
    expect(transaction).not.toHaveBeenCalled();
  });
});
