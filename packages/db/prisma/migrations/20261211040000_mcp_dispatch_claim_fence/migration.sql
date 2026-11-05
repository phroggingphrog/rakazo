-- TASK-484 additive foundation (after live head 20261210040000). Replaces deferred snapshot migration(s) 20261130000000+20261201000000; never apply those.
-- Drain old workers before enabling tokenized MCP dispatch: they do not enforce this token.
ALTER TABLE "external_effects" ADD COLUMN IF NOT EXISTS "dispatchClaimToken" TEXT;
ALTER TABLE "external_effects" ADD COLUMN IF NOT EXISTS "dispatchClaimFence" INTEGER;
