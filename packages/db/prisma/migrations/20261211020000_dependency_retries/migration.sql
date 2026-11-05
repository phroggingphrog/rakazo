-- TASK-484 additive foundation (after live head 20261210040000). Replaces deferred snapshot migration(s) 20261104022000; never apply those.
CREATE TABLE "dependency_retries" (
  "kind" TEXT NOT NULL,
  "dependencyId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "exhausted" BOOLEAN NOT NULL DEFAULT false,
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "reasonCode" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dependency_retries_pkey" PRIMARY KEY ("kind", "dependencyId", "spaceId", "userId", "revision")
);
ALTER TABLE "dependency_retries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dependency_retries_tenant ON "dependency_retries"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dependency_retries_system ON "dependency_retries"
  USING (current_setting('app.rls_bypass', true) = 'on');
