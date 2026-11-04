CREATE TABLE setup_plans (
  id TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "requestKey" TEXT NOT NULL,
  "requestPayload" JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','proposed','configured')),
  draft JSONB NOT NULL,
  "routineId" TEXT REFERENCES routines(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "configureRequestKey" TEXT,
  "configuredFromRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT setup_plans_configure_state_check CHECK (
    (status = 'configured' AND "configureRequestKey" IS NOT NULL AND "configuredFromRevision" IS NOT NULL)
    OR (status <> 'configured' AND "routineId" IS NULL AND "configureRequestKey" IS NULL AND "configuredFromRevision" IS NULL)
  )
);
CREATE UNIQUE INDEX "setup_plans_spaceId_userId_requestKey_key" ON setup_plans("spaceId","userId","requestKey");
CREATE UNIQUE INDEX "setup_plans_routineId_key" ON setup_plans("routineId");
CREATE INDEX "setup_plans_spaceId_userId_updatedAt_idx" ON setup_plans("spaceId","userId","updatedAt");
ALTER TABLE setup_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY setup_plans_tenant ON setup_plans
  USING ("spaceId" = NULLIF(current_setting('app.space_id',true),'') AND "userId" = NULLIF(current_setting('app.user_id',true),''))
  WITH CHECK ("spaceId" = NULLIF(current_setting('app.space_id',true),'') AND "userId" = NULLIF(current_setting('app.user_id',true),'')
    AND ("routineId" IS NULL OR EXISTS (SELECT 1 FROM routines r WHERE r.id=setup_plans."routineId"
      AND r."spaceId"=setup_plans."spaceId" AND r."userId"=setup_plans."userId")));
CREATE POLICY setup_plans_system ON setup_plans
  USING (current_setting('app.rls_bypass',true)='on')
  WITH CHECK (current_setting('app.rls_bypass',true)='on');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON setup_plans TO rakazo_app;
  END IF;
END $$;
