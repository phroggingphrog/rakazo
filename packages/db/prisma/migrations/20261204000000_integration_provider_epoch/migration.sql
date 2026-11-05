BEGIN;

CREATE SEQUENCE "integration_provider_epoch_seq" AS BIGINT NO CYCLE;
CREATE TABLE "integration_provider_epochs" (
  "providerId" TEXT PRIMARY KEY,
  "epoch" BIGINT NOT NULL CHECK ("epoch" > 0),
  CONSTRAINT "integration_provider_epochs_known_provider" CHECK ("providerId" IN ('composio', 'pipedream'))
);

INSERT INTO "integration_provider_epochs" ("providerId", "epoch") VALUES
  ('composio', pg_catalog.nextval('public.integration_provider_epoch_seq'::regclass)),
  ('pipedream', pg_catalog.nextval('public.integration_provider_epoch_seq'::regclass));

CREATE FUNCTION "integration_provider_epoch_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2 OR NEW."providerId" IS DISTINCT FROM OLD."providerId"
     OR NEW."epoch" IS DISTINCT FROM OLD."epoch" THEN
    RAISE EXCEPTION 'Integration provider epoch is database-owned';
  END IF;
  NEW."epoch" := pg_catalog.nextval('public.integration_provider_epoch_seq'::regclass);
  RETURN NEW;
END $$;

CREATE TRIGGER "integration_provider_epoch_guard"
BEFORE UPDATE ON "integration_provider_epochs"
FOR EACH ROW EXECUTE FUNCTION "integration_provider_epoch_guard"();

CREATE FUNCTION "integration_provider_epoch_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Integration provider epoch rows are permanent';
END $$;

CREATE TRIGGER "integration_provider_epoch_immutable"
BEFORE INSERT OR DELETE OR TRUNCATE ON "integration_provider_epochs"
FOR EACH STATEMENT EXECUTE FUNCTION "integration_provider_epoch_immutable"();

CREATE FUNCTION "integration_provider_config_epoch"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  provider_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.ciphertext) IS NOT DISTINCT FROM
                            ROW(OLD.id, OLD.ciphertext) THEN
    RETURN NEW;
  END IF;

  FOR provider_id IN
    SELECT p.id FROM (VALUES
      (CASE WHEN TG_OP <> 'INSERT' THEN OLD.id ELSE NULL END),
      (CASE WHEN TG_OP <> 'DELETE' THEN NEW.id ELSE NULL END)
    ) AS p(id)
    WHERE p.id IN ('composio', 'pipedream')
    GROUP BY p.id ORDER BY p.id
  LOOP
    UPDATE public."integration_provider_epochs" SET "providerId" = "providerId"
      WHERE "providerId" = provider_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Integration provider epoch is unavailable';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "integration_provider_config_epoch"
AFTER INSERT OR UPDATE OR DELETE ON "integration_provider_configs"
FOR EACH ROW EXECUTE FUNCTION "integration_provider_config_epoch"();

REVOKE ALL ON TABLE "integration_provider_epochs" FROM PUBLIC;
REVOKE ALL ON SEQUENCE "integration_provider_epoch_seq" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rakazo_app') THEN
    REVOKE ALL ON TABLE "integration_provider_epochs" FROM rakazo_app;
    REVOKE ALL ON SEQUENCE "integration_provider_epoch_seq" FROM rakazo_app;
    GRANT SELECT, UPDATE ("providerId") ON "integration_provider_epochs" TO rakazo_app;
    GRANT USAGE ON SEQUENCE "integration_provider_epoch_seq" TO rakazo_app;
  END IF;
END $$;

COMMIT;
