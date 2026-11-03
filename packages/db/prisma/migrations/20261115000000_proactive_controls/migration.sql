CREATE TABLE "proactive_controls" (
  "scope" TEXT PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "config" JSONB NOT NULL DEFAULT '{}',
  "day" TEXT NOT NULL DEFAULT '',
  "wakeCount" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE "proactive_control_audit" (
  "id" BIGSERIAL PRIMARY KEY,
  "scope" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "at" BIGINT NOT NULL,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "details" JSONB NOT NULL
);
CREATE INDEX "proactive_control_audit_scope_idx" ON "proactive_control_audit" ("scope", "id");
ALTER TABLE "proactive_controls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_controls_system ON "proactive_controls"
  USING (current_setting('app.rls_bypass', true) = 'on');
ALTER TABLE "proactive_control_audit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_control_audit_system ON "proactive_control_audit"
  USING (current_setting('app.rls_bypass', true) = 'on');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "proactive_controls", "proactive_control_audit" TO rakazo_app;
    GRANT USAGE, SELECT ON SEQUENCE "proactive_control_audit_id_seq" TO rakazo_app;
  END IF;
END $$;
