import type { ConnectorTool } from "@rakazo/adapter-kit";
import { isOwnerStartedRun } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { FIND_TOOL, USE_TOOL } from "./builtin-tool-bridge.js";
import type { ToolIndexSnapshot, ToolUsageCounts } from "./tool-index.js";

/**
 * Bounded per-turn tool selection.
 *
 * This stage runs strictly AFTER every authorization rule: the caller hands it the set that
 * already survived the allowlists, the disabled-tool set and the run-trigger gates. It may
 * only remove or reorder what survived them, never re-admit anything - a name the caller did
 * not pass in can never appear in the result, whatever the index says.
 */

/** The highest number of connector tools a run may offer. Built-ins are governed by their
 *  own gates and are always kept, because losing shell or read_file to a ranking stage would
 *  break the run rather than save tokens. */
export interface ToolSelectionBudget {
  maxTools: number;
  /** Upper bound on the serialized size of the selected connector tools. */
  maxDescriptionChars: number;
}

export const DEFAULT_TOOL_SELECTION_BUDGET: ToolSelectionBudget = {
  maxTools: 24,
  maxDescriptionChars: 24_000,
};

/** Weight of the usage prior next to the lexical score (which is in 0..1). */
const PRIOR_WEIGHT = 0.35;

/** The part of a ToolIndexSnapshot the selector reads. */
export interface ToolSelectionIndex {
  revision: string;
  /** Names the index currently considers servable. */
  servable: readonly string[];
  /** Names the index holds but refuses to offer, and why. */
  withheld?: readonly { name: string; reason: string }[];
}

export type ToolUsagePrior =
  | ReadonlyMap<string, ToolUsageCounts>
  | Readonly<Record<string, ToolUsageCounts>>;

export type ToolSelectionFallbackCause = "index-unavailable" | "empty-result";

export type ToolSelectionMode =
  | "selected"
  | "interactive-full-set"
  | "fallback"
  | "nothing-to-select";

export interface ToolSelectionEntry {
  name: string;
  kept: boolean;
  /** Null for built-ins, which are never scored. */
  score: number | null;
  detail: string;
}

export interface ToolSelectionRecord {
  /** Index revision the decision was made against. */
  revision: string;
  mode: ToolSelectionMode;
  fallbackCause?: ToolSelectionFallbackCause;
  trigger: string | null;
  interactive: boolean;
  budget: ToolSelectionBudget;
  candidates: number;
  builtins: number;
  selected: number;
  /** Every candidate with the reason it was kept or dropped. */
  entries: ToolSelectionEntry[];
  withheld: {
    /** In the catalog but not offered to this run: the policy filter removed it. */
    byPolicy: string[];
    /** Offered to this run but absent from the derived catalog. */
    notInCatalog: string[];
  };
}

export interface ToolSelectionInput {
  /** The built-in tools that already passed their own gates; always kept. */
  builtins: readonly ConnectorTool[];
  /** The connector tools that survived the allowlists, disabled set and trigger gates. */
  connectorCandidates: readonly ConnectorTool[];
  /** The run trigger, used to decide whether a human is present. */
  trigger: string | null | undefined;
  /** Overrides the owner-started inference (the caller already computes it, including
   *  follow_up-from-user which the trigger alone cannot express). */
  interactive?: boolean;
  /** The request text the lexical score is measured against. */
  request?: string;
  budget?: Partial<ToolSelectionBudget>;
  /** Successful and failed uses this bot recorded; absent means "no prior". */
  usage?: ToolUsagePrior;
  /** The derived catalog, or null when it could not be read. */
  index?: ToolSelectionIndex | null;
}

export interface ToolSelectionResult {
  tools: ConnectorTool[];
  record: ToolSelectionRecord;
}

/**
 * Selection is inert until an operator turns it on for a deployment. Off, the run receives
 * exactly the list the sources authorized, as before this stage existed.
 */
