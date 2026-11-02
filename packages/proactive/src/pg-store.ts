import { wakeId } from "./memory-store.js";
import type { PayloadCodec } from "./ports.js";
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

/** Runs SQL. `transaction` must roll back when its callback throws. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PgExecutor extends PgQueryable {
  transaction<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T>;
}

/** The slice of `pg`'s Pool this package needs to build an executor. */
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(error?: unknown): void }>;
}

/** Executor over a `pg` Pool: one client per transaction. */
export function pgPoolExecutor(pool: PgPoolLike): PgExecutor {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
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
    },
  };
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
  constructor(
    private readonly pool: PgExecutor,
    private readonly codec?: PayloadCodec,
  ) {}

  private seal(scope: string, value: unknown): Promise<unknown> {
    return this.codec ? this.codec.seal(scope, value) : Promise.resolve(value);
  }

  private open<T>(scope: string, value: unknown): Promise<T> {
    return (this.codec ? this.codec.open(scope, value) : Promise.resolve(value)) as Promise<T>;
  }

  private tx<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    return this.pool.transaction(fn);
  }

  async receive(event: ProactiveEvent, now: Millis): Promise<"new" | "duplicate"> {
    const sealed = await this.seal(event.scope, event);
    const r = await this.pool.query(
      `INSERT INTO proactive_inbox ("source","eventId","scope","event","receivedAt")
       VALUES ($1,$2,$3,$4::jsonb,$5::bigint) ON CONFLICT DO NOTHING RETURNING "seq"`,
      [event.source, event.id, event.scope, JSON.stringify(sealed), now],
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
        await q.query(
          `UPDATE proactive_scopes SET "firstAt"=$2::bigint,"lastAt"=$3::bigint WHERE "scope"=$1`,
          [scope, state.firstAt, state.lastAt],
        );
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
    const events = await Promise.all(
      rows.rows.map((r) => this.open<ProactiveEvent>(scope, r.event)),
    );
    return { kind: "group", events };
  }

  async recordDecision(
    scope: string,
    events: ProactiveEvent[],
    decision: Decision,
    now: Millis,
  ): Promise<{ recorded: false } | { recorded: true; wake?: Wake }> {
    const last = events[events.length - 1];
    if (!last) return { recorded: false };
    const sealedEvents = decision.kind === "drop" ? null : await this.seal(scope, events);
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
        await q.query(
          `UPDATE proactive_scopes SET "firstAt"=$2::bigint,"lastAt"=$2::bigint WHERE "scope"=$1`,
          [scope, left.rows.length > 0 ? now : null],
        );
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
           VALUES ($1,$2,$3,$4::jsonb,$5,$6::bigint) ON CONFLICT DO NOTHING`,
          [wake.id, scope, wake.reason, JSON.stringify(sealedEvents), wake.judgeError ?? null, now],
        );
        return { recorded: true as const, wake };
      });
    } catch (error) {
      if (error instanceof Rollback) return { recorded: false };
      throw error;
    }
  }

  private async wakeFromRow(row: Record<string, unknown>): Promise<Wake> {
    const scope = String(row.scope);
    return {
      id: String(row.id),
      scope,
      reason: row.reason as Wake["reason"],
      events: await this.open<ProactiveEvent[]>(scope, row.events),
      ...(row.judgeError ? { judgeError: String(row.judgeError) } : {}),
    };
  }

  async markDelivered(id: string): Promise<void> {
    await this.pool.query(`UPDATE proactive_wakes SET "state"='delivered' WHERE "id"=$1`, [id]);
  }

  async pendingWakes(before: Millis, limit: number): Promise<Wake[]> {
    const r = await this.pool.query(
      `SELECT * FROM proactive_wakes WHERE "state"='pending' AND "decidedAt"<=$1::bigint
       ORDER BY "decidedAt" LIMIT $2`,
      [before, limit],
    );
    return Promise.all(r.rows.map((row) => this.wakeFromRow(row)));
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
      wake: await this.wakeFromRow(row),
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
       VALUES ($1,$2,$3::jsonb,$4::bigint) ON CONFLICT DO NOTHING RETURNING *`,
      [sendId, to, JSON.stringify(payload ?? null), now],
    );
    if (ins.rows[0]) return { created: true, record: this.effectFromRow(ins.rows[0]) };
    const existing = await this.effectGet(sendId);
    if (!existing) throw new Error(`effect ${sendId} vanished`);
    return { created: false, record: existing };
  }

  async effectDone(sendId: string, result: EffectResult): Promise<void> {
    await this.pool.query(
      `UPDATE proactive_effects SET "state"='sent',"result"=$2::jsonb WHERE "sendId"=$1`,
      [sendId, JSON.stringify(result)],
    );
  }

  /** With a codec the note column holds the sealed value as JSON text. */
  private async openNote(scope: string, stored: unknown): Promise<string> {
    if (!this.codec) return String(stored);
    return String(await this.open<unknown>(scope, JSON.parse(String(stored))));
  }

  private async timerFromRow(row: Record<string, unknown>): Promise<TimerRecord> {
    const scope = String(row.scope);
    return {
      id: String(row.id),
      scope,
      dueAt: num(row.dueAt),
      note: await this.openNote(scope, row.note),
      setBy: String(row.setBy),
      state: row.state as TimerRecord["state"],
    };
  }

  async timerSet(timer: Omit<TimerRecord, "state">): Promise<"set" | "exists"> {
    const note = this.codec ? JSON.stringify(await this.seal(timer.scope, timer.note)) : timer.note;
    const r = await this.pool.query(
      `INSERT INTO proactive_timers ("id","scope","dueAt","note","setBy")
       VALUES ($1,$2,$3::bigint,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
      [timer.id, timer.scope, timer.dueAt, note, timer.setBy],
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
      `SELECT * FROM proactive_timers WHERE "state"='pending' AND "dueAt"<=$1::bigint
       ORDER BY "dueAt" LIMIT $2`,
      [now, limit],
    );
    return Promise.all(r.rows.map((row) => this.timerFromRow(row)));
  }

  async timerMarkFired(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE proactive_timers SET "state"='fired' WHERE "id"=$1 AND "state"='pending'`,
      [id],
    );
  }

  async timerGet(id: string): Promise<TimerRecord | undefined> {
    const r = await this.pool.query(`SELECT * FROM proactive_timers WHERE "id"=$1`, [id]);
    return r.rows[0] ? await this.timerFromRow(r.rows[0]) : undefined;
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

  async prune(before: Millis): Promise<PruneCounts> {
    return this.tx(async (q) => {
      // Events first, so the inbox rows they pointed at are free to go.
      const events = await q.query(
        `DELETE FROM proactive_events e USING proactive_inbox i
         WHERE e."decided" AND i."source"=e."source" AND i."eventId"=e."eventId"
           AND i."receivedAt"<$1::bigint RETURNING 1`,
        [before],
      );
      await q.query(
        `DELETE FROM proactive_inbox i
         WHERE i."applied" AND i."receivedAt"<$1::bigint AND NOT EXISTS
           (SELECT 1 FROM proactive_events e WHERE e."source"=i."source" AND e."eventId"=i."eventId")`,
        [before],
      );
      const wakes = await q.query(
        `DELETE FROM proactive_wakes WHERE "state"='delivered' AND "decidedAt"<$1::bigint RETURNING 1`,
        [before],
      );
      const timers = await q.query(
        `DELETE FROM proactive_timers WHERE "state"<>'pending' AND "dueAt"<$1::bigint RETURNING 1`,
        [before],
      );
      const effects = await q.query(
        `DELETE FROM proactive_effects WHERE "state"='sent' AND "createdAt"<$1::bigint RETURNING 1`,
        [before],
      );
      return {
        events: events.rows.length,
        wakes: wakes.rows.length,
        timers: timers.rows.length,
        effects: effects.rows.length,
      };
    });
  }

  async knownScopes(limit: number, after = ""): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT "scope" FROM (
         SELECT "scope" FROM proactive_scopes UNION SELECT "scope" FROM proactive_inbox
         UNION SELECT "scope" FROM proactive_events UNION SELECT "scope" FROM proactive_wakes
         UNION SELECT "scope" FROM proactive_timers) s
       WHERE "scope" > $1 ORDER BY "scope" LIMIT $2`,
      [after, limit],
    );
    return r.rows.map((row) => String(row.scope));
  }

  async deleteScope(scope: string): Promise<void> {
    await this.tx(async (q) => {
      await this.lockScope(q, scope);
      for (const table of [
        "proactive_inbox",
        "proactive_events",
        "proactive_wakes",
        "proactive_timers",
        "proactive_scopes",
      ]) {
        await q.query(`DELETE FROM ${table} WHERE "scope"=$1`, [scope]);
      }
    });
  }
}
