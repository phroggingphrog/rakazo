-- Legacy clients see only this benign prompt. Protected routines cannot be enabled.
ALTER TABLE "routines" ADD COLUMN "protected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "routines" ADD CONSTRAINT "routines_protected_inactive_check" CHECK (
  NOT "protected" OR (NOT "active" AND "prompt" = 'Protected setup purpose; this routine cannot run until protected execution is available.')
);
CREATE UNIQUE INDEX "routines_id_protected_key" ON "routines" ("id", "protected");

-- A legacy test run defaults to the unprotected generation. This composite FK
-- also prevents a concurrent conversion from racing a test-run insertion.
-- Historical dangling routine references are preserved as with the old FK.
ALTER TABLE "runs" ADD COLUMN "routineProtected" BOOLEAN DEFAULT false;
ALTER TABLE "runs" ADD CONSTRAINT "runs_protected_routine_disabled" CHECK (
  "routineId" IS NULL OR "routineProtected" IS NOT DISTINCT FROM false
);
ALTER TABLE "runs" ADD CONSTRAINT "runs_routineId_routineProtected_fkey"
  FOREIGN KEY ("routineId", "routineProtected") REFERENCES "routines" ("id", "protected")
  ON DELETE SET NULL ON UPDATE RESTRICT NOT VALID;

-- Sensitive text belongs in an owner-scoped table, not the space-visible routine row.
CREATE TABLE "protected_execution_content" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "protected" BOOLEAN NOT NULL DEFAULT true CHECK ("protected"),
  "routineId" TEXT UNIQUE,
  "taskId" TEXT UNIQUE,
  "text" TEXT NOT NULL CHECK ("text" LIKE 'rkz1:%'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "protected_execution_content_routine_fkey" FOREIGN KEY ("routineId", "protected")
    REFERENCES "routines"("id", "protected") ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT "protected_execution_content_no_task_yet" CHECK ("routineId" IS NOT NULL AND "taskId" IS NULL)
);
CREATE UNIQUE INDEX "protected_execution_content_routineId_protected_key" ON "protected_execution_content" ("routineId", "protected");
CREATE UNIQUE INDEX "protected_execution_content_taskId_protected_key" ON "protected_execution_content" ("taskId", "protected");
CREATE INDEX "protected_execution_content_spaceId_userId_idx" ON "protected_execution_content" ("spaceId", "userId");
ALTER TABLE "protected_execution_content" ENABLE ROW LEVEL SECURITY;
CREATE POLICY protected_execution_content_tenant ON "protected_execution_content"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (
    "spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM routines r WHERE r.id = "protected_execution_content"."routineId"
      AND r."spaceId" = "protected_execution_content"."spaceId" AND r."userId" = "protected_execution_content"."userId" AND r."protected")
  );
CREATE POLICY protected_execution_content_system ON "protected_execution_content"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "protected_execution_content" TO rakazo_app;
  END IF;
END $$;

ALTER TABLE "setup_plans" ADD COLUMN "routineId" TEXT;
ALTER TABLE "setup_plans" ADD COLUMN "configureRequestKey" TEXT;
ALTER TABLE "setup_plans" ADD COLUMN "configuredFromRevision" INTEGER;
ALTER TABLE "setup_plans" DROP CONSTRAINT "setup_plans_status_check";
ALTER TABLE "setup_plans" ADD CONSTRAINT "setup_plans_status_check" CHECK ("status" IN ('draft', 'proposed', 'configured'));
ALTER TABLE "setup_plans" ADD CONSTRAINT "setup_plans_configure_state_check" CHECK (
  ("status" = 'configured' AND "configureRequestKey" IS NOT NULL AND "configuredFromRevision" IS NOT NULL)
  OR ("status" <> 'configured' AND "routineId" IS NULL AND "configureRequestKey" IS NULL AND "configuredFromRevision" IS NULL)
);
ALTER TABLE "setup_plans" ADD CONSTRAINT "setup_plans_routineId_fkey"
  FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "setup_plans_routineId_key" ON "setup_plans"("routineId");
DROP POLICY setup_plans_tenant ON "setup_plans";
CREATE POLICY setup_plans_tenant ON "setup_plans"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND ("routineId" IS NULL OR EXISTS (SELECT 1 FROM routines r WHERE r.id = "setup_plans"."routineId"
      AND r."spaceId" = "setup_plans"."spaceId" AND r."userId" = "setup_plans"."userId" AND r."protected")));

CREATE FUNCTION "reject_unready_protected_routine_run"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."routineId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM routines r WHERE r.id = NEW."routineId" AND r."protected"
  ) THEN
    RAISE EXCEPTION 'Protected setup execution is not available yet.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "runs_protected_routine_guard" BEFORE INSERT OR UPDATE OF "routineId" ON "runs"
  FOR EACH ROW EXECUTE FUNCTION "reject_unready_protected_routine_run"();
