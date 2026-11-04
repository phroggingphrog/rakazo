import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "./expo-push.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";

const context = {
  operationId: "rollback-test",
  traceId: "rollback-test",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const message = {
  kind: "completion" as const,
  title: "Synthetic",
  body: "Synthetic",
  botId: "bot",
  threadId: "thread",
};
const token = "ExponentPushToken[synthetic]";

afterEach(() => vi.unstubAllGlobals());

describe("rollback-floor Expo rejection evidence", () => {
  it("removes a token only for one unambiguous rejection", async () => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("owner", token);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { status: "error", details: { error: "DeviceNotRegistered" } } }),
      ),
    );
    await expect(new ExpoPushProvider(tokens).deliver(message, context)).resolves.toBe(
      "undeliverable",
    );
    expect(await tokens.load("owner")).toBeUndefined();
  });

  it.each([
    { data: { status: "ok", id: "accepted", details: { error: "DeviceNotRegistered" } } },
    { data: [{ status: "error", details: { error: "DeviceNotRegistered" } }, null] },
    { data: { status: "error", id: "accepted", details: { error: "DeviceNotRegistered" } } },
    {
      data: { status: "error", details: { error: "DeviceNotRegistered" } },
      errors: [{ message: "ambiguous" }],
    },
  ])("preserves the token and marks contradictory tickets uncertain", async (body) => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("owner", token);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(new ExpoPushProvider(tokens).deliver(message, context)).rejects.toThrow(
      "uncertain",
    );
    expect((await tokens.load("owner"))?.token).toBe(token);
  });
});
