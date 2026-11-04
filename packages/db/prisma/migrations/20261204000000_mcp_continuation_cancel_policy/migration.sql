-- A grant or server can be revoked before Stop cancels the pending intent.
-- This policy only permits an own-tenant transition to a non-executable cancelled state.
CREATE POLICY mcp_approval_continuations_tenant_cancel ON "mcp_approval_continuations"
  FOR UPDATE
  USING (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND "status" = 'cancelled' AND "cancelledAt" IS NOT NULL AND "runId" IS NULL
    AND EXISTS (SELECT 1 FROM "bots" b WHERE b.id = "mcp_approval_continuations"."botId" AND b."spaceId" = "mcp_approval_continuations"."spaceId" AND b."userId" = "mcp_approval_continuations"."userId")
    AND EXISTS (SELECT 1 FROM "messages" m JOIN "threads" t ON t.id = m."threadId" WHERE m.id = "mcp_approval_continuations"."messageId" AND (m."botId" = "mcp_approval_continuations"."botId" OR (m."botId" IS NULL AND t."botId" = "mcp_approval_continuations"."botId")) AND t.id = "mcp_approval_continuations"."threadId" AND t."spaceId" = "mcp_approval_continuations"."spaceId" AND t."userId" = "mcp_approval_continuations"."userId")
  );
