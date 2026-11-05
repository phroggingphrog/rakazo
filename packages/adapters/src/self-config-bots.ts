/**
 * Per-bot switch for the self-config features (tool selection, the proactive routine source and
 * learning candidates). Each feature keeps its own deployment-wide flag; this list turns all three
 * on for the named bots only, so one bot can try them while every other bot stays unchanged.
 * Comma-separated bot ids; "*" names every bot. Unset or empty opts no bot in.
 */
export const SELF_CONFIG_BOTS_FLAG = "RAKAZO_SELF_CONFIG_BOTS";

export function selfConfigBots(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env[SELF_CONFIG_BOTS_FLAG] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** True when the bot is on the per-bot list. */
export function selfConfigEnabledForBot(
  botId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!botId) return false;
  const bots = selfConfigBots(env);
  return bots.has("*") || bots.has(botId);
}
