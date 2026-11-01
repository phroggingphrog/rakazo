import type { Clock, EffectSink, Judge, Rule, Scheduler, WakeTarget } from "./ports.js";
import { systemClock } from "./ports.js";
import type { ProactiveStore } from "./store.js";
import {
  DEFAULT_CONFIG,
  type Decision,
  type EffectResult,
  type Millis,
  type ProactiveConfig,
  type ProactiveEvent,
  type Wake,
} from "./types.js";

export interface EngineOptions {
  store: ProactiveStore;
  scheduler: Scheduler;
  target: WakeTarget;
  judge?: Judge;
  rules?: Rule[];
  clock?: Clock;
  config?: Partial<ProactiveConfig>;
  /** Called for errors the engine absorbs so a sweep can go on. */
  onError?: (where: string, error: unknown) => void;
}

const SWEEP_LIMIT = 100;

/**
 * The proactive core. Every public method is safe to call from any instance, any number
 * of times: state lives in the store, timing lives in the scheduler.
 */
export class ProactiveEngine {
  private readonly store: ProactiveStore;
  private readonly scheduler: Scheduler;
  private readonly target: WakeTarget;
  private readonly judge?: Judge;
  private readonly rules: Rule[];
  private readonly clock: Clock;
  readonly config: ProactiveConfig;
  private readonly onError: (where: string, error: unknown) => void;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.scheduler = options.scheduler;
    this.target = options.target;
    this.judge = options.judge;
    this.rules = options.rules ?? [];
    this.clock = options.clock ?? systemClock;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * Store, then tell the source it may acknowledge. A repeat still schedules the apply job:
   * the first delivery may have died after storing and before scheduling.
   */
  async receive(event: ProactiveEvent): Promise<{ duplicate: boolean }> {
    const outcome = await this.store.receive(event, this.clock.now());
    // The event is durable. If scheduling fails, `recover` finds it later.
    await this.scheduler
      .schedule({ name: "apply", key: `apply:${event.scope}`, runAt: this.clock.now() })
      .catch((e) => this.onError("schedule apply", e));
    return { duplicate: outcome === "duplicate" };
  }

  /** Job handler: apply a scope's stored events and schedule its decision. */
  async apply(scope: string): Promise<void> {
    const { applied, dueAt } = await this.store.applyScope(
      scope,
      this.clock.now(),
      this.config.debounceMs,
      this.config.debounceMaxMs,
    );
    if (applied > 0 && dueAt !== null) await this.scheduleDecide(scope, dueAt);
  }

  private scheduleDecide(scope: string, runAt: Millis): Promise<void> {
    return this.scheduler.schedule({ name: "decide", key: `decide:${scope}`, runAt });
  }

  /** Job handler: decide a scope's due group, then hand the wake over. */
  async decide(scope: string): Promise<void> {
    const now = this.clock.now();
    const claim = await this.store.claimGroup(
      scope,
      now,
      this.config.debounceMs,
      this.config.debounceMaxMs,
    );
    if (claim.kind === "none") return;
    if (claim.kind === "early") return this.scheduleDecide(scope, claim.dueAt);

    const decision = await this.policy(scope, claim.events);
    const recorded = await this.store.recordDecision(
      scope,
      claim.events,
      decision,
      this.clock.now(),
    );
    if (!recorded.recorded) return; // another worker decided these events
    if (recorded.wake) await this.deliver(recorded.wake);
    // Events that arrived while we were deciding form the next group.
    const more = await this.store.claimGroup(
      scope,
      this.clock.now(),
      this.config.debounceMs,
      this.config.debounceMaxMs,
    );
    if (more.kind === "early") await this.scheduleDecide(scope, more.dueAt);
    else if (more.kind === "group") await this.scheduleDecide(scope, this.clock.now());
  }

  /** steer > addressed > rules > judge. A judge failure never drops events. */
  async policy(scope: string, events: ProactiveEvent[]): Promise<Decision> {
    if (await this.target.isWorking(scope)) return { kind: "wake", reason: "steer" };
    const dm = events.find((e) => e.addressed === "dm");
    if (dm) return { kind: "wake", reason: "dm" };
    if (events.some((e) => e.addressed === "mention")) return { kind: "wake", reason: "mention" };
    if (events.some((e) => e.kind === "timer")) return { kind: "wake", reason: "timer" };
    for (const rule of this.rules) {
      const hit = rule(events);
      if (hit) return { kind: "wake", reason: `rule:${hit.name}` };
    }
    if (!this.judge) return { kind: "drop", reason: "heard" };

    const responsibilities = await this.target.responsibilities();
    let lastError: unknown;
    const attempts = this.config.judgeRetryMs.length + 1;
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await this.judge.judge({ scope, events, responsibilities });
        return result.probability >= this.config.judgeThreshold
          ? { kind: "wake", reason: "relevant" }
          : { kind: "drop", reason: "judge_no" };
      } catch (error) {
        lastError = error;
        const wait = this.config.judgeRetryMs[i];
        if (wait !== undefined) await this.clock.sleep(wait);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return { kind: "wake", reason: "relevant", judgeError: message };
  }

