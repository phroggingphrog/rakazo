-- Provenance is separate: old binaries still see the effect as failed.
CREATE TABLE "local_effect_rejections" (
  "effectId" TEXT PRIMARY KEY REFERENCES "external_effects"("id") ON DELETE CASCADE,
  "runId" TEXT NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "reason" TEXT NOT NULL CHECK ("reason" IN ('invalid_screen_action', 'invalid_shared_memory', 'computer_unavailable')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "local_effect_rejections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY local_effect_rejections_owner ON "local_effect_rejections"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM external_effects e JOIN runs r ON r.id = e."runId"
      WHERE e.id = "local_effect_rejections"."effectId" AND e."runId" = "local_effect_rejections"."runId"
      AND e."spaceId" = "local_effect_rejections"."spaceId" AND e.status = 'failed'
      AND (("local_effect_rejections".reason = 'invalid_screen_action' AND e.kind = 'user_computer_act')
        OR ("local_effect_rejections".reason = 'invalid_shared_memory' AND e.kind = 'save_shared_memory')
        OR ("local_effect_rejections".reason = 'computer_unavailable' AND e.kind IN ('user_computer_shell', 'user_computer_act', 'user_computer_observe')))
      AND r."spaceId" = "local_effect_rejections"."spaceId" AND r."userId" = "local_effect_rejections"."userId")
  );
CREATE POLICY local_effect_rejections_system ON "local_effect_rejections"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT ON "local_effect_rejections" TO rakazo_app;
  END IF;
END $$;
