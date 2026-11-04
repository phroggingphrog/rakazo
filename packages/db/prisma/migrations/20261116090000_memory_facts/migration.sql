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
