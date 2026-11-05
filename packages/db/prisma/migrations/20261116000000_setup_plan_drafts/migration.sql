CREATE TABLE "setup_plans" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "requestPayload" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "status" TEXT NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'proposed')),
  "draft" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "setup_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "setup_plans_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "setup_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "setup_plans_spaceId_userId_requestKey_key" ON "setup_plans"("spaceId", "userId", "requestKey");
CREATE INDEX "setup_plans_spaceId_userId_updatedAt_idx" ON "setup_plans"("spaceId", "userId", "updatedAt");
ALTER TABLE "setup_plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY setup_plans_tenant ON "setup_plans"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY setup_plans_system ON "setup_plans"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
