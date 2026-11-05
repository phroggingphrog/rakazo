/** The run cannot truthfully publish its final answer as a verified completion. */
export class UnverifiedExecutionError extends Error {}

/**
 * Fail closed when the durable effect ledger still has failed, uncertain, or
 * in-flight external effects. Monitor-source evidence and trusted local-rejection
 * messaging need separate foundations (routine.monitor, local_effect_rejections)
 * and are intentionally deferred.
 */
export async function assertNoUnresolvedEffects(
  store: {
    externalEffect: {
      count(args: { where: { runId: string; status: { in: string[] } } }): Promise<number>;
    };
  },
  runId: string,
  _routineId?: string | null,
): Promise<void> {
  const unresolved = await store.externalEffect.count({
    where: { runId, status: { in: ["failed", "uncertain", "executing"] } },
  });
  if (unresolved > 0) {
    throw new UnverifiedExecutionError(
      "External execution remains failed or unverified; reconcile destination evidence before reporting completion.",
    );
  }
}
