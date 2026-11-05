import { describe, expect, it } from "vitest";
import { learningCollectorEnabled } from "./learning-candidate-collector.js";
import { routineSourceEnabledForBot, routineSourceFromEnv } from "./proactive.js";
import { selfConfigBots, selfConfigEnabledForBot } from "./self-config-bots.js";
import { toolSelectionEnabled } from "./tool-selection.js";

describe("per-bot self-config switch", () => {
  it("is off for every bot when unset", () => {
    expect(selfConfigBots({}).size).toBe(0);
    expect(selfConfigEnabledForBot("b1", {})).toBe(false);
    expect(toolSelectionEnabled({}, "b1")).toBe(false);
    expect(routineSourceFromEnv({})).toBe(false);
    expect(learningCollectorEnabled({})).toBe(false);
  });

  it("turns the features on only for listed bots", () => {
    const env = { RAKAZO_SELF_CONFIG_BOTS: " b1 , b2" };
    expect(toolSelectionEnabled(env, "b1")).toBe(true);
    expect(toolSelectionEnabled(env, "b3")).toBe(false);
    expect(toolSelectionEnabled(env)).toBe(false);
    expect(routineSourceFromEnv(env)).toBe(true);
    expect(routineSourceEnabledForBot(env, "b2")).toBe(true);
    expect(routineSourceEnabledForBot(env, "b3")).toBe(false);
    expect(learningCollectorEnabled(env)).toBe(true);
  });

  it("keeps the global flags applying to every bot", () => {
    expect(toolSelectionEnabled({ RAKAZO_TOOL_SELECTION: "on" }, "b3")).toBe(true);
    expect(routineSourceEnabledForBot({ PROACTIVE_ROUTINE_SOURCE: "1" }, "b3")).toBe(true);
    expect(selfConfigEnabledForBot("b3", { RAKAZO_SELF_CONFIG_BOTS: "*" })).toBe(true);
  });
});
