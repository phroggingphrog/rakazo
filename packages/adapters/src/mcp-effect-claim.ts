import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@rakazo/db";
import { currentDbContext, RunHistoryWriteError, runAsTenant } from "@rakazo/db";
import { explicitToolFailure } from "./approval-effect.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { runLeaseFor } from "./run-messages.js";

type OwnerRun = { id: string; spaceId: string; userId: string };
type BindingRecheck = (tx: Prisma.TransactionClient) => Promise<boolean>;
type BindingClaimRecheck = (tx: Prisma.TransactionClient) => Promise<boolean | "uncertain">;
export class PipedreamBindingChangedError extends Error {}
export class PipedreamBindingUncertainError extends Error {}

async function withActiveRun<T>(
  deps: ExecutorDeps,
  run: OwnerRun,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const lease = runLeaseFor(deps, run.id);
  const current = currentDbContext();
  if (
    !lease ||
    !current ||
    (current.kind === "tenant" &&
      (current.spaceId !== run.spaceId || current.userId !== run.userId))
  )
    throw new RunHistoryWriteError();
  return runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
    deps.prisma.$transaction(async (tx) => {
      const active = async () => tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM runs WHERE id = ${run.id} AND "spaceId" = ${run.spaceId}
          AND "userId" = ${run.userId} AND status = 'running'
          AND "leaseOwner" = ${lease.owner} AND "leaseFence" = ${lease.fence}
          AND "leaseExpiresAt" AT TIME ZONE 'UTC' > clock_timestamp() FOR SHARE`;
      if ((await active()).length !== 1) throw new RunHistoryWriteError();
      const result = await write(tx);
      if ((await active()).length !== 1) throw new RunHistoryWriteError();
      return result;
    }),
  );
}

/** Retire a still-approved request only when its account change is proven under the run lease. */
export async function retireChangedPipedreamApproval(
  deps: ExecutorDeps,
  run: OwnerRun,
  idempotencyKey: string,
  expectedRequest: unknown,
  check: (tx: Prisma.TransactionClient, request: unknown) => Promise<boolean>,
): Promise<boolean> {
  return withActiveRun(deps, run, async (tx) => {
    const effect = await tx.externalEffect.findUnique({ where: { idempotencyKey } });
    if (
      !effect ||
      effect.runId !== run.id ||
      effect.spaceId !== run.spaceId ||
      effect.status !== "approved"
    )
      return false;
    if (!isDeepStrictEqual(effect.request, expectedRequest)) return false;
    if (!(await check(tx, effect.request))) return false;
    const locked = await tx.$queryRaw<Array<{ request: unknown }>>`
      SELECT request FROM external_effects WHERE id = ${effect.id} AND "runId" = ${run.id}
        AND "spaceId" = ${run.spaceId} AND status = 'approved' FOR UPDATE`;
    if (
      locked.length !== 1 ||
      !isDeepStrictEqual(expectedRequest, locked[0]?.request) ||
      !(await check(tx, locked[0]?.request))
    )
      return false;
    const updated = await tx.externalEffect.updateMany({
      where: {
        id: effect.id,
        runId: run.id,
        spaceId: run.spaceId,
        status: "approved",
        dispatchClaimToken: null,
        dispatchClaimFence: null,
      },
      data: {
        status: "failed",
        result: {
          error:
            "The connected account changed. No operation was sent; refresh the tool and review again.",
        },
      },
    });
    return updated.count === 1;
  });
}

/** A recorded MCP read is claimed too; a crash after this point requires reconciliation. */
export async function claimMcpEffect(
  deps: ExecutorDeps,
  run: OwnerRun,
  effectId: string,
  from: "intended" | "approved",
  recheck?: BindingClaimRecheck,
): Promise<string | undefined> {
  const token = randomUUID();
  const lease = runLeaseFor(deps, run.id);
  if (!lease) throw new RunHistoryWriteError();
  const outcome = await withActiveRun(deps, run, async (tx) => {
    const checked = recheck ? await recheck(tx) : true;
    if (checked === "uncertain") return { count: 0, retired: false, bindingFailed: true };
    if (!checked) {
      const retired = await tx.externalEffect.updateMany({
        where: {
          id: effectId,
          runId: run.id,
          spaceId: run.spaceId,
          status: from,
          dispatchClaimToken: null,
        },
        data: {
          status: "failed",
          result: {
            error:
              "The connected account changed. No operation was sent; refresh the tool and review again.",
          },
        },
      });
      return { count: 0, retired: retired.count === 1, bindingFailed: true };
    }
    const claimed = await tx.externalEffect.updateMany({
      where: {
        id: effectId,
        runId: run.id,
        spaceId: run.spaceId,
        status: from,
        dispatchClaimToken: null,
        dispatchClaimFence: null,
      },
      data: { status: "executing", dispatchClaimToken: token, dispatchClaimFence: lease.fence },
    });
    return { count: claimed.count, retired: false, bindingFailed: false };
  });
  if (outcome.retired) throw new PipedreamBindingChangedError();
  if (outcome.bindingFailed) throw new PipedreamBindingUncertainError();
  return outcome.count === 1 ? token : undefined;
}

export async function finishPipedreamEffect(
  deps: ExecutorDeps,
  run: OwnerRun,
  effectId: string,
  token: string,
  result: unknown,
  uncertainResult: unknown,
  uncertain: boolean,
  recheck: BindingRecheck,
): Promise<{ settled: boolean; uncertain: boolean }> {
  const lease = runLeaseFor(deps, run.id);
  if (!lease) throw new RunHistoryWriteError();
  return withActiveRun(deps, run, async (tx) => {
    const outcomeUnknown = uncertain || !(await recheck(tx));
    const updated = await tx.externalEffect.updateMany({
      where: {
        id: effectId,
        runId: run.id,
        spaceId: run.spaceId,
        status: "executing",
        dispatchClaimToken: token,
        dispatchClaimFence: lease.fence,
      },
      data: {
        status: outcomeUnknown ? "uncertain" : explicitToolFailure(result) ? "failed" : "completed",
        result: (outcomeUnknown ? uncertainResult : result) as never,
      },
    });
    return { settled: updated.count === 1, uncertain: outcomeUnknown };
  });
}

export async function finishMcpEffect(
  deps: ExecutorDeps,
  run: OwnerRun,
  effectId: string,
  token: string,
  result: unknown,
  uncertain: boolean,
): Promise<boolean> {
  const lease = runLeaseFor(deps, run.id);
  if (!lease) throw new RunHistoryWriteError();
  const updated = await withActiveRun(deps, run, (tx) =>
    tx.externalEffect.updateMany({
      where: {
        id: effectId,
        runId: run.id,
        spaceId: run.spaceId,
        status: "executing",
        dispatchClaimToken: token,
        dispatchClaimFence: lease.fence,
      },
      data: {
        status: uncertain ? "uncertain" : explicitToolFailure(result) ? "failed" : "completed",
        result: result as never,
      },
    }),
  );
  return updated.count === 1;
}

/** A newer run attempt can retire only claims from an older, identified attempt. */
export async function recoverStaleMcpEffects(deps: ExecutorDeps, run: OwnerRun): Promise<number> {
  const lease = runLeaseFor(deps, run.id);
  const current = currentDbContext();
  if (
    !lease ||
    !current ||
    (current.kind === "tenant" &&
      (current.spaceId !== run.spaceId || current.userId !== run.userId))
  )
    throw new RunHistoryWriteError();
  // Once this attempt has the run lease, an older attempt cannot create a new claim.
  const pending = await runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
    deps.prisma.externalEffect.findFirst({
      where: {
        runId: run.id,
        spaceId: run.spaceId,
        status: "executing",
        dispatchClaimToken: { not: null },
        dispatchClaimFence: { lt: lease.fence },
      },
      select: { id: true },
    }),
  );
  if (!pending) return 0;
  return withActiveRun(deps, run, async (tx) => {
    const stale = await tx.externalEffect.findMany({
      where: {
        runId: run.id,
        spaceId: run.spaceId,
        status: "executing",
        dispatchClaimToken: { not: null },
        dispatchClaimFence: { lt: lease.fence },
      },
      select: { id: true, dispatchClaimToken: true, dispatchClaimFence: true },
    });
    let recovered = 0;
    for (const effect of stale) {
      if (effect.dispatchClaimToken === null || effect.dispatchClaimFence === null) continue;
      const updated = await tx.externalEffect.updateMany({
        where: {
          id: effect.id,
          runId: run.id,
          spaceId: run.spaceId,
          status: "executing",
          dispatchClaimToken: effect.dispatchClaimToken,
          dispatchClaimFence: effect.dispatchClaimFence,
        },
        data: {
          status: "uncertain",
          result: {
            error:
              "An earlier external operation has an unknown outcome. Verify it before retrying.",
            uncertain: true,
          },
        },
      });
      recovered += updated.count;
    }
    return recovered;
  });
}
