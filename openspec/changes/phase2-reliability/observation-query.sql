-- Run through the existing PostgreSQL administration path, using psql variables
-- window_start and window_end (ISO timestamps with explicit offsets), and
-- ON_ERROR_STOP=1. Each result is a current snapshot of a creation cohort.
-- Aggregate operational ledger only: completed is NOT destination verification.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Refuse reversed/empty windows and timestamps without explicit UTC offsets.
SELECT (
  :'window_start' ~* '[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
   AND :'window_end' ~* '[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
   AND :'window_start'::timestamptz < :'window_end'::timestamptz
) AS valid_window \gset
\if :valid_window
\else
\warn Invalid observation window: use increasing timestamps with explicit UTC offsets.
SELECT 1 / 0;
\endif

SELECT status, trigger, count(*) AS runs
FROM runs
WHERE "createdAt" >= (:'window_start'::timestamptz AT TIME ZONE 'UTC')
  AND "createdAt" < (:'window_end'::timestamptz AT TIME ZONE 'UTC')
GROUP BY status, trigger ORDER BY trigger, status;

SELECT count(*) AS runs_in_creation_cohort,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM external_effects e
              WHERE e."runId" = r.id AND e.status IN ('failed', 'uncertain', 'executing')))
         AS runs_with_unresolved_effects
FROM runs r
WHERE r."createdAt" >= (:'window_start'::timestamptz AT TIME ZONE 'UTC')
  AND r."createdAt" < (:'window_end'::timestamptz AT TIME ZONE 'UTC');

SELECT count(*) AS completed_ledger_runs_in_creation_cohort,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM external_effects e
              WHERE e."runId" = r.id AND e.status IN ('failed', 'uncertain', 'executing')))
         AS completed_runs_with_unresolved_effects
FROM runs r
WHERE r."createdAt" >= (:'window_start'::timestamptz AT TIME ZONE 'UTC')
  AND r."createdAt" < (:'window_end'::timestamptz AT TIME ZONE 'UTC')
  AND r.status = 'completed';

-- A provider receipt is separate evidence; neither status proves device display.
SELECT status, coalesce("receiptStatus", 'not_recorded') AS receipt_observation,
       count(*) AS notification_intents
FROM routine_notification_intents
WHERE "createdAt" >= (:'window_start'::timestamptz AT TIME ZONE 'UTC')
  AND "createdAt" < (:'window_end'::timestamptz AT TIME ZONE 'UTC')
GROUP BY status, "receiptStatus" ORDER BY status, "receiptStatus";
COMMIT;
