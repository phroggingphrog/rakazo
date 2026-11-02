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

## Data at rest

- `PgProactiveStore(executor, codec?)`: with a `PayloadCodec` the event, wake and timer-note bodies are sealed before they are written and opened on read; ids, scopes, timestamps and states stay readable. Without one they are plain JSON.
- Rakazo passes `RakazoPayloadCodec`: the owning bot's space key and the same `rkz1:` cipher as message content, bound to the bot so a body copied under another bot fails to open. `CONTENT_ENCRYPTION=off` stores plaintext, as for messages.
- The six tables have row-level security with a system-only policy: tenant contexts read and write nothing; the webhook receiver and the worker run `runAsSystem`.
- `engine.prune()` deletes finished work older than `retentionMs` (30 days; 0 keeps everything). A repeat of a pruned event id is accepted as new, so keep the window longer than any sender retries.
- Rakazo runs `maintain()` from the reconciler once an hour: prune, then `forgetScope` for every `bot:<id>` whose bot is gone (bot, space or account deletion). Rows of a deleted bot can live up to an hour.

## Known limits

- Effect payloads and results (`proactive_effects`) are not sealed and have no scope, so deleting a bot does not remove them. Rakazo writes no effects yet; seal them before wiring a sink.
- If a bot is deleted while its rows are still there, jobs for that scope cannot open the sealed bodies and fail until the next hourly sweep removes them.

- Order across restarts is the order events were stored, not the order they were sent.
- A deleted or archived bot's wake is dropped as delivered.
- `HttpIdempotentSink` is exactly-once only if the receiver honors `Idempotency-Key`.
