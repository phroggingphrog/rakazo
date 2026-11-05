import { describe, expect, it } from "vitest";
import { parseFactLines, planMemoryFacts } from "./facts.js";

describe("memory fact lines", () => {
  it("keeps one trimmed line per fact in document order and skips headings", () => {
    const content =
      "# Projects\n\n  Deploy runs on Wednesdays.  \nReview happens on Fridays.\n# Notes\n";
    expect(parseFactLines(content)).toEqual([
      "Deploy runs on Wednesdays.",
      "Review happens on Fridays.",
    ]);
  });

  it("collapses an exact repeated line", () => {
    expect(parseFactLines("Same fact.\nSame fact.\n")).toEqual(["Same fact."]);
  });
});

describe("memory fact planning", () => {
  const live = [
    { id: "fact-1", text: "Deploy runs on Wednesdays." },
    { id: "fact-2", text: "Review happens on Fridays." },
  ];

  it("adds every line of a new document", () => {
    expect(planMemoryFacts([], "One.\nTwo.")).toEqual({
      added: ["One.", "Two."],
      invalidated: [],
      supersedes: new Map(),
    });
  });

  it("treats a rewrite that drops one fact and adds one as a correction", () => {
    const plan = planMemoryFacts(
      live,
      "Deploy runs on Thursdays.\nReview happens on Fridays.",
    );
    expect(plan.invalidated).toEqual([
      { id: "fact-1", text: "Deploy runs on Wednesdays." },
    ]);
    expect(plan.added).toEqual(["Deploy runs on Thursdays."]);
    expect(plan.supersedes.get("Deploy runs on Thursdays.")).toBe("fact-1");
  });

  it("links a split correction to the single fact it replaced", () => {
    const plan = planMemoryFacts(
      [{ id: "fact-9", text: "Deploy is weekly." }],
      "Deploy is Mondays.\nDeploy is Thursdays.",
    );
    expect([...plan.supersedes.values()]).toEqual(["fact-9", "fact-9"]);
  });

  it("invalidates without linking when one save drops several facts", () => {
    const plan = planMemoryFacts(live, "Review happens on Fridays.");
    expect(plan.invalidated.map((fact) => fact.id)).toEqual(["fact-1"]);
    const rewrite = planMemoryFacts(live, "Everything moved.");
    expect(rewrite.invalidated).toHaveLength(2);
    expect(rewrite.supersedes.size).toBe(0);
  });

  it("plans nothing when the saved content asserts the same facts", () => {
    expect(
      planMemoryFacts(
        live,
        "Deploy runs on Wednesdays.\nReview happens on Fridays.",
      ),
    ).toEqual({
      added: [],
      invalidated: [],
      supersedes: new Map(),
    });
  });
});
