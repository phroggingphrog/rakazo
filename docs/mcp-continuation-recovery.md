# MCP approval continuation recovery

The continuation scan hold preserves pending approval continuations; it does not
stop a run already materialized from one. Normal queued-run recovery, Graphile,
and direct in-process dispatch can still execute that run. The hold takes effect
only after all API and worker processes have started with
`MCP_APPROVAL_CONTINUATION_SCAN_ENABLED=false`.

A release containing the continuation schema must use a rollback image that
understands that schema and its message-specific card decisions. Earlier images
are not rollback targets. Do not disable a worker or change an image until a
specific deployment and rollback procedure has been verified for that stack.

To inspect a stopped stack, run the following from a checkout containing this
release's SQL. Replace the container name as appropriate. It uses the existing
Postgres container, requires a database role that can inspect all tenants, and
prints aggregate counts only:

```sh
docker exec -i rakazo-postgres-1 sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/mcp-continuation-inventory.sql
```

A SQL error, including a missing Graphile schema or insufficient access, means
that the snapshot is unavailable. The command deliberately fails rather than
reporting counts filtered by row-level security. Check its exit status.

Before treating the snapshot as evidence, stop **all** API and worker processes,
including other replicas and direct in-process run starters, and independently
verify they have stopped. The snapshot is not a fleet stop check and cannot
prove that a disconnected executor or provider operation has finished. Keep the
stack stopped while collecting it and assessing the result.

Any nonzero `all_nonterminal_runs` or `all_run_jobs` needs investigation and
accounting. A deleted approval or continuation can leave a run or job whose
origin can no longer be linked, so this snapshot cannot safely classify an
existing unlinked run job as unrelated. Require all nonterminal runs and run
jobs to be drained or otherwise individually accounted for before proceeding.
`locked_run_jobs` and `unkeyed_run_jobs` identify jobs that need particular
attention; a database lock alone does not prove that its worker is still alive.

Any nonzero `nonterminal_linked_runs`, `materialized_missing_run`,
`unexpected_linked_intents`, `linked_jobs`, or `unattributable_run_jobs` needs
investigation before a rollback can be considered drained. The last count covers
run jobs with missing, conflicting or orphaned run IDs, including jobs unrelated
to approval continuations whose origin cannot be established by this snapshot.
`linked_jobs` includes locked, unlocked, and detached jobs for both Graphile run
task names. A failed or exhausted job remains a job and must be accounted for;
this command does not remove or retry it. Even zero counts do not prove all
external work has stopped or make an older image compatible.

Pending intents are expected to remain stored under the hold. Their later
resume requires starting an approval-aware image with the scan enabled after
reviewing any held work. Do not replay an uncertain external effect merely to
clear an inventory count.
