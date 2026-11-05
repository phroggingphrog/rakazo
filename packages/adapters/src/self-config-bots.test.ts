import { describe, expect, it } from "vitest";
import { learningCollectorEnabled } from "./learning-candidate-collector.js";
import { routineSourceEnabledForBot, routineSourceFromEnv } from "./proactive.js";
import { selfConfigBots, selfConfigEnabledForBot } from "./self-config-bots.js";
import { toolSelectionEnabled } from "./tool-selection.js";

describe("per-bot self-config switch", () => {
  it("is on for every bot by default when unset", () => {
    expect(selfConfigBots({}).has("*")).toBe(true);
    expect(selfConfigEnabledForBot("b1", {})).toBe(true);
    expect(toolSelectionEnabled({}, "b1")).toBe(true);
    expect(routineSourceFromEnv({})).toBe(true);
    expect(routineSourceEnabledForBot({}, "b1")).toBe(true);
    expect(learningCollectorEnabled({})).toBe(true);
  });

  it.each(["", "  ", "none", "OFF", "0", "false"])("is off for every bot when set to %j", (value) => {
    const env = { RAKAZO_SELF_CONFIG_BOTS: value };
    expect(selfConfigBots(env).size).toBe(0);
    expect(selfConfigEnabledForBot("b1", env)).toBe(false);
    expect(toolSelectionEnabled(env, "b1")).toBe(false);
    expect(routineSourceFromEnv(env)).toBe(false);
    expect(learningCollectorEnabled(env)).toBe(false);
  });

  it("excludes listed bots from the default", () => {
    for (const value of ["*,-b1", "-b1", " * , -b1 , -b2 "]) {
      const env = { RAKAZO_SELF_CONFIG_BOTS: value };
      expect(selfConfigEnabledForBot("b1", env)).toBe(false);
      expect(toolSelectionEnabled(env, "b1")).toBe(false);
      expect(routineSourceEnabledForBot(env, "b1")).toBe(false);
      expect(selfConfigEnabledForBot("b3", env)).toBe(true);
      expect(routineSourceFromEnv(env)).toBe(true);
      expect(learningCollectorEnabled(env)).toBe(true);
    }
    expect(selfConfigEnabledForBot("b1", { RAKAZO_SELF_CONFIG_BOTS: "b1,-b1" })).toBe(false);
  });

  it("keeps the global flags on when the per-bot switch is off", () => {
    const off = { RAKAZO_SELF_CONFIG_BOTS: "none" };
    expect(toolSelectionEnabled({ ...off, RAKAZO_TOOL_SELECTION: "on" }, "b3")).toBe(true);
    expect(routineSourceEnabledForBot({ ...off, PROACTIVE_ROUTINE_SOURCE: "1" }, "b3")).toBe(true);
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
