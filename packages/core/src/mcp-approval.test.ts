import { describe, expect, it } from "vitest";
import { mcpConnectedPrompt } from "./mcp-approval.js";

describe("MCP approval continuation prompt", () => {
  it.each([
    {},
    { assignmentOnly: false, allowAllTools: true },
    { assignmentOnly: true, allowAllTools: true },
    { assignmentOnly: false, allowAllTools: false },
    { assignmentOnly: true, allowAllTools: false },
  ])("does not assert provider readiness for %j", (input) => {
    const prompt = mcpConnectedPrompt('Synthetic "mail"', input);
    expect(prompt).toContain(JSON.stringify('Synthetic "mail"'));
    expect(prompt).toContain("assignment was saved");
    expect(prompt).toContain("provider sign-in and tool availability have not been verified");
    expect(prompt).toContain("Continue with the user's request");
    expect(prompt).not.toContain("tools are available now");
    expect(prompt.includes("restricted to its allowed tools")).toBe(input.allowAllTools === false);
  });
});
