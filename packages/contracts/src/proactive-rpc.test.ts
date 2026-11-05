import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";

describe("owner proactive configuration contract", () => {
  const schema = appContract.bots.proactiveConfigure["~orpc"].inputSchema!;
  it("accepts bounded configuration and rejects excessive interval and unknown stages", () => {
    expect(schema.safeParse({ botId: "bot-one", config: { fallbackMs: 300000 } }).success).toBe(true);
    expect(schema.safeParse({ botId: "bot-one", config: { fallbackMs: 0 } }).success).toBe(true);
    expect(schema.safeParse({ botId: "bot-one", config: { fallbackMs: 1 } }).success).toBe(false);
    expect(
      schema.safeParse({ botId: "bot-one", config: { decisionOrder: ["skip"] } }).success,
    ).toBe(false);
  });
});
