import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { PhrogWebProvider } from "./phrog-web.js";
import { createWebProvider } from "./web-provider-factory.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("phrog-web provider", () => {
  it("maps /api/search hits and sends the query and limit", async () => {
    const fetch = vi.fn(async () =>
      json({ results: [{ title: "Rakazo", url: "https://rakazo.com", snippet: " Open source " }] }),
    );
    const provider = new PhrogWebProvider({ baseUrl: "http://gw:1/", fetch });
    const hits = await provider.search({ query: "rakazo", maxResults: 3 }, context);
    expect(hits).toEqual([{ title: "Rakazo", url: "https://rakazo.com", snippet: "Open source" }]);
    const url = String((fetch.mock.calls[0] as unknown as [URL])[0]);
    expect(url).toBe("http://gw:1/api/search?q=rakazo&limit=3");
  });

  it("posts the page url to /api/fetch and windows long pages", async () => {
    const fetch = vi.fn(async () =>
      json({ url: "https://e.com/", title: "E", markdown: "x".repeat(300) }),
    );
    const provider = new PhrogWebProvider({ baseUrl: "http://gw:1", fetch, token: "secret-token-value" });
    const page = await provider.fetch({ url: "https://e.com/", maxChars: 100 }, context);
    expect(page.truncated).toBe(true);
    expect(page.text).toContain("continue with offset 100");
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://e.com/" });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token-value");
  });

  it("fails clearly on gateway errors and empty pages", async () => {
    const down = new PhrogWebProvider({ baseUrl: "http://gw:1", fetch: async () => json({}, 502) });
    await expect(down.search({ query: "x" }, context)).rejects.toThrow("HTTP 502");
    const empty = new PhrogWebProvider({
      baseUrl: "http://gw:1",
      fetch: async () => json({ url: "u", markdown: "  " }),
    });
    await expect(empty.fetch({ url: "https://e.com/" }, context)).rejects.toThrow("Failed to fetch");
  });

  it("is selected by WEB_PROVIDER=phrog-web and needs PHROG_WEB_URL", () => {
    vi.stubEnv("PHROG_WEB_URL", "");
    expect(() => createWebProvider("phrog-web")).toThrow("PHROG_WEB_URL");
    vi.stubEnv("PHROG_WEB_URL", "http://gw:1");
    expect(createWebProvider("phrog-web").describe().id).toBe("phrog-web");
    vi.unstubAllEnvs();
  });
});
