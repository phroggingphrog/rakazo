import type { EffectSink } from "./ports.js";
import type { EffectResult } from "./types.js";

export interface HttpSinkOptions {
  name?: string;
  /** Defaults to global fetch. */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * Posts a JSON body to the `to` URL with `Idempotency-Key: <sendId>`.
 *
 * Send-once (I9) holds only if the receiver treats a repeated key as the same request, which
 * is what the header means. A plain URL cannot be asked "did you get sendId X?", so
 * `findSent` reports "unknown" and a recovery send repeats the key and lets the receiver
 * absorb it. Do not point this at a receiver that ignores the header.
 */
export class HttpIdempotentSink implements EffectSink {
  readonly name: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: HttpSinkOptions = {}) {
    this.name = options.name ?? "http";
    this.doFetch = options.fetch ?? fetch;
  }

  async send(sendId: string, to: string, payload: unknown): Promise<EffectResult> {
    const res = await this.doFetch(to, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": sendId,
        ...this.options.headers,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
    return { externalId: res.headers.get("x-request-id") ?? undefined };
  }

  async findSent(): Promise<EffectResult | undefined> {
    return undefined;
  }
}