export function toolSelectionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env.RAKAZO_TOOL_SELECTION ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Project a snapshot onto what the selector needs. */
export function selectionIndexOf(
  snapshot: Pick<ToolIndexSnapshot, "revision" | "entries" | "withheld">,
): ToolSelectionIndex {
  return {
    revision: snapshot.revision,
    servable: snapshot.entries.map((entry) => entry.name),
    withheld: snapshot.withheld.map((entry) => ({ name: entry.name, reason: entry.reason })),
  };
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "you",
  "your",
  "are",
  "can",
  "will",
  "any",
  "all",
  "use",
  "using",
  "please",
  "then",
  "than",
  "there",
  "their",
  "have",
  "has",
  "was",
  "were",
  "but",
  "not",
  "out",
  "get",
  "got",
  "its",
  "our",
  "them",
  "they",
  "what",
  "when",
  "which",
  "who",
  "how",
  "need",
  "needs",
  "want",
  "wants",
  "should",
  "could",
  "would",
  "about",
  "just",
  "also",
  "some",
  "one",
  "two",
  "now",
  "let",
  "make",
  "sure",
  "like",
  "this",
  "that",
  "these",
  "those",
  "been",
  "being",
  "does",
  "did",
  "doing",
  "done",
]);

function requestWords(text: string | undefined): Set<string> {
  const words = new Set<string>();
  if (!text) return words;
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3 && !STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

/** Split an offered name into comparable words: camelCase, snake_case, dots and dashes. */
function offeredNameWords(tool: ConnectorTool): Set<string> {
  const words = new Set<string>();
  const sources = [tool.name, tool.route?.toolName ?? ""];
  for (const source of sources) {
    for (const part of source.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)) {
      const word = part.toLowerCase();
      if (word.length >= 2) words.add(word);
    }
  }
  return words;
}

function countsOf(usage: ToolUsagePrior | undefined, name: string): ToolUsageCounts | undefined {
  if (!usage) return undefined;
  if (usage instanceof Map) return usage.get(name);
  const record = usage as Readonly<Record<string, ToolUsageCounts>>;
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/** Laplace-smoothed success rate in 0..1; no history scores 0, so absent data is neutral. */
function priorOf(usage: ToolUsagePrior | undefined, name: string): number {
  const counts = countsOf(usage, name);
  if (!counts) return 0;
  const total = counts.successes + counts.failures;
  if (total <= 0) return 0;
  return counts.successes / (total + 1);
}

function serializedCost(tool: ConnectorTool): number {
  return (
    tool.name.length +
    (tool.description?.length ?? 0) +
    JSON.stringify(tool.inputSchema ?? {}).length
  );
}

function resolveBudget(budget: Partial<ToolSelectionBudget> | undefined): ToolSelectionBudget {
  return {
    maxTools: Math.max(0, Math.floor(budget?.maxTools ?? DEFAULT_TOOL_SELECTION_BUDGET.maxTools)),
    maxDescriptionChars: Math.max(
      0,
      Math.floor(budget?.maxDescriptionChars ?? DEFAULT_TOOL_SELECTION_BUDGET.maxDescriptionChars),
    ),
  };
}

export function selectToolsForRun(input: ToolSelectionInput): ToolSelectionResult {
  const budget = resolveBudget(input.budget);
  const interactive = input.interactive ?? isOwnerStartedRun(input.trigger ?? "", false);
  const revision = input.index?.revision ?? "none";
  const candidates = input.connectorCandidates;
  const builtinNames = new Set(input.builtins.map((tool) => tool.name));
  const record: ToolSelectionRecord = {
    revision,
    mode: "selected",
    trigger: input.trigger ?? null,
    interactive,
    budget,
    candidates: candidates.length,
    builtins: input.builtins.length,
    selected: 0,
    entries: input.builtins.map((tool) => ({
      name: tool.name,
      kept: true,
      score: null,
      detail: tool.name === FIND_TOOL || tool.name === USE_TOOL ? "bridge" : "builtin",
    })),
    withheld: { byPolicy: [], notInCatalog: [] },
  };

  // A human is present: the full set is worth the latency, and a wrong selection would be
  // visible to them. This is the whole point of D3.
  if (interactive) {
    metrics.selections += 1;
    metrics.interactive += 1;
    record.mode = "interactive-full-set";
    record.selected = candidates.length;
    pushCandidates(record, candidates, "interactive");
    return { tools: [...input.builtins, ...candidates], record };
  }

  const fallback = (cause: ToolSelectionFallbackCause): ToolSelectionResult => {
    // Only the built-in entries precede the candidate entries, so this discards any ranking
    // reasons a partial selection already recorded before it gave up.
    record.entries.length = record.builtins;
    record.mode = "fallback";
    record.fallbackCause = cause;
    record.selected = candidates.length;
    pushCandidates(record, candidates, `fallback:${cause}`);
    recordCounters(cause);
    getLogger().warn("tool selection fell back to the unfiltered candidate set", {
      cause,
      revision,
      trigger: record.trigger,
      candidates: candidates.length,
    });
    return { tools: [...input.builtins, ...candidates], record };
  };

  if (candidates.length === 0) {
    record.mode = "nothing-to-select";
    return { tools: [...input.builtins], record };
  }

  const servable = input.index?.servable ?? [];
  if (!input.index || servable.length === 0) return fallback("index-unavailable");

  const servableSet = new Set(servable);
  const candidateNames = new Set(candidates.map((tool) => tool.name));
  const eligible = candidates.filter((tool) => servableSet.has(tool.name));
  record.withheld.byPolicy = servable
    .filter((name) => !candidateNames.has(name) && !builtinNames.has(name))
    .sort((left, right) => left.localeCompare(right));
  record.withheld.notInCatalog = candidates
    .filter((tool) => !servableSet.has(tool.name))
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));

  if (eligible.length === 0) return fallback("empty-result");

  // Rank. Ties break on the offered name, never on iteration order, so the same inputs (in
  // any order) yield the same list for a fixed index revision.
  const words = requestWords(input.request);
  const scored = eligible.map((tool) => {
    const names = offeredNameWords(tool);
    const description = tool.description ?? "";
    let nameHits = 0;
    let descriptionHits = 0;
    for (const word of words) {
      if (names.has(word)) nameHits += 1;
      else if (description.toLowerCase().includes(word)) descriptionHits += 1;
    }
    const lexical = words.size === 0 ? 0 : (2 * nameHits + descriptionHits) / (2 * words.size + 1);
    const prior = priorOf(input.usage, tool.name);
    return { tool, lexical, prior, score: lexical + PRIOR_WEIGHT * prior };
  });
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.tool.name.localeCompare(right.tool.name);
  });

  const kept: ConnectorTool[] = [];
  let usedChars = 0;
  for (const item of scored) {
    if (kept.length >= budget.maxTools) {
      record.entries.push({
        name: item.tool.name,
        kept: false,
        score: item.score,
        detail: `over-budget:count(${budget.maxTools})`,
      });
      continue;
    }
    const cost = serializedCost(item.tool);
    if (usedChars + cost > budget.maxDescriptionChars) {
      record.entries.push({
        name: item.tool.name,
        kept: false,
        score: item.score,
        detail: `over-budget:chars(${budget.maxDescriptionChars})`,
      });
      continue;
    }
    usedChars += cost;
    kept.push(item.tool);
    record.entries.push({ name: item.tool.name, kept: true, score: item.score, detail: "ranked" });
  }

  if (kept.length === 0) return fallback("empty-result");

  record.mode = "selected";
  record.selected = kept.length;
  recordCounters();
  return { tools: [...input.builtins, ...kept], record };
}

