-- Additive and inert until the singleton gate is explicitly enabled.
ALTER TABLE "routines" ADD COLUMN "scheduleGeneration" BIGINT NOT NULL DEFAULT 0;
CREATE TABLE "routine_schedule_gate" (
  "id" BOOLEAN NOT NULL DEFAULT true PRIMARY KEY CHECK ("id"),
  "enabled" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "routine_schedule_gate" ("id", "enabled") VALUES (true, false);
CREATE TABLE "routine_schedule_outbox" (
  "routineId" TEXT PRIMARY KEY,
  "generation" BIGINT NOT NULL,
  "publishedGeneration" BIGINT NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL,
  "nextRunAt" TIMESTAMP(3),
  "operation" TEXT NOT NULL CHECK ("operation" IN ('upsert', 'delete')),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "routine_schedule_outbox_updatedAt_routineId_idx" ON "routine_schedule_outbox" ("updatedAt", "routineId");
CREATE INDEX "routine_schedule_outbox_pending_idx" ON "routine_schedule_outbox" ("updatedAt", "routineId") WHERE "publishedGeneration" < "generation";
ALTER TABLE "routine_schedule_gate" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_schedule_gate_system ON "routine_schedule_gate"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
ALTER TABLE "routine_schedule_outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY routine_schedule_outbox_system ON "routine_schedule_outbox"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "routine_schedule_gate", "routine_schedule_outbox" TO rakazo_app;
  END IF;
END $$;

-- The marker fences version compatibility, not access control: database roles can set it.
-- SECURITY DEFINER allows an old tenant writer to cause only its own row's trigger effects.
-- Identifiers are derived from the trigger's actual table schema, not a caller search_path.
CREATE FUNCTION routine_schedule_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE gate_on boolean; changed boolean; prior bigint;
BEGIN
  EXECUTE format('SELECT enabled FROM %I.routine_schedule_gate WHERE id FOR SHARE', TG_TABLE_SCHEMA) INTO gate_on;
  IF gate_on IS NULL THEN
    RAISE EXCEPTION 'routine scheduling gate is unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT gate_on THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."scheduleGeneration" IS DISTINCT FROM OLD."scheduleGeneration" THEN
      RAISE EXCEPTION 'schedule generation is managed by the scheduler' USING ERRCODE = 'P0001';
    END IF;
    -- A wake must not execute a stale prompt, monitor, destination or model
    -- merely because its due time happened to remain the same.
    changed := (NEW.active, NEW."nextRunAt", NEW.crons, NEW.timezone, NEW.watch, NEW."watchState", NEW."lastRunAt", NEW."spaceId", NEW."userId", NEW."botId", NEW."threadId", NEW.prompt, NEW.monitor, NEW.notify, NEW."modelProvider", NEW."modelId", NEW."thinkingLevel") IS DISTINCT FROM
               (OLD.active, OLD."nextRunAt", OLD.crons, OLD.timezone, OLD.watch, OLD."watchState", OLD."lastRunAt", OLD."spaceId", OLD."userId", OLD."botId", OLD."threadId", OLD.prompt, OLD.monitor, OLD.notify, OLD."modelProvider", OLD."modelId", OLD."thinkingLevel");
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  IF current_setting('app.scheduler_protocol', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'scheduler protocol upgrade required' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    EXECUTE format('SELECT generation FROM %I.routine_schedule_outbox WHERE "routineId" = $1 FOR UPDATE', TG_TABLE_SCHEMA) INTO prior USING NEW.id;
    NEW."scheduleGeneration" := coalesce(prior, 0) + 1;
  ELSE
    NEW."scheduleGeneration" := OLD."scheduleGeneration" + 1;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION routine_schedule_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE gate_on boolean; rid text; gen bigint; enabled boolean; due timestamp(3); op text;
BEGIN
  EXECUTE format('SELECT enabled FROM %I.routine_schedule_gate WHERE id', TG_TABLE_SCHEMA) INTO gate_on;
  IF gate_on IS NULL THEN
    RAISE EXCEPTION 'routine scheduling gate is unavailable' USING ERRCODE = 'P0001';
  END IF;
  IF NOT gate_on THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW."scheduleGeneration" = OLD."scheduleGeneration" THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    rid := OLD.id; gen := OLD."scheduleGeneration" + 1; enabled := false; due := NULL; op := 'delete';
  ELSE
    rid := NEW.id; gen := NEW."scheduleGeneration"; enabled := NEW.active; due := NEW."nextRunAt"; op := 'upsert';
  END IF;
  EXECUTE format('INSERT INTO %I.routine_schedule_outbox ("routineId", generation, active, "nextRunAt", operation, "updatedAt") VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) ON CONFLICT ("routineId") DO UPDATE SET generation=excluded.generation, active=excluded.active, "nextRunAt"=excluded."nextRunAt", operation=excluded.operation, "updatedAt"=excluded."updatedAt"', TG_TABLE_SCHEMA)
    USING rid,gen,enabled,due,op;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION routine_schedule_before() FROM PUBLIC;
REVOKE ALL ON FUNCTION routine_schedule_after() FROM PUBLIC;
CREATE TRIGGER routine_schedule_before BEFORE INSERT OR UPDATE OR DELETE ON "routines" FOR EACH ROW EXECUTE FUNCTION routine_schedule_before();
CREATE TRIGGER routine_schedule_after AFTER INSERT OR UPDATE OR DELETE ON "routines" FOR EACH ROW EXECUTE FUNCTION routine_schedule_after();
