/** All admitted work finished, but at least one MCP session could not be cleaned up. */
export class McpSessionCleanupError extends Error {
  constructor(count: number) {
    super(`Failed to close MCP sessions (${count})`);
    this.stack = undefined;
  }
}
