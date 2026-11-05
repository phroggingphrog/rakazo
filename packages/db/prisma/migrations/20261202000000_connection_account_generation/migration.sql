BEGIN;

CREATE SEQUENCE "connection_account_generation_seq" AS BIGINT NO CYCLE;
ALTER TABLE "connections" ADD COLUMN "accountGeneration" BIGINT NOT NULL DEFAULT 0;
UPDATE "connections"
SET "accountGeneration" = pg_catalog.nextval('public.connection_account_generation_seq'::regclass);

CREATE FUNCTION "connection_account_generation_before"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."accountGeneration" := pg_catalog.nextval('public.connection_account_generation_seq'::regclass);
    RETURN NEW;
  END IF;

  IF NEW."accountGeneration" IS DISTINCT FROM OLD."accountGeneration" THEN
    RAISE EXCEPTION 'Connection account generation is database-owned';
  END IF;

  IF ROW(NEW.id, NEW."spaceId", NEW."userId", NEW."connectorId", NEW.provider,
         NEW.status, NEW."secretId", NEW."providerRef", NEW.metadata)
     IS DISTINCT FROM
     ROW(OLD.id, OLD."spaceId", OLD."userId", OLD."connectorId", OLD.provider,
         OLD.status, OLD."secretId", OLD."providerRef", OLD.metadata) THEN
    NEW."accountGeneration" := pg_catalog.nextval('public.connection_account_generation_seq'::regclass);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "connection_account_generation_before"
BEFORE INSERT OR UPDATE ON "connections"
FOR EACH ROW EXECUTE FUNCTION "connection_account_generation_before"();

ALTER TABLE "connections" ADD CONSTRAINT "connection_account_generation_positive"
CHECK ("accountGeneration" > 0);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT USAGE ON SEQUENCE "connection_account_generation_seq" TO rakazo_app;
  END IF;
END $$;

COMMIT;
