import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export const MCP_OUTPUT_LIMITS = {
  ttlMs: 60 * 60 * 1000,
  fullBytes: 2 * 1024 * 1024,
  pageBytes: 4 * 1024,
  previewBytes: 4 * 1024,
  runQuotaBytes: 8 * 1024 * 1024,
} as const;

export interface McpOutputScope {
  spaceId: string;
  userId: string;
  botId: string;
  runId: string;
  serverId: string;
}

export interface McpOutputStored {
  receipt: string;
  preview: string;
  bytes: number;
  storedBytes: number;
  sha256: string;
  truncated: boolean;
  expiresAt: number;
}

export interface McpOutputPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  bytes: number;
  totalBytes: number;
  sha256: string;
  truncated: boolean;
}

type ReceiptBody = McpOutputScope & { id: string; exp: number };

export interface McpOutputMetadata {
  id: string;
  storageId: string;
  spaceId: string;
  userId: string;
  botId: string;
  runId: string;
  serverId: string;
  bytes: number;
  expiresAt: Date;
}

/** Back this interface with the `mcp_tool_outputs` table. */
export interface McpOutputLedger {
  createUnderRunLock(record: McpOutputMetadata): Promise<void>;
  findOwned(id: string, scope: McpOutputScope): Promise<McpOutputMetadata | null>;
  listExpired(now: Date, limit: number): Promise<McpOutputMetadata[]>;
  delete(id: string): Promise<void>;
}

/** Prisma ledger. Run lock and quota check share the transaction that inserts the row. */
export class PrismaMcpOutputLedger implements McpOutputLedger {
  constructor(private readonly db: PrismaClient) {}

  async createUnderRunLock(record: McpOutputMetadata) {
    await this.db.$transaction(async (tx) => {
      const lockKey = JSON.stringify([record.spaceId, record.userId, record.botId, record.runId]);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-output:${lockKey}`}, 0))`;
      const used = await tx.mcpToolOutput.aggregate({
        where: {
          spaceId: record.spaceId,
          userId: record.userId,
          botId: record.botId,
          runId: record.runId,
          expiresAt: { gt: new Date() },
        },
        _sum: { bytes: true },
      });
      if ((used._sum.bytes ?? 0) + record.bytes > MCP_OUTPUT_LIMITS.runQuotaBytes)
        throw new Error("MCP output run quota exceeded");
      await tx.mcpToolOutput.create({ data: record });
    });
  }

  async findOwned(id: string, scope: McpOutputScope): Promise<McpOutputMetadata | null> {
    const row = await this.db.mcpToolOutput.findFirst({ where: { id, ...scope } });
    return row;
  }

  async listExpired(now: Date, limit: number): Promise<McpOutputMetadata[]> {
    return this.db.mcpToolOutput.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: "asc" },
      take: limit,
    });
  }

  async delete(id: string) {
    await this.db.mcpToolOutput.deleteMany({ where: { id } });
  }
}
const SAFE_ERROR = "MCP output is unavailable, expired, or not authorized";

function scopeKey(scope: McpOutputScope) {
  return JSON.stringify([scope.spaceId, scope.userId, scope.botId, scope.runId, scope.serverId]);
}

function artifactContext(context: AdapterContext, scope: McpOutputScope): AdapterContext {
  return {
    ...context,
    spaceId: scope.spaceId,
    userId: scope.userId,
    botId: scope.botId,
    runId: scope.runId,
  };
}

function textPage(bytes: Uint8Array, start: number, limit: number) {
  let end = Math.min(start + limit, bytes.byteLength);
  // Back up to a UTF-8 leading byte so adjacent pages never split a code point.
  while (end < bytes.byteLength && end > start && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    end,
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(start, end)),
  };
}

/** Stores already-redacted output in encrypted artifacts with durable, per-run quota metadata. */
export class McpOutputStore {
  constructor(
    private readonly artifacts: Pick<ArtifactStore, "put" | "get" | "remove">,
    private readonly ledger: McpOutputLedger,
    private readonly signingKey: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (signingKey.byteLength < 32)
      throw new Error("MCP output signing key must be at least 32 bytes");
  }

