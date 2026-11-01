import { wakeId } from "./memory-store.js";
import type { ClaimResult, ProactiveStore, StoredWake } from "./store.js";
import type {
  Decision,
  EffectRecord,
  EffectResult,
  Millis,
  ProactiveEvent,
  TimerRecord,
  Wake,
} from "./types.js";

/** The slice of `pg`'s Pool and PoolClient this store needs, so the package needs no driver. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(error?: unknown): void }>;
}

class Rollback extends Error {}

const num = (v: unknown): number => Number(v);

function dueAt(
  firstAt: Millis | null,
  lastAt: Millis | null,
  debounceMs: number,
  debounceMaxMs: number,
): Millis | null {
  if (firstAt === null || lastAt === null) return null;
  return Math.min(lastAt + debounceMs, firstAt + debounceMaxMs);
}

/** Postgres implementation. Safe for many instances: scope work runs under a row lock. */
export class PgProactiveStore implements ProactiveStore {
  constructor(private readonly pool: PgPoolLike) {}

  private async tx<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      client.release();
      return out;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async receive(event: ProactiveEvent, now: Millis): Promise<"new" | "duplicate"> {
    const r = await this.pool.query(
      `INSERT INTO proactive_inbox ("source","eventId","scope","event","receivedAt")
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING "seq"`,
      [event.source, event.id, event.scope, JSON.stringify(event), now],
    );
    return r.rows.length > 0 ? "new" : "duplicate";
  }

