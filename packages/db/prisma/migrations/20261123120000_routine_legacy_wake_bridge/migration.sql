-- Only bridge-aware Graphile handlers register here; old binaries and memory queues do not.
ALTER TABLE "routine_schedule_gate" ADD COLUMN "legacyOutstanding" BIGINT NOT NULL DEFAULT 0 CHECK ("legacyOutstanding" >= 0);
CREATE TABLE "routine_legacy_wake_admissions" (
  "id" TEXT PRIMARY KEY,
  "routineId" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3) NOT NULL,
  "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "routine_legacy_wake_unsettled_occurrence_idx"
  ON "routine_legacy_wake_admissions" ("routineId", "scheduledFor") WHERE "settledAt" IS NULL;
ALTER TABLE "routine_legacy_wake_admissions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_legacy_wake_system ON "routine_legacy_wake_admissions"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

CREATE FUNCTION routine_legacy_gate_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.enabled AND NOT OLD.enabled AND NEW."legacyOutstanding" <> 0 THEN
    RAISE EXCEPTION 'legacy routine wakes are not settled' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER routine_legacy_gate_guard BEFORE UPDATE OF enabled ON "routine_schedule_gate"
  FOR EACH ROW EXECUTE FUNCTION routine_legacy_gate_guard();

-- The gate row serializes admission with enable, including a concurrent waiting UPDATE.
-- Capture the migration schema as an identifier, never from a caller's search path.
DO $install$
DECLARE target_schema TEXT := current_schema();
BEGIN
  EXECUTE format($definition$
CREATE FUNCTION %1$I.routine_legacy_wake_begin(wake_id TEXT, routine_id TEXT, scheduled_at TIMESTAMPTZ) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I AS $$
DECLARE changed BOOLEAN;
BEGIN
  IF wake_id IS NULL OR wake_id = '' OR routine_id IS NULL OR routine_id = '' OR scheduled_at IS NULL OR NOT isfinite(scheduled_at) THEN
    RAISE EXCEPTION 'invalid legacy routine wake admission';
  END IF;
  UPDATE routine_schedule_gate SET "legacyOutstanding" = "legacyOutstanding" + 1
    WHERE id AND NOT enabled RETURNING true INTO changed;
  IF NOT coalesce(changed, false) THEN
    IF NOT EXISTS (SELECT FROM routine_schedule_gate WHERE id) THEN
      RAISE EXCEPTION 'routine scheduling gate is unavailable' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'legacy routine wakes require cutover recovery' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT FROM routine_legacy_wake_admissions
    WHERE "routineId" = routine_id AND "scheduledFor" = (scheduled_at AT TIME ZONE 'UTC') AND "settledAt" IS NULL) THEN
    RAISE EXCEPTION 'legacy routine wake outcome is uncertain' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO routine_legacy_wake_admissions (id, "routineId", "scheduledFor")
    VALUES (wake_id, routine_id, scheduled_at AT TIME ZONE 'UTC');
END $$;

-- Failure or connection loss leaves the admission open and gate enable blocked.
CREATE FUNCTION %1$I.routine_legacy_wake_finish(wake_id TEXT) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I AS $$
DECLARE remaining BIGINT; settled TEXT;
BEGIN
  SELECT "legacyOutstanding" INTO remaining FROM routine_schedule_gate WHERE id FOR UPDATE;
  IF remaining IS NULL OR remaining < 1 THEN
    RAISE EXCEPTION 'legacy routine wake admission count is unavailable';
  END IF;
  UPDATE routine_legacy_wake_admissions SET "settledAt" = CURRENT_TIMESTAMP
    WHERE id = wake_id AND "settledAt" IS NULL RETURNING id INTO settled;
  IF settled IS NULL THEN RAISE EXCEPTION 'legacy routine wake admission is unavailable'; END IF;
  UPDATE routine_schedule_gate SET "legacyOutstanding" = remaining - 1 WHERE id;
END $$;
$definition$, target_schema);
END $install$;
REVOKE ALL ON FUNCTION routine_legacy_wake_begin(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION routine_legacy_wake_finish(TEXT) FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "routine_schedule_gate" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rakazo_app') THEN
    -- Runtime may toggle the existing gate but cannot directly falsify its counter.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "routine_schedule_gate" FROM rakazo_app;
    GRANT UPDATE (enabled) ON "routine_schedule_gate" TO rakazo_app;
    GRANT EXECUTE ON FUNCTION routine_legacy_wake_begin(TEXT, TEXT, TIMESTAMPTZ), routine_legacy_wake_finish(TEXT) TO rakazo_app;
  END IF;
END $$;
