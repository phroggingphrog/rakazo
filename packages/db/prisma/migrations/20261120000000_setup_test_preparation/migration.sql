-- Prepared tests are non-runnable drafts. The protected Task has no Run.
CREATE TABLE "setup_test_attempts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "planId" TEXT NOT NULL REFERENCES "setup_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "taskId" TEXT,
  "taskProtected" BOOLEAN DEFAULT true,
  "requestKey" TEXT NOT NULL,
  "planRevision" INTEGER NOT NULL CHECK ("planRevision" > 0),
  "status" TEXT NOT NULL DEFAULT 'prepared' CHECK ("status" = 'prepared'),
  "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot") = 'object' AND ("snapshot" - '$sealed') = '{}'::jsonb AND "snapshot" ->> '$sealed' LIKE 'rkz1:%'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "setup_test_attempts_protected_task_check" CHECK (("taskId" IS NULL AND "taskProtected" IS NULL) OR ("taskId" IS NOT NULL AND "taskProtected" IS TRUE)),
  CONSTRAINT "setup_test_attempts_taskId_taskProtected_fkey" FOREIGN KEY ("taskId", "taskProtected")
    REFERENCES "tasks"("id", "protected") ON DELETE SET NULL ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "setup_test_attempts_planId_key" ON "setup_test_attempts"("planId");
CREATE UNIQUE INDEX "setup_test_attempts_taskId_key" ON "setup_test_attempts"("taskId");
CREATE UNIQUE INDEX "setup_test_attempts_taskId_taskProtected_key" ON "setup_test_attempts"("taskId", "taskProtected");
CREATE INDEX "setup_test_attempts_spaceId_userId_idx" ON "setup_test_attempts"("spaceId", "userId");
ALTER TABLE "setup_test_attempts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY setup_test_attempts_tenant ON "setup_test_attempts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM setup_plans p WHERE p.id = "setup_test_attempts"."planId"
      AND p."spaceId" = "setup_test_attempts"."spaceId" AND p."userId" = "setup_test_attempts"."userId")
    AND ("taskId" IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = "setup_test_attempts"."taskId"
      AND t."spaceId" = "setup_test_attempts"."spaceId" AND t."userId" = "setup_test_attempts"."userId" AND t."protected"))
  );
CREATE POLICY setup_test_attempts_system ON "setup_test_attempts"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "setup_test_attempts" TO rakazo_app;
  END IF;
END $$;