  async unappliedScopes(limit: number): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT "scope" FROM proactive_inbox WHERE NOT "applied" LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => String(row.scope));
  }

  private async lockScope(q: PgQueryable, scope: string) {
    await q.query(`INSERT INTO proactive_scopes ("scope") VALUES ($1) ON CONFLICT DO NOTHING`, [
      scope,
    ]);
    const r = await q.query(
      `SELECT "firstAt","lastAt" FROM proactive_scopes WHERE "scope"=$1 FOR UPDATE`,
      [scope],
    );
    const row = r.rows[0] ?? {};
    return {
      firstAt: row.firstAt == null ? null : num(row.firstAt),
      lastAt: row.lastAt == null ? null : num(row.lastAt),
    };
  }

  async applyScope(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<{ applied: number; dueAt: Millis | null }> {
    return this.tx(async (q) => {
      const state = await this.lockScope(q, scope);
      // One statement, so the rows marked applied are exactly the rows copied.
      const moved = await q.query(
        `WITH moved AS (
           UPDATE proactive_inbox SET "applied"=true
           WHERE "scope"=$1 AND NOT "applied"
           RETURNING "source","eventId","scope","seq","event")
         INSERT INTO proactive_events ("source","eventId","scope","seq","event")
         SELECT "source","eventId","scope","seq","event" FROM moved ORDER BY "seq"
         ON CONFLICT DO NOTHING RETURNING 1`,
        [scope],
      );
      const applied = moved.rows.length;
      if (applied > 0) {
        state.firstAt ??= now;
        state.lastAt = now;
        await q.query(`UPDATE proactive_scopes SET "firstAt"=$2,"lastAt"=$3 WHERE "scope"=$1`, [
          scope,
          state.firstAt,
          state.lastAt,
        ]);
      }
      return { applied, dueAt: dueAt(state.firstAt, state.lastAt, debounceMs, debounceMaxMs) };
    });
  }

  async claimGroup(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<ClaimResult> {
    const rows = await this.pool.query(
      `SELECT "event" FROM proactive_events WHERE "scope"=$1 AND NOT "decided" ORDER BY "seq"`,
      [scope],
    );
    if (rows.rows.length === 0) return { kind: "none" };
    const s = await this.pool.query(
      `SELECT "firstAt","lastAt" FROM proactive_scopes WHERE "scope"=$1`,
      [scope],
    );
    const first = s.rows[0]?.firstAt == null ? null : num(s.rows[0]?.firstAt);
    const last = s.rows[0]?.lastAt == null ? null : num(s.rows[0]?.lastAt);
    const due = dueAt(first, last, debounceMs, debounceMaxMs);
    if (due !== null && now < due) return { kind: "early", dueAt: due };
    return { kind: "group", events: rows.rows.map((r) => r.event as ProactiveEvent) };
  }

  async recordDecision(
    scope: string,
    events: ProactiveEvent[],
    decision: Decision,
    now: Millis,
  ): Promise<{ recorded: false } | { recorded: true; wake?: Wake }> {
    const last = events[events.length - 1];
    if (!last) return { recorded: false };
    try {
      return await this.tx(async (q) => {
        await this.lockScope(q, scope);
        const marked = await q.query(
          `UPDATE proactive_events SET "decided"=true
           WHERE NOT "decided" AND ("source","eventId") IN
             (SELECT * FROM unnest($1::text[], $2::text[])) RETURNING 1`,
          [events.map((e) => e.source), events.map((e) => e.id)],
        );
        // Another worker decided some of these: undo and let it stand.
        if (marked.rows.length !== events.length) throw new Rollback();
        const left = await q.query(
          `SELECT 1 FROM proactive_events WHERE "scope"=$1 AND NOT "decided" LIMIT 1`,
          [scope],
        );
        await q.query(`UPDATE proactive_scopes SET "firstAt"=$2,"lastAt"=$2 WHERE "scope"=$1`, [
          scope,
          left.rows.length > 0 ? now : null,
        ]);
        if (decision.kind === "drop") return { recorded: true as const };
        const wake: Wake = {
          id: wakeId(decision.reason, scope, last.id),
          scope,
          reason: decision.reason,
          events,
          ...(decision.judgeError ? { judgeError: decision.judgeError } : {}),
        };
        await q.query(
          `INSERT INTO proactive_wakes ("id","scope","reason","events","judgeError","decidedAt")
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [wake.id, scope, wake.reason, JSON.stringify(events), wake.judgeError ?? null, now],
        );
        return { recorded: true as const, wake };
      });
    } catch (error) {
      if (error instanceof Rollback) return { recorded: false };
      throw error;
    }
  }

  private wakeFromRow(row: Record<string, unknown>): Wake {
    return {
      id: String(row.id),
      scope: String(row.scope),
      reason: row.reason as Wake["reason"],
      events: row.events as ProactiveEvent[],
      ...(row.judgeError ? { judgeError: String(row.judgeError) } : {}),
    };
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE proactive_wakes SET "state"='delivered' WHERE "id"=$1`, [id]);
  }

  async pendingWakes(before: Millis, limit: number): Promise<Wake[]> {
    const r = await this.pool.query(
      `SELECT * FROM proactive_wakes WHERE "state"='pending' AND "decidedAt"<=$1
       ORDER BY "decidedAt" LIMIT $2`,
      [before, limit],
    );
    return r.rows.map((row) => this.wakeFromRow(row));
  }

  async scopesWithUndecided(limit: number): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT "scope" FROM proactive_events WHERE NOT "decided" LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => String(row.scope));
  }

  async getWake(id: string): Promise<StoredWake | undefined> {
    const r = await this.pool.query(`SELECT * FROM proactive_wakes WHERE "id"=$1`, [id]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      wake: this.wakeFromRow(row),
      state: row.state as StoredWake["state"],
      decidedAt: num(row.decidedAt),
    };
  }

  private effectFromRow(row: Record<string, unknown>): EffectRecord {
    return {
      sendId: String(row.sendId),
      to: String(row.toAddress),
      payload: row.payload,
      state: row.state as EffectRecord["state"],
      ...(row.result ? { result: row.result as EffectResult } : {}),
      createdAt: num(row.createdAt),
    };
  }

  async effectGet(sendId: string): Promise<EffectRecord | undefined> {
    const r = await this.pool.query(`SELECT * FROM proactive_effects WHERE "sendId"=$1`, [sendId]);
    return r.rows[0] ? this.effectFromRow(r.rows[0]) : undefined;
  }

  async effectBegin(
    sendId: string,
    to: string,
    payload: unknown,
    now: Millis,
  ): Promise<{ created: boolean; record: EffectRecord }> {
    const ins = await this.pool.query(
      `INSERT INTO proactive_effects ("sendId","toAddress","payload","createdAt")
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
      [sendId, to, JSON.stringify(payload ?? null), now],
    );
    if (ins.rows[0]) return { created: true, record: this.effectFromRow(ins.rows[0]) };
    const existing = await this.effectGet(sendId);
    if (!existing) throw new Error(`effect ${sendId} vanished`);
    return { created: false, record: existing };
  }

  async effectDone(sendId: string, result: EffectResult): Promise<void> {
    await this.pool.query(
      `UPDATE proactive_effects SET "state"='sent',"result"=$2 WHERE "sendId"=$1`,
      [sendId, JSON.stringify(result)],
    );
  }

  private timerFromRow(row: Record<string, unknown>): TimerRecord {
    return {
      id: String(row.id),
      scope: String(row.scope),
      dueAt: num(row.dueAt),
      note: String(row.note),
      setBy: String(row.setBy),
      state: row.state as TimerRecord["state"],
    };
  }

  async timerSet(timer: Omit<TimerRecord, "state">): Promise<"set" | "exists"> {
    const r = await this.pool.query(
      `INSERT INTO proactive_timers ("id","scope","dueAt","note","setBy")
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
      [timer.id, timer.scope, timer.dueAt, timer.note, timer.setBy],
    );
    return r.rows.length > 0 ? "set" : "exists";
  }

  async timerCancel(id: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE proactive_timers SET "state"='cancelled' WHERE "id"=$1 AND "state"='pending' RETURNING 1`,
      [id],
    );
    return r.rows.length > 0;
  }

  async timersDue(now: Millis, limit: number): Promise<TimerRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM proactive_timers WHERE "state"='pending' AND "dueAt"<=$1
       ORDER BY "dueAt" LIMIT $2`,
      [now, limit],
    );
    return r.rows.map((row) => this.timerFromRow(row));
  }

  async timerMarkFired(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE proactive_timers SET "state"='fired' WHERE "id"=$1 AND "state"='pending'`,
      [id],
    );
  }

  async timerGet(id: string): Promise<TimerRecord | undefined> {
    const r = await this.pool.query(`SELECT * FROM proactive_timers WHERE "id"=$1`, [id]);
    return r.rows[0] ? this.timerFromRow(r.rows[0]) : undefined;
  }

  async nextTimerDue(): Promise<Millis | null> {
    const r = await this.pool.query(
      `SELECT MIN("dueAt") AS next FROM proactive_timers WHERE "state"='pending'`,
    );
    const v = r.rows[0]?.next;
    return v == null ? null : num(v);
  }

  async hasPendingTimer(scope: string, idPrefix: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM proactive_timers
       WHERE "state"='pending' AND "scope"=$1 AND starts_with("id",$2) LIMIT 1`,
      [scope, idPrefix],
    );
    return r.rows.length > 0;
  }
}
