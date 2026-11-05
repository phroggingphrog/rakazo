import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";

export type DependencyIdentity = {
  serverId: string;
  spaceId: string;
  userId: string;
  revision: number;
};
export const DEPENDENCY_RETRY_BUDGET = 5;
export const DEPENDENCY_CLAIM_MS = 60_000;
export function dependencyDelay(failures: number, random = Math.random): number {
  const ceiling = Math.min(300_000, 30_000 * 2 ** Math.min(20, Math.max(0, failures - 1)));
  return Math.round(ceiling * (0.8 + Math.min(1, Math.max(0, random())) * 0.2));
}
export type DependencyClaim = DependencyIdentity & { token: string };
export type DependencyAdmission = { claim: DependencyClaim } | { reason: string };

/** Database errors deliberately propagate: display health is not retry policy. */
export class DependencyRetry {
  constructor(
    private readonly db: PrismaClient,
    private readonly now = () => new Date(Date.now()),
    private readonly random = Math.random,
  ) {}

  async claim(identity: DependencyIdentity): Promise<DependencyAdmission> {
    const { serverId, spaceId, userId, revision } = identity;
    const now = this.now();
    const token = randomUUID();
    const expires = new Date(now.getTime() + DEPENDENCY_CLAIM_MS);
    // Revision is part of the primary key. A late old worker cannot reset the new revision.
    const rows = await this.db.$queryRaw<Array<{ claimToken: string }>>`
      INSERT INTO "dependency_retries" ("kind", "dependencyId", "spaceId", "userId", "revision", "failureCount", "exhausted", "claimToken", "claimExpiresAt", "updatedAt")
      VALUES ('mcp-discovery', ${serverId}, ${spaceId}, ${userId}, ${revision}, 0, false, ${token}, ${expires}, ${now})
      ON CONFLICT ("kind", "dependencyId", "spaceId", "userId", "revision") DO UPDATE
      SET "claimToken" = ${token}, "claimExpiresAt" = ${expires}, "updatedAt" = ${now}
      WHERE NOT "dependency_retries"."exhausted"
        AND ("dependency_retries"."nextAttemptAt" IS NULL OR "dependency_retries"."nextAttemptAt" <= ${now})
        AND ("dependency_retries"."claimExpiresAt" IS NULL OR "dependency_retries"."claimExpiresAt" <= ${now})
      RETURNING "claimToken"
    `;
    return rows.length
      ? { claim: { ...identity, token } }
      : {
          reason:
            "discovery retry is cooling down, already being checked, or exhausted; check the connection to recover",
        };
  }

  async complete(
    claim: DependencyClaim,
    outcome: "success" | "transient" | "excluded" | "intervention",
  ): Promise<boolean> {
    const now = this.now();
    const { serverId, spaceId, userId, revision, token } = claim;
    // Claim expiry also fences late results even before a replacement probe starts.
    if (outcome !== "transient") {
      const count = await this.db.$executeRaw`
        UPDATE "dependency_retries" SET "claimToken" = NULL, "claimExpiresAt" = NULL,
          "failureCount" = CASE WHEN ${outcome === "success"} THEN 0 ELSE "failureCount" END,
          "nextAttemptAt" = CASE WHEN ${outcome === "success"} THEN NULL ELSE "nextAttemptAt" END,
          "exhausted" = CASE WHEN ${outcome === "success"} THEN false WHEN ${outcome === "intervention"} THEN true ELSE "exhausted" END,
          "reasonCode" = CASE WHEN ${outcome === "success"} THEN NULL ELSE "reasonCode" END, "updatedAt" = ${now}
        WHERE "kind" = 'mcp-discovery' AND "dependencyId" = ${serverId} AND "spaceId" = ${spaceId}
          AND "userId" = ${userId} AND "revision" = ${revision} AND "claimToken" = ${token} AND "claimExpiresAt" > ${now}
      `;
      return count === 1;
    }
    const jitter = 0.8 + Math.min(1, Math.max(0, this.random())) * 0.2;
    const count = await this.db.$executeRaw`
      UPDATE "dependency_retries" SET "failureCount" = "failureCount" + 1,
        "nextAttemptAt" = ${now} + (LEAST(300000.0, 30000.0 * power(2, LEAST("failureCount", 20))) * ${jitter}) * interval '1 millisecond',
        "exhausted" = "failureCount" + 1 >= ${DEPENDENCY_RETRY_BUDGET}, "reasonCode" = 'transient',
        "claimToken" = NULL, "claimExpiresAt" = NULL, "updatedAt" = ${now}
      WHERE "kind" = 'mcp-discovery' AND "dependencyId" = ${serverId} AND "spaceId" = ${spaceId}
        AND "userId" = ${userId} AND "revision" = ${revision} AND "claimToken" = ${token} AND "claimExpiresAt" > ${now}
    `;
    return count === 1;
  }

  /** Explicit manual probe only; invalidate outstanding claims for precisely this identity. */
  async recover(identity: DependencyIdentity, observedAt: Date): Promise<void> {
    const { serverId, spaceId, userId, revision } = identity;
    await this.db.$executeRaw`
      UPDATE "dependency_retries" SET "failureCount" = 0, "exhausted" = false, "nextAttemptAt" = NULL,
        "reasonCode" = NULL, "claimToken" = NULL, "claimExpiresAt" = NULL, "updatedAt" = ${this.now()}
      WHERE "kind" = 'mcp-discovery' AND "dependencyId" = ${serverId} AND "spaceId" = ${spaceId}
        AND "userId" = ${userId} AND "revision" = ${revision}
        AND "updatedAt" < ${observedAt} AND "claimToken" IS NULL
    `;
  }
}
