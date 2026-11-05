-- Keep historical decisions, while allowing only one live pending request per card.
-- An existing duplicate causes migration to fail for review; it is never removed here.
CREATE UNIQUE INDEX "mcp_approval_continuations_one_pending_key"
  ON "mcp_approval_continuations" ("messageId", "botId", "serverId")
  WHERE "status" = 'pending';
