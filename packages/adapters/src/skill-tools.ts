import { BotRuntimeProfile } from "@rakazo/contracts";
import type { SkillRecord, SkillSource } from "@rakazo/core";
import {
  buildSkillMd,
  findSkillByName,
  isSkillReadOnly,
  mergeBuiltinSkills,
  parseSkillMd,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  availableInSpace,
  readBotRuntimeProfile,
  writeBotRuntimeProfileInTransaction,
} from "@rakazo/db";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

export const SKILL_TOOL_NAMES = new Set([
  "skill_read",
  "skill_create",
  "skill_update",
  "skill_delete",
]);

/** Match CreateAgentSkillInput / UpdateAgentSkillInput / parseSkillMd bounds. */
const MAX_SKILL_CONTENT_CHARS = 100_000;
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 2000;

export type SkillOwner = {
  spaceId: string;
  userId: string;
  botId?: string;
};

type SkillSelection = { mode: "legacy-library" } | { mode: "explicit"; skillIds: Set<string> };

async function skillSelection(
  prisma: PrismaClient,
  owner: SkillOwner,
  botAlreadyLocked = false,
): Promise<SkillSelection | null> {
  if (!owner.botId) return { mode: "legacy-library" };
  const stored = botAlreadyLocked
    ? await prisma.botRuntimeProfile.findUnique({ where: { botId: owner.botId } })
    : await readBotRuntimeProfile(prisma, {
        botId: owner.botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
      });
  if (!stored) return { mode: "legacy-library" };
  const parsed = BotRuntimeProfile.safeParse(stored.settings);
  if (!parsed.success) return null;
  const selection = parsed.data.skills;
  return selection.mode === "explicit"
    ? { mode: "explicit", skillIds: new Set(selection.skillIds) }
    : selection;
}

type SkillPolicyResult<T> = { ok: true; value: T } | { ok: false };

