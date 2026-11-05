import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { claimProtectedSetupV2, protectedSetupV2JobKey } from "./protected-setup-v2-claim.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("./protected-setup-validation.js", () => ({ inspectPreparedSetupInTransaction: inspect }));
const owner = { spaceId: "space", userId: "owner" };
function fixture(enabled: boolean) {
  let claimed = false;
  const query = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = parts.join("?");
    if (sql.includes("FROM protected_setup_v2_gate")) return [{ enabled }];
    if (sql.includes("FROM setup_test_attempts")) return [{ id: "attempt" }];
    if (sql.includes("FROM protected_setup_v2_claims"))
      return claimed ? [{ attemptId: "attempt" }] : [];
    if (sql.includes("INSERT INTO protected_setup_v2_claims")) {
      if (claimed) return [];
      claimed = true;
      return [{ attemptId: "attempt" }];
    }
    throw new Error("unexpected query");
  });
  const tx = { $queryRaw: query };
  const prisma = {
    $contentEncryption: () => ({ ring: { encryptWrites: true } }),
    $transaction: async (fn: (arg: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  const claim = () => runAsTenant(owner, () => claimProtectedSetupV2(prisma, owner, "attempt"));
  return { claim, prisma, query };
}

describe("protected setup v2 claim foundation", () => {
  it("uses a distinct job namespace and rejects invalid IDs", () => {
    expect(protectedSetupV2JobKey("attempt")).toBe("protected-setup-v2:attempt");
    expect(() => protectedSetupV2JobKey("run:other")).toThrow();
  });
  it("does not inspect or claim with the gate off", async () => {
    const f = fixture(false);
    inspect.mockClear();
    expect(await f.claim()).toBe("disabled");
    expect(inspect).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("revalidates inside the claim and refuses to replay an uncertain claim", async () => {
    const f = fixture(true);
    inspect.mockResolvedValue({ configuration: "stale_or_unavailable", assignment: "not_checked" });
    expect(await f.claim()).toBe("stale");
    inspect.mockResolvedValue({ configuration: "consistent", assignment: "blocked" });
    expect(await f.claim()).toBe("stale");
    inspect.mockResolvedValue({ configuration: "consistent", assignment: "allowed" });
    expect(await f.claim()).toBe("claimed_uncertain");
    expect(await f.claim()).toBe("already_uncertain");
    expect(inspect).toHaveBeenCalledTimes(3);
  });
  it("rejects a mismatched owner before accessing the database", async () => {
    const f = fixture(true);
    await expect(
      runAsTenant({ ...owner, userId: "other" }, () =>
        claimProtectedSetupV2(f.prisma, owner, "attempt"),
      ),
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
});
