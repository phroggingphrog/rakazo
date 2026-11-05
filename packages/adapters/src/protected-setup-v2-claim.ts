import type { PrismaClient } from "@rakazo/db";
import { contentEncryptionOf, currentDbContext, IsolationError } from "@rakazo/db";
import { inspectPreparedSetupInTransaction } from "./protected-setup-validation.js";

export type ProtectedSetupV2Claim =
  | "disabled"
  | "stale"
  | "claimed_uncertain"
  | "already_uncertain";

/** A separate namespace has no handler until protected execution and worker drain are proven. */
export function protectedSetupV2JobKey(attemptId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(attemptId)) throw new Error("Invalid prepared test ID");
  return `protected-setup-v2:${attemptId}`;
}

/**
 * Disconnected protocol foundation. A claim is permanently uncertain after worker loss;
 * it never proves an external read occurred and must not cause a retry or a Run.
 */
export async function claimProtectedSetupV2(
  prisma: PrismaClient,
  owner: { spaceId: string; userId: string },
  attemptId: string,
): Promise<ProtectedSetupV2Claim> {
  protectedSetupV2JobKey(attemptId);
  const context = currentDbContext();
  if (
    context?.kind !== "tenant" ||
    context.spaceId !== owner.spaceId ||
    context.userId !== owner.userId
  )
    throw new IsolationError();
  if (!contentEncryptionOf(prisma)?.ring.encryptWrites)
    throw new Error("Content encryption is required for protected setup claims.");
  return prisma.$transaction(
    async (tx) => {
      const gate = await tx.$queryRaw<Array<{ enabled: boolean }>>`
      SELECT enabled FROM protected_setup_v2_gate WHERE id FOR SHARE`;
      if (!gate[0]?.enabled) return "disabled";
      const attempt = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM setup_test_attempts WHERE id = ${attemptId}
        AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId} FOR UPDATE`;
      if (!attempt.length) return "stale";
      const existing = await tx.$queryRaw<Array<{ attemptId: string }>>`
      SELECT "attemptId" FROM protected_setup_v2_claims WHERE "attemptId" = ${attemptId}`;
      if (existing.length) return "already_uncertain";
      const inspection = await inspectPreparedSetupInTransaction(tx, owner, attemptId);
      if (inspection.configuration !== "consistent" || inspection.assignment !== "allowed")
        return "stale";
      const inserted = await tx.$queryRaw<Array<{ attemptId: string }>>`
      INSERT INTO protected_setup_v2_claims ("attemptId", "spaceId", "userId")
      VALUES (${attemptId}, ${owner.spaceId}, ${owner.userId})
      ON CONFLICT ("attemptId") DO NOTHING RETURNING "attemptId"`;
      return inserted.length ? "claimed_uncertain" : "already_uncertain";
    },
    { isolationLevel: "Serializable" },
  );
}
