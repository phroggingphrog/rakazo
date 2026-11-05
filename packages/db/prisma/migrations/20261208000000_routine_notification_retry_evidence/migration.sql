-- Keep every previous status valid during a mixed-version rollout and rollback.
-- Older workers ignore the two terminal evidence statuses until an owner retries.
ALTER TABLE "routine_notification_intents"
  DROP CONSTRAINT "routine_notification_intents_status_check",
  ADD CONSTRAINT "routine_notification_intents_status_check"
    CHECK ("status" IN (
      'pending', 'preparing', 'submitting', 'accepted', 'undeliverable',
      'uncertain', 'cancelled', 'blocked', 'no_recipient', 'device_rejected'
    )) NOT VALID;

-- All existing rows satisfied the narrower constraint, but validate explicitly.
ALTER TABLE "routine_notification_intents"
  VALIDATE CONSTRAINT "routine_notification_intents_status_check";
