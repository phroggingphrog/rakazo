import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { z } from "zod";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";

const searchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullable().optional(),
      url: z.string().max(8_192),
      snippet: z.string().nullable().optional(),
    }),
  ),
});
const fetchSchema = z.object({
  url: z.string().max(8_192),
  title: z.string().nullable().optional(),
  markdown: z.string(),
});

export type PhrogWebOptions = {
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/**
 * Web tools backed by the operator's own phrog-web gateway (`/api/search`, `/api/fetch`).
 * The base URL is operator configuration (PHROG_WEB_URL) and is intentionally allowed to be a
 * private address; the bot-supplied page URL is only ever sent to the gateway as data.
 */
export class PhrogWebProvider implements WebProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly searchTimeoutMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(options: PhrogWebOptions = {}) {
    const baseUrl = (options.baseUrl ?? process.env.PHROG_WEB_URL ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("PHROG_WEB_URL is required for WEB_PROVIDER=phrog-web");
    this.baseUrl = baseUrl;
    this.token = (options.token ?? process.env.PHROG_WEB_TOKEN ?? "").trim();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 30_000;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 60_000;
  }

  describe() {
    return {
      id: "phrog-web",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: true, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const limit = clampMaxResults(request.maxResults);
    const url = new URL(`${this.baseUrl}/api/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    const body = await this.request(url, { method: "GET" }, this.searchTimeoutMs, [
      request.signal,
      context.signal,
    ]);
    const parsed = searchSchema.parse(body);
    return parsed.results.slice(0, limit).map((hit) => ({
      title: hit.title?.trim() || hit.url,
      url: hit.url,
      snippet: hit.snippet?.trim() ?? "",
    }));
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    const body = await this.request(
      new URL(`${this.baseUrl}/api/fetch`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: request.url }),
      },
      this.fetchTimeoutMs,
      [request.signal, context.signal],
    );
    const page = fetchSchema.parse(body);
    if (!page.markdown.trim()) throw new Error(`Failed to fetch content from ${request.url}`);
    return {
      url: page.url,
      title: page.title?.trim() || "Untitled",
      ...pageWindow(page.markdown.slice(offset), maxChars, offset),
    };
  }

  private async request(
    url: URL,
    init: RequestInit,
    timeoutMs: number,
    signals: (AbortSignal | undefined)[],
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...signals.filter((s): s is AbortSignal => s !== undefined),
    ]);
    const response = await this.fetchImpl(url, { ...init, headers, signal });
    if (!response.ok) throw new Error(`phrog-web answered HTTP ${response.status}`);
    return response.json();
  }
}
