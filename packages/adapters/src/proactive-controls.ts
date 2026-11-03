import type { PgExecutor, PgQueryable } from "@rakazo/proactive";

export const DEFAULT_POLICY_ORDER = ["steer", "dm", "mention", "timer", "rules", "judge"] as const;
export type PolicyStage = typeof DEFAULT_POLICY_ORDER[number];
export interface ProactiveHook { id: string; source: string; contains?: string }
export interface BotProactiveConfig {
  fallbackMs?: number;
  decisionOrder?: PolicyStage[];
  hooks?: ProactiveHook[];
}
export interface ControlState { revision: number; config: BotProactiveConfig }

export function validateProactiveConfig(config: BotProactiveConfig): void {
  if (config.fallbackMs !== undefined && (!Number.isSafeInteger(config.fallbackMs) || config.fallbackMs < 300_000 || config.fallbackMs > 7 * 86_400_000)) throw new Error("Fallback interval must be between five minutes and seven days");
  if (config.decisionOrder && (config.decisionOrder.length !== DEFAULT_POLICY_ORDER.length || new Set(config.decisionOrder).size !== DEFAULT_POLICY_ORDER.length || config.decisionOrder.some(stage => !DEFAULT_POLICY_ORDER.includes(stage)))) throw new Error("Decision order must contain every policy stage exactly once");
  if (config.hooks && (config.hooks.length > 20 || new Set(config.hooks.map(hook => hook.id)).size !== config.hooks.length || config.hooks.some(hook => !hook.id || hook.id.length > 100 || !hook.source || hook.source.length > 200 || (hook.contains?.length ?? 0) > 500))) throw new Error("Invalid hooks: at most twenty unique bounded hooks are allowed");
}

export class PgProactiveControls {
  constructor(private readonly db: PgExecutor) {}

  async get(scope: string): Promise<ControlState> {
    const result = await this.db.query(`SELECT "revision", "config" FROM "proactive_controls" WHERE "scope"=$1`, [scope]);
    return (result.rows[0] as unknown as ControlState | undefined) ?? { revision: 0, config: {} };
  }

  async change<T>(scope: string, actor: string, action: string, details: Record<string, unknown>, fn: (state: ControlState, tx: PgQueryable) => Promise<{ config?: BotProactiveConfig; result: T }>, now = Date.now()): Promise<T> {
    return this.db.transaction(async tx => {
      await tx.query(`INSERT INTO "proactive_controls" ("scope") VALUES ($1) ON CONFLICT DO NOTHING`, [scope]);
      const row = (await tx.query(`SELECT "revision", "config", "day", "wakeCount" FROM "proactive_controls" WHERE "scope"=$1 FOR UPDATE`, [scope])).rows[0] as unknown as ControlState & { day: string; wakeCount: number };
      if (action === "wake" || action === "timer") {
        const day = new Date(now).toISOString().slice(0, 10);
        const count = row.day === day ? row.wakeCount : 0;
        if (count >= 20) throw new Error("Self-set wake limit reached: twenty per UTC day");
        await tx.query(`UPDATE "proactive_controls" SET "day"=$2, "wakeCount"=$3 WHERE "scope"=$1`, [scope, day, count + 1]);
      }
      const changed = await fn(row, tx);
      const config = changed.config ?? row.config;
      validateProactiveConfig(config);
      const revision = row.revision + 1;
      await tx.query(`UPDATE "proactive_controls" SET "revision"=$2, "config"=$3::jsonb WHERE "scope"=$1`, [scope, revision, JSON.stringify(config)]);
      await tx.query(`INSERT INTO "proactive_control_audit" ("scope", "revision", "at", "actor", "action", "details") VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [scope, revision, now, actor, action, JSON.stringify(details)]);
      return changed.result;
    });
  }
}
