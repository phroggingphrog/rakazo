import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";
import {
  createProtectedEffectKey,
  openProtectedEffectKey,
  protectedEffectIdempotencyKey,
  sealProtectedEffectPayload,
} from "./protected-effect-crypto.js";
import { currentDbContext } from "./row-security.js";
import { IsolationError } from "./scope.js";

type Owner = { spaceId: string; userId: string };
type Lease = { runId: string; workerId: string; fence: number };
type ScopeRow = { scopeId: string | null; keyCiphertext: string | null };

async function requireCurrentLease(
  tx: Pick<PrismaClient, "$queryRaw">,
  owner: Owner,
  lease: Lease,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM runs WHERE id = ${lease.runId} AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId}
      AND "taskProtected" = true AND trigger = 'protected_setup_v2' AND status = 'running'
      AND "leaseOwner" = ${lease.workerId} AND "leaseFence" = ${lease.fence}
      AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
  if (!rows.length) throw new Error("Protected effect lease expired");
}

function requireTenant(owner: Owner, lease: Lease) {
  const context = currentDbContext();
  if (
    context?.kind !== "tenant" ||
    context.spaceId !== owner.spaceId ||
    context.userId !== owner.userId
  )
    throw new IsolationError();
  if (!lease.runId || !lease.workerId || !Number.isSafeInteger(lease.fence) || lease.fence < 1)
    throw new Error("Protected effect lease is invalid");
}

/** This lookup is only a preflight; every write repeats it under a gate and run lock. */
async function preflight(prisma: PrismaClient, owner: Owner, lease: Lease) {
  return prisma.$queryRaw<ScopeRow[]>`
    SELECT s.id AS "scopeId", s."keyCiphertext" FROM runs r
    LEFT JOIN protected_effect_scopes s ON s."runId" = r.id AND s."spaceId" = r."spaceId" AND s."userId" = r."userId"
    WHERE r.id = ${lease.runId} AND r."spaceId" = ${owner.spaceId} AND r."userId" = ${owner.userId}
      AND r."taskProtected" = true AND r.trigger = 'protected_setup_v2' AND r.status = 'running'
      AND r."leaseOwner" = ${lease.workerId} AND r."leaseFence" = ${lease.fence}
      AND r."leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      AND EXISTS (SELECT 1 FROM protected_setup_v2_gate WHERE id AND enabled)`;
}

