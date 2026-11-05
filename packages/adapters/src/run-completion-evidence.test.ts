import { describe, expect, it, vi } from "vitest";
import { assertNoUnresolvedEffects, UnverifiedExecutionError } from "./run-completion-evidence.js";

describe("completion evidence guard", () => {
  it("allows runs with no unresolved effects", async () => {
    const store = { externalEffect: { count: vi.fn().mockResolvedValue(0) } };
    await expect(assertNoUnresolvedEffects(store, "run-1")).resolves.toBeUndefined();
    expect(store.externalEffect.count).toHaveBeenCalledWith({
      where: { runId: "run-1", status: { in: ["failed", "uncertain", "executing"] } },
    });
  });

  it.each(["failed", "uncertain", "executing"] as const)(
    "rejects when an effect is still %s",
    async () => {
      const store = { externalEffect: { count: vi.fn().mockResolvedValue(1) } };
      await expect(assertNoUnresolvedEffects(store, "run-1")).rejects.toBeInstanceOf(
        UnverifiedExecutionError,
      );
      await expect(assertNoUnresolvedEffects(store, "run-1")).rejects.toThrow(
        "reconcile destination evidence",
      );
    },
  );

  it("does not disclose destination content in the rejection", async () => {
    const store = { externalEffect: { count: vi.fn().mockResolvedValue(2) } };
    await expect(assertNoUnresolvedEffects(store, "run-secret")).rejects.toThrow(
      UnverifiedExecutionError,
    );
    await expect(assertNoUnresolvedEffects(store, "run-secret")).rejects.not.toThrow(/secret|password|token/i);
  });
});
