import { describe, expect, it, vi } from "vitest";
import { JevProactiveJudge } from "./jev-proactive-judge.js";

const input = { scope: "bot:test", events: [], responsibilities: "Help with requests" };
function fixture(choice: string, confidence?: number) {
  const decide = vi.fn().mockResolvedValue({
    model: "test",
    answers: { respond: { type: "choice", choice, confidence } },
  });
  const judge = new JevProactiveJudge({
    provider: { decide },
    model: "test",
    context: async () => ({
      operationId: "test",
      traceId: "test",
      spaceId: "space",
      userId: "owner",
      botId: "test",
      signal: new AbortController().signal,
    }),
  });
  return { judge, decide };
}
describe("Jev proactive judge", () => {
  it("maps confidence relative to the selected label", async () => {
    expect((await fixture("act", 0.8).judge.judge(input)).probability).toBe(0.8);
    expect((await fixture("ignore", 0.8).judge.judge(input)).probability).toBeCloseTo(0.2);
    expect((await fixture("ignore").judge.judge(input)).probability).toBe(0);
  });
  it("rejects invalid decisions rather than qualifying them", async () => {
    await expect(fixture("unknown").judge.judge(input)).rejects.toThrow(
      "Invalid proactive judge choice",
    );
    await expect(fixture("act", NaN).judge.judge(input)).rejects.toThrow(
      "Invalid proactive judge confidence",
    );
  });
  it("propagates failures to the engine retry path", async () => {
    const { judge, decide } = fixture("act");
    decide.mockRejectedValue(new Error("unavailable"));
    await expect(judge.judge(input)).rejects.toThrow("unavailable");
  });
});
