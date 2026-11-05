ALTER TABLE "local_effect_rejections"
  DROP CONSTRAINT "local_effect_rejections_reason_check";
ALTER TABLE "local_effect_rejections"
  ADD CONSTRAINT "local_effect_rejections_reason_check"
  CHECK ("reason" IN ('invalid_screen_action', 'invalid_shared_memory', 'computer_unavailable', 'stdio_mcp_forbidden', 'instruction_precondition_failed'));

DROP POLICY local_effect_rejections_owner ON "local_effect_rejections";
CREATE POLICY local_effect_rejections_owner ON "local_effect_rejections"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM external_effects e JOIN runs r ON r.id = e."runId"
      WHERE e.id = "local_effect_rejections"."effectId" AND e."runId" = "local_effect_rejections"."runId"
      AND e."spaceId" = "local_effect_rejections"."spaceId" AND e.status = 'failed'
      AND (("local_effect_rejections".reason = 'invalid_screen_action' AND e.kind = 'user_computer_act')
        OR ("local_effect_rejections".reason = 'invalid_shared_memory' AND e.kind = 'save_shared_memory')
        OR ("local_effect_rejections".reason = 'computer_unavailable' AND e.kind IN ('user_computer_shell', 'user_computer_act', 'user_computer_observe'))
        OR ("local_effect_rejections".reason = 'stdio_mcp_forbidden' AND e.kind = 'add_mcp_server')
        OR ("local_effect_rejections".reason = 'instruction_precondition_failed' AND e.kind = 'update_bot'))
      AND r."spaceId" = "local_effect_rejections"."spaceId" AND r."userId" = "local_effect_rejections"."userId")
  );
