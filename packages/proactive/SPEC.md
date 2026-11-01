# Proactive core: contract

Semantics are taken from Pots (pi-durable-bot, MIT, commit 56e9568222d7). This is a reimplementation for Postgres and multiple API instances; no Pots code is used. Each invariant has a conformance test (`src/conformance.ts`) every store must pass.

| # | Invariant |
|---|---|
| I1 | An event is stored before the source is told "received". A repeated (source, id) is a no-op, but still schedules the apply job, because the first delivery may have died between storing and scheduling. |
| I2 | Events of one scope are applied in arrival order. |
| I3 | Events stored but not applied before a crash are applied by `recover()`. |
| I4 | A scope is decided after `debounceMs` of quiet, never later than `debounceMaxMs` after its first undecided event. Each event is in exactly one group. |
| I5 | Decision order: already working (steer) > dm > mention > timer > rules > judge. No judge means the event is only heard. |
| I6 | A judge error never drops events: retries after each `judgeRetryMs` wait, then the target is woken with the error attached. |
| I7 | Wake id is `reason:scope:lastEventId`, recorded in the same step as the decision and before hand-over. |
| I8 | A wake recorded but not confirmed delivered is handed over again with the same id. The target counts one id once. |
| I9 | An effect with send id S reaches the outside at most once: sent -> old result; sending -> `findSent` first; otherwise record, send, record. A sink without `findSent` is refused. |
| I10 | A timer becomes an event, then is marked fired; a crash between the two re-fires it and (source, id) absorbs the repeat. A cancelled timer never fires. One fallback timer per scope is pending while the fallback is on. |

## Deliberate differences from Pots
- No in-memory batches. Debounce state lives in the store and fires through keyed delayed jobs, so any instance can decide a group (Pots keeps batches in a process Map).
- Per-scope ordering comes from a row lock on the scope, not one worker loop.
- Several instances may decide the same group at once. `recordDecision` lets exactly one win; the loser does nothing.

## Ports
`EventSource` (adapter calls `engine.receive`), `Judge`, `WakeTarget`, `EffectSink`; `Scheduler` and `Clock` are infrastructure. The package imports nothing from other `@rakazo/*` packages (`src/independence.test.ts`).
