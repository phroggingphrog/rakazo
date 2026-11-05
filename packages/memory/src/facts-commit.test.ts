import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "memory-facts",
  traceId: "memory-facts",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

type Document = {
  id: string;
  spaceId: string;
  userId: string;
  scope: string;
  botId: string | null;
  path: string;
  content: string;
  revision: number;
};

type Fact = {
  id: string;
  documentId: string;
  text: string;
  validFrom: Date;
  validFromRevision: number;
  invalidFrom: Date | null;
  invalidFromRevision: number | null;
  supersedesFactId: string | null;
  sourceRunId: string | null;
  sourceThreadId: string | null;
  createdAt: Date;
};

/** Enough of the client shape for commit and facts, with the transaction inline. */
function fakeClient() {
  const documents: Document[] = [];
  const revisions: Array<{
    documentId: string;
    revision: number;
    content: string;
  }> = [];
  const facts: Fact[] = [];
  let seq = 0;
  const matches = (document: Document, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "botId") return document.botId === (value ?? null);
      return (document as Record<string, unknown>)[key] === value;
    });
  const memoryDocument = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      documents.find((document) => matches(document, where)) ?? null,
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<Document>;
    }) => {
      const document = documents.find(
        (candidate) => candidate.id === where.id,
      )!;
      Object.assign(document, data);
      return document;
    },
    create: async ({ data }: { data: Omit<Document, "id"> }) => {
      const document = {
        ...data,
        id: `document-${++seq}`,
        revision: data.revision ?? 1,
        botId: data.botId ?? null,
      } as Document;
      documents.push(document);
      return document;
    },
  };
  const memoryFact = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const out = facts
        .filter(
          (fact) =>
            fact.documentId === where.documentId &&
            (where.invalidFrom === null ? fact.invalidFrom === null : true),
        )
        .map((fact) => ({ id: fact.id, text: fact.text }));
      return out;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: { in: string[] }; invalidFrom: null };
      data: { invalidFrom: Date; invalidFromRevision: number };
    }) => {
      let count = 0;
      for (const fact of facts) {
        if (!where.id.in.includes(fact.id) || fact.invalidFrom !== null)
          continue;
        fact.invalidFrom = data.invalidFrom;
        fact.invalidFromRevision = data.invalidFromRevision;
        count += 1;
      }
      return { count };
    },
    createMany: async ({
      data,
    }: {
      data: Array<Omit<Fact, "id" | "createdAt">>;
    }) => {
      for (const row of data) {
        facts.push({
          ...row,
          id: `fact-${++seq}`,
          createdAt: new Date(),
          invalidFrom: row.invalidFrom ?? null,
          invalidFromRevision: row.invalidFromRevision ?? null,
        } as Fact);
      }
      return { count: data.length };
    },
  };
  const tx = {
    memoryDocument,
    memoryFact,
    memoryRevision: {
      create: async ({
        data,
      }: {
        data: { documentId: string; revision: number; content: string };
      }) => {
        revisions.push(data);
        return data;
      },
    },
  };
  const prisma = {
    memoryDocument,
    memoryFact: {
      findMany: async ({ where }: { where: { documentId: string } }) =>
        facts.filter((fact) => fact.documentId === where.documentId),
    },
    $transaction: async <T>(run: (client: typeof tx) => Promise<T>) => run(tx),
  };
  return { prisma, documents, revisions, facts };
}

const commit = (content: string) => ({
  scope: "user" as const,
  path: "MEMORY.md",
  content,
});
const request = (content: string) => ({
  ...commit(content),
  sourceRunId: `run-${content.length}`,
  sourceThreadId: "thread-1",
});

describe("fact-level memory validity", () => {
  it("invalidates the earlier fact at the revision that corrected it and keeps both readable", async () => {
    const { prisma, facts } = fakeClient();
    const store = new MarkdownMemoryStore(prisma as never);
    const first = await store.commit(
      request("Deploy runs on Wednesdays."),
      context,
    );
    await store.commit(
      request("Deploy runs on Wednesdays.\nReview happens on Fridays."),
      context,
    );
    const corrected = await store.commit(
      request("Deploy runs on Thursdays.\nReview happens on Fridays."),
      context,
    );

    const stale = facts.find(
      (fact) => fact.text === "Deploy runs on Wednesdays.",
    )!;
    const current = facts.find(
      (fact) => fact.text === "Deploy runs on Thursdays.",
    )!;
    expect(stale.invalidFromRevision).toBe(corrected.revision);
    expect(current.invalidFrom).toBeNull();
    expect(current.supersedesFactId).toBe(stale.id);
    expect(corrected.content).not.toContain("Wednesdays");
    await expect(store.facts(first.id, context)).resolves.toHaveLength(3);
  });

  it("adds a fact without invalidating anything when a save only appends", async () => {
    const { prisma, facts } = fakeClient();
    const store = new MarkdownMemoryStore(prisma as never);
    await store.commit(request("Deploy runs on Wednesdays."), context);
    await store.commit(
      request("Deploy runs on Wednesdays.\nReview happens on Fridays."),
      context,
    );
    expect(facts.filter((fact) => fact.invalidFrom === null)).toHaveLength(2);
    expect(facts.every((fact) => fact.invalidFrom === null)).toBe(true);
  });

  it("records a rewrite without guessing which new fact replaced which old one", async () => {
    const { prisma, facts } = fakeClient();
    const store = new MarkdownMemoryStore(prisma as never);
    await store.commit(
      request("Deploy runs on Wednesdays.\nReview happens on Fridays."),
      context,
    );
    const rewritten = await store.commit(
      request("Deploy runs on Thursdays."),
      context,
    );
    expect(
      facts.filter((fact) => fact.invalidFromRevision === rewritten.revision),
    ).toHaveLength(2);
    expect(facts.every((fact) => fact.supersedesFactId === null)).toBe(true);
  });
});
