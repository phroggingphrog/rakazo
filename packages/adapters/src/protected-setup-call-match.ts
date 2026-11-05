import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import { validateProtectedSetupArguments } from "./protected-setup-schema-validation.js";

const id = z.string().min(1).max(128);
const binding = z.strictObject({
  spaceId: id,
  userId: id,
  botId: id,
  routineId: id,
  taskId: id,
  attemptId: id,
  runId: id,
  planId: id,
  planRevision: z.number().int().positive().max(2_147_483_647),
  leaseOwner: id,
  leaseFence: z.number().int().positive().max(2_147_483_647),
});
const source = z.strictObject({
  connectorId: z.literal("mcp"),
  resourceId: id,
  resourceRevision: z.number().int().positive().max(2_147_483_647),
  toolName: z.string().min(1).max(200),
});

type ProtectedRead = {
  binding: unknown;
  source: unknown;
  schema: unknown;
  arguments: unknown;
};

/**
 * Pure comparison only. Callers must obtain the reviewed values from the owned,
 * encrypted snapshot and prove a live lease and single dispatch transactionally.
 */
export function matchesReviewedProtectedRead(
  reviewed: ProtectedRead & { ownerConfirmed: boolean },
  candidate: ProtectedRead & { trigger: string; readOnly: boolean; batch: boolean },
): boolean {
  try {
    if (
      reviewed.ownerConfirmed !== true ||
      candidate.trigger !== "protected_setup_v2" ||
      candidate.readOnly !== true ||
      candidate.batch !== false
    )
      return false;
    const expectedBinding = binding.safeParse(reviewed.binding);
    const actualBinding = binding.safeParse(candidate.binding);
    const expectedSource = source.safeParse(reviewed.source);
    const actualSource = source.safeParse(candidate.source);
    if (
      !expectedBinding.success ||
      !actualBinding.success ||
      !expectedSource.success ||
      !actualSource.success
    )
      return false;
    if (
      !isDeepStrictEqual(expectedBinding.data, actualBinding.data) ||
      !isDeepStrictEqual(expectedSource.data, actualSource.data) ||
      !isDeepStrictEqual(reviewed.schema, candidate.schema) ||
      !isDeepStrictEqual(reviewed.arguments, candidate.arguments)
    )
      return false;
    return validateProtectedSetupArguments(candidate.schema, candidate.arguments) === "valid";
  } catch {
    return false;
  }
}
