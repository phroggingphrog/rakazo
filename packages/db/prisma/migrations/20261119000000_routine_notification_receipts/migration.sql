-- Only a provider ticket and a one-way token digest are retained, never push content or tokens.
ALTER TABLE "routine_notification_intents"
  ADD COLUMN "receiptTicketId" TEXT,
  ADD COLUMN "receiptTokenDigest" TEXT,
  ADD COLUMN "receiptStatus" TEXT,
  ADD COLUMN "receiptCheckAt" TIMESTAMP(3),
  ADD COLUMN "receiptExpiresAt" TIMESTAMP(3),
  ADD CONSTRAINT "routine_notification_receipt_status_check"
    CHECK ("receiptStatus" IS NULL OR "receiptStatus" IN ('pending', 'ok', 'device_not_registered', 'error', 'unavailable')),
  ADD CONSTRAINT "routine_notification_receipt_pending_check"
    CHECK ("receiptStatus" IS DISTINCT FROM 'pending' OR (
      "status" = 'accepted' AND "receiptTicketId" IS NOT NULL AND "receiptTokenDigest" IS NOT NULL
      AND "receiptCheckAt" IS NOT NULL AND "receiptExpiresAt" IS NOT NULL
    ));
CREATE INDEX "routine_notification_intents_receiptStatus_receiptCheckAt_idx"
  ON "routine_notification_intents" ("receiptStatus", "receiptCheckAt");
