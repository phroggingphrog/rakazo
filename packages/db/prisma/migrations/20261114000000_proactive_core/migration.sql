-- Additive: new tables only, nothing existing is read or changed.
CREATE TABLE "proactive_inbox" (
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "event" JSONB NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" BIGINT NOT NULL,

    CONSTRAINT "proactive_inbox_pkey" PRIMARY KEY ("source","eventId")
);

CREATE INDEX "proactive_inbox_unapplied_idx" ON "proactive_inbox"("scope", "seq") WHERE NOT "applied";

CREATE TABLE "proactive_events" (
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "event" JSONB NOT NULL,
    "decided" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "proactive_events_pkey" PRIMARY KEY ("source","eventId")
);

CREATE INDEX "proactive_inbox_applied_idx" ON "proactive_inbox"("receivedAt") WHERE "applied";

CREATE INDEX "proactive_events_undecided_idx" ON "proactive_events"("scope", "seq") WHERE NOT "decided";

CREATE TABLE "proactive_scopes" (
    "scope" TEXT NOT NULL,
    "firstAt" BIGINT,
    "lastAt" BIGINT,

    CONSTRAINT "proactive_scopes_pkey" PRIMARY KEY ("scope")
);

CREATE TABLE "proactive_wakes" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "judgeError" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "decidedAt" BIGINT NOT NULL,

    CONSTRAINT "proactive_wakes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "proactive_wakes_pending_idx" ON "proactive_wakes"("decidedAt") WHERE "state" = 'pending';

CREATE TABLE "proactive_effects" (
    "sendId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'sending',
    "result" JSONB,
    "createdAt" BIGINT NOT NULL,

    CONSTRAINT "proactive_effects_pkey" PRIMARY KEY ("sendId")
);

CREATE TABLE "proactive_timers" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "dueAt" BIGINT NOT NULL,
    "note" TEXT NOT NULL,
    "setBy" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "proactive_timers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "proactive_timers_due_idx" ON "proactive_timers"("dueAt") WHERE "state" = 'pending';

-- Rakazo only: these tables hold webhook and wake bodies for every bot. Only system code
-- (the webhook receiver and the worker, both under runAsSystem) reads them, so there is no
-- tenant policy: a tenant-scoped query sees nothing and cannot write.

ALTER TABLE "proactive_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_inbox_system ON "proactive_inbox"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "proactive_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_events_system ON "proactive_events"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "proactive_scopes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_scopes_system ON "proactive_scopes"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "proactive_wakes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_wakes_system ON "proactive_wakes"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "proactive_effects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_effects_system ON "proactive_effects"
  USING (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE "proactive_timers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY proactive_timers_system ON "proactive_timers"
  USING (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "proactive_inbox", "proactive_events", "proactive_scopes", "proactive_wakes", "proactive_effects", "proactive_timers"
      TO rakazo_app;
    GRANT USAGE, SELECT ON SEQUENCE "proactive_inbox_seq_seq" TO rakazo_app;
  END IF;
END $$;
