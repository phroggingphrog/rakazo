/** Describe what an MCP approval established without asserting provider readiness. */
export function mcpConnectedPrompt(
  name: string,
  input: { assignmentOnly?: boolean; allowAllTools?: boolean },
): string {
  const restricted =
    input.allowAllTools === false
      ? " The existing assignment is restricted to its allowed tools."
      : "";
  return `The user approved the MCP server ${JSON.stringify(name)} for this bot.${restricted} The assignment was saved, but provider sign-in and tool availability have not been verified. Continue with the user's request and check what is available before claiming the integration works. If nothing is left to do, confirm in one short sentence.`;
}
