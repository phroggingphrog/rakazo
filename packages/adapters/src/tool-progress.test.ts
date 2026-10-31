import { describe, expect, it } from "vitest";
import { ToolProgressGuard, toolFailureClass } from "./tool-progress.js";

describe("tool no-progress guard", () => {
  it("blocks a repeated equivalent non-transient failure after 1 failed attempt", () => {
    const guard = new ToolProgressGuard();
    const first = guard.fingerprint("mcp__files__write", { path: "/private", content: "x" });
    const equivalent = guard.fingerprint("mcp__files__write", {
      content: "x",
      path: "/private",
    });
    expect(equivalent).toBe(first);
    guard.recordFailure(first, "nontransient");
    expect(guard.isBlocked(equivalent)).toBe(true);
    expect(guard.blockedMessage("mcp__files__write")).toContain("Take a new recovery step");
  });

  it("allows 2 transient failed attempts, then blocks the equivalent call", () => {
    const guard = new ToolProgressGuard();
    const key = guard.fingerprint("web_fetch", { url: "https://example.test" });
    guard.recordFailure(key, "transient");
    expect(guard.isBlocked(key)).toBe(false);
    guard.recordFailure(key, "transient");
    expect(guard.isBlocked(key)).toBe(true);
  });

  it("bounds unknown errors at 2 failed attempts", () => {
    const guard = new ToolProgressGuard();
    const key = guard.fingerprint("custom", { query: "x" });
    guard.recordFailure(key, "unknown");
    expect(guard.isBlocked(key)).toBe(false);
    guard.recordFailure(key, "unknown");
    expect(guard.isBlocked(key)).toBe(true);
  });

  it("resets the failed-call state after success and treats changed arguments as progress", () => {
    const guard = new ToolProgressGuard();
    const key = guard.fingerprint("read_file", { path: "a" });
    guard.recordFailure(key, "unknown");
    expect(guard.fingerprint("read_file", { path: "b" })).not.toBe(key);
    guard.recordSuccess(key);
    expect(guard.isBlocked(key)).toBe(false);
  });

  it.each([
    ["403 permission denied", "nontransient"],
    ["invalid API key", "nontransient"],
    ["configuration error: missing credential", "nontransient"],
    ["OAuth token expired", "nontransient"],
    ["token revoked by administrator", "nontransient"],
    ["unsupported transport: websocket", "nontransient"],
    ["unsupported provider for this operation", "nontransient"],
    ["HTTP 503 unavailable", "transient"],
    ["Request timed out", "transient"],
    ["destination rejected the record", "unknown"],
  ] as const)("classifies %s as %s", (message, kind) => {
    expect(toolFailureClass(message)).toBe(kind);
  });
});
