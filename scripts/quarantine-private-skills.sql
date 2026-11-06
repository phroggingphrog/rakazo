-- Run as database owner with ALL app services stopped before an old-image rollback.
-- Kept outside public, with no app grants: old resolvers cannot read private lessons.
BEGIN;
CREATE SCHEMA IF NOT EXISTS skill_rollback;
REVOKE ALL ON SCHEMA skill_rollback FROM PUBLIC;
CREATE TABLE IF NOT EXISTS skill_rollback.agent_skills
  (LIKE public.agent_skills INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE);
CREATE UNIQUE INDEX IF NOT EXISTS quarantined_skill_id ON skill_rollback.agent_skills (id);
CREATE TABLE IF NOT EXISTS skill_rollback.agent_skill_spaces
  (LIKE public.agent_skill_spaces INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE);
CREATE UNIQUE INDEX IF NOT EXISTS quarantined_skill_space ON skill_rollback.agent_skill_spaces ("skillId", "spaceId");
REVOKE ALL ON ALL TABLES IN SCHEMA skill_rollback FROM PUBLIC;
LOCK TABLE public.agent_skills, public.agent_skill_spaces IN ACCESS EXCLUSIVE MODE;
-- A repeated quarantine must not overwrite the only archived copy.
INSERT INTO skill_rollback.agent_skills
  SELECT * FROM public.agent_skills WHERE "ownerBotId" IS NOT NULL;
INSERT INTO skill_rollback.agent_skill_spaces
  SELECT s.* FROM public.agent_skill_spaces s
  JOIN public.agent_skills a ON a.id = s."skillId" WHERE a."ownerBotId" IS NOT NULL;
DELETE FROM public.agent_skills WHERE "ownerBotId" IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.agent_skills WHERE "ownerBotId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Private skill quarantine incomplete';
  END IF;
END $$;
COMMIT;
