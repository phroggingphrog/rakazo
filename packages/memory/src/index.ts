import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRemoveRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";
import { planMemoryFacts } from "./facts.js";

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        ...(request.scope === "all" ? {} : { scope: request.scope }),
        ...(request.botId ? { botId: request.botId } : {}),
      },
    });
    const q = request.query.toLowerCase();
    return documents
      .filter((doc) => doc.content.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q))
      .map((doc) => ({
        path: doc.path,
        snippet: snippet(doc.content, q),
        score: 1,
      }));
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // A save replaces the current content, appends its history and moves the facts the new
    // content adds or drops, all atomically. A fact the save no longer contains is invalidated
    // from this revision rather than deleted, so the correction and what it replaced both stay
    // readable. Conflicts retry the whole transaction so revision numbers use fresh state.
    return withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.memoryDocument.findFirst({
            where: {
              spaceId: context.spaceId,
              userId: context.userId,
              scope: request.scope,
              botId: request.botId ?? null,
              path: request.path,
            },
          });
          if (request.expectedRevision !== undefined) {
            const live = existing?.revision ?? 0;
            if (live !== request.expectedRevision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
          }
          const doc = existing
            ? await tx.memoryDocument.update({
                where: { id: existing.id },
                data: { content: request.content, revision: existing.revision + 1 },
              })
            : await tx.memoryDocument.create({
                data: {
                  spaceId: context.spaceId,
                  userId: context.userId,
                  botId: request.botId,
                  scope: request.scope,
                  path: request.path,
                  content: request.content,
                },
              });
          await tx.memoryRevision.create({
            data: {
              documentId: doc.id,
              revision: doc.revision,
              content: request.content,
              sourceRunId: request.sourceRunId,
              sourceThreadId: request.sourceThreadId,
            },
          });
          await recordFacts(tx, doc.id, doc.revision, request);
          return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  /** Facts the document has asserted, newest revision first, including the invalidated ones. */
  async facts(documentId: string, context: AdapterContext) {
    // A document id alone is not an authorisation: the caller must own it in this space.
    const document = await this.prisma.memoryDocument.findFirst({
      where: { id: documentId, spaceId: context.spaceId, userId: context.userId },
      select: { id: true },
    });
    if (!document) return [];
    return this.prisma.memoryFact.findMany({
      where: { documentId },
      orderBy: [{ validFromRevision: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
  }

  async remove(
    request: MemoryRemoveRequest,
    context: AdapterContext,
  ): Promise<{ removed: boolean }> {
    // Revisions cascade with the document row.
    const { count } = await this.prisma.memoryDocument.deleteMany({
      where: {
        ...(request.id ? { id: request.id } : {}),
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        botId: request.botId ?? null,
        path: request.path,
      },
    });
    return { removed: count > 0 };
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

/**
 * Record which facts start and stop being true at one document revision. The revision and the fact
 * rows are written by the same transaction, so a fact can never point at a revision that was not
 * stored. A correction stamps the earlier fact invalid at the instant the new one takes over,
 * which keeps one current fact per line and the earlier one readable.
 */
async function recordFacts(
  tx: Prisma.TransactionClient,
  documentId: string,
  revision: number,
  request: MemoryCommitRequest,
): Promise<void> {
  const live = await tx.memoryFact.findMany({
    where: { documentId, invalidFrom: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, text: true },
  });
  const plan = planMemoryFacts(live, request.content);
  if (plan.invalidated.length === 0 && plan.added.length === 0) return;
  const at = new Date();
  if (plan.invalidated.length > 0) {
    await tx.memoryFact.updateMany({
      where: { id: { in: plan.invalidated.map((fact) => fact.id) }, invalidFrom: null },
      data: { invalidFrom: at, invalidFromRevision: revision },
    });
  }
  if (plan.added.length > 0) {
    await tx.memoryFact.createMany({
      data: plan.added.map((text) => ({
        documentId,
        text,
        validFrom: at,
        validFromRevision: revision,
        supersedesFactId: plan.supersedes.get(text) ?? null,
        sourceRunId: request.sourceRunId ?? null,
        sourceThreadId: request.sourceThreadId ?? null,
      })),
    });
  }
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}
