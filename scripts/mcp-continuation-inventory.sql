-- Read-only snapshot only. Stop and verify every API/worker process separately.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Fail rather than return a tenant-filtered partial inventory.
SET LOCAL row_security = off;
WITH intents AS (
  SELECT c.status AS intent_status, c."runId" AS run_id, r.id AS found_run_id,
         r.status AS run_status
  FROM mcp_approval_continuations c
  LEFT JOIN runs r ON r.id = c."runId"
), jobs AS (
  SELECT j.locked_at, j.key,
         NULLIF(j.payload->>'runId', '') AS direct_run_id,
         NULLIF(j.payload->'payload'->>'runId', '') AS nested_run_id
  FROM graphile_worker._private_jobs j
  JOIN graphile_worker._private_tasks t ON t.id = j.task_id
  WHERE t.identifier IN ('run.continue', 'run.interactive')
), job_ids AS (
  SELECT locked_at, key, direct_run_id, nested_run_id,
         COALESCE(direct_run_id, nested_run_id) AS run_id,
         direct_run_id IS NOT NULL AND nested_run_id IS NOT NULL
           AND direct_run_id <> nested_run_id AS conflicting_ids
  FROM jobs
), accounted_jobs AS (
  SELECT j.*, r.id AS found_run_id, c."runId" AS linked_run_id
  FROM job_ids j
  LEFT JOIN runs r ON r.id = j.run_id
  LEFT JOIN mcp_approval_continuations c ON c."runId" = j.run_id
)
SELECT json_build_object(
  'fleet_drain', 'not_verified',
  'pending_intents', (SELECT count(*) FROM intents WHERE intent_status = 'pending'),
  'all_nonterminal_runs', (SELECT count(*) FROM runs WHERE status NOT IN ('completed', 'failed', 'cancelled')),
  'all_run_jobs', (SELECT count(*) FROM jobs),
  'locked_run_jobs', (SELECT count(*) FROM jobs WHERE locked_at IS NOT NULL),
  'unkeyed_run_jobs', (SELECT count(*) FROM jobs WHERE key IS NULL),
  'materialized_missing_run', (SELECT count(*) FROM intents WHERE intent_status = 'materialized' AND found_run_id IS NULL),
  'nonterminal_linked_runs', (SELECT count(*) FROM intents WHERE found_run_id IS NOT NULL AND run_status NOT IN ('completed', 'failed', 'cancelled')),
  'unexpected_linked_intents', (SELECT count(*) FROM intents WHERE intent_status <> 'materialized' AND run_id IS NOT NULL),
  'linked_jobs', (SELECT count(*) FROM accounted_jobs WHERE linked_run_id IS NOT NULL),
  'locked_linked_jobs', (SELECT count(*) FROM accounted_jobs WHERE linked_run_id IS NOT NULL AND locked_at IS NOT NULL),
  'unattributable_run_jobs', (SELECT count(*) FROM accounted_jobs WHERE run_id IS NULL OR conflicting_ids OR found_run_id IS NULL),
  'snapshot_scope', 'database_only'
)::text;
COMMIT;
