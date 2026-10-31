-- Additive metadata for short-lived MCP outputs. Payloads remain in encrypted artifact storage.
CREATE TABLE "mcp_tool_outputs" (
  "id" TEXT NOT NULL,
  "storageId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mcp_tool_outputs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mcp_tool_outputs_bytes_check" CHECK ("bytes" >= 0 AND "bytes" <= 2097152)
);
CREATE UNIQUE INDEX "mcp_tool_outputs_storageId_key" ON "mcp_tool_outputs"("storageId");
CREATE INDEX "mcp_tool_outputs_scope_expiry_idx" ON "mcp_tool_outputs"("spaceId", "userId", "botId", "runId", "serverId", "expiresAt");
CREATE INDEX "mcp_tool_outputs_expiresAt_idx" ON "mcp_tool_outputs"("expiresAt");
ALTER TABLE "mcp_tool_outputs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_tool_outputs_tenant ON "mcp_tool_outputs"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY mcp_tool_outputs_system ON "mcp_tool_outputs"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
