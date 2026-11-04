import { describe, expect, it } from "vitest";
import { SetupOperationArgumentsSchema } from "./setup-plan.js";

describe("setup operation arguments", () => {
  it("accepts ordinary continuation fields even when their names include token or credential", () => {
    const input = {
      pageToken: "cursor",
      nested: { credentialType: "local", next_secret: "marker" },
    };
    expect(SetupOperationArgumentsSchema.safeParse(input).success).toBe(true);
  });

  it("continues to reject prototype keys and oversized arguments", () => {
    expect(
      SetupOperationArgumentsSchema.safeParse(JSON.parse('{"__proto__":{"polluted":true}}'))
        .success,
    ).toBe(false);
    expect(SetupOperationArgumentsSchema.safeParse({ query: "x".repeat(2049) }).success).toBe(
      false,
    );
  });
});
