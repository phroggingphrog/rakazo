import type {
  DeliveryRef,
  EffectResult,
  JudgeInput,
  JudgeResult,
  Millis,
  ProactiveEvent,
  Wake,
} from "./types.js";

/**
 * An adapter turns something outside (a webhook, a mail watcher, a finished job) into
 * `ProactiveEvent`s and calls `engine.receive`. It owns scope and actor naming. The core
 * never pulls from a source, so this is a shape, not a method set.
 */
export type EventSource = (emit: (event: ProactiveEvent) => Promise<void>) => void;

/** Natural-language relevance check. Versioned so a rubric change is visible in records. */
export interface Judge {
  readonly version: string;
  judge(input: JudgeInput): Promise<JudgeResult>;
}

/** A deterministic rule. Return a reason to wake, or null to leave it to the judge. */
export type Rule = (events: ProactiveEvent[]) => { name: string } | null;

/** The thing that gets woken: a Rakazo run, a Pi session, a command. */
export interface WakeTarget {
  readonly name: string;
  /** True while the target is already working on this scope, so new events steer it. */
  isWorking(scope: string): Promise<boolean>;
  /**
   * Hand over a wake. Must count `wake.id` once: a repeat with the same id is the same
   * work. Throw to leave the wake pending for redelivery.
   */
  deliver(wake: Wake): Promise<DeliveryRef>;
  /** What the target is for. Passed to the judge. */
  responsibilities(): Promise<string>;
}

/** The outside world an effect lands in. Both methods are needed for send-once. */
export interface EffectSink {
  readonly name: string;
  send(sendId: string, to: string, payload: unknown): Promise<EffectResult>;
  /** Look the send up on the platform. `undefined` means it never happened. */
  findSent(to: string, sendId: string, since: Millis): Promise<EffectResult | undefined>;
}

/** Delayed, keyed jobs. A repeat with the same key replaces the pending one. */
export interface Scheduler {
  schedule(job: { name: ScheduledJobName; key: string; runAt: Millis }): Promise<void>;
  cancel(key: string): Promise<void>;
}

export type ScheduledJobName = "apply" | "decide" | "redeliver" | "timers";

export interface Clock {
  now(): Millis;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Optional at-rest protection for what the store keeps: event bodies, wake bodies and
 * timer notes. `scope` says whose data it is, so a binding can pick that owner's key and
 * refuse to open it under another scope. `open` must pass unsealed values through, so
 * rows written before sealing was switched on stay readable.
 */
export interface PayloadCodec {
  seal(scope: string, value: unknown): Promise<unknown>;
  open(scope: string, value: unknown): Promise<unknown>;
}
