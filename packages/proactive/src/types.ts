/** Milliseconds since the epoch. Every time in this package is a plain number so tests can fake it. */
export type Millis = number;

/** What an adapter hands the core. `scope` and `actor` are opaque strings the adapter owns. */
export interface ProactiveEvent {
  /** Names the adapter, e.g. "webhook", "timer". Part of the dedupe key. */
  source: string;
  /** Unique within `source`. A repeated id is a no-op. */
  id: string;
  kind: string;
  at: Millis;
  /** Events of one scope are applied in arrival order and decided as one group. */
  scope: string;
  actor?: string;
  text?: string;
  /** Set when the event is aimed at the bot. Skips the judge. */
  addressed?: "dm" | "mention";
  /** Adapter payload, kept verbatim for the target. */
  raw?: unknown;
}

export type WakeReason = "steer" | "dm" | "mention" | "timer" | "relevant" | `rule:${string}`;

export type DropReason = "heard" | "judge_no";

export interface Wake {
  /** `reason:scope:lastEventId`. Recorded before hand-over, so a repeat counts once. */
  id: string;
  scope: string;
  reason: WakeReason;
  events: ProactiveEvent[];
  /** Set when the judge failed and the wake went out anyway. */
  judgeError?: string;
}

export type Decision =
  | { kind: "wake"; reason: WakeReason; judgeError?: string }
  | { kind: "drop"; reason: DropReason };

export interface DeliveryRef {
  /** Whatever the target uses to find the work again, e.g. a run id. */
  ref: string;
}

export interface JudgeInput {
  scope: string;
  events: ProactiveEvent[];
  responsibilities: string;
}

export interface JudgeResult {
  /** 0..1 probability that the bot should act. */
  probability: number;
}

export interface EffectResult {
  /** Platform id of what was sent, if any. */
  externalId?: string;
}

export type EffectState = "sending" | "sent";

export interface EffectRecord {
  sendId: string;
  to: string;
  payload: unknown;
  state: EffectState;
  result?: EffectResult;
  createdAt: Millis;
}

export interface TimerRecord {
  id: string;
  scope: string;
  dueAt: Millis;
  note: string;
  setBy: string;
  state: "pending" | "fired" | "cancelled";
}

export interface ProactiveConfig {
  debounceMs: number;
  debounceMaxMs: number;
  judgeThreshold: number;
  /** Waits between judge retries. A third failure wakes the target anyway. */
  judgeRetryMs: number[];
  /** A pending wake older than this is handed over again. */
  redeliverAfterMs: number;
  /** One fallback timer per scope while none is pending. 0 turns it off. */
  fallbackMs: number;
  /**
   * Finished work older than this is deleted by `prune`. A repeat of a pruned event id is
   * accepted as new, so keep it longer than any sender retries. 0 keeps everything.
   */
  retentionMs: number;
}

/** What one `prune` removed. */
export interface PruneCounts {
  events: number;
  wakes: number;
  timers: number;
  effects: number;
}

export const DEFAULT_CONFIG: ProactiveConfig = {
  debounceMs: 3_000,
  debounceMaxMs: 20_000,
  judgeThreshold: 0.5,
  judgeRetryMs: [2_000, 8_000],
  redeliverAfterMs: 3_000,
  fallbackMs: 120 * 60_000,
  retentionMs: 30 * 24 * 60 * 60_000,
};
