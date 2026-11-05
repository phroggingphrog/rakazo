# Tasks

## 1. Phase 1: provenance and private correction
- [x] 1.1 Additive migration: provenance columns on `memory_facts`, backfilled from the owning document, plus indexes.
- [x] 1.2 Stamp provenance on every fact a commit adds.
- [x] 1.3 `remember` supports `replaces`, `source`, `confidence`; correction supersedes via the existing chain; missing fact is an error.
- [x] 1.4 `learning.share` (`off` | `read` | `read+propose`, default `off`) in the runtime profile contract.
- [x] 1.5 Share-level resolver gated by the per-bot switch; read order constant.
- [x] 1.6 Unit tests and typecheck; migration applied to a restored copy of a production-shaped database before deploy.
- [ ] 1.7 Provision per-bot private semantic banks — blocked: needs a write-capable bank credential (owner decision).

## 2. Phase 2: promotion pipeline
- [ ] 2.1 Collect `read+propose` private facts as learning candidates with provenance.
- [ ] 2.2 Rules engine: precedence, newer-wins validity, dedup, never-promote classes.
- [ ] 2.3 Promotion job writes Space-shared and owner-global facts in Postgres, then mirrors to the shared bank through a write path the owner approves.

## 3. Phase 3: read path and review surface
- [ ] 3.1 Inject private > Space > owner facts with per-level budgets and source labels.
- [ ] 3.2 Review page for promoted and rejected facts; roll out beyond the test bot.

## 4. Phase 4
- [ ] 4.1 Weekly summary of what the bots learned.
