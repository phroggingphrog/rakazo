-- A historical association, not proof of current access or activation.
CREATE TABLE setup_plan_tests (
  "runId" TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "planId" TEXT NOT NULL REFERENCES setup_plans(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "requestKey" TEXT NOT NULL,
  "planRevision" INTEGER NOT NULL CHECK ("planRevision" > 0),
  "configuredFromRevision" INTEGER NOT NULL CHECK ("configuredFromRevision" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "setup_plan_tests_spaceId_userId_requestKey_key"
  ON setup_plan_tests ("spaceId", "userId", "requestKey");
CREATE INDEX "setup_plan_tests_planId_createdAt_idx" ON setup_plan_tests ("planId", "createdAt");
ALTER TABLE setup_plan_tests ENABLE ROW LEVEL SECURITY;
CREATE POLICY setup_plan_tests_tenant ON setup_plan_tests
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM setup_plans p JOIN runs r ON r.id = setup_plan_tests."runId"
      WHERE p.id = setup_plan_tests."planId" AND p."spaceId" = setup_plan_tests."spaceId"
        AND p."userId" = setup_plan_tests."userId" AND p.status = 'configured'
        AND p.revision = setup_plan_tests."planRevision"
        AND p."configuredFromRevision" = setup_plan_tests."configuredFromRevision"
        AND r."spaceId" = setup_plan_tests."spaceId" AND r."userId" = setup_plan_tests."userId"
        AND r."routineId" = p."routineId"
        AND r."trigger" = 'routine'
        AND r."clientNonce" = 'setup-test:' || setup_plan_tests."userId" || ':' || setup_plan_tests."requestKey"
        AND EXISTS (SELECT 1 FROM external_effects e WHERE e."runId" = r.id
          AND e."spaceId" = r."spaceId" AND e.kind = 'setup_source_test'
          AND e."idempotencyKey" = 'setup-source-test:' || r.id AND e.status = 'intended')
    ));
CREATE POLICY setup_plan_tests_system ON setup_plan_tests
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, DELETE ON setup_plan_tests TO rakazo_app;
  END IF;
END $$;
