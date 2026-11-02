import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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

/**
 * The tables behind `SqliteProactiveStore`: the same shape as the Postgres schema, with
 * integer milliseconds and JSON kept as text.
 */
export const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proactive_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  eventId TEXT NOT NULL,
  scope TEXT NOT NULL,
  event TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  receivedAt INTEGER NOT NULL,
  UNIQUE (source, eventId)
);
CREATE INDEX IF NOT EXISTS proactive_inbox_unapplied_idx ON proactive_inbox(scope, seq) WHERE applied = 0;
CREATE INDEX IF NOT EXISTS proactive_inbox_applied_idx ON proactive_inbox(receivedAt) WHERE applied = 1;

CREATE TABLE IF NOT EXISTS proactive_events (
  source TEXT NOT NULL,
  eventId TEXT NOT NULL,
  scope TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  decided INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, eventId)
);
CREATE INDEX IF NOT EXISTS proactive_events_undecided_idx ON proactive_events(scope, seq) WHERE decided = 0;

CREATE TABLE IF NOT EXISTS proactive_scopes (
  scope TEXT PRIMARY KEY,
  firstAt INTEGER,
  lastAt INTEGER
);

CREATE TABLE IF NOT EXISTS proactive_wakes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  reason TEXT NOT NULL,
  events TEXT NOT NULL,
  judgeError TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  decidedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proactive_wakes_pending_idx ON proactive_wakes(decidedAt) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS proactive_effects (
  sendId TEXT PRIMARY KEY,
  toAddress TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sending',
  result TEXT,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_timers (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  dueAt INTEGER NOT NULL,
  note TEXT NOT NULL,
  setBy TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS proactive_timers_due_idx ON proactive_timers(dueAt) WHERE state = 'pending';
`;

class Rollback extends Error {}

type Row = Record<string, unknown>;

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

/**
 * SQLite implementation on Node's built-in `node:sqlite`: one file, WAL, full fsync, so
 * committed work survives a power cut or restart. Meant for one machine; several
 * processes may share the file (writers queue on `BEGIN IMMEDIATE`). Use Postgres when
 * instances run on different hosts.
 *
 * The driver is synchronous, so every step that touches the database runs without an
 * await in the middle; the codec's async work happens before or after it.
 */
export class SqliteProactiveStore implements ProactiveStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly codec?: PayloadCodec,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(SQLITE_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  /** Takes the write lock up front, as Postgres does with the scope row lock. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // the transaction is already gone
      }
      throw error;
    }
  }

  private async seal(scope: string, value: unknown): Promise<unknown> {
    return this.codec ? this.codec.seal(scope, value) : value;
  }

  private async open<T>(scope: string, text: unknown): Promise<T> {
    const value = JSON.parse(String(text));
    return (this.codec ? await this.codec.open(scope, value) : value) as T;
  }

  async receive(event: ProactiveEvent, now: Millis): Promise<"new" | "duplicate"> {
    const sealed = JSON.stringify(await this.seal(event.scope, event));
    const changes = this.run(
      `INSERT OR IGNORE INTO proactive_inbox (source,eventId,scope,event,receivedAt)
       VALUES (?,?,?,?,?)`,
      event.source,
      event.id,
      event.scope,
      sealed,
      now,
    );
    return changes > 0 ? "new" : "duplicate";
  }

  async unappliedScopes(limit: number): Promise<string[]> {
    return this.all(
      "SELECT DISTINCT scope FROM proactive_inbox WHERE applied = 0 LIMIT ?",
      limit,
    ).map((r) => String(r.scope));
  }

  async applyScope(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<{ applied: number; dueAt: Millis | null }> {
    return this.tx(() => {
      this.run("INSERT OR IGNORE INTO proactive_scopes (scope) VALUES (?)", scope);
      const row = this.get("SELECT firstAt,lastAt FROM proactive_scopes WHERE scope=?", scope);
      let firstAt = row?.firstAt == null ? null : num(row.firstAt);
      let lastAt = row?.lastAt == null ? null : num(row.lastAt);
      const moved = this.all(
        "SELECT source,eventId,seq,event FROM proactive_inbox WHERE scope=? AND applied=0 ORDER BY seq",
        scope,
      );
      let applied = 0;
      for (const r of moved) {
        this.run(
          "UPDATE proactive_inbox SET applied=1 WHERE source=? AND eventId=?",
          String(r.source),
          String(r.eventId),
        );
        applied += this.run(
          `INSERT OR IGNORE INTO proactive_events (source,eventId,scope,seq,event)
           VALUES (?,?,?,?,?)`,
          String(r.source),
          String(r.eventId),
          scope,
          num(r.seq),
          String(r.event),
        );
      }
      if (applied > 0) {
        firstAt ??= now;
        lastAt = now;
        this.run(
          "UPDATE proactive_scopes SET firstAt=?,lastAt=? WHERE scope=?",
          firstAt,
          lastAt,
          scope,
        );
      }
      return { applied, dueAt: dueAt(firstAt, lastAt, debounceMs, debounceMaxMs) };
    });
  }

  async claimGroup(
    scope: string,
    now: Millis,
    debounceMs: number,
    debounceMaxMs: number,
  ): Promise<ClaimResult> {
    const rows = this.all(
      "SELECT event FROM proactive_events WHERE scope=? AND decided=0 ORDER BY seq",
      scope,
    );
    if (rows.length === 0) return { kind: "none" };
    const s = this.get("SELECT firstAt,lastAt FROM proactive_scopes WHERE scope=?", scope);
    const first = s?.firstAt == null ? null : num(s.firstAt);
    const last = s?.lastAt == null ? null : num(s.lastAt);
    const due = dueAt(first, last, debounceMs, debounceMaxMs);
    if (due !== null && now < due) return { kind: "early", dueAt: due };
    const events = await Promise.all(rows.map((r) => this.open<ProactiveEvent>(scope, r.event)));
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
    const sealedEvents =
      decision.kind === "drop" ? null : JSON.stringify(await this.seal(scope, events));
    try {
      return this.tx(() => {
        let marked = 0;
        for (const e of events) {
          marked += this.run(
            "UPDATE proactive_events SET decided=1 WHERE decided=0 AND source=? AND eventId=?",
            e.source,
            e.id,
          );
        }
        // Another worker decided some of these: undo and let it stand.
        if (marked !== events.length) throw new Rollback();
        const left = this.get(
          "SELECT 1 AS x FROM proactive_events WHERE scope=? AND decided=0 LIMIT 1",
          scope,
        );
        this.run(
          "UPDATE proactive_scopes SET firstAt=?,lastAt=? WHERE scope=?",
          left ? now : null,
          left ? now : null,
          scope,
        );
        if (decision.kind === "drop") return { recorded: true as const };
        const wake: Wake = {
          id: wakeId(decision.reason, scope, last.id),
          scope,
          reason: decision.reason,
          events,
          ...(decision.judgeError ? { judgeError: decision.judgeError } : {}),
        };
        this.run(
          `INSERT OR IGNORE INTO proactive_wakes (id,scope,reason,events,judgeError,decidedAt)
         VALUES (?,?,?,?,?,?)`,
          wake.id,
          scope,
          wake.reason,
          sealedEvents,
          wake.judgeError ?? null,
          now,
        );
        return { recorded: true as const, wake };
      });
    } catch (error) {
      if (error instanceof Rollback) return { recorded: false };
      throw error;
    }
  }

  private async wakeFromRow(row: Row): Promise<Wake> {
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
    this.run("UPDATE proactive_wakes SET state='delivered' WHERE id=?", id);
  }

  async pendingWakes(before: Millis, limit: number): Promise<Wake[]> {
    const rows = this.all(
      "SELECT * FROM proactive_wakes WHERE state='pending' AND decidedAt<=? ORDER BY decidedAt LIMIT ?",
      before,
      limit,
    );
    return Promise.all(rows.map((r) => this.wakeFromRow(r)));
  }

  async scopesWithUndecided(limit: number): Promise<string[]> {
    return this.all(
      "SELECT DISTINCT scope FROM proactive_events WHERE decided=0 LIMIT ?",
      limit,
    ).map((r) => String(r.scope));
  }

  async getWake(id: string): Promise<StoredWake | undefined> {
    const row = this.get("SELECT * FROM proactive_wakes WHERE id=?", id);
    if (!row) return undefined;
    return {
      wake: await this.wakeFromRow(row),
      state: row.state as StoredWake["state"],
      decidedAt: num(row.decidedAt),
    };
  }

  private effectFromRow(row: Row): EffectRecord {
    return {
      sendId: String(row.sendId),
      to: String(row.toAddress),
      payload: JSON.parse(String(row.payload)),
      state: row.state as EffectRecord["state"],
      ...(row.result ? { result: JSON.parse(String(row.result)) as EffectResult } : {}),
      createdAt: num(row.createdAt),
    };
  }

  async effectGet(sendId: string): Promise<EffectRecord | undefined> {
    const row = this.get("SELECT * FROM proactive_effects WHERE sendId=?", sendId);
    return row ? this.effectFromRow(row) : undefined;
  }

  async effectBegin(
    sendId: string,
    to: string,
    payload: unknown,
    now: Millis,
  ): Promise<{ created: boolean; record: EffectRecord }> {
    const created =
      this.run(
        `INSERT OR IGNORE INTO proactive_effects (sendId,toAddress,payload,createdAt)
         VALUES (?,?,?,?)`,
        sendId,
        to,
        JSON.stringify(payload ?? null),
        now,
      ) > 0;
    const record = await this.effectGet(sendId);
    if (!record) throw new Error(`effect ${sendId} vanished`);
    return { created, record };
  }

  async effectDone(sendId: string, result: EffectResult): Promise<void> {
    this.run(
      "UPDATE proactive_effects SET state='sent',result=? WHERE sendId=?",
      JSON.stringify(result),
      sendId,
    );
  }

  /** With a codec the note column holds the sealed value as JSON text. */
  private async openNote(scope: string, stored: unknown): Promise<string> {
    if (!this.codec) return String(stored);
    return String(await this.open<unknown>(scope, stored));
  }

  private async timerFromRow(row: Row): Promise<TimerRecord> {
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
    const changes = this.run(
      `INSERT OR IGNORE INTO proactive_timers (id,scope,dueAt,note,setBy) VALUES (?,?,?,?,?)`,
      timer.id,
      timer.scope,
      timer.dueAt,
      note,
      timer.setBy,
    );
    return changes > 0 ? "set" : "exists";
  }

  async timerCancel(id: string): Promise<boolean> {
    return (
      this.run("UPDATE proactive_timers SET state='cancelled' WHERE id=? AND state='pending'", id) >
      0
    );
  }

  async timersDue(now: Millis, limit: number): Promise<TimerRecord[]> {
    const rows = this.all(
      "SELECT * FROM proactive_timers WHERE state='pending' AND dueAt<=? ORDER BY dueAt LIMIT ?",
      now,
      limit,
    );
    return Promise.all(rows.map((r) => this.timerFromRow(r)));
  }

  async timerMarkFired(id: string): Promise<void> {
    this.run("UPDATE proactive_timers SET state='fired' WHERE id=? AND state='pending'", id);
  }

  async timerGet(id: string): Promise<TimerRecord | undefined> {
    const row = this.get("SELECT * FROM proactive_timers WHERE id=?", id);
    return row ? await this.timerFromRow(row) : undefined;
  }

  async nextTimerDue(): Promise<Millis | null> {
    const row = this.get("SELECT MIN(dueAt) AS next FROM proactive_timers WHERE state='pending'");
    return row?.next == null ? null : num(row.next);
  }

  async hasPendingTimer(scope: string, idPrefix: string): Promise<boolean> {
    return (
      this.get(
        `SELECT 1 AS x FROM proactive_timers
         WHERE state='pending' AND scope=? AND substr(id,1,length(?))=? LIMIT 1`,
        scope,
        idPrefix,
        idPrefix,
      ) !== undefined
    );
  }

  async prune(before: Millis): Promise<PruneCounts> {
    return this.tx(() => {
      // Events first, so the inbox rows they pointed at are free to go.
      const events = this.run(
        `DELETE FROM proactive_events WHERE decided=1 AND EXISTS
           (SELECT 1 FROM proactive_inbox i
            WHERE i.source=proactive_events.source AND i.eventId=proactive_events.eventId
              AND i.receivedAt<?)`,
        before,
      );
      this.run(
        `DELETE FROM proactive_inbox WHERE applied=1 AND receivedAt<? AND NOT EXISTS
           (SELECT 1 FROM proactive_events e
            WHERE e.source=proactive_inbox.source AND e.eventId=proactive_inbox.eventId)`,
        before,
      );
      const wakes = this.run(
        "DELETE FROM proactive_wakes WHERE state='delivered' AND decidedAt<?",
        before,
      );
      const timers = this.run(
        "DELETE FROM proactive_timers WHERE state<>'pending' AND dueAt<?",
        before,
      );
      const effects = this.run(
        "DELETE FROM proactive_effects WHERE state='sent' AND createdAt<?",
        before,
      );
      return { events, wakes, timers, effects };
    });
  }

  async knownScopes(limit: number, after = ""): Promise<string[]> {
    return this.all(
      `SELECT scope FROM (
         SELECT scope FROM proactive_scopes UNION SELECT scope FROM proactive_inbox
         UNION SELECT scope FROM proactive_events UNION SELECT scope FROM proactive_wakes
         UNION SELECT scope FROM proactive_timers)
       WHERE scope > ? ORDER BY scope LIMIT ?`,
      after,
      limit,
    ).map((r) => String(r.scope));
  }

  async deleteScope(scope: string): Promise<void> {
    this.tx(() => {
      for (const table of [
        "proactive_inbox",
        "proactive_events",
        "proactive_wakes",
        "proactive_timers",
        "proactive_scopes",
      ]) {
        this.run(`DELETE FROM ${table} WHERE scope=?`, scope);
      }
    });
  }
}
