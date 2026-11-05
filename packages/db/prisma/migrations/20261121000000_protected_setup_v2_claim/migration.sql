-- A separate protocol gate stays physically disabled until a reviewed cutover migration.
CREATE TABLE "protected_setup_v2_gate" (
  "id" BOOLEAN PRIMARY KEY DEFAULT true CHECK ("id"),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "protected_setup_v2_gate_disabled" CHECK (NOT "enabled")
);
INSERT INTO "protected_setup_v2_gate" ("id", "enabled") VALUES (true, false);
ALTER TABLE "protected_setup_v2_gate" ENABLE ROW LEVEL SECURITY;
CREATE POLICY protected_setup_v2_gate_read ON "protected_setup_v2_gate" FOR SELECT USING (true);
CREATE POLICY protected_setup_v2_gate_system ON "protected_setup_v2_gate" FOR UPDATE
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

-- One non-replayable marker per prepared attempt; this is not a Run or evidence of a read.
CREATE TABLE "protected_setup_v2_claims" (
  "attemptId" TEXT PRIMARY KEY REFERENCES "setup_test_attempts"("id") ON DELETE CASCADE,
  "runId" TEXT UNIQUE REFERENCES "runs"("id") ON DELETE RESTRICT,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "protocol" INTEGER NOT NULL DEFAULT 2 CHECK ("protocol" = 2),
  "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "protected_setup_v2_claims" ENABLE ROW LEVEL SECURITY;
CREATE POLICY protected_setup_v2_claims_tenant ON "protected_setup_v2_claims"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (SELECT 1 FROM setup_test_attempts a WHERE a.id = "protected_setup_v2_claims"."attemptId"
      AND a."spaceId" = "protected_setup_v2_claims"."spaceId" AND a."userId" = "protected_setup_v2_claims"."userId"));
CREATE POLICY protected_setup_v2_claims_system ON "protected_setup_v2_claims"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
CREATE FUNCTION "protected_setup_v2_require_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM protected_setup_v2_gate WHERE id AND enabled) THEN
    RAISE EXCEPTION 'protected setup v2 is disabled';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "protected_setup_v2_claim_gate" BEFORE INSERT OR UPDATE ON "protected_setup_v2_claims"
  FOR EACH ROW EXECUTE FUNCTION "protected_setup_v2_require_gate"();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, UPDATE ON "protected_setup_v2_gate" TO rakazo_app;
    GRANT SELECT, INSERT ON "protected_setup_v2_claims" TO rakazo_app;
  END IF;
END $$;