  async store(
    redactedOutput: string | Uint8Array,
    scope: McpOutputScope,
    context: AdapterContext,
  ): Promise<McpOutputStored> {
    context.signal.throwIfAborted();
    this.validateScope(scope);
    const input =
      typeof redactedOutput === "string"
        ? Buffer.from(redactedOutput, "utf8")
        : Buffer.from(redactedOutput);
    if (input.byteLength > MCP_OUTPUT_LIMITS.fullBytes)
      throw new Error("MCP output exceeds the 2 MiB storage limit");
    // Do not run global cleanup on a tenant request. A trusted worker calls sweepExpired().
    const expiresAt = this.now() + MCP_OUTPUT_LIMITS.ttlMs;
    const { id: storageId } = await this.artifacts.put(
      {
        name: "mcp-output.txt",
        mimeType: "text/plain; charset=utf-8",
        bytes: new Uint8Array(input),
      },
      artifactContext(context, scope),
    );
    if (context.signal.aborted) {
      void this.artifacts.remove(storageId, artifactContext(context, scope)).catch(() => undefined);
      context.signal.throwIfAborted();
    }
    const id = randomBytes(18).toString("base64url");
    try {
      await this.ledger.createUnderRunLock({
        id,
        storageId,
        ...scope,
        bytes: input.byteLength,
        expiresAt: new Date(expiresAt),
      });
    } catch (error) {
      void this.artifacts.remove(storageId, artifactContext(context, scope)).catch(() => undefined);
      throw error;
    }
    return {
      receipt: this.sign({ ...scope, id, exp: expiresAt }),
      preview: textPage(input, 0, MCP_OUTPUT_LIMITS.previewBytes).text,
      bytes: input.byteLength,
      storedBytes: input.byteLength,
      sha256: createHash("sha256").update(input).digest("hex"),
      truncated: false,
      expiresAt,
    };
  }

  async retrieve(
    receipt: string,
    scope: McpOutputScope,
    context: AdapterContext,
    offset = 0,
    maxBytes = MCP_OUTPUT_LIMITS.pageBytes,
  ): Promise<McpOutputPage> {
    context.signal.throwIfAborted();
    this.validateScope(scope);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error(SAFE_ERROR);
    const body = this.verify(receipt);
    if (!body || body.exp <= this.now() || scopeKey(body) !== scopeKey(scope))
      throw new Error(SAFE_ERROR);
    const record = await this.ledger.findOwned(body.id, scope);
    if (!record || record.expiresAt.getTime() <= this.now() || record.storageId.length === 0)
      throw new Error(SAFE_ERROR);
    try {
      const bytes = await this.artifacts.get(record.storageId, artifactContext(context, scope));
      context.signal.throwIfAborted();
      if (
        offset > bytes.byteLength ||
        (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80)
      )
        throw new Error(SAFE_ERROR);
      const { end, text } = textPage(
        bytes,
        offset,
        Math.min(maxBytes, MCP_OUTPUT_LIMITS.pageBytes),
      );
      return {
        text,
        offset,
        nextOffset: end < bytes.byteLength ? end : null,
        bytes: end - offset,
        totalBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        truncated: false,
      };
    } catch {
      throw new Error(SAFE_ERROR);
    }
  }

  private validateScope(scope: McpOutputScope) {
    if (!scope.spaceId || !scope.userId || !scope.botId || !scope.runId || !scope.serverId)
      throw new Error(SAFE_ERROR);
  }

  private sign(body: ReceiptBody) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.signingKey, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(body), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const payload = Buffer.concat([nonce, encrypted]).toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private verify(receipt: string): ReceiptBody | undefined {
    try {
      const [payload, signature, extra] = receipt.split(".");
      if (!payload || !signature || extra !== undefined) return;
      const expected = createHmac("sha256", this.signingKey).update(payload).digest();
      const supplied = Buffer.from(signature, "base64url");
      if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied))
        return;
      const packed = Buffer.from(payload, "base64url");
      if (packed.byteLength < 29) return;
      const decipher = createDecipheriv("aes-256-gcm", this.signingKey, packed.subarray(0, 12));
      decipher.setAuthTag(packed.subarray(-16));
      const value: unknown = JSON.parse(
        Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString(
          "utf8",
        ),
      );
      if (!value || typeof value !== "object") return;
      const body = value as ReceiptBody;
      if (
        typeof body.id !== "string" ||
        typeof body.exp !== "number" ||
        !body.spaceId ||
        !body.userId ||
        !body.botId ||
        !body.runId ||
        !body.serverId
      )
        return;
      return body;
    } catch {
      return;
    }
  }

  /** Removes at most `limit` expired rows. The ledger must run with trusted system DB access. */
  async sweepExpired(context: AdapterContext, limit = 256): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error("Invalid MCP output sweep limit");
    const expired = await this.ledger.listExpired(new Date(this.now()), limit);
    let cleaned = 0;
    for (const row of expired) {
      context.signal.throwIfAborted();
      try {
        await this.artifacts.remove(row.storageId, artifactContext(context, row));
        context.signal.throwIfAborted();
        await this.ledger.delete(row.id);
        cleaned++;
      } catch (error) {
        context.signal.throwIfAborted();
        // Keep the ledger row when artifact removal fails. A later sweep can retry safely.
      }
    }
    return cleaned;
  }
}
