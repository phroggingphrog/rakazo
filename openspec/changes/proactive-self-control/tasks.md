## Implementation
- [x] 1. Verify working state and outgoing delivery reconciliation risks.
- [x] 2. Implement and wire opt-in Jev judge with deterministic tests.
- [x] 3. Persist versioned per-bot configuration, audit and reset.
- [x] 4. Expose bot wake/timer/cancel/hook tools with limits and trusted identity.
- [x] 5. Arm fallback on startup/enable and feed sent events without loops.
- [x] 6. Resolve delivery ambiguity using existing primitives where possible: existing outbox claims before send and never reclaims accepted rows; retain at-most-once attempt semantics, not exactly-once delivery.
- [x] 7. Finish offline release qualification: adapter/API/worker/core/contracts typechecks pass in isolated transient 4 GiB build services. Scoped behavior tests and isolated real-PostgreSQL controls tests pass. Fixed the API test unauthenticated context to explicitly use actor: null. Evidence and rollout/undo handoff recorded on TASK-468.
- [ ] 8. Separate deployment phase (not authorized by this implementation objective): approve a test bot, release one pinned image through the existing stack, and verify a real-model wake and timer through its owner-facing entry point. No production deployment performed.
