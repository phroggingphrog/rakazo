-- Additive: nullable provenance columns on memory_facts, backfilled from the owning document.
-- Nothing existing is dropped or rewritten; rows written before this migration keep NULL method
-- and confidence, which readers treat as "unknown provenance".
ALTER TABLE "memory_facts" ADD COLUMN "botId" TEXT;
ALTER TABLE "memory_facts" ADD COLUMN "spaceId" TEXT;
ALTER TABLE "memory_facts" ADD COLUMN "scope" TEXT;
ALTER TABLE "memory_facts" ADD COLUMN "bankId" TEXT;
ALTER TABLE "memory_facts" ADD COLUMN "method" TEXT;
ALTER TABLE "memory_facts" ADD COLUMN "confidence" DOUBLE PRECISION;
ALTER TABLE "memory_facts" ADD COLUMN "sourceMessageId" TEXT;

UPDATE "memory_facts" f
SET "botId" = d."botId",
    "spaceId" = d."spaceId",
    "scope" = d."scope",
    "bankId" = CASE WHEN d."botId" IS NOT NULL THEN 'rakazo-bot-' || d."botId" ELSE NULL END
FROM "memory_documents" d
WHERE d."id" = f."documentId" AND f."scope" IS NULL;

CREATE INDEX "memory_facts_botId_invalidFrom_idx" ON "memory_facts"("botId", "invalidFrom");
CREATE INDEX "memory_facts_spaceId_scope_idx" ON "memory_facts"("spaceId", "scope");
