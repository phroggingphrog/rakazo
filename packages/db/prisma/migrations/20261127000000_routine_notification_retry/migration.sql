-- Existing pending intents remain immediately eligible and keep their original state.
ALTER TABLE "routine_notification_intents"
  ADD COLUMN "preSubmitFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextPreSubmitAttemptAt" TIMESTAMP(3),
  DROP CONSTRAINT "routine_notification_intents_status_check",
  ADD CONSTRAINT "routine_notification_intents_status_check"
    CHECK ("status" IN ('pending', 'preparing', 'submitting', 'accepted', 'undeliverable', 'uncertain', 'cancelled', 'blocked')),
  ADD CONSTRAINT "routine_notification_pre_submit_failures_check"
    CHECK ("preSubmitFailures" BETWEEN 0 AND 5),
  ADD CONSTRAINT "routine_notification_preparing_claim_check"
    CHECK ("status" <> 'preparing' OR ("claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL));

CREATE INDEX "routine_notification_intents_pending_retry_idx"
  ON "routine_notification_intents" ("nextPreSubmitAttemptAt", "createdAt", "id")
  WHERE "status" = 'pending';
