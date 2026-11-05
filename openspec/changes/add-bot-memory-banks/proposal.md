# Proposal: per-bot memory with gated promotion to a shared bank

## Why
Bots should remember on their own initiative, and what one bot learns should eventually help the others and the owner's wider assistant setup. Letting every bot write straight into one shared semantic bank causes conflicting, unattributed and unrevokable facts.

## What changes
- Each bot owns a private memory level (its explicit memory documents plus a logical private bank id) and writes to it freely.
- A shared, owner-global semantic bank is read by bots but is never written by them directly. Rakazo contributes to it only through the gated path: private fact -> learning candidate -> rules-based promotion job -> shared bank. Other systems that already own that bank keep their native write path.
- A Space-shared level sits between private and owner-global.
- Every fact carries provenance (bot, Space, level, bank, run/thread/message, time, method, confidence).
- `remember` can correct a fact; the old fact is superseded and kept, never deleted.
- A per-bot `learning.share` setting (`off` | `read` | `read+propose`), default `off`, behind the existing per-bot self-config switch.

## Phase 1 (this change's first slice)
Provenance columns (additive, backfilled), `remember` supersede, the `learning.share` setting, the share-level resolver and read order constant. No promotion to the shared bank yet and no bank provisioning.

## Out of scope
Credentials, access policy and any change that would grant Rakazo write access to the shared bank.
