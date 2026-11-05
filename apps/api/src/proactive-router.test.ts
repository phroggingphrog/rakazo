import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

it("passes authenticated owner identity through the real proactive RPC", async () => {
  const configure = vi.fn().mockResolvedValue({ updated: true });
  const deps = {
    prisma: {},
    proactive: { configure },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      webOrigin: "http://127.0.0.1",
      screenProxySecret: "fake",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const request = () =>
    new Request("http://127.0.0.1/rpc/bots/proactiveConfigure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: {
          botId: "bot",
          config: { fallbackMs: 600000 },
          spaceId: "attacker",
          userId: "attacker",
        },
      }),
    });
  const actor = {
    spaceId: "space",
    userId: "owner",
    email: "owner@example.test",
    isDeploymentOwner: false,
  };
  const { response } = await handler.handle(request(), {
    prefix: "/rpc",
    context: { actor, sessionId: "session" },
  });
  expect(response?.status).toBe(200);
  expect(configure).toHaveBeenCalledWith({
    botId: "bot",
    config: { fallbackMs: 600000 },
    spaceId: "space",
    userId: "owner",
  });
  configure.mockClear();
  const denied = await handler.handle(request(), { prefix: "/rpc", context: { actor: null } });
  expect(denied.response?.status).toBe(401);
  expect(configure).not.toHaveBeenCalled();
});
