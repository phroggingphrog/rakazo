import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { listSchedulesFromTool } from "./schedule-tools.js";
import { listScratchpadItems } from "./scratchpad-tools.js";
import { listAgentSkillRecords } from "./skill-tools.js";

export type TaskCatalogToolDeps = {
  prisma: PrismaClient;
};

type TaskCatalogInput = {
  spaceId: string;
  botId: string;
  userId: string;
  threadId?: string;
  tools: readonly Pick<ConnectorTool, "name" | "description" | "readOnly">[];
};

/**
 * Guidance injected alongside the catalog tool. Keep this short: the live
 * records returned by task_catalog are the source of truth for names and ids.
 */
export const TASK_CATALOG_GUIDANCE = [
  "Task execution: task_catalog is the source of truth for this bot's open work, routines, skills, and exposed tools; conversation or memory text is not proof that a task exists.",
  "When a request refers to an existing task, routine, skill, or capability, call task_catalog first and use the exact returned id/name.",
  "For an open task, perform the work with the exposed tools, verify the result, then use scratchpad_update or scratchpad_complete. Never mark work done before verification.",
  "Built-in tool discovery: if a named tool is absent from the direct list, call find_tool with its exact name, then use use_tool with the returned schema. Treat a tool as unavailable only when it is absent from this run's discovery catalog, and explain any known run-specific restriction.",
  "Connected tool discovery: use directly listed tools as-is. When a source is represented by a catalog, search it, load the exact tool schema, then execute by the returned id (MCP: connectors_search_tools/connectors_load_tool/connectors_execute_tool; installed apps: installed_search_tools/installed_load_tool/installed_execute_tool; Pipedream: pipedream_search_tools/pipedream_load_tool/pipedream_execute_tool). Treat a tool as absent only after searching its assigned source; report source-specific run or health restrictions.",
  "For scheduling, provide exactly one timing mode to schedule_create (cron, every+unit, runAt, delayMinutes, or delaySeconds). To change an existing routine, call find_tool for schedule_update, then use_tool; do not cancel and recreate. After a write, call schedule_list and report success only when the returned state confirms it.",
  "Routine-triggered runs intentionally omit schedule_create and schedule_update to prevent adding unattended work. This is a run-policy restriction, not a global scheduling outage; user-started runs can create schedules directly and discover schedule_update when it is offered.",
  "If a tool returns an error, do not repeat the same tool call with the same arguments. Correct the specific field once as a separate attempt; if that attempt fails, stop and explain the blocker instead of narrating more retries. A different command is not a retry.",
].join("\n");

export async function taskCatalogFromTool(deps: TaskCatalogToolDeps, input: TaskCatalogInput) {
  const [tasks, schedules, taughtSkills, skills] = await Promise.all([
    listScratchpadItems(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      includeDone: false,
    }),
    listSchedulesFromTool(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }),
    deps.prisma.taughtSkill.findMany({
      where: {
        spaceId: input.spaceId,
        botId: input.botId,
        status: "saved",
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, name: true, goal: true, status: true },
    }),
    listAgentSkillRecords(deps.prisma, {
      spaceId: input.spaceId,
      userId: input.userId,
    }),
  ]);

  const seenTools = new Set<string>();
  const exposedTools = input.tools.flatMap((tool) => {
    if (seenTools.has(tool.name)) return [];
    seenTools.add(tool.name);
    return [
      {
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly ?? false,
      },
    ];
  });

  return {
    guidance: TASK_CATALOG_GUIDANCE,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      notes: task.notes,
      source: "scratchpad",
    })),
    routines: schedules.routines,
    taughtSkills: taughtSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      goal: skill.goal,
      status: skill.status,
      source: "taught_skill",
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      readOnly: skill.readOnly,
    })),
    tools: exposedTools,
  };
}
