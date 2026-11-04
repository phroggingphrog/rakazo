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
