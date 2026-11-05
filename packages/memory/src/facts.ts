/**
 * Fact-level validity for durable memory.
 *
 * A memory document stays the live copy and its revisions stay the document history. This module
 * turns the difference between the facts that were live before a commit and the lines the commit
 * contains into the facts that start and stop being true, so a correction invalidates an earlier
 * fact instead of deleting it.
 *
 * Matching is exact text, the same rule `appendMemoryFact` already uses to skip a repeated line.
 * Nothing here judges whether two sentences mean the same thing: the writer corrects memory by
 * saving the document without the fact it replaced, and that omission is what invalidates it.
 */

/** One fact that is currently live on a document. */
export interface LiveMemoryFact {
  id: string;
  text: string;
}

export interface MemoryFactPlan {
  /** Facts that start being true in this commit, in document order. */
  added: string[];
  /** Facts that stop being true in this commit because the document no longer contains them. */
  invalidated: LiveMemoryFact[];
  /** New fact text to the id of the fact it replaces, when this commit reads as one correction. */
  supersedes: Map<string, string>;
}

const HEADING = /^#{1,6}\s/;

/**
 * Split a document into the facts it asserts: one per trimmed, non-empty line, in document order,
 * with exact repeats collapsed. Markdown headings are structure rather than facts.
 */
export function parseFactLines(content: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of content.split("\n")) {
    const text = raw.trim();
    if (text === "" || HEADING.test(text) || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }
  return lines;
}

/**
 * Compare the facts that are live now with the lines a commit is about to store.
 *
 * A commit that drops one fact and adds at least one reads as a correction, so every added fact
 * points at the one it replaced. A commit that drops several facts at once (a rewrite or a merge)
 * records the invalidation without guessing which new fact replaced which old one.
 */
export function planMemoryFacts(live: readonly LiveMemoryFact[], content: string): MemoryFactPlan {
  const next = parseFactLines(content);
  const nextTexts = new Set(next);
  const liveTexts = new Set(live.map((fact) => fact.text));
  const invalidated = live.filter((fact) => !nextTexts.has(fact.text));
  const added = next.filter((text) => !liveTexts.has(text));
  const supersedes = new Map<string, string>();
  if (invalidated.length === 1) {
    const replaced = invalidated[0]!;
    for (const text of added) supersedes.set(text, replaced.id);
  }
  return { added, invalidated, supersedes };
}