/** An owner-scoped storage identity; this does not authorize a tool call. */
export async function ensureProtectedEffectScope(prisma: PrismaClient, owner: Owner, lease: Lease) {
  requireTenant(owner, lease);
  const first = await preflight(prisma, owner, lease);
  if (!first.length) throw new Error("Protected effect storage is unavailable");
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring?.encryptWrites) throw new Error("Protected effect encryption is unavailable");
  const scopeId = randomUUID();
  const generated = await createProtectedEffectKey(ring, { ...owner, scopeId });
  return prisma.$transaction(async (tx) => {
    const gate = await tx.$queryRaw<Array<{ enabled: boolean }>>`
      SELECT enabled FROM protected_setup_v2_gate WHERE id FOR SHARE`;
    if (!gate[0]?.enabled) throw new Error("Protected effect storage is unavailable");
    const runs = await tx.$queryRaw<Array<{ stableId: string | null }>>`
      SELECT "protectedStorageId"::text AS "stableId" FROM runs
      WHERE id = ${lease.runId} AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId}
        AND "taskProtected" = true AND trigger = 'protected_setup_v2' AND status = 'running'
        AND "leaseOwner" = ${lease.workerId} AND "leaseFence" = ${lease.fence}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE`;
    if (!runs.length) throw new Error("Protected effect storage is unavailable");
    const existing = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM protected_effect_scopes WHERE "runId" = ${lease.runId}
        AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId} FOR UPDATE`;
    if (existing.length) return { scopeId: existing[0]!.id };
    const stableId = runs[0]!.stableId ?? randomUUID();
    if (!runs[0]!.stableId)
      await tx.$executeRaw`UPDATE runs SET "protectedStorageId" = ${stableId}::uuid WHERE id = ${lease.runId} AND "protectedStorageId" IS NULL`;
    await tx.$executeRaw`
      INSERT INTO protected_effect_scopes (id, "runId", "runStorageId", "spaceId", "userId", "keyCiphertext")
      VALUES (${scopeId}, ${lease.runId}, ${stableId}::uuid, ${owner.spaceId}, ${owner.userId}, ${generated.ciphertext})`;
    await requireCurrentLease(tx, owner, lease);
    return { scopeId };
  });
}

/** Store a marker and encrypted request atomically. No tool is dispatched by this function. */
export async function stageProtectedEffect(
  prisma: PrismaClient,
  owner: Owner,
  lease: Lease,
  input: { scopeId: string; route: unknown; args: unknown; occurrence: number },
): Promise<{ status: "created"; effectId: string } | { status: "already_present_unverified" }> {
  requireTenant(owner, lease);
  const first = await preflight(prisma, owner, lease);
  if (first[0]?.scopeId !== input.scopeId || !first[0].keyCiphertext)
    throw new Error("Protected effect storage is unavailable");
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring?.encryptWrites) throw new Error("Protected effect encryption is unavailable");
  const identity = { ...owner, scopeId: input.scopeId };
  const key = await openProtectedEffectKey(ring, identity, first[0].keyCiphertext);
  const idempotencyKey = protectedEffectIdempotencyKey(key, identity, input);
  const effectId = randomUUID();
  const effectStorageId = randomUUID();
  const payloadId = randomUUID();
  const ciphertext = await sealProtectedEffectPayload(ring, identity, payloadId, {
    route: input.route,
    request: input.args,
  });
  return prisma.$transaction(async (tx) => {
    const gate = await tx.$queryRaw<Array<{ enabled: boolean }>>`
      SELECT enabled FROM protected_setup_v2_gate WHERE id FOR SHARE`;
    if (!gate[0]?.enabled) throw new Error("Protected effect storage is unavailable");
    const runs = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM runs WHERE id = ${lease.runId} AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId}
        AND "taskProtected" = true AND trigger = 'protected_setup_v2' AND status = 'running'
        AND "leaseOwner" = ${lease.workerId} AND "leaseFence" = ${lease.fence}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') FOR UPDATE`;
    if (!runs.length) throw new Error("Protected effect storage is unavailable");
    const scopes = await tx.$queryRaw<Array<{ ciphertext: string }>>`
      SELECT "keyCiphertext" AS ciphertext FROM protected_effect_scopes
      WHERE id = ${input.scopeId} AND "runId" = ${lease.runId}
        AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId} FOR UPDATE`;
    if (scopes[0]?.ciphertext !== first[0]!.keyCiphertext)
      throw new Error("Protected effect scope changed; retry preparation");
    const existing = await tx.externalEffect.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (existing) return { status: "already_present_unverified" as const };
    await tx.externalEffect.create({
      data: {
        id: effectId,
        spaceId: owner.spaceId,
        runId: lease.runId,
        kind: "protected_marker",
        status: "intended",
        idempotencyKey,
        request: {},
      },
    });
    await tx.$executeRaw`UPDATE external_effects SET "protectedStorageId" = ${effectStorageId}::uuid WHERE id = ${effectId} AND "runId" = ${lease.runId} AND "protectedStorageId" IS NULL`;
    await tx.$executeRaw`
      INSERT INTO protected_effect_payloads (id, "effectId", "effectStorageId", "scopeId", "runId", "spaceId", "userId", ciphertext)
      VALUES (${payloadId}, ${effectId}, ${effectStorageId}::uuid, ${input.scopeId}, ${lease.runId}, ${owner.spaceId}, ${owner.userId}, ${ciphertext})`;
    await requireCurrentLease(tx, owner, lease);
    return { status: "created" as const, effectId };
  });
}