function pushCandidates(
  record: ToolSelectionRecord,
  candidates: readonly ConnectorTool[],
  detail: string,
): void {
  for (const tool of candidates) {
    record.entries.push({ name: tool.name, kept: true, score: null, detail });
  }
}

export interface ToolSelectionMetrics {
  selections: number;
  interactive: number;
  fallbacks: number;
  fallbacksByCause: Record<ToolSelectionFallbackCause, number>;
}

const metrics: ToolSelectionMetrics = {
  selections: 0,
  interactive: 0,
  fallbacks: 0,
  fallbacksByCause: { "index-unavailable": 0, "empty-result": 0 },
};

function recordCounters(cause?: ToolSelectionFallbackCause): void {
  metrics.selections += 1;
  if (cause === "index-unavailable" || cause === "empty-result") {
    metrics.fallbacks += 1;
    metrics.fallbacksByCause[cause] += 1;
  }
}

/** Process-lifetime counters; the run path already logs the structured fallback line. */
export function toolSelectionMetrics(): Readonly<ToolSelectionMetrics> {
  return {
    ...metrics,
    fallbacksByCause: { ...metrics.fallbacksByCause },
  };
}

export function resetToolSelectionMetrics(): void {
  metrics.selections = 0;
  metrics.interactive = 0;
  metrics.fallbacks = 0;
  metrics.fallbacksByCause = { "index-unavailable": 0, "empty-result": 0 };
}
