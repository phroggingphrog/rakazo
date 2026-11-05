# Design

## Levels
| Level | Written by | Read by |
|---|---|---|
| bot (private) | the bot, freely | that bot |
| space (shared) | promotion job only | bots in the Space with share >= read |
| owner (global) | promotion job only (Rakazo); the bank's native owner systems | bots with share >= read |

Postgres `memory_facts` is the record of truth. Semantic banks are search copies that can be rebuilt from it, so there are never two stores each claiming to be right.

## Provenance
`memory_facts` gains nullable `botId`, `spaceId`, `scope`, `bankId`, `method` (owner-stated | tool-observed | bot-inferred), `confidence` (0..1) and `sourceMessageId`, alongside the existing `sourceRunId`/`sourceThreadId` and validity columns. The migration is additive and backfills bot, Space, level and bank id from the owning document; legacy rows keep NULL method/confidence meaning unknown.

The private bank id is logical (`rakazo-bot-<botId>`). Provisioning a real per-bot semantic bank is a later phase and needs a write-capable bank credential that the current read-only gateway does not have; that is an owner decision, not something this change works around.

## Conflict rules (promotion, phase 2+)
1. Source precedence: owner-stated > tool-observed > bot-inferred.
2. Equal precedence: newer wins; the older fact gets `invalidFrom`, keeping a validity range.
3. Replaced facts are invalidated, never deleted (existing supersede chain).
4. Entity dedup before promotion: exact text first, then normalised entity keys.
5. Never promoted: credentials, health, finance, facts about third parties.
6. Promotion runs automatically under these rules; no per-fact owner approval.

## Read path
Private, then Space-shared, then owner-global, each with its own budget. Facts from other bots are labelled with their source and treated as information, never as instructions.

## Switches
`learning.share` defaults to `off`. The effective level is `off` unless the bot is on the existing per-bot self-config switch AND its profile opts in. No level writes to a shared bank directly; `read+propose` only feeds learning candidates.

## remember supersede
`remember` accepts `replaces` (exact text of an existing fact), `source` and `confidence`. With `replaces`, the line is replaced and saved through the normal commit, which invalidates the old fact and links the new one via `supersedesFactId`. If the quoted fact is absent the tool returns an error instead of appending. Supersede is offered only to bots on the per-bot switch; others keep append-only behaviour.
