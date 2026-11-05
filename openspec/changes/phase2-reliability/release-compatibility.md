# Phase 2 release compatibility checkpoint

Status: candidate source builds locally; not deployed.

## Schema ordering and mixed versions

The initial two migrations add nullable columns only: mcp_servers.authFailureRevision INTEGER and routines.monitor JSONB. Existing rows retain NULL and preserve legacy behavior. Deploy migrations before any new Prisma client starts selecting those fields. Older images ignore the new nullable columns; rolling application rollback retains the additive columns rather than dropping data. Do not activate monitor routines while an older worker can claim them: old workers do not enforce monitor policy. Stop/drain workers through the existing rollout mechanism before switching the shared application image, then verify all workers use the candidate image before enabling monitors.

The auth failure revision is a suppressor tied to the current credential/settings revision, not a permanent account disable. A reconnect/settings update must make the connector eligible again. Existing NULL records retain ordinary connection behavior.

The additional dependency_retries migration creates an identity/revision-scoped operational table with tenant and explicit-system RLS policies. Existing default privileges grant runtime DML. Isolated runtime-role tests confirmed matching-tenant writes, foreign-tenant rejection, and explicit-system visibility. Old workers ignore the circuit table; they must be drained before circuit enforcement is claimed. This migration is additive but is not covered by the earlier two-column production rollback smoke test.

## Verification collected

On 2026-11-04, both exact ALTER TABLE statements executed successfully against the existing database within one transaction with a one-second lock timeout, followed by ROLLBACK. A subsequent information_schema query confirmed neither column remained. This validates existing-table compatibility without applying a release. Separately, all 201 ordered migration SQL files applied to a fresh isolated PostgreSQL 16 database after supplying the _prisma_migrations metadata prerequisite normally created by Prisma; both new columns were verified nullable. The first direct-SQL attempt omitted that prerequisite and failed at the existing RLS migration; a separate fresh database with the prerequisite passed. The isolated container used no network or production volumes and was stopped afterward. This is SQL-sequence evidence, not an end-to-end test of the application migration CLI. Prisma schema validation passed. API and worker artifact builds passed; web production build passed. Shared contracts type checking passed. Full adapter type checking remains unverified due to the proven subprocess memory limit, not a successful compiler result.

## Runtime baseline

Before rollout, existing Compose project rakazo used API/worker image tag a5cdbe430 and web/supervisor tag 57582d4. Record immutable digests and back up deployment configuration through the established deployment procedure before changing them. The source branch is feat/phase2-reliability based on a5cdbe430 with uncommitted Phase 2 changes; do not label an image with the base commit alone as if it identifies those changes.

## Dependency retry implementation checkpoint

The process-local discovery backoff authority has been replaced locally with an additive dependency_retries table, scoped by kind/server/space/user/revision. Conditional claims, expiring tokens, capped jitter and finite budgets persist across instances. Focused connector/helper/health suites passed 118 tests. Actual helper SQL executed against isolated PostgreSQL proved one concurrent winner, expiry fencing, persisted cooldown, identity/revision independence and manual recovery protection against active claims/newer failures. This uses a psql test transport, not the production Prisma binding. All 202 ordered migration SQL files applied in isolation and runtime DML grants were confirmed. Current API/worker builds passed. Full adapter type checking, actual Prisma transport validation, runtime tenant isolation review and rollout remain release gates; do not infer provider-wide circuit coverage or side-effect replay safety from discovery-only coverage.

## Release gates still open

Application migration CLI verification on a fresh database; final patch review including new modules/scripts; complete type-check evidence; existing-stack backup and restore readiness; shared image build with unique revision identity; controlled dependency/interruption scenarios; actual owner-facing authenticated workflow, approval and notification verification; installed iOS check; host scheduler installation; actual observation start record. None is implied by a local build or HTTP 200 response.
