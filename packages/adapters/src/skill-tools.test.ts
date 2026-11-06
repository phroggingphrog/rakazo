import { buildSkillMd, formatSkillsCatalogInstruction, parseSkillMd } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import {
  listAgentSkillRecords,
  skillCreateFromTool,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "./skill-tools.js";

type Scope = { spaceId?: string; userId?: string; OR?: Array<{ spaceId?: string }> };
/** The owner's rows here: added in this space (no fixture is available beyond one). */
function inScope(row: Record<string, unknown>, where: Scope): boolean {
  if (where.userId && row.userId !== where.userId) return false;
  if (where.spaceId && row.spaceId !== where.spaceId) return false;
  if (where.OR && !where.OR.some((branch) => branch.spaceId === row.spaceId)) return false;
  return true;
}

function makePrisma(rows: Array<Record<string, unknown>> = [], settings: unknown = null) {
  const store = [...rows];
  const profiles = new Map<string, { settings: unknown; revision: number }>();
  const prisma = {
    agentSkill: {
      findMany: vi.fn(async ({ where }: { where?: Scope } = {}) =>
        store.filter((row) => !where || inScope(row, where)).map((row) => ({ ...row })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Scope & { id: string } }) => {
        const row = store.find((item) => item.id === where.id && inScope(item, where));
        return row ? { ...row, files: row.files ?? null } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `skill-${store.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          source: "user",
          ...data,
        };
        store.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const index = store.findIndex((row) => row.id === where.id);
          if (index < 0) throw new Error("missing");
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return store[index];
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, string>;
          data: Record<string, unknown>;
        }) => {
          const index = store.findIndex(
            (row) =>
              row.id === where.id &&
              row.spaceId === where.spaceId &&
              row.userId === where.userId &&
              row.source === where.source,
          );
          if (index < 0) return { count: 0 };
          store[index] = { ...store[index], ...data, updatedAt: new Date() };
          return { count: 1 };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = store.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error("missing");
        const [removed] = store.splice(index, 1);
        return removed;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const index = store.findIndex(
          (row) =>
            row.id === where.id &&
            row.spaceId === where.spaceId &&
            row.userId === where.userId &&
            row.source === where.source,
        );
        if (index < 0) return { count: 0 };
        store.splice(index, 1);
        return { count: 1 };
      }),
    },
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; spaceId: string; userId: string } }) =>
          where.id && where.spaceId && where.userId ? { id: where.id } : null,
      ),
    },
    $queryRaw: vi.fn(async () => [{ id: "bot-1" }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    botRuntimeProfile: {
      findUnique: vi.fn(
        async ({ where }: { where: { botId: string } }) =>
          profiles.get(where.botId) ?? (settings === null ? null : { settings }),
      ),
      create: vi.fn(
        async ({ data }: { data: { botId: string; settings: unknown; revision: number } }) => {
          profiles.set(data.botId, data);
          return data;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { botId: string };
          data: { settings: unknown; revision: number };
        }) => {
          profiles.set(where.botId, data);
          return data;
        },
      ),
    },
    botRuntimeProfileRevision: { create: vi.fn(async () => ({})) },
    _store: store,
  };
  return prisma;
}

const owner = { spaceId: "ws-1", userId: "user-1" };

describe("skill tools", () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it("discovers disabled skills without their bodies and changes only own selection", async () => {
    const botOwner = { ...owner, botId: "bot-1" };
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Shared",
      description: "Shared recipe",
      body: "Hidden recipe",
    });
    const disabled = await skillUpdateFromTool(prisma as never, botOwner, {
      skillId: String(created.id),
      enabled: false,
    } as never);
    expect(disabled.ok).toBe(true);
    expect(
      await skillReadFromTool(prisma as never, botOwner, { skillId: String(created.id) }),
    ).toHaveProperty("error");
    const discovery = await skillReadFromTool(prisma as never, botOwner, {
      discover: true,
    } as never);
    expect(discovery).toHaveProperty("skills");
    expect(JSON.stringify(discovery)).not.toContain("Hidden recipe");
    expect(
      await skillReadFromTool(
        prisma as never,
        { ...owner, botId: "bot-2" },
        { skillId: String(created.id) },
      ),
    ).toHaveProperty("content");
    expect(
      await skillUpdateFromTool(prisma as never, botOwner, {
        skillId: String(created.id),
        enabled: true,
      } as never),
    ).toHaveProperty("ok", true);
    expect(
      await skillReadFromTool(prisma as never, botOwner, { skillId: String(created.id) }),
    ).toHaveProperty("content");
  });

  it("versions private improvements and rolls back without changing another bot", async () => {
    const botOwner = { ...owner, botId: "bot-1" };
    const created = await skillCreateFromTool(prisma as never, botOwner, {
      name: "Lesson",
      description: "Repeatable",
      body: "Original",
    });
    expect(
      await skillUpdateFromTool(prisma as never, botOwner, {
        skillId: String(created.id),
        body: "Improved",
      }),
    ).toHaveProperty("ok", true);
    const history = await skillReadFromTool(prisma as never, botOwner, {
      skillId: String(created.id),
      history: true,
    } as never);
    expect(history).toHaveProperty("revisions");
    expect(
      await skillUpdateFromTool(prisma as never, botOwner, {
        skillId: String(created.id),
        rollbackRevision: 1,
      } as never),
    ).toHaveProperty("ok", true);
    expect(
      await skillReadFromTool(prisma as never, botOwner, { skillId: String(created.id) }),
    ).toHaveProperty(
      "content",
      buildSkillMd({ name: "Lesson", description: "Repeatable", body: "Original" }),
    );
    expect(
      await skillUpdateFromTool(prisma as never, { ...owner, botId: "bot-2" }, {
        skillId: String(created.id),
        rollbackRevision: 1,
      } as never),
    ).toHaveProperty("error");
  });

  it("enables a new private lesson for a bot with an explicit empty catalog", async () => {
    const scoped = makePrisma([], { skills: { mode: "explicit", skillIds: [] } });
    const botOwner = { ...owner, botId: "bot-1" };
    const created = await skillCreateFromTool(scoped as never, botOwner, {
      name: "Lesson",
      description: "Repeatable",
      body: "Steps",
    });
    expect(
      await skillReadFromTool(scoped as never, botOwner, { skillId: String(created.id) }),
    ).toHaveProperty("content");
  });

  it("cannot expose another bot lesson via an explicit assignment or discovery", async () => {
    const scoped = makePrisma(
      [
        {
          id: "private-other",
          ...owner,
          ownerBotId: "bot-2",
          name: "Other lesson",
          description: "Private metadata",
          content: "Private body",
          source: "user",
        },
      ],
      { skills: { mode: "explicit", skillIds: ["private-other"] } },
    );
    const botOwner = { ...owner, botId: "bot-1" };
    expect(await listAgentSkillRecords(scoped as never, botOwner)).toEqual([]);
    expect(
      JSON.stringify(await skillReadFromTool(scoped as never, botOwner, { discover: true })),
    ).not.toContain("Private metadata");
    expect(
      await skillUpdateFromTool(scoped as never, botOwner, {
        skillId: "private-other",
        enabled: true,
      }),
    ).toHaveProperty("error");
  });

  it("preserves non-skill profile settings when selecting skills", async () => {
    const scoped = makePrisma([], { persona: { persona: "Keep role" } });
    const botOwner = { ...owner, botId: "bot-1" };
    const id = `builtin:${BUILTIN_AGENT_SKILLS[0]!.name}`;
    expect(
      await skillUpdateFromTool(scoped as never, botOwner, { skillId: id, enabled: false }),
    ).toHaveProperty("ok", true);
    const saved = await scoped.botRuntimeProfile.findUnique({ where: { botId: "bot-1" } });
    expect(saved?.settings).toMatchObject({
      persona: { persona: "Keep role" },
      learning: { mode: "off" },
      initiative: { enabled: false },
    });
    expect(
      await skillUpdateFromTool(scoped as never, botOwner, {
        skillId: id,
        enabled: true,
        body: "No mixed writes",
      }),
    ).toHaveProperty("error");
  });

  it("rejects a bot editing a shared skill even in its own space", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Shared",
      description: "Shared recipe",
    });
    expect(
      await skillUpdateFromTool(
        prisma as never,
        { ...owner, botId: "bot-1" },
        { skillId: String(created.id), body: "Overwrite" },
      ),
    ).toHaveProperty("error");
    expect(
      await skillDeleteFromTool(
        prisma as never,
        { ...owner, botId: "bot-1" },
        { skillId: String(created.id) },
      ),
    ).toHaveProperty("error");
  });

  it("keeps bot-created lessons private even in legacy library mode", async () => {
    const botOwner = { ...owner, botId: "bot-1" };
    const created = await skillCreateFromTool(prisma as never, botOwner, {
      name: "Private lesson",
      description: "Use for repeated checks",
      body: "Verify first.",
    });
    expect(created.ok).toBe(true);
    expect(prisma._store[0]?.ownerBotId).toBe("bot-1");
    expect(
      (await listAgentSkillRecords(prisma as never, botOwner)).some((s) => s.id === created.id),
    ).toBe(true);
    expect(
      (await listAgentSkillRecords(prisma as never, { ...owner, botId: "bot-2" })).some(
        (s) => s.id === created.id,
      ),
    ).toBe(false);
    expect(
      await skillReadFromTool(
        prisma as never,
        { ...owner, botId: "bot-2" },
        { skillId: String(created.id) },
      ),
    ).toEqual({ error: "Skill not found." });
  });

  it("enforces current explicit skill assignments for listing and tool access", async () => {
    const rows = [
      {
        id: "skill-picked",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Picked",
        description: "ok",
        content: buildSkillMd({ name: "Picked", description: "ok", body: "picked body" }),
        source: "user",
      },
      {
        id: "skill-other",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Other",
        description: "ok",
        content: buildSkillMd({ name: "Other", description: "ok", body: "secret body" }),
        source: "user",
      },
    ];
    const settings = { schemaVersion: 1, skills: { mode: "explicit", skillIds: ["skill-picked"] } };
    const prisma = makePrisma(rows, settings);
    const selectedOwner = { ...owner, botId: "bot-1" };

    expect(
      (await listAgentSkillRecords(prisma as never, selectedOwner)).map(({ id }) => id),
    ).toEqual(["skill-picked"]);
    expect(await skillReadFromTool(prisma as never, selectedOwner, { name: "Other" })).toEqual({
      error: "Skill not found.",
    });
    expect(
      await skillReadFromTool(prisma as never, selectedOwner, { skillId: "skill-other" }),
    ).toEqual({ error: "Skill not found." });
    expect(
      await skillUpdateFromTool(prisma as never, selectedOwner, {
        skillId: "skill-other",
        body: "changed",
      }),
    ).toEqual({ error: "Skill not found." });
    expect(
      await skillUpdateFromTool(prisma as never, selectedOwner, {
        name: "Other",
        body: "changed",
      }),
    ).toEqual({ error: "Skill not found." });
    expect(
      await skillDeleteFromTool(prisma as never, selectedOwner, { skillId: "skill-other" }),
    ).toEqual({ error: "Skill not found." });
    expect(await skillDeleteFromTool(prisma as never, selectedOwner, { name: "Other" })).toEqual({
      error: "Skill not found.",
    });
    expect(prisma._store).toHaveLength(2);
  });

  it("rechecks revoked assignment on the next call and validates bot scope", async () => {
    const settings = { schemaVersion: 1, skills: { mode: "explicit", skillIds: ["skill-picked"] } };
    const row = {
      id: "skill-picked",
      spaceId: owner.spaceId,
      userId: owner.userId,
      name: "Picked",
      description: "ok",
      content: buildSkillMd({ name: "Picked", description: "ok", body: "private" }),
      source: "user",
    };
    const prisma = makePrisma([row], settings);
    const botOwner = { ...owner, botId: "bot-1" };
    expect(
      await skillReadFromTool(prisma as never, botOwner, { skillId: row.id }),
    ).not.toHaveProperty("error");
    settings.skills.skillIds.splice(0);
    expect(await skillReadFromTool(prisma as never, botOwner, { skillId: row.id })).toEqual({
      error: "Skill not found.",
    });

    const scoped = makePrisma([row], settings);
    scoped.$queryRaw.mockResolvedValue([]);
    scoped.botRuntimeProfile.findUnique.mockClear();
    expect(await listAgentSkillRecords(scoped as never, botOwner)).toEqual([]);
    expect(scoped.botRuntimeProfile.findUnique).not.toHaveBeenCalled();
  });

  it("requires explicit assignment for builtin IDs and rejects invalid profiles closed", async () => {
    const builtinId = `builtin:${BUILTIN_AGENT_SKILLS[0]!.name}`;
    const explicit = makePrisma([], {
      schemaVersion: 1,
      skills: { mode: "explicit", skillIds: [builtinId] },
    });
    const botOwner = { ...owner, botId: "bot-1" };
    expect(
      (await listAgentSkillRecords(explicit as never, botOwner)).some(
        (skill) => skill.id === builtinId,
      ),
    ).toBe(true);
    expect(
      await skillReadFromTool(explicit as never, botOwner, { skillId: builtinId }),
    ).not.toHaveProperty("error");

    const notAssigned = makePrisma([], {
      schemaVersion: 1,
      skills: { mode: "explicit", skillIds: [] },
    });
    expect(
      (await listAgentSkillRecords(notAssigned as never, botOwner)).some(
        (skill) => skill.id === builtinId,
      ),
    ).toBe(false);
    expect(
      await skillReadFromTool(notAssigned as never, botOwner, {
        name: BUILTIN_AGENT_SKILLS[0]!.name,
      }),
    ).toEqual({ error: "Skill not found." });

    const invalid = makePrisma([], { schemaVersion: 99 });
    expect(await listAgentSkillRecords(invalid as never, botOwner)).toEqual([]);
    expect(
      await skillCreateFromTool(invalid as never, botOwner, { name: "No", description: "No" }),
    ).toHaveProperty("error");
  });

  it("keeps legacy library access and enables newly created private lessons", async () => {
    const botOwner = { ...owner, botId: "bot-1" };
    const legacy = makePrisma([], { schemaVersion: 1, skills: { mode: "legacy-library" } });
    expect((await listAgentSkillRecords(legacy as never, botOwner)).length).toBeGreaterThan(0);
    const explicit = makePrisma([], {
      schemaVersion: 1,
      skills: { mode: "explicit", skillIds: [] },
    });
    const created = await skillCreateFromTool(explicit as never, botOwner, {
      name: "New",
      description: "Private",
    });
    expect(created).toMatchObject({ ok: true });
    expect(
      (await listAgentSkillRecords(explicit as never, botOwner)).some(
        (skill) => skill.name === "New",
      ),
    ).toBe(true);
    expect(await skillReadFromTool(explicit as never, botOwner, { name: "New" })).toHaveProperty(
      "content",
    );
  });

  it("creates, reads, updates, and deletes user skills", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "1. Summarize yesterday.\n2. List blockers.",
    });
    expect(created).toMatchObject({ ok: true, name: "Daily standup" });
    expect(String(created.hint)).toContain("/Daily standup");

    const read = await skillReadFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(read).toMatchObject({
      name: "Daily standup",
      description: "Prepare standup notes",
      readOnly: false,
    });
    expect(String(read.content)).toContain("Summarize yesterday");

    const updated = await skillUpdateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Updated when-to-use",
    });
    expect(updated).toMatchObject({ ok: true, description: "Updated when-to-use" });

    const deleted = await skillDeleteFromTool(prisma as never, owner, { name: "Daily standup" });
    expect(deleted).toEqual({ ok: true, name: "Daily standup" });
    expect(await skillReadFromTool(prisma as never, owner, { name: "Daily standup" })).toEqual({
      error: "Skill not found.",
    });
  });

  it("lists a skill's reference files and reads one by exact path only", async () => {
    const prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "billing",
        description: "Billing guidance",
        content: buildSkillMd({
          name: "billing",
          description: "Billing guidance",
          body: "See references/rates.md.",
        }),
        source: "plugin",
        files: { "references/rates.md": "Rates table", "notes.txt": "Notes" },
      },
    ]);
    expect(await skillReadFromTool(prisma as never, owner, { name: "billing" })).toMatchObject({
      name: "billing",
      files: ["notes.txt", "references/rates.md"],
    });
    expect(
      await skillReadFromTool(prisma as never, owner, {
        name: "billing",
        file: "./references/rates.md",
      }),
    ).toEqual({ name: "billing", file: "references/rates.md", content: "Rates table" });
    expect(
      await skillReadFromTool(prisma as never, owner, { name: "billing", file: "../secrets.md" }),
    ).toMatchObject({ error: expect.stringContaining("No file") });
  });

  it("preserves extra frontmatter keys on update", async () => {
    const content = buildSkillMd({
      name: "Review PR",
      description: "Review a pull request",
      body: "1. Read the diff.",
      frontmatter: { compatibility: "cursor", "allowed-tools": ["shell"] },
    });
    await skillCreateFromTool(prisma as never, owner, { content });
    await skillUpdateFromTool(prisma as never, owner, {
      name: "Review PR",
      body: "1. Read the diff.\n2. Leave comments.",
    });
    const read = await skillReadFromTool(prisma as never, owner, { name: "Review PR" });
    expect(String(read.content)).toContain("compatibility: cursor");
    expect(String(read.content)).toContain("Leave comments");
  });

  it("renames only via newName, not the name lookup key", async () => {
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Original",
      description: "Keep name unless newName",
      body: "body",
    });
    const skillId = String(created.id);
    const mistyped = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      name: "Should not apply",
      description: "still original name",
    });
    expect(mistyped).toMatchObject({ ok: true, name: "Original" });

    const renamed = await skillUpdateFromTool(prisma as never, owner, {
      skillId,
      newName: "Renamed",
    });
    expect(renamed).toMatchObject({ ok: true, name: "Renamed" });
  });

  it("scopes list to the owner workspace and injects catalog lines", async () => {
    prisma = makePrisma([
      {
        id: "other-1",
        spaceId: "ws-2",
        userId: "user-2",
        name: "Other workspace skill",
        description: "not visible",
        content: buildSkillMd({
          name: "Other workspace skill",
          description: "not visible",
          body: "x",
        }),
        source: "user",
      },
    ]);
    await skillCreateFromTool(prisma as never, owner, {
      name: "Daily standup",
      description: "Prepare standup notes",
      body: "steps",
    });
    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.map((row) => row.name)).toContain("Daily standup");
    expect(records.map((row) => row.name)).not.toContain("Other workspace skill");
    const catalog = formatSkillsCatalogInstruction(records);
    expect(catalog).toContain("- Daily standup: Prepare standup notes");
    expect(catalog).toContain("skill_read");
  });

  it("rejects update/delete for plugin and builtin skills", async () => {
    prisma = makePrisma([
      {
        id: "plugin-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Plugin recipe",
        description: "From a plugin",
        content: buildSkillMd({
          name: "Plugin recipe",
          description: "From a plugin",
          body: "do not edit",
        }),
        source: "plugin",
      },
    ]);
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Plugin recipe",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Plugin recipe" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it("ships builtin skills as valid, readable, read-only SKILL.md records", async () => {
    expect(BUILTIN_AGENT_SKILLS.map((skill) => skill.name)).toContain("Interrogate");
    for (const skill of BUILTIN_AGENT_SKILLS) {
      const parsed = parseSkillMd(skill.content);
      expect(parsed).toMatchObject({ name: skill.name, description: skill.description });
      // / picker truncates at 72; keep descriptions short so "review only" stays visible.
      expect(skill.description.length).toBeLessThanOrEqual(72);
    }

    const records = await listAgentSkillRecords(prisma as never, owner);
    const interrogate = records.find((row) => row.name === "Interrogate");
    expect(interrogate).toMatchObject({
      id: "builtin:Interrogate",
      source: "builtin",
      readOnly: true,
    });
    expect(formatSkillsCatalogInstruction(records)).toContain("- Interrogate:");
    expect(formatSkillsCatalogInstruction(records)).toContain("Review only");

    const read = await skillReadFromTool(prisma as never, owner, { name: "interrogate" });
    expect(read).toMatchObject({ name: "Interrogate", source: "builtin", readOnly: true });
    expect(String(read.content)).toContain("Do not modify files");

    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: "interrogate",
        description: "shadow the builtin",
        body: "steps",
      }),
    ).toEqual({ error: 'A skill named "Interrogate" already exists.' });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Interrogate",
        description: "hijack",
      }),
    ).toEqual({ error: "Builtin and plugin skills are read-only." });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Interrogate" })).toEqual({
      error: "Builtin and plugin skills are read-only.",
    });
  });

  it.each(["interrogate", " Interrogate "])("preserves a saved skill named %j", async (name) => {
    prisma = makePrisma([
      {
        id: "legacy-1",
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
        description: "my review recipe",
        content: buildSkillMd({
          name,
          description: "my review recipe",
          body: "my steps",
        }),
        source: "user",
      },
    ]);

    const records = await listAgentSkillRecords(prisma as never, owner);
    expect(records.filter((skill) => skill.name.trim().toLowerCase() === "interrogate")).toEqual([
      expect.objectContaining({ id: "legacy-1", source: "user", readOnly: false }),
    ]);
    expect(await skillReadFromTool(prisma as never, owner, { name: "Interrogate" })).toMatchObject({
      name,
      source: "user",
      readOnly: false,
    });
    expect(await skillReadFromTool(prisma as never, owner, { skillId: "legacy-1" })).toMatchObject({
      name,
      source: "user",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Interrogate",
        description: "still mine",
      }),
    ).toMatchObject({ ok: true });
    expect(await skillDeleteFromTool(prisma as never, owner, { name: "Interrogate" })).toEqual({
      ok: true,
      name: name.trim(),
    });
  });

  it("rejects oversized skill content", async () => {
    const body = "x".repeat(100_001);
    const created = await skillCreateFromTool(prisma as never, owner, {
      name: "Huge",
      description: "too big",
      body,
    });
    expect(created).toMatchObject({ error: expect.stringContaining("at most") });
  });

  it("rejects overlong skill names on structured create and rename", async () => {
    const longName = "N".repeat(81);
    expect(
      await skillCreateFromTool(prisma as never, owner, {
        name: longName,
        description: "ok description",
        body: "steps",
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });

    await skillCreateFromTool(prisma as never, owner, {
      name: "Short",
      description: "ok description",
      body: "steps",
    });
    expect(
      await skillUpdateFromTool(prisma as never, owner, {
        name: "Short",
        newName: longName,
      }),
    ).toEqual({ error: "Skill name must be at most 80 characters." });
  });
});
