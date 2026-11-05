import * as z from "zod";
import { TimeZoneSchema } from "./domain.js";
import { Id } from "./ids.js";

/** Revisions are stored as signed PostgreSQL integers. */
export const SetupPlanRevisionSchema = z.number().int().positive().max(2_147_483_647);

/** Bounded preparatory input, not a claim that a provider schema or access was verified. */
export const SetupOperationArgumentsSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    let nodes = 0;
    const visited = new Set<object>();
    function valid(item: unknown, depth: number): boolean {
      if (++nodes > 256 || depth > 5) return false;
      if (item === null || typeof item === "boolean") return true;
      if (typeof item === "number") return Number.isFinite(item);
      if (typeof item === "string") return item.length <= 2048;
      if (typeof item !== "object" || visited.has(item)) return false;
      if (
        !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        return false;
      visited.add(item);
      if (Array.isArray(item)) return item.every((entry) => valid(entry, depth + 1));
      return Object.entries(item).every(([key, entry]) => {
        return (
          key.length <= 100 &&
          !/^(?:__proto__|prototype|constructor)$/i.test(key) &&
          valid(entry, depth + 1)
        );
      });
    }
    function utf8Bytes(text: string): number {
      let bytes = 0;
      for (const character of text) {
        const code = character.codePointAt(0)!;
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      }
      return bytes;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !valid(value, 0) ||
      utf8Bytes(JSON.stringify(value)) > 8192
    )
      ctx.addIssue({ code: "custom", message: "Arguments must be a bounded JSON object." });
  })
  .pipe(z.record(z.string(), z.json()));

/** A proposal describes intent; its references and permissions are not verified. */
export const SetupPlanDraftSchema = z
  .object({
    kind: z.literal("email_monitor"),
    purpose: z.string().trim().min(1).max(2000),
    arguments: SetupOperationArgumentsSchema.optional(),
    botId: Id.nullable(),
    source: z
      .object({
        serverId: Id,
        revision: SetupPlanRevisionSchema,
        toolName: z.string().min(1).max(200),
      })
      .strict()
      .nullable(),
    schedule: z
      .object({
        cron: z.string().trim().min(1).max(200),
        timezone: z.string().trim().pipe(TimeZoneSchema),
      })
      .strict()
      .nullable(),
    notify: z.boolean(),
  })
  .strict();

export const SetupPlanSchema = z
  .object({
    id: Id,
    revision: SetupPlanRevisionSchema,
    status: z.enum(["draft", "proposed", "configured"]),
    routineId: Id.nullable(),
    sourceAccess: z.literal("not_verified"),
    botAssignment: z.literal("not_checked"),
    draft: SetupPlanDraftSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

/** A snapshot of local configuration; it does not test a provider or activate a monitor. */
export const SetupPlanPrerequisitesSchema = z
  .object({
    planRevision: SetupPlanRevisionSchema,
    bot: z.enum(["not_selected", "available", "unavailable"]),
    source: z.enum(["not_selected", "available", "unavailable", "changed", "unsupported"]),
    assignment: z.enum(["not_checked", "configured", "not_configured"]),
    selectedTool: z.enum(["not_checked", "allowed", "blocked"]),
    operation: z.literal("not_verified"),
    sourceAccess: z.literal("not_verified"),
  })
  .strict();

export const SetupPlanCandidateOperationsSchema = z
  .object({
    planRevision: SetupPlanRevisionSchema,
    sourceRevision: SetupPlanRevisionSchema,
    status: z.enum(["ok", "unavailable", "not_assigned"]),
    selectedOperation: z.enum(["declared_read", "not_found", "not_checked"]),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    ),
    sourceAccess: z.literal("not_verified"),
    read: z.literal("not_performed"),
  })
  .strict();

/** A prepared test has not been queued, run or verified. */
export const SetupPreparedTestSchema = z
  .object({
    id: Id,
    planId: Id,
    planRevision: SetupPlanRevisionSchema,
    taskId: Id.nullable(),
    status: z.literal("prepared"),
    execution: z.literal("not_started"),
    sourceAccess: z.literal("not_verified"),
    createdAt: z.string(),
  })
  .strict();

/** Cross-install archive intentionally clears nonportable integration and bot references. */
export const PortableSetupPlanDraftSchema = SetupPlanDraftSchema.extend({
  botId: z.null(),
  source: z.null(),
  arguments: z.undefined().optional(),
});

export function portableSetupPlanDraft(value: unknown) {
  const draft = SetupPlanDraftSchema.parse(value);
  const { arguments: _arguments, ...portable } = draft;
  return PortableSetupPlanDraftSchema.parse({ ...portable, botId: null, source: null });
}
