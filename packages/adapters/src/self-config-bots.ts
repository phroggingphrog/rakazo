/**
 * Per-bot switch for the self-config features (tool selection, the proactive routine source and
 * learning candidates). Each feature keeps its own deployment-wide flag; this list decides which
 * bots get all three.
 *
 * On by default: when the variable is unset every bot is opted in (the same as "*").
 * Values (comma-separated):
 *   - "*"            every bot
 *   - "b1,b2"        only the named bots
 *   - "*,-b1" or "-b1" every bot except b1 ("-id" excludes, and exclusion always wins)
 *   - "" / "none" / "off" / "0" / "false"   no bot (explicit opt-out)
 */
export const SELF_CONFIG_BOTS_FLAG = "RAKAZO_SELF_CONFIG_BOTS";

const OFF_VALUES = new Set(["none", "off", "0", "false", "no"]);

export type SelfConfigPolicy = {
  /** Every bot is in unless excluded. */
  all: boolean;
  /** Bots named explicitly. */
  include: Set<string>;
  /** Bots excluded with "-id"; exclusion wins over "*" and over an include. */
  exclude: Set<string>;
};

export function selfConfigPolicy(
  env: Record<string, string | undefined> = process.env,
): SelfConfigPolicy {
  const raw = env[SELF_CONFIG_BOTS_FLAG];
  if (raw === undefined) return { all: true, include: new Set(), exclude: new Set() };
  const tokens = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const policy: SelfConfigPolicy = { all: false, include: new Set(), exclude: new Set() };
  if (tokens.length === 0 || (tokens.length === 1 && OFF_VALUES.has((tokens[0] ?? "").toLowerCase()))) {
    return policy;
  }
  for (const token of tokens) {
    if (token === "*") policy.all = true;
    else if (token.startsWith("-") && token.length > 1) policy.exclude.add(token.slice(1));
    else if (!OFF_VALUES.has(token.toLowerCase())) policy.include.add(token);
  }
  // Only exclusions given ("-b1"): treat as every bot except those.
  if (!policy.all && policy.include.size === 0 && policy.exclude.size > 0) policy.all = true;
  return policy;
}

/**
 * The opted-in bot ids, with "*" standing for every bot. Kept for callers that only need to
 * know whether any bot is in; prefer selfConfigAnyBot and selfConfigEnabledForBot.
 */
export function selfConfigBots(env: Record<string, string | undefined> = process.env): Set<string> {
  const policy = selfConfigPolicy(env);
  const ids = new Set(policy.include);
  for (const id of policy.exclude) ids.delete(id);
  if (policy.all) ids.add("*");
  return ids;
}

/** True when at least one bot may be opted in, so deployment-level jobs should run. */
export function selfConfigAnyBot(env: Record<string, string | undefined> = process.env): boolean {
  return selfConfigBots(env).size > 0;
}

/** True when the bot is opted in by the per-bot switch. */
export function selfConfigEnabledForBot(
  botId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!botId) return false;
  const policy = selfConfigPolicy(env);
  if (policy.exclude.has(botId)) return false;
  return policy.all || policy.include.has(botId);
}
