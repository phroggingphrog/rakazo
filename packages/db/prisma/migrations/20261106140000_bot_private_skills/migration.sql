ALTER TABLE "agent_skills"
  ADD COLUMN "ownerBotId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "history" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_ownerBotId_fkey"
  FOREIGN KEY ("ownerBotId") REFERENCES "bots"("id") ON DELETE CASCADE;

DROP INDEX "agent_skills_spaceId_userId_name_lower_key";
CREATE UNIQUE INDEX "agent_skills_spaceId_userId_name_lower_key"
  ON "agent_skills" ("spaceId", "userId", lower("name")) WHERE "ownerBotId" IS NULL;
CREATE UNIQUE INDEX "agent_skills_bot_name_lower_key"
  ON "agent_skills" ("ownerBotId", lower("name")) WHERE "ownerBotId" IS NOT NULL;
CREATE INDEX "agent_skills_ownerBotId_idx" ON "agent_skills" ("ownerBotId");
