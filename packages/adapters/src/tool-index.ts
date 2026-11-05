import type { ConnectorTool } from "@rakazo/adapter-kit";

/**
 * A derived, in-process capability index.
 *
 * It is not a second catalog: it never enumerates anything itself. It records what the
 * discovery sources that already own enumeration reported on the way past, so a run can
 * rank the same set those sources authorized. Nothing here reads a database or the network,
 * and the whole structure is bounded and in memory.
 */

/** Which discovery source offered an indexed tool. */
export type ToolSourceKind = "mcp" | "installed" | "connector";

export interface ToolSource {
  kind: ToolSourceKind;
  /** The id of the thing that offered the tool: an MCP server id, a capability install id,
   *  or the connector registry id for a provider library. */
  id: string;
}

export interface ToolIndexScope {
  spaceId: string;
  /** The bot the entries are bound to, or null when the caller indexes without one. */
  botId: string | null;
}

export interface ToolIndexEntry {
  /** The name the source offered, after the registry's collision rule ran. */
  name: string;
  source: ToolSource;
  spaceId: string;
  botId: string | null;
  /** Digest of the offered description, so a changed description is visible as drift. */
  descriptionDigest: string;
  firstSeenAt: number;
  /** The last time a successful enumeration listed this tool. */
  lastConfirmedAt: number;
  /** When a later enumeration stopped listing it, or null while it is still listed. */
  absentSince: number | null;
  /** True when the source that owns this entry still offered other tools when it went absent. */
  sourceStillLive: boolean;
}

export type ToolWithheldReason = "stale" | "dropped" | "grace-expired";

export interface ToolWithheldEntry {
  name: string;
  reason: ToolWithheldReason;
}

export interface ToolIndexSnapshot {
  /** Stable digest of the servable entries; equal content gives an equal revision. */
  revision: string;
  observedAt: number | null;
  /** Name-sorted entries a run may offer. */
  entries: ToolIndexEntry[];
  /** Entries the index knows about but refuses to offer, with the reason. */
  withheld: ToolWithheldEntry[];
}

/** Successful and failed uses of one tool by the bot that owns the scope. */
export interface ToolUsageCounts {
  successes: number;
  failures: number;
}

export interface ToolIndexWindows {
  /** How long an entry whose site of enumeration went silent stays usable. */
  graceMs: number;
  /** How long an entry stays usable without any confirmation at all. */
  freshnessMs: number;
}

/**
 * Both windows are multiples of the existing MCP health re-probe cadence in
 * apps/api/src/mcp-servers.ts, which re-probes assigned servers every 10 minutes.
 * A run also re-enumerates on every turn, so in practice a live source refreshes well
 * inside the freshness window.
 */
export const DEFAULT_TOOL_INDEX_WINDOWS: ToolIndexWindows = {
  graceMs: 15 * 60_000,
  freshnessMs: 60 * 60_000,
};

export const EMPTY_TOOL_INDEX_REVISION = "none";

const DEFAULT_MAX_SCOPES = 256;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 4_000;

const MCP_OFFERED_NAME = /^mcp__(.+?)__(.+)$/;

/** Project the discovery source out of the route the offering connector already set. */
export function toolSource(tool: ConnectorTool): ToolSource {
  const route = tool.route;
  const offeredSlug = MCP_OFFERED_NAME.exec(tool.name)?.[1];
  if (route?.connectorId === "mcp" || (!route?.connectorId && offeredSlug)) {
    return { kind: "mcp", id: route?.resourceId ?? offeredSlug ?? "mcp" };
  }
  if (route?.connectorId === "installed") {
    return { kind: "installed", id: route.resourceId ?? "installed" };
  }
  return { kind: "connector", id: route?.resourceId ?? route?.connectorId ?? "connector" };
}

/** 32-bit FNV-1a, so a description change is visible without storing the description. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function scopeKey(scope: ToolIndexScope): string {
  return `${scope.spaceId}::${scope.botId ?? "*"}`;
}

function sourceKey(source: ToolSource): string {
  return `${source.kind}:${source.id}`;
}

interface ScopeState {
  entries: Map<string, ToolIndexEntry>;
  observedAt: number | null;
  usage: Map<string, ToolUsageCounts>;
}

export interface ObserveToolsInput {
  scope: ToolIndexScope;
  /** The tools the discovery sources offered this time, after their own authorization. */
  tools: readonly ConnectorTool[];
  now: number;
  /** Sources whose enumeration failed; their entries keep their grace instead of being dropped. */
  failedSources?: readonly ToolSource[];
}

export interface ToolIndexOptions {
  windows?: ToolIndexWindows;
  maxScopes?: number;
  maxEntriesPerScope?: number;
}

export class ToolIndex {
  private readonly windows: ToolIndexWindows;
  private readonly maxScopes: number;
  private readonly maxEntriesPerScope: number;
  /** Insertion order is least-recently-used first. */
  private readonly scopes = new Map<string, ScopeState>();

  constructor(options: ToolIndexOptions = {}) {
    this.windows = options.windows ?? DEFAULT_TOOL_INDEX_WINDOWS;
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
    this.maxEntriesPerScope = options.maxEntriesPerScope ?? DEFAULT_MAX_ENTRIES_PER_SCOPE;
  }

