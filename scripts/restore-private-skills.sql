-- Run as database owner with ALL app services stopped, only for an ownership-aware image.
-- Conflicts (including deleted owners) fail atomically; never discard an archived lesson.
BEGIN;
LOCK TABLE public.agent_skills, public.agent_skill_spaces IN ACCESS EXCLUSIVE MODE;
INSERT INTO public.agent_skills SELECT * FROM skill_rollback.agent_skills;
INSERT INTO public.agent_skill_spaces SELECT * FROM skill_rollback.agent_skill_spaces;
-- Archive is emptied only after every row and link is successfully restored.
DELETE FROM skill_rollback.agent_skill_spaces;
DELETE FROM skill_rollback.agent_skills;
COMMIT;
