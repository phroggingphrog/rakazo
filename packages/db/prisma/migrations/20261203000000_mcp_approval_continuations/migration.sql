CREATE TABLE "mcp_approval_continuations" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "assignmentOnly" BOOLEAN NOT NULL DEFAULT false,
  "decisionSeq" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "runId" TEXT,
  "materializedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mcp_approval_continuations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mcp_approval_continuations_status_check" CHECK ("status" IN ('pending', 'materialized', 'cancelled')),
  CONSTRAINT "mcp_approval_continuations_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "mcp_approval_continuations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "mcp_approval_continuations_occurrence_key" ON "mcp_approval_continuations" ("messageId", "botId", "serverId", "decisionSeq");
CREATE UNIQUE INDEX "mcp_approval_continuations_runId_key" ON "mcp_approval_continuations" ("runId");
CREATE INDEX "mcp_approval_continuations_status_created_id_idx" ON "mcp_approval_continuations" ("status", "createdAt", "id");
CREATE INDEX "mcp_approval_continuations_owner_thread_bot_status_idx" ON "mcp_approval_continuations" ("spaceId", "userId", "threadId", "botId", "status");

ALTER TABLE "mcp_approval_continuations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_approval_continuations_tenant ON "mcp_approval_continuations"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM "bots" b WHERE b.id = "mcp_approval_continuations"."botId" AND b."spaceId" = "mcp_approval_continuations"."spaceId" AND b."userId" = "mcp_approval_continuations"."userId")
    AND EXISTS (SELECT 1 FROM "messages" m JOIN "threads" t ON t.id = m."threadId" WHERE m.id = "mcp_approval_continuations"."messageId" AND (m."botId" = "mcp_approval_continuations"."botId" OR (m."botId" IS NULL AND t."botId" = "mcp_approval_continuations"."botId")) AND t.id = "mcp_approval_continuations"."threadId" AND t."spaceId" = "mcp_approval_continuations"."spaceId" AND t."userId" = "mcp_approval_continuations"."userId")
    AND EXISTS (SELECT 1 FROM "mcp_servers" s WHERE s.id = "mcp_approval_continuations"."serverId" AND s."userId" = "mcp_approval_continuations"."userId" AND (s."spaceId" = "mcp_approval_continuations"."spaceId" OR s."allSpaces" OR EXISTS (SELECT 1 FROM "mcp_server_spaces" ss WHERE ss."serverId" = s.id AND ss."spaceId" = "mcp_approval_continuations"."spaceId" AND ss."userId" = "mcp_approval_continuations"."userId")))
    AND ("runId" IS NULL OR EXISTS (SELECT 1 FROM "runs" r WHERE r.id = "mcp_approval_continuations"."runId" AND r."spaceId" = "mcp_approval_continuations"."spaceId" AND r."userId" = "mcp_approval_continuations"."userId" AND r."threadId" = "mcp_approval_continuations"."threadId" AND r."botId" = "mcp_approval_continuations"."botId"))
  );
CREATE POLICY mcp_approval_continuations_system ON "mcp_approval_continuations"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_approval_continuations" TO rakazo_app;
  END IF;
END $$;