  /**
   * Record a successful enumeration. A tool that is missing now is withheld at once when
   * its source still offered other tools (the source answered and dropped it), and only
   * after the grace window when the whole source went quiet (it may have failed, and a
   * live-only provider's outage must withhold rather than delete).
   */
  observe(input: ObserveToolsInput): ToolIndexSnapshot {
    const { scope, tools, now } = input;
    const state = this.stateFor(scope);
    const failed = new Set((input.failedSources ?? []).map(sourceKey));
    const liveSources = new Set<string>();
    const seen = new Set<string>();
    for (const tool of tools) {
      const source = toolSource(tool);
      liveSources.add(sourceKey(source));
      seen.add(tool.name);
      const previous = state.entries.get(tool.name);
      state.entries.set(tool.name, {
        name: tool.name,
        source,
        spaceId: scope.spaceId,
        botId: scope.botId,
        descriptionDigest: digest(tool.description ?? ""),
        firstSeenAt: previous?.firstSeenAt ?? now,
        lastConfirmedAt: now,
        absentSince: null,
        sourceStillLive: false,
      });
    }
    for (const [name, entry] of state.entries) {
      if (seen.has(name)) continue;
      const key = sourceKey(entry.source);
      // A source that reported its own failure says nothing about its tools.
      if (failed.has(key)) continue;
      state.entries.set(name, {
        ...entry,
        absentSince: entry.absentSince ?? now,
        sourceStillLive: liveSources.has(key),
      });
    }
    this.bound(state);
    state.observedAt = now;
    return this.snapshot(scope, now);
  }

  /**
   * Record that the whole enumeration failed. Nothing is confirmed and nothing is dropped:
   * entries stay servable until the freshness window elapses.
   */
  recordEnumerationFailure(scope: ToolIndexScope, now: number): ToolIndexSnapshot {
    const state = this.scopes.get(scopeKey(scope));
    if (state) this.touch(scopeKey(scope), state);
    return this.snapshot(scope, now);
  }

  snapshot(scope: ToolIndexScope, now: number): ToolIndexSnapshot {
    const state = this.scopes.get(scopeKey(scope));
    if (!state) {
      return { revision: EMPTY_TOOL_INDEX_REVISION, observedAt: null, entries: [], withheld: [] };
    }
    const entries: ToolIndexEntry[] = [];
    const withheld: ToolWithheldEntry[] = [];
    for (const entry of state.entries.values()) {
      const reason = withheldReason(entry, now, this.windows);
      if (reason) withheld.push({ name: entry.name, reason });
      else entries.push(entry);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    withheld.sort((left, right) => left.name.localeCompare(right.name));
    return {
      revision: revisionOf(entries),
      observedAt: state.observedAt,
      entries,
      withheld,
    };
  }

  /** Successful and failed uses this bot recorded for a tool. */
  usageFor(scope: ToolIndexScope): ReadonlyMap<string, ToolUsageCounts> {
    return this.scopes.get(scopeKey(scope))?.usage ?? new Map();
  }

  recordToolOutcome(scope: ToolIndexScope, name: string, succeeded: boolean): void {
    const state = this.stateFor(scope);
    const counts = state.usage.get(name) ?? { successes: 0, failures: 0 };
    state.usage.set(name, {
      successes: counts.successes + (succeeded ? 1 : 0),
      failures: counts.failures + (succeeded ? 0 : 1),
    });
  }

  /** Drop every scope; for shutdown and tests. */
  clear(): void {
    this.scopes.clear();
  }

  get size(): number {
    return this.scopes.size;
  }

  private stateFor(scope: ToolIndexScope): ScopeState {
    const key = scopeKey(scope);
    const existing = this.scopes.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const created: ScopeState = { entries: new Map(), observedAt: null, usage: new Map() };
    this.scopes.set(key, created);
    if (this.scopes.size > this.maxScopes) {
      const oldest = this.scopes.keys().next();
      if (!oldest.done) this.scopes.delete(oldest.value);
    }
    return created;
  }

  private touch(key: string, state: ScopeState): void {
    this.scopes.delete(key);
    this.scopes.set(key, state);
  }

  /** Keep one scope from growing without bound: drop the least recently confirmed entries. */
  private bound(state: ScopeState): void {
    if (state.entries.size <= this.maxEntriesPerScope) return;
    const ordered = [...state.entries.values()].sort(
      (left, right) => left.lastConfirmedAt - right.lastConfirmedAt,
    );
    const excess = state.entries.size - this.maxEntriesPerScope;
    for (const entry of ordered.slice(0, excess)) state.entries.delete(entry.name);
    for (const name of [...state.usage.keys()]) {
      if (!state.entries.has(name)) state.usage.delete(name);
    }
  }
}

/**
 * The index the run path shares. One instance per process: entries are keyed by space and
 * bot, bounded, and refreshed by the enumeration the run already performs, so there is no
 * second scheduler and no cold-build wait - a cold scope simply produces an empty snapshot,
 * which is the documented fallback path.
 */
let sharedIndex: ToolIndex | undefined;

export function runToolIndex(): ToolIndex {
  sharedIndex ??= new ToolIndex();
  return sharedIndex;
}

function withheldReason(
  entry: ToolIndexEntry,
  now: number,
  windows: ToolIndexWindows,
): ToolWithheldReason | null {
  if (now - entry.lastConfirmedAt > windows.freshnessMs) return "stale";
  if (entry.absentSince === null) return null;
  // The source answered and no longer lists the tool: offering it would fail at call time.
  if (entry.sourceStillLive) return "dropped";
  return now - entry.absentSince > windows.graceMs ? "grace-expired" : null;
}

function revisionOf(entries: readonly ToolIndexEntry[]): string {
  if (entries.length === 0) return EMPTY_TOOL_INDEX_REVISION;
  return digest(
    entries
      .map(
        (entry) =>
          `${entry.name}|${entry.descriptionDigest}|${entry.source.kind}|${entry.source.id}`,
      )
      .join("\n"),
  );
}
