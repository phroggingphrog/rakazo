import type {
  Decision,
  EffectRecord,
  EffectResult,
  Millis,
  ProactiveEvent,
  PruneCounts,
  TimerRecord,
  Wake,
} from "./types.js";

export type ClaimResult =
  | { kind: "none" }
  | { kind: "early"; dueAt: Millis }
  | { kind: "group"; events: ProactiveEvent[] };

export interface StoredWake {
  wake: Wake;
  state: "pending" | "delivered";
  decidedAt: Millis;
}

/**
 * Durable state behind the engine. Every method is one atomic step: a crash between two
 * calls leaves a state the engine's sweeps can finish. Implementations must pass the
 * conformance suite.
 */
export interface ProactiveStore {
  /** Store an event. "duplicate" when (source, id) was already stored. */
  receive(event: ProactiveEvent, now: Millis): Promise<"new" | "duplicate">;
  /** Scopes that have stored events not yet applied. */
  unappliedScopes(limit: number): Promise<string[]>;
  /**
   * Apply this scope's stored events in arrival order. Returns how many were applied and
   * when the scope's group falls due.
   */
  applyScope(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<{ applied: number; dueAt: Millis | null }>;
  /** Take the scope's undecided events if they are due, without deciding them. */
  claimGroup(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<ClaimResult>;
  /**
   * Record the decision for exactly these events. False when another worker already
   * decided any of them. A wake is stored pending, in the same step.
   */
  recordDecision(
    scope: string,
    events: ProactiveEvent[],
    decision: Decision,
    now: Millis,
  ): Promise<{ recorded: false } | { recorded: true; wake?: Wake }>;
  markDelivered(wakeId: string): Promise<void>;
  /** Wakes recorded before `before` and not yet marked delivered. */
  pendingWakes(before: Millis, limit: number): Promise<Wake[]>;
  /** Scopes that still hold undecided, applied events. */
  scopesWithUndecided(limit: number): Promise<string[]>;
  getWake(wakeId: string): Promise<StoredWake | undefined>;

  effectGet(sendId: string): Promise<EffectRecord | undefined>;
  /** Insert a `sending` record, or return the one that exists. */
  effectBegin(
    sendId: string,
    to: string,
    payload: unknown,
    now: Millis,
  ): Promise<{ created: boolean; record: EffectRecord }>;
  effectDone(sendId: string, result: EffectResult): Promise<void>;

  timerSet(timer: Omit<TimerRecord, "state">): Promise<"set" | "exists">;
  timerCancel(id: string): Promise<boolean>;
  timersDue(now: Millis, limit: number): Promise<TimerRecord[]>;
  timerMarkFired(id: string): Promise<void>;
  timerGet(id: string): Promise<TimerRecord | undefined>;
  nextTimerDue(): Promise<Millis | null>;
  /** True when this scope has a pending timer whose id starts with the prefix. */
  hasPendingTimer(scope: string, idPrefix: string): Promise<boolean>;

  /**
   * Delete finished work older than `before`: decided events with their inbox rows,
   * delivered wakes, fired or cancelled timers, sent effects. Undecided work stays.
   */
  prune(before: Millis): Promise<PruneCounts>;
  /** Scopes that hold any row, in scope order, for sweeps. Pass the last one as `after`. */
  knownScopes(limit: number, after?: string): Promise<string[]>;
  /** Delete every event, wake and timer of a scope (its owner is gone). */
  deleteScope(scope: string): Promise<void>;
}
