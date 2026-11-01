# @rakazo/proactive

A mechanism for bots that act on events instead of waiting to be messaged. It stores events safely, groups bursts, decides whether to wake the bot, hands over each wake once, fires timers, and sends effects once. It knows nothing about Rakazo, Slack or any model: sources, targets and sinks plug in through four small ports. The semantics come from Pots (pi-durable-bot); see [SPEC.md](SPEC.md) for the ten invariants every store and binding must keep.

## How an event travels

```
adapter --receive--> inbox (stored, deduped) --apply--> ordered events per scope
   --debounce--> policy (steer > dm > mention > timer > rules > judge)
   --> wake recorded (id = reason:scope:lastEventId) --deliver--> target
```

Every step is a keyed delayed job (`Scheduler`), so any API or worker instance can run it, and a crash leaves state the sweeps (`recover`, `redeliver`, `fireTimers`) finish.

## Ports

| Port | You write | Rule |
| --- | --- | --- |
| source | a function that calls `engine.receive(event)` | `(source, id)` must be unique and stable across retries |
| `WakeTarget` | `deliver(wake)` | count `wake.id` once; throw to be retried |
| `Judge` | `judge(input)` | optional; any error wakes the target anyway |
| `EffectSink` | `send`, `findSent` | `findSent` must answer "did this send id happen?" |
| `ProactiveStore` | only if you need another database | must pass `runConformance` |

`scope` is a string you choose. Everything in one scope is ordered and decided together, so put the tenant in it (Rakazo uses `bot:<botId>`).

## Write an adapter

```ts
const engine = new ProactiveEngine({ store, scheduler, target, judge });
await engine.receive({
  source: "my-source", id: deliveryId, kind: "message", at: Date.now(),
  scope: "bot:abc", text: "deploy failed", addressed: "mention",
});
```

Register the four job handlers (`apply`, `decide`, `redeliver`, `timers`) with whatever runs your jobs. Rakazo does this in `packages/adapters/src/proactive.ts`.

## Tests

- `pnpm --filter @rakazo/proactive test` runs the conformance suite on the in-memory store (no database).
- Set `PROACTIVE_TEST_DATABASE_URL` to also run it on Postgres. Each test gets its own schema.
- A new store or binding calls `runConformance(label, open)` from `src/conformance.ts`.

## Turning it on in Rakazo

`PROACTIVE_WEBHOOK_BOTS=<botId>[,<botId>]` (or `*`) on the API and worker. Unlisted bots keep the direct path. Each step logs one line (`proactive received|applied|decided|delivered`) with ids and counts, never message text; search a wake id to see its whole path.

Roll out in this order: one test bot with a test webhook; read the `decided` lines for a week; add real bots. The model judge (`LlmJudge`) is not wired to a model in Rakazo yet, so judged sources do not exist there; webhooks are addressed and always wake.

## Known limits

- Order across restarts is the order events were stored, not the order they were sent.
- A deleted or archived bot's wake is dropped as delivered.
- `HttpIdempotentSink` is exactly-once only if the receiver honors `Idempotency-Key`.
