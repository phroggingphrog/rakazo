-- Additive: new table only, nothing existing is read or changed.
-- memory_documents stays the live document and memory_revisions stays the document history. This
-- table records one row per fact line with the revision that introduced it and the revision that
-- stopped containing it, so a correction invalidates the earlier fact instead of deleting it.

CREATE TABLE "memory_facts" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validFromRevision" INTEGER NOT NULL,
    "invalidFrom" TIMESTAMP(3),
    "invalidFromRevision" INTEGER,
    "supersedesFactId" TEXT,
    "sourceRunId" TEXT,
    "sourceThreadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_facts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_facts_documentId_invalidFrom_idx" ON "memory_facts"("documentId", "invalidFrom");

CREATE INDEX "memory_facts_supersedesFactId_idx" ON "memory_facts"("supersedesFactId");

ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "memory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_facts" ADD CONSTRAINT "memory_facts_supersedesFactId_fkey" FOREIGN KEY ("supersedesFactId") REFERENCES "memory_facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Same policies as memory_revisions (20261021140000_row_level_security): a fact belongs to its
-- document's Space, and only a system-scope job may read across Spaces.
ALTER TABLE "memory_facts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_facts_tenant ON "memory_facts"
  USING (EXISTS (
    SELECT 1 FROM "memory_documents" d
    WHERE d."id" = "memory_facts"."documentId"
      AND d."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY memory_facts_system ON "memory_facts"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "memory_facts" TO rakazo_app;
  END IF;
END $$;
