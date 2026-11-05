## Context
TASK-468 follows merged SQLite support in TASK-455. Reuse the existing Postgres runtime for Rakazo; SQLite remains for later BC-250 deployment.

## Decisions
Use provider-neutral Judge with a Jev adapter reusing TYPESAFE_API_KEY. Missing credentials leave judge disabled; errors remain retry then wake, not success. Default policy preserves steer, dm, mention, timer, rules, judge ordering. Owners control reordering. Bot tools derive tenant and bot identity from trusted execution context. Self-set wakes have a five-minute minimum and twenty-per-day cap. Persist config revisions and audits; reset restores defaults. Arm two-hour fallback on enable/startup. Sent feedback is heard-only to prevent loops. Check platform reconciliation before promising send-once. Inspection and 67 existing messaging tests confirm the outbox claims pending rows as sent before platform submission and retains the claim after accepted-send bookkeeping failures. Do not add a second ledger. This is at-most-once attempt semantics: process death before submission may lose delivery, and there is no platform findSent reconciliation or exactly-once guarantee.

## Non-goals
No mail watcher, BC-250 model deployment, new services, or production rollout.

## Verification
Offline deterministic adapter/core/tool tests cover judge errors, tenant isolation, timers, quotas, reset, sent-loop prevention and unchanged defaults. Existing stack remains untouched.
