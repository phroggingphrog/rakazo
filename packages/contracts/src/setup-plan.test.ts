import { describe, expect, it } from "vitest";
import {
  PortableSetupPlanDraftSchema,
  portableSetupPlanDraft,
  SetupPlanDraftSchema,
} from "./setup-plan.js";

const draft = {
  kind: "email_monitor" as const,
  purpose: "Monitor my mail",
  botId: "bot-1",
  source: { serverId: "server-1", revision: 1, toolName: "read_mail" },
  schedule: { cron: "0 9 * * *", timezone: "Australia/Melbourne" },
  notify: true,
};

describe("setup plan draft", () => {
  it("bounds operation arguments and keeps older drafts compatible", () => {
    expect(SetupPlanDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        arguments: { query: "sample", limit: 5, flags: [true] },
      }).success,
    ).toBe(true);
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        arguments: { password: "example", options: [{ api_key: "example" }], accessToken: "x" },
      }).success,
    ).toBe(true);
    for (const args of [
      [],
      { query: "x".repeat(2049) },
      { items: Array.from({ length: 300 }, () => 1) },
      { a: { b: { c: { d: { e: { f: 1 } } } } } },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      { value: Number.NaN },
    ])
      expect(SetupPlanDraftSchema.safeParse({ ...draft, arguments: args }).success).toBe(false);
  });
  it("accepts incomplete proposals but rejects unsupported or secret-bearing fields", () => {
    expect(
      SetupPlanDraftSchema.safeParse({ ...draft, botId: null, source: null, schedule: null })
        .success,
    ).toBe(true);
    expect(SetupPlanDraftSchema.safeParse({ ...draft, password: "fake" }).success).toBe(false);
    expect(
      SetupPlanDraftSchema.safeParse({ ...draft, source: { ...draft.source, token: "fake" } })
        .success,
    ).toBe(false);
    expect(SetupPlanDraftSchema.safeParse({ ...draft, status: "active" }).success).toBe(false);
  });
  it("rejects invalid timezones without substituting UTC", () => {
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        schedule: { ...draft.schedule, timezone: "Not/A_Zone" },
      }).success,
    ).toBe(false);
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        schedule: { ...draft.schedule, timezone: "+01:00" },
      }).success,
    ).toBe(false);
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        schedule: { ...draft.schedule, timezone: "Australia/Melbourne" },
      }).success,
    ).toBe(true);
  });
  it("bounds referenced integration revisions to PostgreSQL integers", () => {
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        source: { ...draft.source, revision: 2_147_483_647 },
      }).success,
    ).toBe(true);
    expect(
      SetupPlanDraftSchema.safeParse({
        ...draft,
        source: { ...draft.source, revision: 2_147_483_648 },
      }).success,
    ).toBe(false);
  });
  it("drops nonportable bot and integration references from exports", () => {
    const portable = portableSetupPlanDraft(draft);
    expect(portable).toEqual({ ...draft, botId: null, source: null });
    expect(PortableSetupPlanDraftSchema.safeParse(draft).success).toBe(false);
    expect(portableSetupPlanDraft({ ...draft, arguments: { query: "sample" } })).toEqual(portable);
  });
});
