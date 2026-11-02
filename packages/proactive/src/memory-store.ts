import type { ClaimResult, ProactiveStore, StoredWake } from "./store.js";
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

interface InboxRow {
  seq: number;
  receivedAt: Millis;
  event: ProactiveEvent;
  applied: boolean;
}

interface EventRow {
  event: ProactiveEvent;
  decided: boolean;
}

interface ScopeState {
  firstAt: Millis | null;
  lastAt: Millis | null;
}

/**
 * Reference implementation. Single-threaded JS makes each method atomic, which is what a
 * Postgres transaction gives the real store. Tests also use `crash` to model a process
 * dying between two calls.
 */
export class MemoryProactiveStore implements ProactiveStore {
  private seq = 0;
  private readonly inbox = new Map<string, InboxRow>();
  private readonly events = new Map<string, EventRow[]>();
  private readonly scopes = new Map<string, ScopeState>();
  private readonly wakes = new Map<string, StoredWake>();
  private readonly effects = new Map<string, EffectRecord>();
  private readonly timers = new Map<string, TimerRecord>();

  async receive(event: ProactiveEvent, now: Millis): Promise<"new" | "duplicate"> {
    const key = `${event.source}\u0000${event.id}`;
    if (this.inbox.has(key)) return "duplicate";
    this.inbox.set(key, { seq: ++this.seq, receivedAt: now, event, applied: false });
    return "new";
  }

  async unappliedScopes(limit: number): Promise<string[]> {
    const out = new Set<string>();
    for (const row of this.inbox.values()) {
      if (!row.applied) out.add(row.event.scope);
      if (out.size >= limit) break;
    }
    return [...out];
  }

