-- An uncertain effect must be resolved before a mutation can report success.
-- The guard is inert while the scheduler gate is off. A completed attempt does
-- not block later schedule changes; uncertain attempts remain visible.
CREATE FUNCTION routine_watch_mutation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE gate_on boolean; rid text; pending boolean;
BEGIN
  EXECUTE format('SELECT enabled FROM %I.routine_schedule_gate WHERE id FOR SHARE', TG_TABLE_SCHEMA) INTO gate_on;
  IF NOT coalesce(gate_on, false) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN rid := OLD.id; ELSE rid := NEW.id; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.routine_watch_attempts WHERE "routineId" = $1 AND state = ''uncertain'')', TG_TABLE_SCHEMA)
    INTO pending USING rid;
  IF pending THEN
    RAISE EXCEPTION 'routine watch effect is in progress or its outcome is uncertain'
      USING ERRCODE = 'P4770';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION routine_watch_mutation_guard() FROM PUBLIC;
CREATE TRIGGER routine_watch_mutation_guard BEFORE INSERT OR UPDATE OR DELETE ON "routines"
  FOR EACH ROW EXECUTE FUNCTION routine_watch_mutation_guard();
