-- A group member may be removed before Stop; the bot row need not still exist.
-- This permits only a non-executable cancellation inside the owning thread.
CREATE POLICY mcp_approval_continuations_cancel_removed_bot ON "mcp_approval_continuations"
  FOR UPDATE
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "status" = 'cancelled' AND "cancelledAt" IS NOT NULL AND "runId" IS NULL
    AND EXISTS (SELECT 1 FROM "messages" m JOIN "threads" t ON t.id = m."threadId" WHERE m.id = "mcp_approval_continuations"."messageId" AND (m."botId" = "mcp_approval_continuations"."botId" OR (m."botId" IS NULL AND t."botId" = "mcp_approval_continuations"."botId")) AND t.id = "mcp_approval_continuations"."threadId" AND t."spaceId" = "mcp_approval_continuations"."spaceId" AND t."userId" = "mcp_approval_continuations"."userId")
  );
