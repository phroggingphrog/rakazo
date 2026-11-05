import { describe, expect, it } from "vitest";
import { setupRoutinePrompt } from "./routes/setup-plans.js";

describe("setup routine instruction", () => {
  it("identifies the selected integration when two integrations expose the same operation", () => {
    const build = (integration: { name: string; id: string; slug: string }) =>
      setupRoutinePrompt({
        purpose: "Find updates",
        integration,
        toolName: "search",
        operationArguments: { query: "appointments" },
      });
    const first = build({ name: "Personal mail", id: "server-one", slug: "personal" });
    const second = build({ name: "Work mail", id: "server-two", slug: "work" });
    expect(first).toContain('integration "Personal mail"');
    expect(first).toContain('ID "server-one"');
    expect(first).toContain("mcp__personal__");
    expect(first).toContain('read operation "search"');
    expect(first).toContain('{"query":"appointments"}');
    expect(first).not.toContain("server-two");
    expect(second).toContain('ID "server-two"');
    expect(second).toContain("mcp__work__");
    expect(second).not.toContain("server-one");
  });
});

it("keeps the source bound only while the saved intent still matches the routine", async () => {
  const { setupSourceForRoutine } = await import("@rakazo/contracts");
  const source = { serverId: "server-1", revision: 1, toolName: "read" };
  const draft = {
    kind: "email_monitor",
    purpose: "Find updates",
    botId: "bot-1",
    source,
    arguments: { b: 2, a: 1 },
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    notify: true,
  };
  const prompt = setupRoutinePrompt({
    purpose: draft.purpose,
    integration: { name: "Mail", id: "server-1", slug: "mail" },
    toolName: source.toolName,
    operationArguments: { a: 1, b: 2 },
  });
  expect(
    setupSourceForRoutine(prompt, draft, "bot-1", null, {
      name: "Mail",
      id: "server-1",
      slug: "mail",
    }),
  ).toEqual(draft);
  expect(
    setupSourceForRoutine(`${prompt}\n\nOwner changed the instructions`, draft, "bot-1", null, {
      name: "Mail",
      id: "server-1",
      slug: "mail",
    }),
  ).toBeUndefined();
  expect(
    setupSourceForRoutine(prompt.replace('"server-1"', '"server-2"'), draft, "bot-1", null, {
      name: "Mail",
      id: "server-1",
      slug: "mail",
    }),
  ).toBeUndefined();
  expect(
    setupSourceForRoutine(prompt, { ...draft, arguments: { a: 2, b: 2 } }, "bot-1", null, {
      name: "Mail",
      id: "server-1",
      slug: "mail",
    }),
  ).toBeUndefined();
  expect(
    setupSourceForRoutine(prompt, draft, "another-bot", null, {
      name: "Mail",
      id: "server-1",
      slug: "mail",
    }),
  ).toBeUndefined();
});