/** Lock the bot row used by profile writes before reading policy or touching skills. */
async function withSkillPolicy<T>(
  prisma: PrismaClient,
  owner: SkillOwner,
  operation: (tx: PrismaClient, selection: SkillSelection) => Promise<T>,
): Promise<SkillPolicyResult<T>> {
  if (!owner.botId) {
    const selection = await skillSelection(prisma, owner);
    return selection ? { ok: true, value: await operation(prisma, selection) } : { ok: false };
  }
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM bots
      WHERE id = ${owner.botId} AND "spaceId" = ${owner.spaceId} AND "userId" = ${owner.userId}
      FOR UPDATE
    `;
    if (rows.length === 0) return { ok: false } as const;
    const selection = await skillSelection(tx as PrismaClient, owner, true);
    if (!selection) return { ok: false } as const;
    return { ok: true, value: await operation(tx as PrismaClient, selection) } as const;
  });
}

const INVALID_PROFILE_ERROR = "Skill access is unavailable because the bot profile is invalid.";
function includesSelection(selection: SkillSelection, id: string): boolean {
  return selection.mode === "legacy-library" || selection.skillIds.has(id);
}

type AgentSkillRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  source: string;
  ownerBotId?: string | null;
  revision?: number;
  history?: unknown;
};

function asSource(value: string): SkillSource {
  if (value === "builtin" || value === "plugin" || value === "user") return value;
  return "user";
}

function toRecord(row: AgentSkillRow): SkillRecord & { id: string } {
  const source = asSource(row.source);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    source,
    readOnly: isSkillReadOnly(source),
  };
}

function builtinRecords(): Array<SkillRecord & { id: string }> {
  return BUILTIN_AGENT_SKILLS.map((skill) => ({
    id: `builtin:${skill.name}`,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    source: "builtin" as const,
    readOnly: true,
  }));
}

function rejectOversizedContent(content: string): string | undefined {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `Skill content must be at most ${MAX_SKILL_CONTENT_CHARS} characters.`;
  }
  return undefined;
}

function rejectInvalidSkillFields(name: string, description: string): string | undefined {
  if (!name) return "Skill name is required.";
  if (!description) return "Skill description is required.";
  if (name.length > MAX_SKILL_NAME_CHARS) {
    return `Skill name must be at most ${MAX_SKILL_NAME_CHARS} characters.`;
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    return `Skill description must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`;
  }
  return undefined;
}

/**
 * A bot changes only skills that live in its own space alone: writing this space's details into
 * a skill other spaces read would carry them across the boundary.
 */
function onlyInSpace(owner: SkillOwner) {
  return {
    spaceId: owner.spaceId,
    userId: owner.userId,
    allSpaces: false,
    availableIn: { none: {} },
    ownerBotId: owner.botId ?? null,
  };
}

const SHARED_SKILL_ERROR =
  "Could not change this skill. A skill available in other spaces can only be changed by the user.";

async function listAgentSkillRecordsInternal(
  prisma: PrismaClient,
  owner: SkillOwner,
  selection?: SkillSelection,
): Promise<Array<SkillRecord & { id: string }>> {
  const rows = await prisma.agentSkill.findMany({
    where: availableInSpace(owner),
    // Reference files are read one at a time through skill_read, never with the catalog.
    omit: { files: true, history: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const records = mergeBuiltinSkills(
    builtinRecords(),
    rows.filter((row) => !row.ownerBotId || row.ownerBotId === owner.botId).map(toRecord),
  );
  return selection ? records.filter((skill) => includesSelection(selection, skill.id)) : records;
}

async function findOwnedSkill(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { skillId?: string; name?: string },
  selection?: SkillSelection,
): Promise<(SkillRecord & { id: string }) | null> {
  const skills = await listAgentSkillRecordsInternal(prisma, owner, selection);
  if (input.skillId) {
    return skills.find((skill) => skill.id === input.skillId) ?? null;
  }
  if (input.name) return findSkillByName(skills, input.name) ?? null;
  return null;
}

/** The text files stored beside a skill's SKILL.md, keyed by relative path. */
export function skillFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function saveSkillSelection(
  prisma: PrismaClient,
  owner: SkillOwner & { botId: string },
  skillIds: string[],
) {
  const current = await prisma.botRuntimeProfile.findUnique({ where: { botId: owner.botId } });
  const settings = BotRuntimeProfile.parse(current?.settings ?? {});
  settings.skills = { mode: "explicit", skillIds };
  // The caller already holds the bot lock and transaction. Reuse the profile revision writer.
  await writeBotRuntimeProfileInTransaction(prisma, {
    ...owner,
    expectedRevision: current?.revision ?? 0,
    settings: settings as Prisma.InputJsonValue,
    reason: "Bot skill selection",
  });
}

async function skillReadFromToolInternal(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    file?: string;
    discover?: boolean;
    query?: string;
    history?: boolean;
  },
  selection?: SkillSelection,
): Promise<Record<string, unknown>> {
  if (input.discover) {
    const records = await listAgentSkillRecordsInternal(prisma, owner);
    const query = (input.query ?? "").trim().toLowerCase();
    return {
      skills: records
        .filter((s) => !query || `${s.name} ${s.description}`.toLowerCase().includes(query))
        .map(({ id, name, description, source }) => ({
          id,
          name,
          description,
          source,
          enabled: !selection || includesSelection(selection, id),
        })),
    };
  }
  const skill = await findOwnedSkill(prisma, owner, input, selection);
  if (!skill) return { error: "Skill not found." };
  const row = skill.id.startsWith("builtin:")
    ? null
    : await prisma.agentSkill.findFirst({
        where: { id: skill.id, ...availableInSpace(owner) },
        select: { files: true, revision: true, history: true, ownerBotId: true },
      });
  if (input.history) {
    if (!row || row.ownerBotId !== owner.botId)
      return { error: "Only private lesson history is available." };
    return { revision: row.revision, revisions: row.history };
  }
  const files = skillFiles(row?.files);
  const paths = Object.keys(files).sort();
  const wanted = input.file?.trim().replace(/^\.\//, "");
  if (wanted) {
    // Only exact stored paths resolve, so no path can reach outside the skill.
    const text = files[wanted];
    if (text === undefined) return { error: `No file "${wanted}" in this skill.`, files: paths };
    return { name: skill.name, file: wanted, content: text };
  }
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    readOnly: skill.readOnly,
    content: skill.content,
    ...(paths.length ? { files: paths } : {}),
  };
}

async function skillCreateFromToolInternal(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
  selection?: SkillSelection,
): Promise<Record<string, unknown>> {
  let name = "";
  let description = "";
  let content = "";
  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    name = parsed.name;
    description = parsed.description;
    content = buildSkillMd(parsed);
  } else {
    name = String(input.name ?? "").trim();
    description = String(input.description ?? "").trim();
    const body = String(input.body ?? "").trim();
    if (!name || !description) {
      return {
        error: "Provide name and description (and optional body), or full SKILL.md content.",
      };
    }
    const invalid = rejectInvalidSkillFields(name, description);
    if (invalid) return { error: invalid };
    content = buildSkillMd({ name, description, body });
  }

  const oversized = rejectOversizedContent(content);
  if (oversized) return { error: oversized };

  const existing = await findOwnedSkill(prisma, owner, { name });
  if (existing) return { error: `A skill named "${existing.name}" already exists.` };

  const row = await prisma.agentSkill.create({
    data: {
      spaceId: owner.spaceId,
      userId: owner.userId,
      name,
      description,
      content,
      source: "user",
      ownerBotId: owner.botId ?? null,
    },
  });
  if (owner.botId && selection?.mode === "explicit") {
    await saveSkillSelection(prisma, { ...owner, botId: owner.botId }, [
      ...selection.skillIds,
      row.id,
    ]);
  }
  return {
    ok: true,
    id: row.id,
    name: row.name,
    description: row.description,
    hint: `Created skill. Mention /${row.name} so the user can open it.`,
  };
}

async function skillUpdateFromToolInternal(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    newName?: string;
    description?: string;
    body?: string;
    content?: string;
    enabled?: boolean;
    rollbackRevision?: number;
  },
  selection?: SkillSelection,
): Promise<Record<string, unknown>> {
  if (input.enabled !== undefined) {
    if (!owner.botId || !selection)
      return { error: "A bot is required to change skill selection." };
    if (
      [input.newName, input.description, input.body, input.content, input.rollbackRevision].some(
        (v) => v !== undefined,
      )
    )
      return { error: "Change selection separately from content." };
    const records = await listAgentSkillRecordsInternal(prisma, owner);
    const target = input.skillId
      ? records.find((s) => s.id === input.skillId)
      : findSkillByName(records, input.name ?? "");
    if (!target) return { error: "Skill not found." };
    const ids =
      selection.mode === "explicit"
        ? new Set(selection.skillIds)
        : new Set(records.map((s) => s.id));
    if (input.enabled) ids.add(target.id);
    else ids.delete(target.id);
    await saveSkillSelection(prisma, owner as SkillOwner & { botId: string }, [...ids]);
    return { ok: true, id: target.id, enabled: input.enabled };
  }
  const existing = await findOwnedSkill(
    prisma,
    owner,
    {
      skillId: input.skillId,
      name: input.name,
    },
    selection,
  );
  if (!existing) return { error: "Skill not found." };
  if (owner.botId) {
    const row = await prisma.agentSkill.findFirst({
      where: { id: existing.id, ...availableInSpace(owner) },
    });
    if (!row || row.ownerBotId !== owner.botId)
      return { error: "Shared skills are read-only. Create a private lesson instead." };
  }
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }

  const stored = await prisma.agentSkill.findFirst({
    where: { id: existing.id, ...availableInSpace(owner) },
  });
  if (!stored) return { error: "Skill not found." };
  const snapshots = Array.isArray(stored.history) ? stored.history : [];
  if (input.rollbackRevision !== undefined) {
    if (!Number.isSafeInteger(input.rollbackRevision) || input.rollbackRevision < 1)
      return { error: "Invalid revision." };
    const snapshot = snapshots.find(
      (s) =>
        s && typeof s === "object" && !Array.isArray(s) && s.revision === input.rollbackRevision,
    );
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot) ||
      typeof snapshot.content !== "string"
    )
      return { error: "Revision not found." };
    if ([input.newName, input.description, input.body, input.content].some((v) => v !== undefined))
      return { error: "Rollback separately from editing." };
    input = { ...input, content: snapshot.content };
  }
  let nextContent = existing.content;
  let nextName = existing.name;
  let nextDescription = existing.description;

  if (input.content?.trim()) {
    const parsed = parseSkillMd(input.content);
    if ("error" in parsed) return { error: parsed.error };
    nextName = parsed.name;
    nextDescription = parsed.description;
    nextContent = buildSkillMd(parsed);
  } else {
    const prior = parseSkillMd(existing.content);
    if ("error" in prior) return { error: prior.error };
    // `name` is only a lookup key (see findOwnedSkill above); renames require `newName`.
    nextName = String(input.newName ?? existing.name).trim() || existing.name;
    nextDescription =
      input.description !== undefined ? String(input.description).trim() : existing.description;
    const body = input.body !== undefined ? String(input.body) : prior.body;
    const invalidFields = rejectInvalidSkillFields(nextName, nextDescription);
    if (invalidFields) return { error: invalidFields };
    nextContent = buildSkillMd({
      name: nextName,
      description: nextDescription,
      body,
      frontmatter: prior.frontmatter,
    });
  }

  const invalid = rejectInvalidSkillFields(nextName, nextDescription);
  if (invalid) return { error: invalid };
  const oversized = rejectOversizedContent(nextContent);
  if (oversized) return { error: oversized };

  if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await findOwnedSkill(prisma, owner, { name: nextName });
    if (clash && clash.id !== existing.id) {
      return { error: `A skill named "${clash.name}" already exists.` };
    }
  }

  try {
    // Re-scope mutate to owner + user source so a stale id cannot cross tenants.
    const updated = await prisma.agentSkill.updateMany({
      where: { id: existing.id, ...onlyInSpace(owner), source: "user", revision: stored.revision },
      data: {
        name: nextName,
        description: nextDescription,
        content: nextContent,
        revision: (stored.revision ?? 1) + 1,
        history: [
          ...snapshots,
          { revision: stored.revision ?? 1, content: existing.content },
        ] as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) return { error: SHARED_SKILL_ERROR };
    return { ok: true, id: existing.id, name: nextName, description: nextDescription };
  } catch {
    return { error: "Could not update skill." };
  }
}

async function skillDeleteFromToolInternal(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
  selection?: SkillSelection,
): Promise<Record<string, unknown>> {
  const existing = await findOwnedSkill(prisma, owner, input, selection);
  if (!existing) return { error: "Skill not found." };
  if (owner.botId) {
    const row = await prisma.agentSkill.findFirst({
      where: { id: existing.id, ...availableInSpace(owner) },
    });
    if (!row || row.ownerBotId !== owner.botId)
      return { error: "Shared skills are read-only. Create a private lesson instead." };
  }
  if (existing.readOnly || existing.source !== "user" || existing.id.startsWith("builtin:")) {
    return { error: "Builtin and plugin skills are read-only." };
  }
  const deleted = await prisma.agentSkill.deleteMany({
    where: { id: existing.id, ...onlyInSpace(owner), source: "user" },
  });
  if (deleted.count !== 1) return { error: SHARED_SKILL_ERROR };
  return { ok: true, name: existing.name };
}

export async function listAgentSkillRecords(
  prisma: PrismaClient,
  owner: SkillOwner,
): Promise<Array<SkillRecord & { id: string }>> {
  const result = await withSkillPolicy(prisma, owner, (tx, selection) =>
    listAgentSkillRecordsInternal(tx, owner, selection),
  );
  return result.ok ? result.value : [];
}

export async function skillReadFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: {
    name?: string;
    skillId?: string;
    file?: string;
    discover?: boolean;
    query?: string;
    history?: boolean;
  },
): Promise<Record<string, unknown>> {
  const result = await withSkillPolicy(prisma, owner, (tx, selection) =>
    skillReadFromToolInternal(tx, owner, input, selection),
  );
  return result.ok ? result.value : { error: "Skill not found." };
}

export async function skillCreateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; description?: string; body?: string; content?: string },
): Promise<Record<string, unknown>> {
  try {
    const result = await withSkillPolicy(prisma, owner, (tx, selection) =>
      skillCreateFromToolInternal(tx, owner, input, selection),
    );
    return result.ok ? result.value : { error: INVALID_PROFILE_ERROR };
  } catch {
    return { error: "Could not create skill (name or selection may conflict)." };
  }
}

export async function skillUpdateFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: Parameters<typeof skillUpdateFromToolInternal>[2],
): Promise<Record<string, unknown>> {
  const result = await withSkillPolicy(prisma, owner, (tx, selection) =>
    skillUpdateFromToolInternal(tx, owner, input, selection),
  );
  return result.ok ? result.value : { error: "Skill not found." };
}

export async function skillDeleteFromTool(
  prisma: PrismaClient,
  owner: SkillOwner,
  input: { name?: string; skillId?: string },
): Promise<Record<string, unknown>> {
  const result = await withSkillPolicy(prisma, owner, (tx, selection) =>
    skillDeleteFromToolInternal(tx, owner, input, selection),
  );
  return result.ok ? result.value : { error: "Skill not found." };
}
