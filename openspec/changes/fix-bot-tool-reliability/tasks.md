## 1. Evidence
- [x] Recheck deployed revisions, health and current bot assignments.
- [x] Classify recent failures without exposing private tool payloads.
- [x] Verify read-only end-to-end access through existing grants.
## 2. Implementation
- [x] Add explicit output truncation metadata and encrypted expiring retrieval.
- [x] Enforce output size, retrieval isolation and lifecycle limits.
- [x] Add bounded no-progress guards with specific recovery messages.
- [x] Add API/worker connection diagnostics with redacted reasons.
## 3. Verification
- [x] Test permissions, missing grants, network errors, output limits, retrieval isolation and redaction.
- [x] Test loops, genuine progress, retry limits and cancellation.
- [x] Run relevant complete suites, type checks and builds.
- [ ] Publish owner-fork branch and PR. Do not deploy.

## 4. Explicit remaining limits
- [ ] Activate Sol low only after the exact model is allowed by the existing connection and an explicit cost budget is configured. Current policy is tested but not wired to execute a model switch.
- [ ] Validate cleanup throughput and database migration against the complete deployment schema before any later release. An isolated PostgreSQL fixture validates the additive table and cross-owner RLS.
