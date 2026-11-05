# Durable discovery circuit implementation scope

Status: design checkpoint; not implemented. Continues approved task 2.2, not a replacement executor.

## Existing behavior to preserve

Run setup retry budgets derive from persisted attempts and schedule Run.wakeAt plus the existing queue job. Busy/database waits do not consume provider failure budget. MCP sessions and concurrent connection coalescing remain local optimizations. Typed authentication failures retain revision-scoped intervention semantics. Never automatically replay a side-effecting MCP call.

## Durable identity and state

Use an additive PostgreSQL record unique to dependency kind/id plus launch space/user identity. Store settings revision, failure count, next attempt timestamp, finite-budget exhaustion, half-open claim token/expiry and update timestamp. Store only sanitized reason codes, never tool content, credentials or raw error text. A server-only key incorrectly merges launch identities.

## State transitions

A conditional database claim admits at most one probe for the same identity after cooldown. Claim expiry permits crash recovery. Successful or failed completion must match claim token and settings revision; stale completion cannot clear or reopen newer state. Transient failures use capped exponential delay with bounded jitter and finite budget. Authentication, cancellation and installation-in-progress do not consume transient budget. Exhaustion requests intervention instead of polling forever. Settings revision change resets eligibility; an explicit successful manual probe can recover the matching identity/revision. Database policy failures must fail closed, unlike best-effort display-health writes.

## Integration and compatibility

Replace discoveryBackoff Map as policy authority in McpConnector discovery, not the connector or executor architecture. Retain local cache only if it cannot override database denial. Apply additive migration before candidate clients start and drain old workers before enabling circuits, because older workers ignore the table. Do not claim provider-wide retry coverage unless each provider boundary is separately wired.

## Acceptance evidence required

Deterministic clock/random tests cover delay caps, jitter, exhaustion, distinct identities, revision reset, stale completion, claim expiry and non-transient exclusion. Connector tests cover recreated instances, two instances sharing state, half-open single winner, manual recovery and no mutation replay. Real isolated PostgreSQL concurrency tests must prove conditional claims; mocks are not sufficient. Verify migration against populated baseline and old-code/new-schema overlap. Full affected type checks remain a release gate.
