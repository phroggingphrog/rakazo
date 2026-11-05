-- A claim records that a watch effect may have started. It never authorizes a retry.
CREATE TABLE "routine_watch_attempts" (
  "routineId" TEXT NOT NULL,
  "generation" BIGINT NOT NULL CHECK ("generation" > 0),
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'uncertain' CHECK ("state" IN ('uncertain', 'completed')),
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("routineId", "generation")
);
CREATE INDEX "routine_watch_attempts_claimedAt_routineId_generation_idx"
  ON "routine_watch_attempts" ("claimedAt", "routineId", "generation");
ALTER TABLE "routine_watch_attempts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_watch_attempts_system ON "routine_watch_attempts"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE ("state") ON "routine_watch_attempts" TO rakazo_app;
  END IF;
END $$;
