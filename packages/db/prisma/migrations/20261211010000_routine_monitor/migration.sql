-- TASK-484 additive foundation (after live head 20261210040000). Replaces deferred snapshot migration(s) 20261104021000; never apply those.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "monitor" JSONB;
