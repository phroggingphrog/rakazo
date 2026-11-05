-- Protected run execution remains disabled by runs_protected_execution_disabled.
-- Nullable IDs avoid rewriting or backfilling existing ordinary rows.
-- CUTOVER BLOCKED: protected scopes currently prohibit user/space ID update
-- cascades. Old-worker isolation, protected restore/rotation, and the locking
-- cost of the following unique indexes must be verified before enabling runs.
ALTER TABLE "runs" ADD COLUMN "protectedStorageId" UUID;
ALTER TABLE "external_effects" ADD COLUMN "protectedStorageId" UUID;
ALTER TABLE "runs" ADD CONSTRAINT "runs_protectedStorageId_key" UNIQUE ("protectedStorageId");
ALTER TABLE "external_effects" ADD CONSTRAINT "external_effects_protectedStorageId_key" UNIQUE ("protectedStorageId");
ALTER TABLE "runs" ADD CONSTRAINT "runs_protected_storage_binding_key"
  UNIQUE ("id", "protectedStorageId", "spaceId", "userId", "taskProtected");
ALTER TABLE "external_effects" ADD CONSTRAINT "external_effects_protected_storage_binding_key"
  UNIQUE ("id", "runId", "protectedStorageId");

-- An ID can be assigned once, without affecting ordinary existing rows.
CREATE FUNCTION "prevent_protected_storage_id_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."protectedStorageId" IS NOT NULL AND NEW."protectedStorageId" IS DISTINCT FROM OLD."protectedStorageId" THEN
    RAISE EXCEPTION 'protected storage identity cannot be changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "runs_protected_storage_id_immutable" BEFORE UPDATE OF "protectedStorageId" ON "runs"
  FOR EACH ROW EXECUTE FUNCTION "prevent_protected_storage_id_change"();
CREATE TRIGGER "effects_protected_storage_id_immutable" BEFORE UPDATE OF "protectedStorageId" ON "external_effects"
  FOR EACH ROW EXECUTE FUNCTION "prevent_protected_storage_id_change"();

CREATE TABLE "protected_effect_scopes" (
  "id" TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "runStorageId" UUID NOT NULL UNIQUE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "runProtected" BOOLEAN NOT NULL DEFAULT true CHECK ("runProtected"),
  "keyCiphertext" TEXT NOT NULL CHECK (length("keyCiphertext") <= 1048576 AND "keyCiphertext" ~ '^rkz1:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{38,}$'),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("runId", "runStorageId", "spaceId", "userId", "runProtected")
    REFERENCES "runs"("id", "protectedStorageId", "spaceId", "userId", "taskProtected")
    ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE ("id", "runId", "spaceId", "userId")
);
CREATE FUNCTION "prevent_protected_effect_scope_rebinding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."runStorageId", NEW."spaceId", NEW."userId", NEW."runProtected")
    IS DISTINCT FROM (OLD."id", OLD."runStorageId", OLD."spaceId", OLD."userId", OLD."runProtected") THEN
    RAISE EXCEPTION 'protected effect scope cannot be rebound';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "protected_effect_scope_immutable" BEFORE UPDATE ON "protected_effect_scopes"
  FOR EACH ROW EXECUTE FUNCTION "prevent_protected_effect_scope_rebinding"();

CREATE TABLE "protected_effect_payloads" (
  "id" TEXT PRIMARY KEY,
  "effectId" TEXT NOT NULL UNIQUE,
  "effectStorageId" UUID NOT NULL UNIQUE,
  "scopeId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ciphertext" TEXT NOT NULL CHECK (length("ciphertext") <= 1048576 AND "ciphertext" ~ '^rkz1:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{38,}$'),
  FOREIGN KEY ("effectId", "runId", "effectStorageId")
    REFERENCES "external_effects"("id", "runId", "protectedStorageId") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("scopeId", "runId", "spaceId", "userId")
    REFERENCES "protected_effect_scopes"("id", "runId", "spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE FUNCTION "prevent_protected_effect_payload_rebinding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."effectStorageId", NEW."scopeId", NEW."spaceId", NEW."userId")
    IS DISTINCT FROM (OLD."id", OLD."effectStorageId", OLD."scopeId", OLD."spaceId", OLD."userId") THEN
    RAISE EXCEPTION 'protected effect payload cannot be rebound';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "protected_effect_payload_immutable" BEFORE UPDATE ON "protected_effect_payloads"
  FOR EACH ROW EXECUTE FUNCTION "prevent_protected_effect_payload_rebinding"();

ALTER TABLE "protected_effect_scopes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "protected_effect_payloads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "protected_effect_scopes_owner" ON "protected_effect_scopes"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY "protected_effect_payloads_owner" ON "protected_effect_payloads"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '') AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "protected_effect_scopes", "protected_effect_payloads" TO rakazo_app;
  END IF;
END $$;
