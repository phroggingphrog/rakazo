import { describe, expect, it, vi } from "vitest";
import { DEPENDENCY_RETRY_BUDGET, DependencyRetry, dependencyDelay } from "./dependency-retry.js";

const identity = { serverId: "s", spaceId: "w", userId: "u", revision: 1 };

describe("dependency retry SQL contract", () => {
  it("bounds exponential jitter and caps long outages", () => {
    expect(dependencyDelay(1, () => 0)).toBe(24000);
    expect(dependencyDelay(1, () => 1)).toBe(30000);
    expect(dependencyDelay(2, () => 1)).toBe(60000);
    expect(dependencyDelay(100, () => 1)).toBe(300000);
    expect(dependencyDelay(100, () => 0)).toBe(240000);
    expect(DEPENDENCY_RETRY_BUDGET).toBe(5);
  });
  it("claims conditionally with identity, revision and expiry, denying a lost claim", async () => {
    const query = vi
      .fn((_sql: TemplateStringsArray, ..._values: unknown[]) =>
        Promise.resolve([] as Array<{ claimToken: string }>),
      )
      .mockResolvedValueOnce([{ claimToken: "ignored" }])
      .mockResolvedValueOnce([]);
    const retry = new DependencyRetry({ $queryRaw: query } as never, () => new Date(1000));
    const first = await retry.claim(identity);
    expect(first).toHaveProperty("claim.token");
    expect(await retry.claim(identity)).toHaveProperty("reason");
    const [sql, ...values] = query.mock.calls[0]!;
    expect(sql.join("?")).toContain(
      'ON CONFLICT ("kind", "dependencyId", "spaceId", "userId", "revision")',
    );
    expect(sql.join("?")).toContain('"claimExpiresAt" <=');
    expect(sql.join("?")).toContain('NOT "dependency_retries"."exhausted"');
    expect(values.slice(0, 4)).toEqual(["s", "w", "u", 1]);
    expect(values).toContainEqual(new Date(61000));
  });
  it("fences all completions and excludes cancellation/auth/install from the budget", async () => {
    const execute = vi.fn((_sql: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(0),
    );
    const retry = new DependencyRetry(
      { $executeRaw: execute } as never,
      () => new Date(1000),
      () => 0,
    );
    const claim = { ...identity, token: "old-token" };
    for (const outcome of ["transient", "success", "excluded"] as const)
      await retry.complete(claim, outcome);
    for (const [sql, ...values] of execute.mock.calls) {
      expect(sql.join("?")).toContain('"claimToken" = ? AND "claimExpiresAt" > ?');
      expect(values).toContain("old-token");
      expect(values).toContain(1);
    }
    expect(execute.mock.calls[0]![0].join("?")).toContain('"failureCount" + 1 >=');
    expect(execute.mock.calls[2]![0].join("?")).not.toContain('"failureCount" + 1');
  });
  it("fails closed when persistence is unavailable", async () => {
    const retry = new DependencyRetry({
      $queryRaw: vi.fn().mockRejectedValue(new Error("db down")),
    } as never);
    await expect(retry.claim(identity)).rejects.toThrow("db down");
  });
  it("manual recovery is restricted to matching launch identity and revision", async () => {
    const execute = vi.fn((_sql: TemplateStringsArray, ..._values: unknown[]) =>
      Promise.resolve(1),
    );
    const observedAt = new Date();
    await new DependencyRetry({ $executeRaw: execute } as never).recover(identity, observedAt);
    expect(execute.mock.calls[0]!.slice(-5)).toEqual(["s", "w", "u", 1, observedAt]);
    expect(execute.mock.calls[0]![0].join("?")).toContain(
      '"updatedAt" < ? AND "claimToken" IS NULL',
    );
    expect(execute.mock.calls[0]![0].join("?")).toContain('"claimToken" = NULL');
  });
});