  async applyScope(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<{ applied: number; dueAt: Millis | null }> {
    const rows = [...this.inbox.values()]
      .filter((r) => !r.applied && r.event.scope === scope)
      .sort((a, b) => a.seq - b.seq);
    const list = this.events.get(scope) ?? [];
    for (const row of rows) {
      list.push({ event: row.event, decided: false });
      row.applied = true;
    }
    this.events.set(scope, list);
    const state = this.scopes.get(scope) ?? { firstAt: null, lastAt: null };
    if (rows.length > 0) {
      state.firstAt ??= now;
      state.lastAt = now;
    }
    this.scopes.set(scope, state);
    return { applied: rows.length, dueAt: this.dueAt(state, debounceMs, debounceMaxMs) };
  }

  private dueAt(state: ScopeState, debounceMs: number, debounceMaxMs: number): Millis | null {
    if (state.firstAt === null || state.lastAt === null) return null;
    return Math.min(state.lastAt + debounceMs, state.firstAt + debounceMaxMs);
  }

  async claimGroup(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<ClaimResult> {
    const undecided = (this.events.get(scope) ?? []).filter((r) => !r.decided);
    const state = this.scopes.get(scope);
    if (undecided.length === 0 || !state) return { kind: "none" };
    const due = this.dueAt(state, debounceMs, debounceMaxMs);
    if (due !== null && now < due) return { kind: "early", dueAt: due };
    return { kind: "group", events: undecided.map((r) => r.event) };
  }

  async recordDecision(
    scope: string,
    events: ProactiveEvent[],
    decision: Decision,
    now: Millis,
  ): Promise<{ recorded: false } | { recorded: true; wake?: Wake }> {
    const rows = this.events.get(scope) ?? [];
    const targets = events.map((e) =>
      rows.find((r) => r.event.source === e.source && r.event.id === e.id),
    );
    if (targets.some((r) => !r || r.decided)) return { recorded: false };
    for (const r of targets) if (r) r.decided = true;
    const remaining = rows.some((r) => !r.decided);
    const state = this.scopes.get(scope);
    if (state && !remaining) {
      state.firstAt = null;
      state.lastAt = null;
    } else if (state) {
      state.firstAt = now;
      state.lastAt = now;
    }
    if (decision.kind === "drop") return { recorded: true };
    const last = events[events.length - 1];
    if (!last) return { recorded: false };
    const wake: Wake = {
      id: wakeId(decision.reason, scope, last.id),
      scope,
      reason: decision.reason,
      events,
      ...(decision.judgeError ? { judgeError: decision.judgeError } : {}),
    };
    if (!this.wakes.has(wake.id))
      this.wakes.set(wake.id, { wake, state: "pending", decidedAt: now });
    return { recorded: true, wake };
  }

  async markDelivered(wakeId: string): Promise<void> {
    const w = this.wakes.get(wakeId);
    if (w) w.state = "delivered";
  }

  async pendingWakes(before: Millis, limit: number): Promise<Wake[]> {
    return [...this.wakes.values()]
      .filter((w) => w.state === "pending" && w.decidedAt <= before)
      .slice(0, limit)
      .map((w) => w.wake);
  }

  async scopesWithUndecided(limit: number): Promise<string[]> {
    const out: string[] = [];
    for (const [scope, rows] of this.events) {
      if (rows.some((r) => !r.decided)) out.push(scope);
      if (out.length >= limit) break;
    }
    return out;
  }

  async getWake(id: string): Promise<StoredWake | undefined> {
    return this.wakes.get(id);
  }

  async effectGet(sendId: string): Promise<EffectRecord | undefined> {
    return this.effects.get(sendId);
  }

  async effectBegin(
    sendId: string,
    to: string,
    payload: unknown,
    now: Millis,
  ): Promise<{ created: boolean; record: EffectRecord }> {
    const existing = this.effects.get(sendId);
    if (existing) return { created: false, record: existing };
    const record: EffectRecord = { sendId, to, payload, state: "sending", createdAt: now };
    this.effects.set(sendId, record);
    return { created: true, record };
  }

  async effectDone(sendId: string, result: EffectResult): Promise<void> {
    const r = this.effects.get(sendId);
    if (r) {
      r.state = "sent";
      r.result = result;
    }
  }

  async timerSet(timer: Omit<TimerRecord, "state">): Promise<"set" | "exists"> {
    if (this.timers.has(timer.id)) return "exists";
    this.timers.set(timer.id, { ...timer, state: "pending" });
    return "set";
  }

  async timerCancel(id: string): Promise<boolean> {
    const t = this.timers.get(id);
    if (!t || t.state !== "pending") return false;
    t.state = "cancelled";
    return true;
  }

  async timersDue(now: Millis, limit: number): Promise<TimerRecord[]> {
    return [...this.timers.values()]
      .filter((t) => t.state === "pending" && t.dueAt <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, limit);
  }

  async timerMarkFired(id: string): Promise<void> {
    const t = this.timers.get(id);
    if (t && t.state === "pending") t.state = "fired";
  }

  async timerGet(id: string): Promise<TimerRecord | undefined> {
    return this.timers.get(id);
  }

  async nextTimerDue(): Promise<Millis | null> {
    let min: Millis | null = null;
    for (const t of this.timers.values())
      if (t.state === "pending" && (min === null || t.dueAt < min)) min = t.dueAt;
    return min;
  }

  async hasPendingTimer(scope: string, idPrefix: string): Promise<boolean> {
    return [...this.timers.values()].some(
      (t) => t.state === "pending" && t.scope === scope && t.id.startsWith(idPrefix),
    );
  }

  async prune(before: Millis): Promise<PruneCounts> {
    const counts: PruneCounts = { events: 0, wakes: 0, timers: 0, effects: 0 };
    const received = (e: ProactiveEvent) =>
      this.inbox.get(`${e.source}\u0000${e.id}`)?.receivedAt ?? Number.POSITIVE_INFINITY;
    for (const [scope, rows] of this.events) {
      const kept = rows.filter((r) => !(r.decided && received(r.event) < before));
      counts.events += rows.length - kept.length;
      this.events.set(scope, kept);
    }
    const live = new Set(
      [...this.events.values()].flat().map((r) => `${r.event.source}\u0000${r.event.id}`),
    );
    for (const [key, row] of this.inbox)
      if (row.applied && row.receivedAt < before && !live.has(key)) this.inbox.delete(key);
    for (const [id, w] of this.wakes)
      if (w.state === "delivered" && w.decidedAt < before) {
        this.wakes.delete(id);
        counts.wakes++;
      }
    for (const [id, t] of this.timers)
      if (t.state !== "pending" && t.dueAt < before) {
        this.timers.delete(id);
        counts.timers++;
      }
    for (const [id, e] of this.effects)
      if (e.state === "sent" && e.createdAt < before) {
        this.effects.delete(id);
        counts.effects++;
      }
    return counts;
  }

  async knownScopes(limit: number, after = ""): Promise<string[]> {
    const all = new Set<string>([
      ...[...this.inbox.values()].map((r) => r.event.scope),
      ...this.events.keys(),
      ...this.scopes.keys(),
      ...[...this.wakes.values()].map((w) => w.wake.scope),
      ...[...this.timers.values()].map((t) => t.scope),
    ]);
    return [...all]
      .filter((s) => s > after)
      .sort()
      .slice(0, limit);
  }

  async deleteScope(scope: string): Promise<void> {
    for (const [key, row] of this.inbox) if (row.event.scope === scope) this.inbox.delete(key);
    this.events.delete(scope);
    this.scopes.delete(scope);
    for (const [id, w] of this.wakes) if (w.wake.scope === scope) this.wakes.delete(id);
    for (const [id, t] of this.timers) if (t.scope === scope) this.timers.delete(id);
  }
}

export function wakeId(reason: string, scope: string, lastEventId: string): string {
  return `${reason}:${scope}:${lastEventId}`;
}
