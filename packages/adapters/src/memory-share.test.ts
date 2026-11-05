import { describe, expect, it } from "vitest";
import { BotRuntimeProfile } from "@rakazo/contracts";
import { memoryShareLevel } from "./memory-share.js";
import { replaceFactLine } from "./memory-tools.js";
import { rememberProvenance } from "./run-tools-memory.js";

describe("memoryShareLevel", () => {
  const optedIn = BotRuntimeProfile.parse({
    learning: { share: "read+propose" },
  });
  it("defaults off even when every bot is on the switch", () => {
    expect(
      memoryShareLevel("b1", BotRuntimeProfile.parse({}), {
        RAKAZO_SELF_CONFIG_BOTS: "*",
      }),
    ).toBe("off");
  });
  it("stays off for a bot not on the switch", () => {
    expect(
      memoryShareLevel("b1", optedIn, { RAKAZO_SELF_CONFIG_BOTS: "b2" }),
    ).toBe("off");
  });
  it("honours the profile for a switched-on bot", () => {
    expect(
      memoryShareLevel("b1", optedIn, { RAKAZO_SELF_CONFIG_BOTS: "b1" }),
    ).toBe("read+propose");
  });
});

describe("replaceFactLine", () => {
  it("replaces an exact line", () => {
    expect(replaceFactLine("a\nold fact\nc\n", "old fact", "new fact")).toBe(
      "a\nnew fact\nc\n",
    );
  });
  it("returns null when the fact is absent", () => {
    expect(replaceFactLine("a\n", "missing", "x")).toBeNull();
  });
  it("collapses a duplicate of the new fact", () => {
    expect(replaceFactLine("new\nold\n", "old", "new")).toBe("new\n");
  });
});

describe("rememberProvenance", () => {
  it("defaults to bot-inferred", () => {
    expect(rememberProvenance({})).toEqual({ method: "bot-inferred" });
    expect(
      rememberProvenance({ source: "owner-stated", confidence: 0.9 }),
    ).toEqual({
      method: "owner-stated",
      confidence: 0.9,
    });
  });
});