  private async deliver(wake: Wake): Promise<void> {
    try {
      await this.target.deliver(wake);
    } catch (error) {
      // Left pending: `redeliver` hands it over again with the same id.
      this.onError("deliver", error);
      await this.scheduler
        .schedule({
          name: "redeliver",
          key: "redeliver",
          runAt: this.clock.now() + this.config.redeliverAfterMs,
        })
        .catch((e) => this.onError("schedule redeliver", e));
      return;
    }
    await this.store.markDelivered(wake.id);
  }

  /** Sweep: hand over wakes recorded but never confirmed delivered. */
  async redeliver(): Promise<number> {
    const wakes = await this.store.pendingWakes(
      this.clock.now() - this.config.redeliverAfterMs,
      SWEEP_LIMIT,
    );
    for (const wake of wakes) await this.deliver(wake);
    return wakes.length;
  }

  /** Sweep: apply and decide whatever a crash left behind. */
  async recover(): Promise<void> {
    for (const scope of await this.store.unappliedScopes(SWEEP_LIMIT)) await this.apply(scope);
    for (const scope of await this.store.scopesWithUndecided(SWEEP_LIMIT)) {
      await this.scheduleDecide(scope, this.clock.now());
    }
  }

  // --- timers ---------------------------------------------------------------------

  async setTimer(timer: {
    id: string;
    scope: string;
    dueAt: Millis;
    note: string;
    setBy: string;
  }): Promise<void> {
    const outcome = await this.store.timerSet(timer);
    if (outcome === "set") await this.armTimerJob();
  }

  async cancelTimer(id: string): Promise<boolean> {
    return this.store.timerCancel(id);
  }

  private async armTimerJob(): Promise<void> {
    const next = await this.store.nextTimerDue();
    if (next !== null)
      await this.scheduler.schedule({ name: "timers", key: "timers", runAt: next });
  }

  /**
   * Job handler: fire due timers. A timer becomes an event first and is marked fired after,
   * so a crash in between fires it again and the event's (source, id) key absorbs the repeat.
   */
  async fireTimers(): Promise<number> {
    const due = await this.store.timersDue(this.clock.now(), SWEEP_LIMIT);
    for (const timer of due) {
      const isFallback = timer.id.startsWith("fallback:");
      await this.receive({
        source: "timer",
        id: timer.id,
        kind: "timer",
        at: timer.dueAt,
        scope: timer.scope,
        text: timer.note,
        raw: { setBy: timer.setBy },
      });
      await this.store.timerMarkFired(timer.id);
      if (isFallback) await this.ensureFallback(timer.scope);
    }
    await this.armTimerJob();
    return due.length;
  }

  /** Keep one fallback timer pending for the scope. No-op when it is off or already there. */
  async ensureFallback(scope: string): Promise<void> {
    if (this.config.fallbackMs <= 0) return;
    if (await this.store.hasPendingTimer(scope, "fallback:")) return;
    const dueAt = this.clock.now() + this.config.fallbackMs;
    await this.setTimer({
      id: `fallback:${scope}:${dueAt}`,
      scope,
      dueAt,
      note: "fallback patrol",
      setBy: "engine",
    });
  }

  // --- effects --------------------------------------------------------------------

  /**
   * Send once. sent -> old result; sending -> ask the platform first; otherwise record,
   * send, record. The sink must be able to find a send by its id.
   */
  async sendEffect(
    sink: EffectSink,
    sendId: string,
    to: string,
    payload: unknown,
  ): Promise<EffectResult> {
    if (typeof sink.findSent !== "function") {
      throw new Error(`Sink ${sink.name} cannot find a send by id, so it cannot send once`);
    }
    const existing = await this.store.effectGet(sendId);
    if (existing?.state === "sent") return existing.result ?? {};
    const { created, record } = await this.store.effectBegin(sendId, to, payload, this.clock.now());
    if (!created) {
      if (record.state === "sent") return record.result ?? {};
      const found = await sink.findSent(to, sendId, record.createdAt);
      if (found) {
        await this.store.effectDone(sendId, found);
        return found;
      }
    }
    const result = await sink.send(sendId, to, payload);
    await this.store.effectDone(sendId, result);
    return result;
  }
}
