BEGIN;

CREATE SEQUENCE "installed_capability_generation_seq" AS BIGINT NO CYCLE;

ALTER TABLE "capability_installs" ADD COLUMN "sourceGeneration" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "capability_install_spaces" ADD COLUMN "availabilityGeneration" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "secrets" ADD COLUMN "credentialGeneration" BIGINT NOT NULL DEFAULT 0;

UPDATE "capability_installs" SET "sourceGeneration" = pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
UPDATE "capability_install_spaces" SET "availabilityGeneration" = pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
UPDATE "secrets" SET "credentialGeneration" = pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);

CREATE FUNCTION "installed_source_generation_before"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."sourceGeneration" := pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
  ELSE
    IF NEW."sourceGeneration" IS DISTINCT FROM OLD."sourceGeneration" THEN
      RAISE EXCEPTION 'Installed source generation is database-owned';
    END IF;
    IF ROW(NEW.id, NEW."spaceId", NEW."userId", NEW.kind, NEW.name, NEW.source,
           NEW.version, NEW.digest, NEW."secretId", NEW.config, NEW."allSpaces")
       IS DISTINCT FROM
       ROW(OLD.id, OLD."spaceId", OLD."userId", OLD.kind, OLD.name, OLD.source,
           OLD.version, OLD.digest, OLD."secretId", OLD.config, OLD."allSpaces") THEN
      NEW."sourceGeneration" := pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "installed_source_generation_before"
BEFORE INSERT OR UPDATE ON "capability_installs"
FOR EACH ROW EXECUTE FUNCTION "installed_source_generation_before"();

CREATE FUNCTION "installed_space_generation_before"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."availabilityGeneration" := pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
  ELSE
    IF NEW."availabilityGeneration" IS DISTINCT FROM OLD."availabilityGeneration" THEN
      RAISE EXCEPTION 'Installed space generation is database-owned';
    END IF;
    IF ROW(NEW."installId", NEW."spaceId", NEW."userId") IS DISTINCT FROM
       ROW(OLD."installId", OLD."spaceId", OLD."userId") THEN
      NEW."availabilityGeneration" := pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "installed_space_generation_before"
BEFORE INSERT OR UPDATE ON "capability_install_spaces"
FOR EACH ROW EXECUTE FUNCTION "installed_space_generation_before"();

CREATE FUNCTION "installed_secret_generation_before"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."credentialGeneration" := pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
  ELSE
    IF NEW."credentialGeneration" IS DISTINCT FROM OLD."credentialGeneration" THEN
      RAISE EXCEPTION 'Secret credential generation is database-owned';
    END IF;
    IF ROW(NEW.id, NEW."userId", NEW."spaceId", NEW.kind, NEW.ciphertext) IS DISTINCT FROM
       ROW(OLD.id, OLD."userId", OLD."spaceId", OLD.kind, OLD.ciphertext) THEN
      NEW."credentialGeneration" := pg_catalog.nextval('public.installed_capability_generation_seq'::regclass);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "installed_secret_generation_before"
BEFORE INSERT OR UPDATE ON "secrets"
FOR EACH ROW EXECUTE FUNCTION "installed_secret_generation_before"();

ALTER TABLE "capability_installs" ADD CONSTRAINT "installed_source_generation_positive"
  CHECK ("sourceGeneration" > 0);
ALTER TABLE "capability_install_spaces" ADD CONSTRAINT "installed_space_generation_positive"
  CHECK ("availabilityGeneration" > 0);
ALTER TABLE "secrets" ADD CONSTRAINT "installed_secret_generation_positive"
  CHECK ("credentialGeneration" > 0);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT USAGE ON SEQUENCE "installed_capability_generation_seq" TO rakazo_app;
  END IF;
END $$;

COMMIT;
