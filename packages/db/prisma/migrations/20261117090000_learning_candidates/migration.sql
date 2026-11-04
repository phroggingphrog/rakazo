-- Additive: two new tables. No existing table, column or index is changed, and nothing
-- reads either table unless a bot's stored profile asks for reviews and the collector flag is on.
-- learning_candidates holds one row per lesson waiting for a review; learning_reviews holds one row
-- per completed review, so the unique (botId, day, slot) key is both the cross-process claim and the
-- per-day cap the learning policy sets.

CREATE TABLE "learning_candidates" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "sourceThreadId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "learning_reviews" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "slot" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "rubricVersion" TEXT NOT NULL,
    "outcome" JSONB NOT NULL DEFAULT '{}',
    "tokensSpent" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learning_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "learning_candidates_botId_dedupeKey_key" ON "learning_candidates"("botId", "dedupeKey");
CREATE INDEX "learning_candidates_botId_status_createdAt_idx" ON "learning_candidates"("botId", "status", "createdAt");
CREATE INDEX "learning_candidates_spaceId_createdAt_idx" ON "learning_candidates"("spaceId", "createdAt");
CREATE UNIQUE INDEX "learning_reviews_botId_day_slot_key" ON "learning_reviews"("botId", "day", "slot");
CREATE INDEX "learning_reviews_botId_createdAt_idx" ON "learning_reviews"("botId", "createdAt");

ALTER TABLE "learning_candidates" ADD CONSTRAINT "learning_candidates_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "learning_reviews" ADD CONSTRAINT "learning_reviews_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Both tables are tenant data: a Space reaches only its own candidates and reviews.
ALTER TABLE "learning_candidates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY learning_candidates_tenant ON "learning_candidates"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY learning_candidates_system ON "learning_candidates"
  USING (current_setting('app.rls_bypass', true) = 'on');

-- A review carries no Space of its own; it belongs to its bot's Space.
ALTER TABLE "learning_reviews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY learning_reviews_tenant ON "learning_reviews"
  USING (EXISTS (
    SELECT 1 FROM "bots" b
    WHERE b."id" = "learning_reviews"."botId"
      AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY learning_reviews_system ON "learning_reviews"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "learning_candidates", "learning_reviews" TO rakazo_app;
  END IF;
END $$;
