import { WorkspaceMonitorSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { monitorSourceEvidence } from "./run-monitor-evidence.js";

/** The run cannot truthfully publish its final answer as a verified completion. */
export class UnverifiedExecutionError extends Error {}

/** Fail closed without leaking tool requests, results, or private destination data. */
export async function assertNoUnresolvedEffects(
  store: {
    $queryRaw?: PrismaClient["$queryRaw"];
    externalEffect: {
      count(args: { where: { runId: string; status: { in: string[] } } }): Promise<number>;
    };
    routine?: {
      findUnique(args: {
        where: { id: string };
        select: { monitor: true };
      }): Promise<{ monitor: unknown } | null>;
    };
    event?: {
      count(args: {
        where: {
          runId: string;
          type: string;
          payload: { path: string[]; equals: string };
        };
      }): Promise<number>;
    };
  },
  runId: string,
  routineId?: string | null,
): Promise<void> {
  if (routineId) {
    const routine = await store.routine?.findUnique({
      where: { id: routineId },
      select: { monitor: true },
    });
    if (!routine) throw new UnverifiedExecutionError("Routine policy unavailable");
    if (routine.monitor != null) {
      const policy = WorkspaceMonitorSchema.safeParse(routine.monitor);
      if (!policy.success) throw new UnverifiedExecutionError("Routine policy invalid");
      if (!policy.data.source)
        throw new UnverifiedExecutionError("Monitor source is not configured");
      const reads = await store.event?.count({
        where: {
          runId,
          type: "effect.recorded",
          payload: { path: ["evidence"], equals: monitorSourceEvidence(policy.data.source) },
        },
      });
      if (!reads)
        throw new UnverifiedExecutionError(
          "Monitor requires a successful declared external read in this run before reporting completion.",
        );
    }
  }
  const unresolved = await store.externalEffect.count({
    where: { runId, status: { in: ["failed", "uncertain", "executing"] } },
  });
  if (unresolved > 0) {
    if (store.$queryRaw) {
      const effects = await store.$queryRaw<Array<{ status: string; reason: string | null }>>`
        SELECT e.status, p.reason FROM external_effects e
        LEFT JOIN local_effect_rejections p ON p."effectId" = e.id
          AND p."runId" = e."runId" AND p."spaceId" = e."spaceId"
        WHERE e."runId" = ${runId} AND e.status IN ('failed', 'uncertain', 'executing')`;
      if (
        effects.length === unresolved &&
        effects.every(
          (effect) =>
            effect.status === "failed" &&
            [
              "invalid_screen_action",
              "invalid_shared_memory",
              "computer_unavailable",
              "stdio_mcp_forbidden",
              "instruction_precondition_failed",
            ].includes(effect.reason ?? ""),
        )
      ) {
        if (effects.every((effect) => effect.reason === "computer_unavailable"))
          throw new UnverifiedExecutionError(
            "The computer could not be reached, so the requested action did not run.",
          );
        if (effects.every((effect) => effect.reason === "stdio_mcp_forbidden"))
          throw new UnverifiedExecutionError(
            "The local MCP server was not added because this action requires an administrator.",
          );
        if (effects.every((effect) => effect.reason === "instruction_precondition_failed"))
          throw new UnverifiedExecutionError(
            "The instructions were not updated because their precondition changed; review them and try again.",
          );
        if (new Set(effects.map((effect) => effect.reason)).size > 1)
          throw new UnverifiedExecutionError(
            "One or more requested actions did not run. Review the action errors before retrying.",
          );
        throw new UnverifiedExecutionError(
          "The requested action did not run because its input was invalid. Check the action and try again.",
        );
      }
    }
    throw new UnverifiedExecutionError(
      "External execution remains failed or unverified; reconcile destination evidence before reporting completion.",
    );
  }
}
