import type { BotRuntimeProfile } from "@rakazo/contracts";
import { selfConfigEnabledForBot } from "./self-config-bots.js";

export type MemoryShareLevel = "off" | "read" | "read+propose";

/**
 * Effective shared-memory participation for a bot. Off unless the bot is on the per-bot
 * self-config switch AND its profile opts in, so nothing shares until a bot opts in. No level
 * ever writes to a shared bank directly: read+propose only feeds learning candidates.
 */
export function memoryShareLevel(
  botId: string | null | undefined,
  profile: Pick<BotRuntimeProfile, "learning"> | null | undefined,
  env: Record<string, string | undefined> = process.env,
): MemoryShareLevel {
  if (!selfConfigEnabledForBot(botId, env)) return "off";
  return profile?.learning?.share ?? "off";
}

/** Read order for memory injection: private first, then Space-shared, then owner-global. */
export const MEMORY_READ_ORDER = ["bot", "space", "owner"] as const;
