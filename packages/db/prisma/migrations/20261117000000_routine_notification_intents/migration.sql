-- Additive outbox; notification content remains in the protected message row.
CREATE TABLE "routine_notification_intents" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "messageId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "routine_notification_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "routine_notification_intents_status_check" CHECK ("status" IN ('pending', 'submitting', 'accepted', 'undeliverable', 'uncertain', 'cancelled', 'blocked')),
  CONSTRAINT "routine_notification_intents_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "routine_notification_intents_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "routine_notification_intents_runId_key" ON "routine_notification_intents"("runId");
CREATE UNIQUE INDEX "routine_notification_intents_messageId_key" ON "routine_notification_intents"("messageId");
CREATE INDEX "routine_notification_intents_status_updatedAt_idx" ON "routine_notification_intents"("status", "updatedAt");
CREATE INDEX "routine_notification_intents_spaceId_userId_idx" ON "routine_notification_intents"("spaceId", "userId");

ALTER TABLE "routine_notification_intents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_notification_intents_tenant ON "routine_notification_intents"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = "routine_notification_intents"."runId" AND r."spaceId" = "routine_notification_intents"."spaceId" AND r."userId" = "routine_notification_intents"."userId")
    AND ("messageId" IS NULL OR EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = "routine_notification_intents"."messageId" AND m."runId" = "routine_notification_intents"."runId"))
  );
CREATE POLICY routine_notification_intents_system ON "routine_notification_intents"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "routine_notification_intents" TO rakazo_app;
  END IF;
END $$;
