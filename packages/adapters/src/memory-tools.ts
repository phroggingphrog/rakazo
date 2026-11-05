import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set([
  "recall_memory",
  "save_memory",
  "forget_memory",
]);

/** `forget_memory` is offered only when the provider implements its optional forget verb. */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  semanticMemoryForgets: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter(
        (tool) => semanticMemoryForgets || tool.name !== "forget_memory",
      )
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}

export function appendMemoryFact(existing: string, fact: string): string {
  const current = existing.trimEnd().replace(/\r\n/g, "\n");
  const next = fact.trim();
  const comparableFact = next.replace(/\r\n/g, "\n");
  if (
    !next ||
    `\n${current}\n`.includes(`\n${comparableFact}\n`) ||
    (!next.includes("\n") &&
      current.split("\n").some((line) => line.trim() === next))
  )
    return existing;
  return existing
    ? `${existing}${existing.endsWith("\n") ? "" : "\n"}${next}\n`
    : `${next}\n`;
}

/**
 * Replace one exact fact line with a new one. Returns null when the old fact is not a line of the
 * document, so a caller never silently appends instead of correcting. Saving the result through
 * the normal commit path invalidates the old fact and links the new one to it (supersede).
 */
export function replaceFactLine(
  content: string,
  oldFact: string,
  newFact: string,
): string | null {
  const target = oldFact.trim();
  const next = newFact.trim();
  if (!target || !next || next.includes("\n")) return null;
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex((line) => line.trim() === target);
  if (index < 0) return null;
  const kept = lines.filter((line, i) => i === index || line.trim() !== next);
  const at = kept.findIndex((line) => line.trim() === target);
  kept[at] = next;
  return kept.join("\n");
}
