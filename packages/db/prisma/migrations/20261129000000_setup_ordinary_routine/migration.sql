-- Setup may link an ordinary routine owned by the same user and space.
-- Legacy protected routines remain readable and keep their existing guards.
ALTER POLICY setup_plans_tenant ON setup_plans
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND ("routineId" IS NULL OR EXISTS (
      SELECT 1 FROM routines r WHERE r.id = setup_plans."routineId"
        AND r."spaceId" = setup_plans."spaceId" AND r."userId" = setup_plans."userId"
    ))
  );
