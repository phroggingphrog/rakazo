-- The approval event sequence preserves order even when wall-clock timestamps tie.
CREATE INDEX "mcp_approval_continuations_thread_order_idx"
  ON "mcp_approval_continuations" ("threadId", "botId", "status", "decisionSeq", "id");
